// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";
import {CatchManager} from "../src/CatchManager.sol";
import {CatchReceiver} from "../src/CatchReceiver.sol";

/// The test contract is the forwarder, so it delivers CRE reports straight to CatchReceiver.onReport.
contract CatchFlowTest is Test {
    uint64 constant SELECTOR = 10344971235874465080; // Base Sepolia
    int32 constant LAT = 19_063_702;
    int32 constant LON = 72_867_181;

    VRFCoordinatorV2_5Mock vrf;
    CreatureCampaignManager campaigns;
    CatchManager catches;
    CatchReceiver receiver;

    address business = makeAddr("business");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 campaignId;

    function setUp() public {
        vrf = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4e15);
        uint256 subId = vrf.createSubscription();
        vrf.fundSubscription(subId, 1000 ether);

        campaigns = new CreatureCampaignManager(
            address(vrf), CreatureCampaignManager.VrfConfig(bytes32(uint256(1)), subId, 3, 2_500_000, false)
        );
        vrf.addConsumer(subId, address(campaigns));
        // 100% catch rate for every rarity, so a verified catch always lands.
        catches = new CatchManager(
            address(vrf),
            CatchManager.VrfConfig(bytes32(uint256(1)), subId, 3, 2_500_000, false),
            campaigns,
            [uint16(10_000), 10_000, 10_000, 10_000]
        );
        vrf.addConsumer(subId, address(catches));
        receiver = new CatchReceiver(address(this), catches, SELECTOR);
        catches.setCatchReceiver(address(receiver));

        CreatureCampaignManager.Reward[4] memory rewards;
        for (uint256 r = 0; r < 4; r++) rewards[r] = CreatureCampaignManager.Reward("e1.ciphertext", "10% off");
        vm.prank(business);
        campaignId = campaigns.createCampaign(
            CreatureCampaignManager.CampaignInput({
                businessName: "Reliance",
                swarmReference: "bd302c38bc1dc7e34646473c3d0a9d2d4444eb03bce35ccccd1e339e7b49ae1c",
                latitudeE6: LAT,
                longitudeE6: LON,
                expiresAt: 0,
                totalCreatures: 4,
                rarityCounts: [uint32(1), 1, 1, 1],
                rewards: rewards
            })
        );
        vrf.fulfillRandomWords(campaigns.getCampaign(campaignId).vrfRequestId, address(campaigns));
    }

    // --- helpers ---

    function _report(uint8 reportType, bytes memory payload) internal {
        receiver.onReport("", abi.encode(SELECTOR, reportType, payload));
    }

    function _verdict(uint256 attemptId, bool approved) internal {
        _report(1, abi.encode(attemptId, approved, uint256(0)));
    }

    function _request(address player) internal returns (uint256 attemptId) {
        vm.prank(player);
        attemptId = catches.requestCatch(campaignId, LAT, LON, "");
    }

    /// requestCatch -> approved CRE verdict -> VRF -> caught creature id.
    function _catch(address player) internal returns (uint256 creatureId) {
        uint256 attemptId = _request(player);
        _verdict(attemptId, true);
        vrf.fulfillRandomWords(catches.getAttempt(attemptId).vrfRequestId, address(catches));
        CatchManager.Attempt memory a = catches.getAttempt(attemptId);
        assertEq(uint8(a.status), uint8(CatchManager.AttemptStatus.CAUGHT));
        creatureId = a.creatureId;
    }

    function _redeem(address player, uint256 creatureId) internal {
        vm.prank(player);
        catches.requestRedeem(creatureId, bytes32(uint256(0xbeef)));
        _report(2, abi.encode(creatureId, true, bytes("sealed")));
    }

    // --- catching ---

    function test_FarAwayCatchRejected() public {
        uint256 attemptId = _request(alice);
        _verdict(attemptId, false); // CRE: haversine > CATCH_RADIUS_METERS
        CatchManager.Attempt memory a = catches.getAttempt(attemptId);
        assertEq(uint8(a.status), uint8(CatchManager.AttemptStatus.REJECTED));
        assertEq(a.vrfRequestId, 0, "no VRF for a rejected catch");
        assertEq(catches.caughtCount(campaignId), 0);
        assertEq(catches.reservedCount(campaignId), 0, "reservation released");
    }

    function test_NearbyCatchSucceeds() public {
        uint256 id = _catch(alice);
        assertEq(catches.getCaught(id).owner, alice);
        assertEq(id >> 32, campaignId);
    }

    function test_ReplayedCatchReportIgnored() public {
        uint256 attemptId = _request(alice);
        _verdict(attemptId, true);
        uint256 requestId = catches.getAttempt(attemptId).vrfRequestId;

        vm.recordLogs();
        _verdict(attemptId, true); // same report again: no revert, no second VRF request
        assertTrue(_emitted(keccak256("StaleCallbackIgnored(uint256)")));
        assertEq(catches.getAttempt(attemptId).vrfRequestId, requestId);
    }

    function test_WrongChainSelectorRejected() public {
        uint256 attemptId = _request(alice);
        vm.expectRevert(abi.encodeWithSelector(CatchReceiver.UnexpectedChainSelector.selector, uint64(1), SELECTOR));
        receiver.onReport("", abi.encode(uint64(1), uint8(1), abi.encode(attemptId, true, uint256(0))));
    }

    function test_OnlyForwarderCanReport() public {
        vm.prank(alice);
        vm.expectRevert();
        receiver.onReport("", abi.encode(SELECTOR, uint8(1), abi.encode(uint256(1), true, uint256(0))));
    }

    // --- redeem ---

    function test_RedeemByNonOwnerRejected() public {
        uint256 id = _catch(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.NotOwner.selector, id));
        catches.requestRedeem(id, bytes32(uint256(1)));
    }

    function test_RedeemOnlyOnce() public {
        uint256 id = _catch(alice);
        vm.recordLogs();
        _redeem(alice, id);
        assertTrue(catches.redeemed(id));
        assertTrue(_emitted(keccak256("CodeRevealed(uint256,bytes)")));
        assertEq(catches.sealedCodes(id), bytes("sealed"));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.AlreadyRedeemed.selector, id));
        catches.requestRedeem(id, bytes32(uint256(1)));

        // A replayed redeem report is consumed without reverting or revealing again.
        vm.recordLogs();
        _report(2, abi.encode(id, true, bytes("sealed")));
        assertTrue(_emitted(keccak256("StaleCallbackIgnored(uint256)")));
        assertFalse(_emitted(keccak256("CodeRevealed(uint256,bytes)")));
    }

    function test_RejectedRedeemCanRetry() public {
        uint256 id = _catch(alice);
        vm.prank(alice);
        catches.requestRedeem(id, bytes32(uint256(1)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.RedeemPending.selector, id));
        catches.requestRedeem(id, bytes32(uint256(1)));

        _report(2, abi.encode(id, false, bytes("")));
        assertFalse(catches.redeemed(id));
        _redeem(alice, id);
        assertTrue(catches.redeemed(id));
    }

    // --- trading ---

    function test_CannotListAfterRedeem() public {
        uint256 id = _catch(alice);
        _redeem(alice, id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.AlreadyRedeemed.selector, id));
        catches.list(id, 1 ether);
    }

    function test_BuyPaysSellerAndMovesOwner() public {
        uint256 id = _catch(alice);
        vm.prank(alice);
        catches.list(id, 1 ether);

        vm.deal(bob, 2 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.WrongPayment.selector, 0.5 ether, 1 ether));
        catches.buy{value: 0.5 ether}(id);

        vm.prank(bob);
        catches.buy{value: 1 ether}(id);
        assertEq(catches.getCaught(id).owner, bob);
        assertEq(alice.balance, 1 ether);
        (address seller,) = catches.listings(id);
        assertEq(seller, address(0));

        // The new owner can redeem; the seller can't.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.NotOwner.selector, id));
        catches.requestRedeem(id, bytes32(uint256(1)));
        _redeem(bob, id);
        assertTrue(catches.redeemed(id));
    }

    function test_NoListingWhileRedeemPending() public {
        uint256 id = _catch(alice);
        vm.prank(alice);
        catches.requestRedeem(id, bytes32(uint256(1)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CatchManager.RedeemPending.selector, id));
        catches.list(id, 1 ether);
    }

    function test_LateRedeemVerdictAfterSaleIgnored() public {
        uint256 id = _catch(alice);
        vm.prank(alice);
        catches.requestRedeem(id, bytes32(uint256(1)));
        // CRE never answers; after the timeout Alice lists and Bob buys.
        vm.warp(block.timestamp + catches.REDEEM_TIMEOUT());
        vm.prank(alice);
        catches.list(id, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        catches.buy{value: 1 ether}(id);

        // The old verdict (sealed to Alice's key) arrives late: ignored, Bob's creature stays unredeemed.
        _report(2, abi.encode(id, true, bytes("sealed-for-alice")));
        assertFalse(catches.redeemed(id));
    }

    function _emitted(bytes32 topic0) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0) return true;
        }
        return false;
    }
}
