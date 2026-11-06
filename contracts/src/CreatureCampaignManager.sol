// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {RarityShuffle} from "./RarityShuffle.sol";

/// @title CreatureCampaignManager
/// @notice Businesses create AR creature campaigns with an exact rarity distribution.
///         Chainlink VRF v2.5 supplies randomness; an on-chain Fisher–Yates shuffle decides the
///         position (and therefore the Creature ID) of every rarity while preserving the distribution.
/// @dev Creature IDs are globally unique: creatureId = (campaignId << 32) | index.
///      Allocation happens entirely on-chain inside the VRF callback and does not depend on any
///      frontend, backend, Arkiv or Swarm being available.
contract CreatureCampaignManager is VRFConsumerBaseV2Plus {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Rarity {
        COMMON,
        RARE,
        EPIC,
        LEGENDARY
    }

    enum CampaignStatus {
        NONE,
        RANDOMNESS_REQUESTED,
        ALLOCATED,
        CANCELLED
    }

    struct Reward {
        string code;
        string description;
    }

    struct CampaignInput {
        string businessName;
        string swarmReference;
        int32 latitudeE6;
        int32 longitudeE6;
        uint64 expiresAt; // unix seconds, 0 = never expires
        uint32 totalCreatures;
        uint32[4] rarityCounts; // COMMON, RARE, EPIC, LEGENDARY
        Reward[4] rewards; // indexed by Rarity
    }

    struct Campaign {
        address business;
        CampaignStatus status;
        int32 latitudeE6;
        int32 longitudeE6;
        uint64 expiresAt;
        uint64 createdAt;
        uint64 requestedAt;
        uint64 allocatedAt;
        uint32 totalCreatures;
        uint32[4] rarityCounts;
        uint256 vrfRequestId;
        uint256 randomWord;
        string businessName;
        string swarmReference;
    }

    struct Creature {
        uint256 creatureId;
        uint256 campaignId;
        uint32 index;
        address business;
        string businessName;
        Rarity rarity;
        string discountCode;
        string discountDescription;
        int32 latitudeE6;
        int32 longitudeE6;
        uint64 expiresAt;
        string swarmReference;
        uint64 createdAt;
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

    uint32 public constant MAX_CREATURES = 500;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_CODE_BYTES = 64;
    uint256 public constant MAX_DESCRIPTION_BYTES = 128; // = Arkiv MAX_STRING_BYTES
    uint64 public constant RETRY_TIMEOUT = 1 hours;
    int32 internal constant MAX_LAT_E6 = 90_000_000;
    int32 internal constant MAX_LON_E6 = 180_000_000;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    VrfConfig public vrfConfig;
    uint256 public campaignCount;

    mapping(uint256 campaignId => Campaign) private _campaigns;
    mapping(uint256 campaignId => Reward[4]) private _rewards;
    mapping(uint256 campaignId => bytes) private _rarities; // 1 byte (Rarity) per creature, shuffled
    mapping(uint256 requestId => uint256 campaignId) public campaignOfRequest;
    mapping(address business => uint256[]) private _businessCampaigns;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed business,
        string businessName,
        uint32 totalCreatures,
        uint32[4] rarityCounts,
        string swarmReference,
        int32 latitudeE6,
        int32 longitudeE6,
        uint64 expiresAt
    );
    event RandomnessRequested(uint256 indexed campaignId, uint256 indexed requestId);
    event RandomnessFulfilled(uint256 indexed campaignId, uint256 indexed requestId, uint256 randomWord);
    event RarityAllocated(uint256 indexed campaignId, uint256 firstCreatureId, uint32 totalCreatures);
    event FulfillmentIgnored(uint256 indexed requestId, uint256 indexed campaignId);
    event CampaignCancelled(uint256 indexed campaignId);
    event VrfConfigUpdated(
        bytes32 keyHash, uint256 subscriptionId, uint16 requestConfirmations, uint32 callbackGasLimit, bool nativePayment
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error Reentrancy();
    error NotCampaignBusiness(uint256 campaignId, address caller);
    error CampaignNotFound(uint256 campaignId);
    error InvalidStatus(uint256 campaignId, CampaignStatus status);
    error InvalidTotal(uint32 total);
    error DistributionMismatch(uint256 sum, uint32 total);
    error InvalidBusinessName();
    error InvalidSwarmReference();
    error InvalidReward(uint8 rarity);
    error InvalidCoordinates(int32 latitudeE6, int32 longitudeE6);
    error ExpirationInPast(uint64 expiresAt);
    error RetryTooEarly(uint64 availableAt);
    error InvalidVrfConfig();
    error CreatureNotFound(uint256 creatureId);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyBusiness(uint256 campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status == CampaignStatus.NONE) revert CampaignNotFound(campaignId);
        if (c.business != msg.sender) revert NotCampaignBusiness(campaignId, msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor / admin
    // ---------------------------------------------------------------------

    constructor(address vrfCoordinator, VrfConfig memory config) VRFConsumerBaseV2Plus(vrfCoordinator) {
        _setVrfConfig(config);
    }

    /// @notice Platform owner updates VRF parameters (e.g. after moving to another subscription).
    function setVrfConfig(VrfConfig calldata config) external onlyOwner {
        _setVrfConfig(config);
    }

    function _setVrfConfig(VrfConfig memory config) internal {
        if (config.keyHash == bytes32(0) || config.subscriptionId == 0 || config.callbackGasLimit == 0) {
            revert InvalidVrfConfig();
        }
        vrfConfig = config;
        emit VrfConfigUpdated(
            config.keyHash,
            config.subscriptionId,
            config.requestConfirmations,
            config.callbackGasLimit,
            config.nativePayment
        );
    }

    // ---------------------------------------------------------------------
    // Business actions
    // ---------------------------------------------------------------------

    /// @notice Creates a campaign and requests VRF randomness for its rarity allocation.
    /// @return campaignId The new campaign ID.
    function createCampaign(CampaignInput calldata input) external nonReentrant returns (uint256 campaignId) {
        _validate(input);

        campaignId = ++campaignCount;
        Campaign storage c = _campaigns[campaignId];
        c.business = msg.sender;
        c.status = CampaignStatus.RANDOMNESS_REQUESTED;
        c.latitudeE6 = input.latitudeE6;
        c.longitudeE6 = input.longitudeE6;
        c.expiresAt = input.expiresAt;
        c.createdAt = uint64(block.timestamp);
        c.totalCreatures = input.totalCreatures;
        c.rarityCounts = input.rarityCounts;
        c.businessName = input.businessName;
        c.swarmReference = input.swarmReference;
        for (uint8 r = 0; r < 4; r++) {
            _rewards[campaignId][r] = input.rewards[r];
        }
        _businessCampaigns[msg.sender].push(campaignId);

        emit CampaignCreated(
            campaignId,
            msg.sender,
            input.businessName,
            input.totalCreatures,
            input.rarityCounts,
            input.swarmReference,
            input.latitudeE6,
            input.longitudeE6,
            input.expiresAt
        );

        _requestRandomness(campaignId);
    }

    /// @notice If VRF has not answered within RETRY_TIMEOUT (e.g. the subscription was underfunded),
    ///         the business can issue a fresh request. The stale request is invalidated so a late
    ///         fulfillment of it is ignored (no double allocation).
    function retryRandomness(uint256 campaignId) external nonReentrant onlyBusiness(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status != CampaignStatus.RANDOMNESS_REQUESTED) revert InvalidStatus(campaignId, c.status);
        uint64 availableAt = c.requestedAt + RETRY_TIMEOUT;
        if (block.timestamp < availableAt) revert RetryTooEarly(availableAt);
        delete campaignOfRequest[c.vrfRequestId];
        _requestRandomness(campaignId);
    }

    /// @notice A business may cancel its campaign before rarities are allocated.
    function cancelCampaign(uint256 campaignId) external nonReentrant onlyBusiness(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status != CampaignStatus.RANDOMNESS_REQUESTED) revert InvalidStatus(campaignId, c.status);
        c.status = CampaignStatus.CANCELLED;
        delete campaignOfRequest[c.vrfRequestId];
        emit CampaignCancelled(campaignId);
    }

    // ---------------------------------------------------------------------
    // VRF
    // ---------------------------------------------------------------------

    function _requestRandomness(uint256 campaignId) internal {
        VrfConfig memory cfg = vrfConfig;
        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: cfg.keyHash,
                subId: cfg.subscriptionId,
                requestConfirmations: cfg.requestConfirmations,
                callbackGasLimit: cfg.callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: cfg.nativePayment}))
            })
        );
        Campaign storage c = _campaigns[campaignId];
        c.vrfRequestId = requestId;
        c.requestedAt = uint64(block.timestamp);
        campaignOfRequest[requestId] = campaignId;
        emit RandomnessRequested(campaignId, requestId);
    }

    /// @dev Called by VRFConsumerBaseV2Plus.rawFulfillRandomWords, which already enforces
    ///      msg.sender == coordinator. Per Chainlink guidance this must not revert, so unknown,
    ///      stale or duplicate fulfillments are ignored with an event instead.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 campaignId = campaignOfRequest[requestId];
        Campaign storage c = _campaigns[campaignId];
        if (
            campaignId == 0 || c.status != CampaignStatus.RANDOMNESS_REQUESTED || c.vrfRequestId != requestId
                || randomWords.length == 0
        ) {
            emit FulfillmentIgnored(requestId, campaignId);
            return;
        }

        // Effects first: mark the request consumed so it can never be applied twice.
        delete campaignOfRequest[requestId];
        uint256 word = randomWords[0];
        c.randomWord = word;
        c.status = CampaignStatus.ALLOCATED;
        c.allocatedAt = uint64(block.timestamp);
        emit RandomnessFulfilled(campaignId, requestId, word);

        uint8[] memory arr = RarityShuffle.buildRarityArray(c.rarityCounts);
        // Domain-separate the seed per campaign.
        RarityShuffle.shuffle(arr, uint256(keccak256(abi.encode(word, campaignId))));
        _rarities[campaignId] = RarityShuffle.pack(arr);

        emit RarityAllocated(campaignId, creatureIdOf(campaignId, 0), c.totalCreatures);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function creatureIdOf(uint256 campaignId, uint32 index) public pure returns (uint256) {
        return (campaignId << 32) | uint256(index);
    }

    function decodeCreatureId(uint256 creatureId) public pure returns (uint256 campaignId, uint32 index) {
        return (creatureId >> 32, uint32(creatureId));
    }

    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        Campaign memory c = _campaigns[campaignId];
        if (c.status == CampaignStatus.NONE) revert CampaignNotFound(campaignId);
        return c;
    }

    function getRewards(uint256 campaignId) external view returns (Reward[4] memory) {
        if (_campaigns[campaignId].status == CampaignStatus.NONE) revert CampaignNotFound(campaignId);
        return _rewards[campaignId];
    }

    function getBusinessCampaigns(address business) external view returns (uint256[] memory) {
        return _businessCampaigns[business];
    }

    /// @notice Shuffled rarity array (empty until allocated).
    function getRarities(uint256 campaignId) external view returns (Rarity[] memory out) {
        bytes storage packed = _rarities[campaignId];
        out = new Rarity[](packed.length);
        for (uint256 i = 0; i < packed.length; i++) {
            out[i] = Rarity(uint8(packed[i]));
        }
    }

    function getCreature(uint256 creatureId) public view returns (Creature memory) {
        (uint256 campaignId, uint32 index) = decodeCreatureId(creatureId);
        Campaign storage c = _campaigns[campaignId];
        bytes storage packed = _rarities[campaignId];
        if (c.status != CampaignStatus.ALLOCATED || index >= packed.length) revert CreatureNotFound(creatureId);
        Rarity rarity = Rarity(uint8(packed[index]));
        Reward storage reward = _rewards[campaignId][uint8(rarity)];
        return Creature({
            creatureId: creatureId,
            campaignId: campaignId,
            index: index,
            business: c.business,
            businessName: c.businessName,
            rarity: rarity,
            discountCode: reward.code,
            discountDescription: reward.description,
            latitudeE6: c.latitudeE6,
            longitudeE6: c.longitudeE6,
            expiresAt: c.expiresAt,
            swarmReference: c.swarmReference,
            createdAt: c.allocatedAt
        });
    }

    /// @notice Paginated creature records for an allocated campaign.
    function getCreatures(uint256 campaignId, uint32 offset, uint32 limit) external view returns (Creature[] memory out) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status != CampaignStatus.ALLOCATED) revert InvalidStatus(campaignId, c.status);
        uint256 total = c.totalCreatures;
        if (offset >= total) return new Creature[](0);
        uint256 end = uint256(offset) + limit > total ? total : uint256(offset) + limit;
        out = new Creature[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = getCreature(creatureIdOf(campaignId, uint32(i)));
        }
    }

    // ---------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------

    function _validate(CampaignInput calldata input) internal view {
        uint32 total = input.totalCreatures;
        if (total == 0 || total > MAX_CREATURES) revert InvalidTotal(total);
        uint256 sum =
            uint256(input.rarityCounts[0]) + input.rarityCounts[1] + input.rarityCounts[2] + input.rarityCounts[3];
        if (sum != total) revert DistributionMismatch(sum, total);

        uint256 nameLen = bytes(input.businessName).length;
        if (nameLen == 0 || nameLen > MAX_NAME_BYTES) revert InvalidBusinessName();
        if (!_isSwarmReference(input.swarmReference)) revert InvalidSwarmReference();

        if (
            input.latitudeE6 < -MAX_LAT_E6 || input.latitudeE6 > MAX_LAT_E6 || input.longitudeE6 < -MAX_LON_E6
                || input.longitudeE6 > MAX_LON_E6
        ) revert InvalidCoordinates(input.latitudeE6, input.longitudeE6);

        if (input.expiresAt != 0 && input.expiresAt <= block.timestamp) revert ExpirationInPast(input.expiresAt);

        for (uint8 r = 0; r < 4; r++) {
            uint256 codeLen = bytes(input.rewards[r].code).length;
            uint256 descLen = bytes(input.rewards[r].description).length;
            if (codeLen > MAX_CODE_BYTES || descLen > MAX_DESCRIPTION_BYTES) revert InvalidReward(r);
            // A rarity that will actually be minted must carry a reward.
            if (input.rarityCounts[r] > 0 && (codeLen == 0 || descLen == 0)) revert InvalidReward(r);
        }
    }

    /// @dev Swarm references are 32-byte (64 hex chars) or, for encrypted content, 64-byte (128 hex chars).
    function _isSwarmReference(string calldata ref) internal pure returns (bool) {
        bytes calldata b = bytes(ref);
        if (b.length != 64 && b.length != 128) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool ok = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
            if (!ok) return false;
        }
        return true;
    }
}
