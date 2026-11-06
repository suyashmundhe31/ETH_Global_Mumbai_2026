// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";

contract CreatureCampaignManagerTest is Test {
    VRFCoordinatorV2_5Mock internal coordinator;
    CreatureCampaignManager internal manager;
    uint256 internal subId;

    address internal business = makeAddr("business");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant KEY_HASH = keccak256("test-key-hash");
    string internal constant SWARM_REF = "22cbb9cedca08ca8d50b0319a32016174ceb8fbaa452ca5f0a77b804109baa00";
    uint32 internal constant CALLBACK_GAS = 2_500_000;

    function setUp() public {
        vm.warp(1_750_000_000);
        // Values as used in Chainlink's local-testing guide: 0.1 LINK base fee, 1 gwei gas price, 0.004 ETH/LINK.
        coordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4e15);
        subId = coordinator.createSubscription();
        coordinator.fundSubscription(subId, 1000 ether);

        manager = new CreatureCampaignManager(
            address(coordinator),
            CreatureCampaignManager.VrfConfig({
                keyHash: KEY_HASH,
                subscriptionId: subId,
                requestConfirmations: 3,
                callbackGasLimit: CALLBACK_GAS,
                nativePayment: false
            })
        );
        coordinator.addConsumer(subId, address(manager));
    }

    // ------------------------------------------------------------------ helpers

    function _input(uint32 c, uint32 r, uint32 e, uint32 l)
        internal
        view
        returns (CreatureCampaignManager.CampaignInput memory input)
    {
        input.businessName = "Chai Point";
        input.swarmReference = SWARM_REF;
        input.latitudeE6 = 19_076_090;
        input.longitudeE6 = 72_877_426;
        input.expiresAt = uint64(block.timestamp + 30 days);
        input.totalCreatures = c + r + e + l;
        input.rarityCounts = [c, r, e, l];
        input.rewards[0] = CreatureCampaignManager.Reward("COMMON10", "10% off any drink");
        input.rewards[1] = CreatureCampaignManager.Reward("RARE25", "25% off any drink");
        input.rewards[2] = CreatureCampaignManager.Reward("EPIC50", "50% off your order");
        input.rewards[3] = CreatureCampaignManager.Reward("LEGEND100", "Free meal for two");
    }

    function _create(CreatureCampaignManager.CampaignInput memory input) internal returns (uint256 id) {
        vm.prank(business);
        id = manager.createCampaign(input);
    }

    function _fulfillDirect(uint256 requestId, uint256 word) internal {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(address(coordinator));
        manager.rawFulfillRandomWords(requestId, words);
    }

    function _assertDistribution(uint256 id, uint32[4] memory expected) internal view {
        CreatureCampaignManager.Rarity[] memory rarities = manager.getRarities(id);
        uint32[4] memory seen;
        for (uint256 i = 0; i < rarities.length; i++) {
            seen[uint8(rarities[i])]++;
        }
        for (uint256 r = 0; r < 4; r++) {
            assertEq(seen[r], expected[r], "rarity count changed");
        }
        assertEq(rarities.length, expected[0] + expected[1] + expected[2] + expected[3]);
    }

    // ------------------------------------------------------------------ creation

    function test_CreateCampaign_StoresConfigAndRequestsVrf() public {
        CreatureCampaignManager.CampaignInput memory input = _input(6, 2, 1, 1);

        vm.expectEmit(true, true, false, false, address(manager));
        emit CreatureCampaignManager.CampaignCreated(
            1, business, "", 0, [uint32(0), 0, 0, 0], "", 0, 0, 0
        );
        vm.expectEmit(true, true, false, false, address(manager));
        emit CreatureCampaignManager.RandomnessRequested(1, 1);
        uint256 id = _create(input);

        assertEq(id, 1);
        CreatureCampaignManager.Campaign memory c = manager.getCampaign(id);
        assertEq(c.business, business);
        assertEq(uint8(c.status), uint8(CreatureCampaignManager.CampaignStatus.RANDOMNESS_REQUESTED));
        assertEq(c.totalCreatures, 10);
        assertEq(c.swarmReference, SWARM_REF);
        assertEq(c.vrfRequestId, 1);
        assertEq(manager.campaignOfRequest(1), id);
        assertEq(manager.getRarities(id).length, 0, "no allocation before VRF");
        assertEq(manager.getBusinessCampaigns(business).length, 1);
    }

    function test_CampaignIdsAreUnique() public {
        uint256 a = _create(_input(1, 0, 0, 0));
        uint256 b = _create(_input(1, 0, 0, 0));
        assertTrue(a != b);
        assertEq(manager.campaignCount(), 2);
    }

    // ------------------------------------------------------------------ allocation

    function test_FulfillViaMock_AllocatesExactDistribution() public {
        uint256 id = _create(_input(6, 2, 1, 1));

        vm.recordLogs();
        coordinator.fulfillRandomWords(1, address(manager));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool sawFulfilled;
        bool sawAllocated;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == CreatureCampaignManager.RandomnessFulfilled.selector) sawFulfilled = true;
            if (logs[i].topics[0] == CreatureCampaignManager.RarityAllocated.selector) sawAllocated = true;
        }
        assertTrue(sawFulfilled && sawAllocated, "missing events");

        CreatureCampaignManager.Campaign memory c = manager.getCampaign(id);
        assertEq(uint8(c.status), uint8(CreatureCampaignManager.CampaignStatus.ALLOCATED));
        assertTrue(c.randomWord != 0);
        _assertDistribution(id, [uint32(6), 2, 1, 1]);
    }

    function test_CreaturesCarryRewardOfTheirRarity() public {
        uint256 id = _create(_input(6, 2, 1, 1));
        coordinator.fulfillRandomWords(1, address(manager));

        CreatureCampaignManager.Creature[] memory creatures = manager.getCreatures(id, 0, 100);
        CreatureCampaignManager.Reward[4] memory rewards = manager.getRewards(id);
        assertEq(creatures.length, 10);
        for (uint256 i = 0; i < creatures.length; i++) {
            CreatureCampaignManager.Creature memory cr = creatures[i];
            assertEq(cr.creatureId, manager.creatureIdOf(id, uint32(i)));
            assertEq(cr.campaignId, id);
            assertEq(cr.business, business);
            assertEq(cr.discountCode, rewards[uint8(cr.rarity)].code);
            assertEq(cr.discountDescription, rewards[uint8(cr.rarity)].description);
            assertEq(cr.swarmReference, SWARM_REF);
            assertEq(cr.createdAt, block.timestamp);
            for (uint256 j = 0; j < i; j++) {
                assertTrue(creatures[j].creatureId != cr.creatureId, "duplicate creature id");
            }
            (uint256 decodedCampaign, uint32 decodedIndex) = manager.decodeCreatureId(cr.creatureId);
            assertEq(decodedCampaign, id);
            assertEq(decodedIndex, i);
        }
    }

    function test_CreatureIdsUniqueAcrossCampaigns() public {
        uint256 a = _create(_input(3, 0, 0, 0));
        uint256 b = _create(_input(3, 0, 0, 0));
        coordinator.fulfillRandomWords(1, address(manager));
        coordinator.fulfillRandomWords(2, address(manager));
        for (uint32 i = 0; i < 3; i++) {
            for (uint32 j = 0; j < 3; j++) {
                assertTrue(manager.creatureIdOf(a, i) != manager.creatureIdOf(b, j));
            }
            assertEq(manager.getCreature(manager.creatureIdOf(b, i)).campaignId, b);
        }
    }

    function test_DifferentRandomnessGivesDifferentOrder() public {
        uint256 a = _create(_input(10, 5, 3, 2));
        uint256 b = _create(_input(10, 5, 3, 2));
        _fulfillDirect(1, 111);
        _fulfillDirect(2, 222);
        assertTrue(
            keccak256(abi.encode(manager.getRarities(a))) != keccak256(abi.encode(manager.getRarities(b))),
            "shuffle ignored randomness"
        );
    }

    function testFuzz_DistributionAlwaysPreserved(uint32 c, uint32 r, uint32 e, uint32 l, uint256 word) public {
        c = uint32(bound(c, 0, 200));
        r = uint32(bound(r, 0, 150));
        e = uint32(bound(e, 0, 100));
        l = uint32(bound(l, 0, 50));
        vm.assume(c + r + e + l > 0);
        uint256 id = _create(_input(c, r, e, l));
        _fulfillDirect(manager.getCampaign(id).vrfRequestId, word);
        _assertDistribution(id, [c, r, e, l]);
    }

    function test_MaxCampaignFitsInCallbackGas() public {
        uint256 id = _create(_input(400, 70, 25, 5)); // MAX_CREATURES = 500
        uint256 before = gasleft();
        coordinator.fulfillRandomWords(1, address(manager));
        uint256 used = before - gasleft();
        emit log_named_uint("gas used fulfilling 500 creatures (incl. mock overhead)", used);
        assertEq(uint8(manager.getCampaign(id).status), uint8(CreatureCampaignManager.CampaignStatus.ALLOCATED));
        assertLt(used, CALLBACK_GAS, "callback too expensive");
        _assertDistribution(id, [uint32(400), 70, 25, 5]);
    }

    // ------------------------------------------------------------------ VRF safety

    function test_OnlyCoordinatorCanFulfill() public {
        _create(_input(1, 1, 0, 0));
        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                VRFConsumerBaseV2Plus.OnlyCoordinatorCanFulfill.selector, attacker, address(coordinator)
            )
        );
        manager.rawFulfillRandomWords(1, words);
    }

    function test_DuplicateFulfillmentIgnored() public {
        uint256 id = _create(_input(5, 3, 1, 1));
        _fulfillDirect(1, 7);
        CreatureCampaignManager.Rarity[] memory first = manager.getRarities(id);
        uint256 firstWord = manager.getCampaign(id).randomWord;

        vm.expectEmit(true, true, false, false, address(manager));
        emit CreatureCampaignManager.FulfillmentIgnored(1, 0);
        _fulfillDirect(1, 999); // must not revert, must not change anything

        assertEq(manager.getCampaign(id).randomWord, firstWord);
        assertEq(keccak256(abi.encode(manager.getRarities(id))), keccak256(abi.encode(first)));
    }

    function test_UnknownRequestIgnoredWithoutRevert() public {
        _fulfillDirect(12345, 1);
    }

    // ------------------------------------------------------------------ access control & lifecycle

    function test_OnlyBusinessCanCancel() public {
        uint256 id = _create(_input(1, 0, 0, 0));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.NotCampaignBusiness.selector, id, attacker));
        manager.cancelCampaign(id);
    }

    function test_CancelledCampaignIgnoresFulfillment() public {
        uint256 id = _create(_input(2, 1, 0, 0));
        vm.prank(business);
        manager.cancelCampaign(id);
        _fulfillDirect(1, 5);
        assertEq(uint8(manager.getCampaign(id).status), uint8(CreatureCampaignManager.CampaignStatus.CANCELLED));
        assertEq(manager.getRarities(id).length, 0);
    }

    function test_CannotCancelAfterAllocation() public {
        uint256 id = _create(_input(2, 1, 0, 0));
        _fulfillDirect(1, 5);
        vm.prank(business);
        vm.expectRevert(
            abi.encodeWithSelector(
                CreatureCampaignManager.InvalidStatus.selector, id, CreatureCampaignManager.CampaignStatus.ALLOCATED
            )
        );
        manager.cancelCampaign(id);
    }

    function test_RetryRandomness_TimeoutAndStaleRequestIgnored() public {
        uint256 id = _create(_input(4, 2, 1, 1));
        vm.prank(business);
        vm.expectRevert(
            abi.encodeWithSelector(CreatureCampaignManager.RetryTooEarly.selector, uint64(block.timestamp + 1 hours))
        );
        manager.retryRandomness(id);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.NotCampaignBusiness.selector, id, attacker));
        manager.retryRandomness(id);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(business);
        manager.retryRandomness(id);
        uint256 newRequest = manager.getCampaign(id).vrfRequestId;
        assertEq(newRequest, 2);
        assertEq(manager.campaignOfRequest(1), 0);

        _fulfillDirect(1, 77); // stale -> ignored
        assertEq(uint8(manager.getCampaign(id).status), uint8(CreatureCampaignManager.CampaignStatus.RANDOMNESS_REQUESTED));

        _fulfillDirect(newRequest, 78);
        assertEq(uint8(manager.getCampaign(id).status), uint8(CreatureCampaignManager.CampaignStatus.ALLOCATED));
        _assertDistribution(id, [uint32(4), 2, 1, 1]);
    }

    function test_OnlyOwnerCanSetVrfConfig() public {
        CreatureCampaignManager.VrfConfig memory cfg = CreatureCampaignManager.VrfConfig({
            keyHash: KEY_HASH,
            subscriptionId: subId,
            requestConfirmations: 5,
            callbackGasLimit: 1_000_000,
            nativePayment: true
        });
        vm.prank(attacker);
        vm.expectRevert(bytes("Only callable by owner"));
        manager.setVrfConfig(cfg);

        manager.setVrfConfig(cfg);
        (,, uint16 confirmations,, bool native) = manager.vrfConfig();
        assertEq(confirmations, 5);
        assertTrue(native);
    }

    // ------------------------------------------------------------------ validation

    function test_RevertWhen_TotalZero() public {
        CreatureCampaignManager.CampaignInput memory input = _input(0, 0, 0, 0);
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.InvalidTotal.selector, uint32(0)));
        manager.createCampaign(input);
    }

    function test_RevertWhen_TotalAboveMax() public {
        CreatureCampaignManager.CampaignInput memory input = _input(501, 0, 0, 0);
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.InvalidTotal.selector, uint32(501)));
        manager.createCampaign(input);
    }

    function test_RevertWhen_DistributionMismatch() public {
        CreatureCampaignManager.CampaignInput memory input = _input(6, 2, 1, 1);
        input.totalCreatures = 11;
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.DistributionMismatch.selector, 10, uint32(11)));
        manager.createCampaign(input);
    }

    function test_RevertWhen_BadSwarmReference() public {
        CreatureCampaignManager.CampaignInput memory input = _input(1, 0, 0, 0);
        input.swarmReference = "not-a-reference";
        vm.prank(business);
        vm.expectRevert(CreatureCampaignManager.InvalidSwarmReference.selector);
        manager.createCampaign(input);
    }

    function test_RevertWhen_BadCoordinates() public {
        CreatureCampaignManager.CampaignInput memory input = _input(1, 0, 0, 0);
        input.latitudeE6 = 90_000_001;
        vm.prank(business);
        vm.expectRevert(
            abi.encodeWithSelector(
                CreatureCampaignManager.InvalidCoordinates.selector, int32(90_000_001), int32(72_877_426)
            )
        );
        manager.createCampaign(input);
    }

    function test_RevertWhen_ExpirationInPast() public {
        CreatureCampaignManager.CampaignInput memory input = _input(1, 0, 0, 0);
        input.expiresAt = uint64(block.timestamp);
        vm.prank(business);
        vm.expectRevert(
            abi.encodeWithSelector(CreatureCampaignManager.ExpirationInPast.selector, uint64(block.timestamp))
        );
        manager.createCampaign(input);
    }

    function test_NoExpirationAllowed() public {
        CreatureCampaignManager.CampaignInput memory input = _input(1, 0, 0, 0);
        input.expiresAt = 0;
        uint256 id = _create(input);
        assertEq(manager.getCampaign(id).expiresAt, 0);
    }

    function test_RevertWhen_MissingRewardForUsedRarity() public {
        CreatureCampaignManager.CampaignInput memory input = _input(1, 0, 0, 1);
        input.rewards[3].code = "";
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.InvalidReward.selector, uint8(3)));
        manager.createCampaign(input);
    }

    function test_EmptyRewardAllowedForUnusedRarity() public {
        CreatureCampaignManager.CampaignInput memory input = _input(1, 0, 0, 0);
        input.rewards[3] = CreatureCampaignManager.Reward("", "");
        _create(input);
    }

    function test_GetCreatureRevertsBeforeAllocation() public {
        uint256 id = _create(_input(1, 0, 0, 0));
        uint256 creatureId = manager.creatureIdOf(id, 0);
        vm.expectRevert(abi.encodeWithSelector(CreatureCampaignManager.CreatureNotFound.selector, creatureId));
        manager.getCreature(creatureId);
    }

    function test_GetCreaturesPagination() public {
        uint256 id = _create(_input(7, 2, 1, 0));
        _fulfillDirect(1, 3);
        assertEq(manager.getCreatures(id, 0, 4).length, 4);
        assertEq(manager.getCreatures(id, 8, 4).length, 2);
        assertEq(manager.getCreatures(id, 10, 4).length, 0);
        assertEq(manager.getCreatures(id, 0, type(uint32).max).length, 10);
    }
}
