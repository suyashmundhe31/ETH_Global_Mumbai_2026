// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {CreatureCampaignManager} from "./CreatureCampaignManager.sol";

/// @title CatchManager
/// @notice Each player sees ONE spawn per campaign and can catch at most ONE creature per campaign.
///         Which creature they get is decided by Chainlink VRF at catch time, so rarity cannot be
///         sniped by choosing a creature or grinding wallet addresses.
///
///         Flow:
///           1. Player calls requestCatch(campaignId, lat, lon, worldIdProof)  -> CatchRequested event
///           2. CRE workflow (EVM log trigger) checks distance + World ID, writes a signed report
///              -> KeystoneForwarder -> CatchReceiver -> onVerification(attemptId, approved, nullifier)
///           3. If approved, VRF is requested (3 words: catch roll, creature pick, float)
///           4. fulfillRandomWords resolves the catch -> CatchResolved event (business app settles Arkiv)
///
///         Redeem: owner calls requestRedeem(creatureId, playerPubKey) -> RedeemRequested; CRE checks
///         ownership, decrypts the code and seals it to playerPubKey -> onRedeemVerified -> CodeRevealed.
///         Trading: list / unlist / buy move the creature between wallets (blocked once redeemed).
/// @dev Read-only dependency on CreatureCampaignManager. Add this contract as a consumer on the same
///      VRF subscription as the campaign manager.
contract CatchManager is VRFConsumerBaseV2Plus {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum AttemptStatus {
        NONE,
        VERIFYING, // waiting for the CRE verdict
        ROLLING, // waiting for VRF
        CAUGHT,
        FAILED, // VRF roll failed
        REJECTED, // CRE rejected (too far / World ID invalid)
        EXPIRED // released after a timeout
    }

    struct Attempt {
        address player;
        AttemptStatus status;
        uint64 createdAt;
        uint32 totalCreatures; // cached so the VRF callback needs no campaign read
        uint256 campaignId;
        uint256 vrfRequestId;
        uint256 creatureId; // set on success
    }

    struct CaughtCreature {
        address owner;
        uint64 floatE18; // wear * 1e18, in [0, 1e18)
        uint64 caughtAt;
        uint8 rarity;
        uint256 attemptId;
    }

    struct Listing {
        address seller;
        uint256 price; // wei
    }

    struct RedeemRequest {
        address owner; // owner at request time; the verdict only applies if they still own it
        uint64 requestedAt;
    }

    struct VrfConfig {
        bytes32 keyHash;
        uint256 subscriptionId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        bool nativePayment;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 public constant FLOAT_SCALE = 1e18;
    uint256 public constant BPS = 10_000;
    uint64 public constant FAIL_COOLDOWN = 60 seconds;
    uint64 public constant ATTEMPT_TIMEOUT = 30 minutes;
    uint64 public constant REDEEM_TIMEOUT = 30 minutes; // a pending redeem can be re-requested after this
    int32 internal constant MAX_LAT_E6 = 90_000_000;
    int32 internal constant MAX_LON_E6 = 180_000_000;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    CreatureCampaignManager public immutable campaignManager;
    VrfConfig public vrfConfig;
    address public catchReceiver;
    uint16[4] public catchRateBps; // indexed by CreatureCampaignManager.Rarity
    uint256 public attemptCount;

    mapping(uint256 attemptId => Attempt) private _attempts;
    mapping(uint256 requestId => uint256 attemptId) public attemptOfRequest;
    mapping(uint256 creatureId => CaughtCreature) private _caught;
    mapping(uint256 campaignId => uint32) public caughtCount;
    mapping(uint256 campaignId => uint32) public reservedCount; // attempts in flight
    mapping(address player => mapping(uint256 campaignId => uint256)) public activeAttempt;
    mapping(address player => mapping(uint256 campaignId => uint256)) public caughtInCampaign; // creatureId
    mapping(address player => mapping(uint256 campaignId => uint64)) public lastFailedAt;
    mapping(uint256 campaignId => mapping(uint256 nullifier => address)) public humanOfCampaign;
    mapping(address player => uint256[]) private _playerCatches;
    mapping(uint256 creatureId => bool) public redeemed; // never reset
    /// @dev Kept so the owner can re-read it without log queries; only the owner's box key opens it.
    mapping(uint256 creatureId => bytes) public sealedCodes;
    mapping(uint256 creatureId => RedeemRequest) public pendingRedeem;
    mapping(uint256 creatureId => Listing) public listings;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @dev The CRE workflow's EVM log trigger listens for this event. It carries everything the
    ///      workflow needs (player and spawn coordinates), so no extra chain read is required.
    event CatchRequested(
        uint256 indexed attemptId,
        uint256 indexed campaignId,
        address indexed player,
        int32 playerLatE6,
        int32 playerLonE6,
        int32 spawnLatE6,
        int32 spawnLonE6,
        bytes worldIdProof
    );
    event CatchVerified(uint256 indexed attemptId, uint256 indexed vrfRequestId);
    event CatchRejected(uint256 indexed attemptId, uint256 indexed campaignId, address indexed player);
    event CatchResolved(
        uint256 indexed attemptId,
        uint256 indexed campaignId,
        address indexed player,
        bool success,
        uint256 creatureId,
        uint8 rarity,
        uint64 floatE18
    );
    event AttemptExpired(uint256 indexed attemptId);
    /// @dev Second CRE log trigger. playerPubKey is the player's X25519 (nacl.box) public key.
    event RedeemRequested(uint256 indexed creatureId, address indexed owner, bytes32 playerPubKey);
    /// @dev sealedCode = nacl.box(code, nonce = keccak256(creatureId)[0:24], playerPubKey, workflowSecretKey).
    event CodeRevealed(uint256 indexed creatureId, bytes sealedCode);
    event RedeemRejected(uint256 indexed creatureId);
    event Listed(uint256 indexed creatureId, address indexed seller, uint256 price);
    event Unlisted(uint256 indexed creatureId);
    event Sold(uint256 indexed creatureId, address indexed seller, address indexed buyer, uint256 price);
    event StaleCallbackIgnored(uint256 indexed id);
    event CatchReceiverUpdated(address receiver);
    event CatchRatesUpdated(uint16[4] rates);
    event VrfConfigUpdated(bytes32 keyHash, uint256 subscriptionId, uint16 confirmations, uint32 gasLimit, bool native);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error Reentrancy();
    error InvalidConfig();
    error OnlyCatchReceiver();
    error CampaignNotActive(uint256 campaignId);
    error CampaignExpired(uint256 campaignId);
    error CampaignDepleted(uint256 campaignId);
    error AlreadyCaughtInCampaign(uint256 campaignId, uint256 creatureId);
    error AttemptInProgress(uint256 attemptId);
    error CooldownActive(uint64 availableAt);
    error InvalidCoordinates();
    error NotExpirable(uint256 attemptId);
    error NotOwner(uint256 creatureId);
    error AlreadyRedeemed(uint256 creatureId);
    error RedeemPending(uint256 creatureId);
    error IsListed(uint256 creatureId);
    error NotListed(uint256 creatureId);
    error InvalidPrice();
    error WrongPayment(uint256 sent, uint256 price);
    error PaymentFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------------
    // Constructor / admin
    // ---------------------------------------------------------------------

    constructor(address vrfCoordinator, VrfConfig memory config, CreatureCampaignManager manager, uint16[4] memory rates)
        VRFConsumerBaseV2Plus(vrfCoordinator)
    {
        if (address(manager) == address(0)) revert InvalidConfig();
        campaignManager = manager;
        _setVrfConfig(config);
        _setCatchRates(rates);
    }

    /// @notice Set once the CatchReceiver (CRE entry point) is deployed.
    function setCatchReceiver(address receiver) external onlyOwner {
        if (receiver == address(0)) revert InvalidConfig();
        catchReceiver = receiver;
        emit CatchReceiverUpdated(receiver);
    }

    function setVrfConfig(VrfConfig calldata config) external onlyOwner {
        _setVrfConfig(config);
    }

    function setCatchRates(uint16[4] calldata rates) external onlyOwner {
        _setCatchRates(rates);
    }

    function _setVrfConfig(VrfConfig memory config) internal {
        if (config.keyHash == bytes32(0) || config.subscriptionId == 0 || config.callbackGasLimit == 0) {
            revert InvalidConfig();
        }
        vrfConfig = config;
        emit VrfConfigUpdated(
            config.keyHash, config.subscriptionId, config.requestConfirmations, config.callbackGasLimit, config.nativePayment
        );
    }

    function _setCatchRates(uint16[4] memory rates) internal {
        for (uint256 i = 0; i < 4; i++) {
            if (rates[i] == 0 || rates[i] > BPS) revert InvalidConfig();
        }
        catchRateBps = rates;
        emit CatchRatesUpdated(rates);
    }

    // ---------------------------------------------------------------------
    // Step 1: player
    // ---------------------------------------------------------------------

    /// @param worldIdProof Opaque bytes passed through to the CRE workflow (empty if World ID is off).
    function requestCatch(uint256 campaignId, int32 latE6, int32 lonE6, bytes calldata worldIdProof)
        external
        nonReentrant
        returns (uint256 attemptId)
    {
        if (latE6 < -MAX_LAT_E6 || latE6 > MAX_LAT_E6 || lonE6 < -MAX_LON_E6 || lonE6 > MAX_LON_E6) {
            revert InvalidCoordinates();
        }
        CreatureCampaignManager.Campaign memory camp = campaignManager.getCampaign(campaignId); // reverts if none
        if (camp.status != CreatureCampaignManager.CampaignStatus.ALLOCATED) revert CampaignNotActive(campaignId);
        if (camp.expiresAt != 0 && block.timestamp >= camp.expiresAt) revert CampaignExpired(campaignId);

        uint256 owned = caughtInCampaign[msg.sender][campaignId];
        if (owned != 0) revert AlreadyCaughtInCampaign(campaignId, owned);
        uint256 active = activeAttempt[msg.sender][campaignId];
        if (active != 0) revert AttemptInProgress(active);
        uint64 failedAt = lastFailedAt[msg.sender][campaignId];
        if (failedAt != 0 && block.timestamp < failedAt + FAIL_COOLDOWN) revert CooldownActive(failedAt + FAIL_COOLDOWN);
        if (uint256(caughtCount[campaignId]) + reservedCount[campaignId] >= camp.totalCreatures) {
            revert CampaignDepleted(campaignId);
        }

        reservedCount[campaignId] += 1; // guarantees an uncaught creature exists when VRF lands
        attemptId = ++attemptCount;
        Attempt storage a = _attempts[attemptId];
        a.player = msg.sender;
        a.status = AttemptStatus.VERIFYING;
        a.createdAt = uint64(block.timestamp);
        a.campaignId = campaignId;
        a.totalCreatures = camp.totalCreatures;
        activeAttempt[msg.sender][campaignId] = attemptId;

        emit CatchRequested(
            attemptId, campaignId, msg.sender, latE6, lonE6, camp.latitudeE6, camp.longitudeE6, worldIdProof
        );
    }

    // ---------------------------------------------------------------------
    // Step 2: CRE verdict (via CatchReceiver)
    // ---------------------------------------------------------------------

    /// @dev Never reverts on stale input, so a replayed report is consumed harmlessly.
    /// @param nullifier World ID nullifier for this campaign's action (0 if World ID is off). Binds one
    ///        human to one wallet per campaign, so a person cannot farm catches with extra wallets.
    function onVerification(uint256 attemptId, bool approved, uint256 nullifier) external nonReentrant {
        if (msg.sender != catchReceiver) revert OnlyCatchReceiver();
        Attempt storage a = _attempts[attemptId];
        if (a.status != AttemptStatus.VERIFYING) {
            emit StaleCallbackIgnored(attemptId);
            return;
        }

        if (approved && nullifier != 0) {
            address bound = humanOfCampaign[a.campaignId][nullifier];
            if (bound == address(0)) humanOfCampaign[a.campaignId][nullifier] = a.player;
            else if (bound != a.player) approved = false; // same human, different wallet
        }

        if (!approved) {
            _close(attemptId, AttemptStatus.REJECTED);
            emit CatchRejected(attemptId, a.campaignId, a.player);
            return;
        }

        VrfConfig memory cfg = vrfConfig;
        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: cfg.keyHash,
                subId: cfg.subscriptionId,
                requestConfirmations: cfg.requestConfirmations,
                callbackGasLimit: cfg.callbackGasLimit,
                numWords: 3, // [0] catch roll, [1] creature pick, [2] float
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: cfg.nativePayment}))
            })
        );
        a.status = AttemptStatus.ROLLING;
        a.vrfRequestId = requestId;
        attemptOfRequest[requestId] = attemptId;
        emit CatchVerified(attemptId, requestId);
    }

    // ---------------------------------------------------------------------
    // Step 3: VRF (must not revert)
    // ---------------------------------------------------------------------

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 attemptId = attemptOfRequest[requestId];
        Attempt storage a = _attempts[attemptId];
        if (attemptId == 0 || a.status != AttemptStatus.ROLLING || a.vrfRequestId != requestId || randomWords.length < 3)
        {
            emit StaleCallbackIgnored(requestId);
            return;
        }
        delete attemptOfRequest[requestId];
        uint256 campaignId = a.campaignId;
        address player = a.player;

        // Pick a uniformly random uncaught creature: random start, linear probe. The reservation made in
        // requestCatch guarantees at least one uncaught index exists.
        uint256 total = a.totalCreatures;
        uint256 start = randomWords[1] % total;
        uint256 creatureId;
        for (uint256 i = 0; i < total; i++) {
            // Same encoding as CreatureCampaignManager.creatureIdOf, computed locally to save gas.
            uint256 id = (campaignId << 32) | ((start + i) % total);
            if (_caught[id].owner == address(0)) {
                creatureId = id;
                break;
            }
        }

        uint8 rarity;
        try campaignManager.getCreature(creatureId) returns (CreatureCampaignManager.Creature memory c) {
            rarity = uint8(c.rarity);
        } catch {
            // Unreachable for an allocated campaign; never revert inside the VRF callback.
            emit StaleCallbackIgnored(requestId);
            return; // attempt stays ROLLING and can be released with expireAttempt
        }
        bool success = (randomWords[0] % BPS) < catchRateBps[rarity];

        if (!success) {
            lastFailedAt[player][campaignId] = uint64(block.timestamp);
            _close(attemptId, AttemptStatus.FAILED);
            emit CatchResolved(attemptId, campaignId, player, false, 0, rarity, 0);
            return;
        }

        // 2^256 / 1e18 leaves negligible modulo bias.
        uint64 floatE18 = uint64(randomWords[2] % FLOAT_SCALE);
        _caught[creatureId] = CaughtCreature({
            owner: player,
            floatE18: floatE18,
            caughtAt: uint64(block.timestamp),
            rarity: rarity,
            attemptId: attemptId
        });
        caughtCount[campaignId] += 1;
        caughtInCampaign[player][campaignId] = creatureId;
        _playerCatches[player].push(creatureId);
        a.creatureId = creatureId;
        _close(attemptId, AttemptStatus.CAUGHT);
        emit CatchResolved(attemptId, campaignId, player, true, creatureId, rarity, floatE18);
    }

    // ---------------------------------------------------------------------
    // Redeem (CRE decrypts the code and seals it to the owner)
    // ---------------------------------------------------------------------

    function requestRedeem(uint256 creatureId, bytes32 playerPubKey) external nonReentrant {
        if (_caught[creatureId].owner != msg.sender) revert NotOwner(creatureId);
        if (redeemed[creatureId]) revert AlreadyRedeemed(creatureId);
        if (listings[creatureId].seller != address(0)) revert IsListed(creatureId);
        if (playerPubKey == bytes32(0)) revert InvalidConfig();
        RedeemRequest memory p = pendingRedeem[creatureId];
        if (p.owner != address(0) && block.timestamp < p.requestedAt + REDEEM_TIMEOUT) revert RedeemPending(creatureId);
        pendingRedeem[creatureId] = RedeemRequest({owner: msg.sender, requestedAt: uint64(block.timestamp)});
        emit RedeemRequested(creatureId, msg.sender, playerPubKey);
    }

    /// @dev Never reverts on stale input: no pending request, already redeemed, or the creature changed
    ///      hands since the request are all ignored, so a replayed or late report is consumed harmlessly.
    function onRedeemVerified(uint256 creatureId, bool approved, bytes calldata sealedCode) external nonReentrant {
        if (msg.sender != catchReceiver) revert OnlyCatchReceiver();
        RedeemRequest memory p = pendingRedeem[creatureId];
        if (p.owner == address(0) || redeemed[creatureId] || _caught[creatureId].owner != p.owner) {
            emit StaleCallbackIgnored(creatureId);
            return;
        }
        delete pendingRedeem[creatureId];
        if (!approved) {
            emit RedeemRejected(creatureId);
            return;
        }
        redeemed[creatureId] = true;
        sealedCodes[creatureId] = sealedCode;
        if (listings[creatureId].seller != address(0)) {
            delete listings[creatureId]; // a redeemed creature can't be sold
            emit Unlisted(creatureId);
        }
        emit CodeRevealed(creatureId, sealedCode);
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    function list(uint256 creatureId, uint256 price) external nonReentrant {
        if (_caught[creatureId].owner != msg.sender) revert NotOwner(creatureId);
        if (redeemed[creatureId]) revert AlreadyRedeemed(creatureId);
        // A redeem in flight could reveal the code to the seller after the sale. (A late verdict for a timed-out
        // request is still safe: onRedeemVerified ignores it once the creature has changed hands.)
        RedeemRequest memory p = pendingRedeem[creatureId];
        if (p.owner != address(0) && block.timestamp < p.requestedAt + REDEEM_TIMEOUT) revert RedeemPending(creatureId);
        if (price == 0) revert InvalidPrice();
        listings[creatureId] = Listing({seller: msg.sender, price: price});
        emit Listed(creatureId, msg.sender, price);
    }

    function unlist(uint256 creatureId) external nonReentrant {
        if (listings[creatureId].seller != msg.sender) revert NotListed(creatureId);
        delete listings[creatureId];
        emit Unlisted(creatureId);
    }

    function buy(uint256 creatureId) external payable nonReentrant {
        Listing memory l = listings[creatureId];
        if (l.seller == address(0)) revert NotListed(creatureId);
        if (redeemed[creatureId]) revert AlreadyRedeemed(creatureId);
        if (msg.value != l.price) revert WrongPayment(msg.value, l.price);
        // Effects before the payout.
        delete listings[creatureId];
        _caught[creatureId].owner = msg.sender;
        emit Sold(creatureId, l.seller, msg.sender, l.price);
        (bool ok,) = l.seller.call{value: l.price}("");
        if (!ok) revert PaymentFailed();
    }

    // ---------------------------------------------------------------------
    // Recovery
    // ---------------------------------------------------------------------

    /// @notice Anyone can expire an attempt stuck in VERIFYING or ROLLING (CRE or VRF never answered).
    function expireAttempt(uint256 attemptId) external nonReentrant {
        Attempt storage a = _attempts[attemptId];
        if (
            (a.status != AttemptStatus.VERIFYING && a.status != AttemptStatus.ROLLING)
                || block.timestamp < a.createdAt + ATTEMPT_TIMEOUT
        ) revert NotExpirable(attemptId);
        if (a.vrfRequestId != 0) delete attemptOfRequest[a.vrfRequestId];
        _close(attemptId, AttemptStatus.EXPIRED);
        emit AttemptExpired(attemptId);
    }

    function _close(uint256 attemptId, AttemptStatus finalStatus) private {
        Attempt storage a = _attempts[attemptId];
        a.status = finalStatus;
        reservedCount[a.campaignId] -= 1;
        delete activeAttempt[a.player][a.campaignId];
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getAttempt(uint256 attemptId) external view returns (Attempt memory) {
        return _attempts[attemptId];
    }

    function getCaught(uint256 creatureId) external view returns (CaughtCreature memory) {
        return _caught[creatureId];
    }

    function getPlayerCatches(address player) external view returns (uint256[] memory) {
        return _playerCatches[player];
    }

    /// @notice Uncaught creatures not reserved by in-flight attempts.
    function available(uint256 campaignId) external view returns (uint256) {
        uint256 total = campaignManager.getCampaign(campaignId).totalCreatures;
        uint256 used = uint256(caughtCount[campaignId]) + reservedCount[campaignId];
        return used >= total ? 0 : total - used;
    }

    /// @notice Whether the map should show this campaign's spawn to the player.
    function canSpawnFor(address player, uint256 campaignId) external view returns (bool) {
        if (caughtInCampaign[player][campaignId] != 0) return false;
        CreatureCampaignManager.Campaign memory camp = campaignManager.getCampaign(campaignId);
        if (camp.status != CreatureCampaignManager.CampaignStatus.ALLOCATED) return false;
        if (camp.expiresAt != 0 && block.timestamp >= camp.expiresAt) return false;
        return uint256(caughtCount[campaignId]) < camp.totalCreatures;
    }

    /// @notice CS2 wear tiers: 0 FN <0.07, 1 MW <0.15, 2 FT <0.38, 3 WW <0.45, 4 BS.
    function wearTier(uint64 floatE18) public pure returns (uint8) {
        if (floatE18 < 0.07e18) return 0;
        if (floatE18 < 0.15e18) return 1;
        if (floatE18 < 0.38e18) return 2;
        if (floatE18 < 0.45e18) return 3;
        return 4;
    }
}
