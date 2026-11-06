// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CreatureCampaignManager} from "./CreatureCampaignManager.sol";

/// @title CreatureMarket
/// @notice Player side of the creature campaigns: claim, redeem, sell and buy. Everything is decided here
///         on chain; Arkiv only mirrors it.
///
///   Claim   A player standing within CLAIM_RADIUS_M of a campaign's spawn claims the campaign's NEXT
///           creature. Creature indexes were shuffled by Chainlink VRF (Fisher–Yates in
///           CreatureCampaignManager), so the next index is a uniformly random rarity nobody can choose.
///           One creature per player per campaign. The claim needs a ticket signed by `humanSigner`
///           (the app's backend issues one only to a World ID verified human's wallet).
///   Redeem  The owner marks the creature redeemed (forever). The discount code is then revealed off chain
///           to the owner only. A redeemed creature can never be sold.
///   Sell    The owner lists with a price. The listing needs an attestation signed by `settler`: the
///           settler holds the creature's Arkiv entity in escrow and has checked its data against this
///           chain, so a sale can be mirrored on Arkiv automatically.
///   Buy     Exact price; the seller is paid in the same transaction and ownership moves to the buyer.
/// @dev Read-only dependency on CreatureCampaignManager. creatureId = (campaignId << 32) | index.
contract CreatureMarket is Ownable2Step, ReentrancyGuard, EIP712 {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Holding {
        address owner; // zero = not claimed yet
        uint64 claimedAt;
        bool redeemed;
    }

    struct Listing {
        address seller; // zero = not listed
        uint256 price; // wei
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 public constant CLAIM_RADIUS_M = 50;
    /// @dev Prices are mirrored on Arkiv in a u64 column.
    uint256 public constant MAX_PRICE = type(uint64).max;
    /// @dev Signed tickets may not be valid for longer than this (limits the damage of a leaked ticket).
    uint256 public constant MAX_TICKET_TTL = 1 hours;

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address player,uint256 creatureId,uint256 deadline)");
    bytes32 public constant LISTING_TYPEHASH =
        keccak256("Listing(address seller,uint256 creatureId,uint256 price,uint256 deadline)");

    int256 internal constant MAX_LAT_E6 = 90_000_000;
    int256 internal constant MAX_LON_E6 = 180_000_000;
    /// @dev Metres per degree of latitude, in micrometres per micro-degree (111 320 m / degree).
    uint256 internal constant UM_PER_MICRODEG = 111_320;
    /// @dev 180^2 * 1e12: Bhaskara I's cosine approximation in micro-degrees (max error ~0.16%).
    uint256 internal constant BHASKARA_K = 32_400 * 1e12;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    CreatureCampaignManager public immutable campaignManager;
    address public humanSigner;
    address public settler;

    mapping(uint256 creatureId => Holding) private _holdings;
    mapping(uint256 creatureId => Listing) private _listings;
    mapping(uint256 campaignId => uint32) public claimedCount;
    /// @dev creatureId claimed by `player` in `campaignId` (0 = none; real ids are >= 1 << 32).
    mapping(address player => mapping(uint256 campaignId => uint256)) public claimedIn;
    mapping(address player => uint256[]) private _claims;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CreatureClaimed(
        uint256 indexed creatureId, uint256 indexed campaignId, address indexed player, address business, uint8 rarity
    );
    event Redeemed(uint256 indexed creatureId, address indexed owner);
    event Listed(uint256 indexed creatureId, address indexed seller, uint256 price);
    event Unlisted(uint256 indexed creatureId, address indexed seller);
    event Sold(uint256 indexed creatureId, address indexed seller, address indexed buyer, uint256 price);
    event HumanSignerUpdated(address signer);
    event SettlerUpdated(address settler);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error InvalidCoordinates();
    error TicketExpired(uint256 deadline);
    error TicketTooLong(uint256 deadline);
    error InvalidTicket();
    error CampaignNotActive(uint256 campaignId);
    error CampaignExpired(uint256 campaignId);
    error CampaignDepleted(uint256 campaignId);
    error AlreadyClaimedInCampaign(uint256 campaignId, uint256 creatureId);
    error NotNextCreature(uint256 creatureId, uint256 nextCreatureId);
    error TooFar(uint256 distanceM);
    error NotOwner(uint256 creatureId);
    error AlreadyRedeemed(uint256 creatureId);
    error IsListed(uint256 creatureId);
    error NotListed(uint256 creatureId);
    error InvalidPrice(uint256 price);
    error OwnListing(uint256 creatureId);
    error WrongPayment(uint256 sent, uint256 price);
    error PaymentFailed();

    // ---------------------------------------------------------------------
    // Constructor / admin
    // ---------------------------------------------------------------------

    constructor(CreatureCampaignManager manager, address humanSigner_, address settler_, address owner_)
        Ownable(owner_)
        EIP712("CreatureMarket", "1")
    {
        if (address(manager) == address(0)) revert ZeroAddress();
        campaignManager = manager;
        _setHumanSigner(humanSigner_);
        _setSettler(settler_);
    }

    function setHumanSigner(address signer) external onlyOwner {
        _setHumanSigner(signer);
    }

    function setSettler(address settler_) external onlyOwner {
        _setSettler(settler_);
    }

    function _setHumanSigner(address signer) private {
        if (signer == address(0)) revert ZeroAddress();
        humanSigner = signer;
        emit HumanSignerUpdated(signer);
    }

    function _setSettler(address settler_) private {
        if (settler_ == address(0)) revert ZeroAddress();
        settler = settler_;
        emit SettlerUpdated(settler_);
    }

    // ---------------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------------

    /// @param creatureId The creature the player saw: must be its campaign's next unclaimed one.
    /// @param latE6 / lonE6 The player's position (micro-degrees).
    /// @param deadline / humanSig Ticket from `humanSigner` for (msg.sender, creatureId, deadline).
    function claim(uint256 creatureId, int32 latE6, int32 lonE6, uint256 deadline, bytes calldata humanSig)
        external
        nonReentrant
    {
        _checkDeadline(deadline);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, creatureId, deadline)));
        if (ECDSA.recover(digest, humanSig) != humanSigner) revert InvalidTicket();
        if (!_validCoordinates(latE6, lonE6)) revert InvalidCoordinates();

        (uint256 campaignId, uint32 index) = campaignManager.decodeCreatureId(creatureId);
        CreatureCampaignManager.Campaign memory camp = campaignManager.getCampaign(campaignId); // reverts if none
        if (camp.status != CreatureCampaignManager.CampaignStatus.ALLOCATED) revert CampaignNotActive(campaignId);
        if (camp.expiresAt != 0 && block.timestamp >= camp.expiresAt) revert CampaignExpired(campaignId);

        uint256 already = claimedIn[msg.sender][campaignId];
        if (already != 0) revert AlreadyClaimedInCampaign(campaignId, already);
        uint32 next = claimedCount[campaignId];
        if (next >= camp.totalCreatures) revert CampaignDepleted(campaignId);
        if (index != next) revert NotNextCreature(creatureId, campaignManager.creatureIdOf(campaignId, next));

        uint256 distanceSq = distanceSquaredUm(latE6, lonE6, camp.latitudeE6, camp.longitudeE6);
        if (distanceSq > (CLAIM_RADIUS_M * 1e6) ** 2) revert TooFar(Math.sqrt(distanceSq) / 1e6);

        claimedCount[campaignId] = next + 1;
        claimedIn[msg.sender][campaignId] = creatureId;
        _claims[msg.sender].push(creatureId);
        _holdings[creatureId] = Holding({owner: msg.sender, claimedAt: uint64(block.timestamp), redeemed: false});

        uint8 rarity = uint8(campaignManager.getCreature(creatureId).rarity);
        emit CreatureClaimed(creatureId, campaignId, msg.sender, camp.business, rarity);
    }

    // ---------------------------------------------------------------------
    // Redeem
    // ---------------------------------------------------------------------

    function redeem(uint256 creatureId) external nonReentrant {
        Holding storage h = _holdings[creatureId];
        if (h.owner != msg.sender) revert NotOwner(creatureId);
        if (h.redeemed) revert AlreadyRedeemed(creatureId);
        if (_listings[creatureId].seller != address(0)) revert IsListed(creatureId);
        h.redeemed = true;
        emit Redeemed(creatureId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Marketplace
    // ---------------------------------------------------------------------

    /// @param deadline / settlerSig Attestation from `settler` for (msg.sender, creatureId, price, deadline):
    ///        the creature's Arkiv entity is in the settler's escrow, listed at `price`, with untampered data.
    function list(uint256 creatureId, uint256 price, uint256 deadline, bytes calldata settlerSig)
        external
        nonReentrant
    {
        Holding storage h = _holdings[creatureId];
        if (h.owner != msg.sender) revert NotOwner(creatureId);
        if (h.redeemed) revert AlreadyRedeemed(creatureId);
        if (_listings[creatureId].seller != address(0)) revert IsListed(creatureId);
        if (price == 0 || price > MAX_PRICE) revert InvalidPrice(price);
        _checkDeadline(deadline);
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(LISTING_TYPEHASH, msg.sender, creatureId, price, deadline)));
        if (ECDSA.recover(digest, settlerSig) != settler) revert InvalidTicket();

        _listings[creatureId] = Listing({seller: msg.sender, price: price});
        emit Listed(creatureId, msg.sender, price);
    }

    function unlist(uint256 creatureId) external nonReentrant {
        if (_listings[creatureId].seller != msg.sender) revert NotListed(creatureId);
        delete _listings[creatureId];
        emit Unlisted(creatureId, msg.sender);
    }

    function buy(uint256 creatureId) external payable nonReentrant {
        Listing memory l = _listings[creatureId];
        if (l.seller == address(0)) revert NotListed(creatureId);
        if (l.seller == msg.sender) revert OwnListing(creatureId);
        if (msg.value != l.price) revert WrongPayment(msg.value, l.price);
        // Effects before the payout (checks-effects-interactions, plus the reentrancy guard).
        delete _listings[creatureId];
        _holdings[creatureId].owner = msg.sender;
        emit Sold(creatureId, l.seller, msg.sender, l.price);
        (bool ok,) = l.seller.call{value: l.price}("");
        if (!ok) revert PaymentFailed();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getHolding(uint256 creatureId) external view returns (Holding memory) {
        return _holdings[creatureId];
    }

    function getListing(uint256 creatureId) external view returns (Listing memory) {
        return _listings[creatureId];
    }

    /// @notice Every creature `player` ever claimed (they may have sold some since: see getHolding).
    function getPlayerClaims(address player) external view returns (uint256[] memory) {
        return _claims[player];
    }

    /// @notice The campaign's next claimable creature, and whether one is left.
    function nextCreature(uint256 campaignId) external view returns (uint256 creatureId, bool available) {
        CreatureCampaignManager.Campaign memory camp = campaignManager.getCampaign(campaignId);
        uint32 next = claimedCount[campaignId];
        available = camp.status == CreatureCampaignManager.CampaignStatus.ALLOCATED
            && (camp.expiresAt == 0 || block.timestamp < camp.expiresAt) && next < camp.totalCreatures;
        creatureId = campaignManager.creatureIdOf(campaignId, next);
    }

    /// @notice EIP-712 domain separator (for off-chain signers and tests).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Squared ground distance in micrometres^2 between two points (equirectangular projection with
    ///         Bhaskara I's cosine at the second point's latitude). Within 0.2% of the great-circle distance
    ///         at the claim radius. Apps use the same formula to tell players whether a claim will pass.
    function distanceSquaredUm(int32 latA, int32 lonA, int32 latB, int32 lonB) public pure returns (uint256) {
        uint256 dLat = _absDiff(latA, latB);
        uint256 dLon = _absDiff(lonA, lonB);
        if (dLon > uint256(MAX_LON_E6)) dLon = 2 * uint256(MAX_LON_E6) - dLon; // across the antimeridian
        uint256 lat = latB < 0 ? uint256(-int256(latB)) : uint256(int256(latB));
        uint256 latSq = lat * lat;
        uint256 dy = dLat * UM_PER_MICRODEG;
        uint256 dx = (dLon * UM_PER_MICRODEG * (BHASKARA_K - 4 * latSq)) / (BHASKARA_K + latSq);
        return dx * dx + dy * dy;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp) revert TicketExpired(deadline);
        if (deadline > block.timestamp + MAX_TICKET_TTL) revert TicketTooLong(deadline);
    }

    function _validCoordinates(int32 latE6, int32 lonE6) private pure returns (bool) {
        return int256(latE6) >= -MAX_LAT_E6 && int256(latE6) <= MAX_LAT_E6 && int256(lonE6) >= -MAX_LON_E6
            && int256(lonE6) <= MAX_LON_E6;
    }

    function _absDiff(int32 a, int32 b) private pure returns (uint256) {
        int256 d = int256(a) - int256(b);
        return d < 0 ? uint256(-d) : uint256(d);
    }
}
