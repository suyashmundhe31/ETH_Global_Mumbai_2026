// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";
import {CreatureMarket} from "../src/CreatureMarket.sol";

/// Seller that refuses ETH, or tries to re-enter buy() when paid.
contract HostileSeller {
    CreatureMarket internal immutable market;
    bool internal reenter;

    constructor(CreatureMarket m, bool reenter_) {
        market = m;
        reenter = reenter_;
    }

    function claim(uint256 id, int32 lat, int32 lon, uint256 deadline, bytes calldata sig) external {
        market.claim(id, lat, lon, deadline, sig);
    }

    function list(uint256 id, uint256 price, uint256 deadline, bytes calldata sig) external {
        market.list(id, price, deadline, sig);
    }

    receive() external payable {
        if (!reenter) revert("no ETH");
        market.buy{value: msg.value}(0);
    }
}

contract CreatureMarketTest is Test {
    VRFCoordinatorV2_5Mock internal coordinator;
    CreatureCampaignManager internal manager;
    CreatureMarket internal market;

    address internal business = makeAddr("business");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    uint256 internal humanPk = 0xA11CE;
    uint256 internal settlerPk = 0x5E77;
    uint256 internal strangerPk = 0xBAD;

    string internal constant SWARM_REF = "22cbb9cedca08ca8d50b0319a32016174ceb8fbaa452ca5f0a77b804109baa00";
    int32 internal constant LAT = 19_076_090;
    int32 internal constant LON = 72_877_426;
    uint256 internal campaignId;

    function setUp() public {
        vm.warp(1_750_000_000);
        coordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4e15);
        uint256 subId = coordinator.createSubscription();
        coordinator.fundSubscription(subId, 1000 ether);
        manager = new CreatureCampaignManager(
            address(coordinator),
            CreatureCampaignManager.VrfConfig({
                keyHash: keccak256("k"),
                subscriptionId: subId,
                requestConfirmations: 3,
                callbackGasLimit: 2_500_000,
                nativePayment: false
            })
        );
        coordinator.addConsumer(subId, address(manager));
        market = new CreatureMarket(manager, vm.addr(humanPk), vm.addr(settlerPk), address(this));
        campaignId = _campaign(4, uint64(block.timestamp + 30 days));
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _campaign(uint32 total, uint64 expiresAt) internal returns (uint256 id) {
        CreatureCampaignManager.CampaignInput memory input;
        input.businessName = "Chai Point";
        input.swarmReference = SWARM_REF;
        input.latitudeE6 = LAT;
        input.longitudeE6 = LON;
        input.expiresAt = expiresAt;
        input.totalCreatures = total;
        input.rarityCounts = [total - 1, 1, 0, 0];
        input.rewards[0] = CreatureCampaignManager.Reward("e1.common", "10% off");
        input.rewards[1] = CreatureCampaignManager.Reward("e1.rare", "25% off");
        vm.prank(business);
        id = manager.createCampaign(input);
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256(abi.encode(id)));
        uint256 requestId = manager.getCampaign(id).vrfRequestId;
        vm.prank(address(coordinator));
        manager.rawFulfillRandomWords(requestId, words);
    }

    /// @dev Computed locally: an external call here would consume vm.prank / vm.expectRevert.
    function _id(uint32 index) internal view returns (uint256) {
        return (campaignId << 32) | index;
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", market.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _ticket(uint256 pk, address player, uint256 creatureId, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, keccak256(abi.encode(market.CLAIM_TYPEHASH(), player, creatureId, deadline)));
    }

    function _attest(uint256 pk, address seller, uint256 creatureId, uint256 price, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, keccak256(abi.encode(market.LISTING_TYPEHASH(), seller, creatureId, price, deadline)));
    }

    function _claim(address player, uint256 creatureId) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, player, creatureId, deadline);
        vm.prank(player);
        market.claim(creatureId, LAT, LON, deadline, sig);
    }

    function _list(address seller, uint256 creatureId, uint256 price) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _attest(settlerPk, seller, creatureId, price, deadline);
        vm.prank(seller);
        market.list(creatureId, price, deadline, sig);
    }

    // ------------------------------------------------------------------ claim

    function test_Claim_NextCreature() public {
        uint256 id = _id(0);
        uint8 rarity = uint8(manager.getCreature(id).rarity);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, id, deadline);
        vm.expectEmit(true, true, true, true, address(market));
        emit CreatureMarket.CreatureClaimed(id, campaignId, alice, business, rarity);
        vm.prank(alice);
        market.claim(id, LAT + 100, LON - 100, deadline, sig);

        CreatureMarket.Holding memory h = market.getHolding(id);
        assertEq(h.owner, alice);
        assertEq(h.claimedAt, block.timestamp);
        assertFalse(h.redeemed);
        assertEq(market.claimedCount(campaignId), 1);
        assertEq(market.claimedIn(alice, campaignId), id);
        assertEq(market.getPlayerClaims(alice).length, 1);
        (uint256 next, bool available) = market.nextCreature(campaignId);
        assertEq(next, _id(1));
        assertTrue(available);
    }

    function test_Claim_OnlyTheNextCreature() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, _id(2), deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotNextCreature.selector, _id(2), _id(0)));
        vm.prank(alice);
        market.claim(_id(2), LAT, LON, deadline, sig);
    }

    function test_Claim_OnePerCampaign() public {
        _claim(alice, _id(0));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, _id(1), deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.AlreadyClaimedInCampaign.selector, campaignId, _id(0)));
        vm.prank(alice);
        market.claim(_id(1), LAT, LON, deadline, sig);
        _claim(bob, _id(1)); // another player gets the next one
        assertEq(market.claimedCount(campaignId), 2);
    }

    function test_Claim_RaceLoserGetsNotNext() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory bobSig = _ticket(humanPk, bob, _id(0), deadline);
        _claim(alice, _id(0)); // alice's transaction lands first
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotNextCreature.selector, _id(0), _id(1)));
        vm.prank(bob);
        market.claim(_id(0), LAT, LON, deadline, bobSig);
    }

    function test_Claim_RadiusNorth() public {
        // 1 micro-degree of latitude = 0.11132 m: 449 -> 49.98 m (in), 450 -> 50.09 m (out).
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, _id(0), deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.TooFar.selector, 50));
        vm.prank(alice);
        market.claim(_id(0), LAT + 450, LON, deadline, sig);
        vm.prank(alice);
        market.claim(_id(0), LAT + 449, LON, deadline, sig);
    }

    function test_Claim_RadiusEast() public {
        // At 19.076 deg N one micro-degree of longitude is ~0.10521 m: 470 -> 49.4 m, 480 -> 50.5 m.
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, _id(0), deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.TooFar.selector, 50));
        vm.prank(alice);
        market.claim(_id(0), LAT, LON + 480, deadline, sig);
        vm.prank(alice);
        market.claim(_id(0), LAT, LON - 470, deadline, sig);
    }

    function test_Distance_MatchesKnownValues() public view {
        // ~1 km north and ~1 km east of the spawn (accuracy of the approximation: well under 1%).
        uint256 north = market.distanceSquaredUm(LAT + 8983, LON, LAT, LON);
        assertApproxEqRel(north, 1e18, 0.002e18);
        uint256 east = market.distanceSquaredUm(LAT, LON + 9505, LAT, LON);
        assertApproxEqRel(east, 1e18, 0.01e18);
        // Antimeridian: 1 micro-degree apart.
        uint256 wrap = market.distanceSquaredUm(0, 180_000_000, 0, -179_999_999);
        assertEq(wrap, 111_320 * 111_320);
    }

    function test_Claim_RejectsBadTickets() public {
        uint256 deadline = block.timestamp + 10 minutes;
        // Signed by someone else.
        bytes memory sig = _ticket(strangerPk, alice, _id(0), deadline);
        vm.expectRevert(CreatureMarket.InvalidTicket.selector);
        vm.prank(alice);
        market.claim(_id(0), LAT, LON, deadline, sig);
        // Ticket of another player.
        sig = _ticket(humanPk, bob, _id(0), deadline);
        vm.expectRevert(CreatureMarket.InvalidTicket.selector);
        vm.prank(alice);
        market.claim(_id(0), LAT, LON, deadline, sig);
        // Expired.
        uint256 past = block.timestamp - 1;
        sig = _ticket(humanPk, alice, _id(0), past);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.TicketExpired.selector, past));
        vm.prank(alice);
        market.claim(_id(0), LAT, LON, past, sig);
        // Valid for too long.
        uint256 far = block.timestamp + 2 hours;
        sig = _ticket(humanPk, alice, _id(0), far);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.TicketTooLong.selector, far));
        vm.prank(alice);
        market.claim(_id(0), LAT, LON, far, sig);
    }

    function test_Claim_RejectsBadCoordinates() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, _id(0), deadline);
        vm.expectRevert(CreatureMarket.InvalidCoordinates.selector);
        vm.prank(alice);
        market.claim(_id(0), 90_000_001, LON, deadline, sig);
    }

    function test_Claim_CampaignStates() public {
        // Depleted.
        uint256 small = _campaign(1, 0);
        uint256 id = manager.creatureIdOf(small, 0);
        _claim(alice, id);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, bob, id, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.CampaignDepleted.selector, small));
        vm.prank(bob);
        market.claim(id, LAT, LON, deadline, sig);
        (, bool available) = market.nextCreature(small);
        assertFalse(available);

        // Expired.
        uint256 soon = _campaign(2, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        id = manager.creatureIdOf(soon, 0);
        deadline = vm.getBlockTimestamp() + 10 minutes; // via_ir may cache block.timestamp across vm.warp
        sig = _ticket(humanPk, bob, id, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.CampaignExpired.selector, soon));
        vm.prank(bob);
        market.claim(id, LAT, LON, deadline, sig);

        // Not allocated yet (VRF pending).
        CreatureCampaignManager.CampaignInput memory input;
        input.businessName = "Late";
        input.swarmReference = SWARM_REF;
        input.latitudeE6 = LAT;
        input.longitudeE6 = LON;
        input.totalCreatures = 1;
        input.rarityCounts = [uint32(1), 0, 0, 0];
        input.rewards[0] = CreatureCampaignManager.Reward("e1.x", "x");
        vm.prank(business);
        uint256 pending = manager.createCampaign(input);
        id = manager.creatureIdOf(pending, 0);
        sig = _ticket(humanPk, bob, id, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.CampaignNotActive.selector, pending));
        vm.prank(bob);
        market.claim(id, LAT, LON, deadline, sig);
    }

    // ------------------------------------------------------------------ redeem

    function test_Redeem() public {
        _claim(alice, _id(0));
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotOwner.selector, _id(0)));
        vm.prank(bob);
        market.redeem(_id(0));

        vm.expectEmit(true, true, false, false, address(market));
        emit CreatureMarket.Redeemed(_id(0), alice);
        vm.prank(alice);
        market.redeem(_id(0));
        assertTrue(market.getHolding(_id(0)).redeemed);

        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.AlreadyRedeemed.selector, _id(0)));
        vm.prank(alice);
        market.redeem(_id(0));

        // A redeemed creature can never be listed.
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _attest(settlerPk, alice, _id(0), 1 ether, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.AlreadyRedeemed.selector, _id(0)));
        vm.prank(alice);
        market.list(_id(0), 1 ether, deadline, sig);
    }

    function test_Redeem_BlockedWhileListed() public {
        _claim(alice, _id(0));
        _list(alice, _id(0), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.IsListed.selector, _id(0)));
        vm.prank(alice);
        market.redeem(_id(0));
    }

    // ------------------------------------------------------------------ marketplace

    function test_List_NeedsSettlerAttestation() public {
        _claim(alice, _id(0));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory bad = _attest(strangerPk, alice, _id(0), 1 ether, deadline);
        vm.expectRevert(CreatureMarket.InvalidTicket.selector);
        vm.prank(alice);
        market.list(_id(0), 1 ether, deadline, bad);

        // An attestation is bound to the price.
        bytes memory good = _attest(settlerPk, alice, _id(0), 1 ether, deadline);
        vm.expectRevert(CreatureMarket.InvalidTicket.selector);
        vm.prank(alice);
        market.list(_id(0), 2 ether, deadline, good);

        vm.expectEmit(true, true, false, true, address(market));
        emit CreatureMarket.Listed(_id(0), alice, 1 ether);
        vm.prank(alice);
        market.list(_id(0), 1 ether, deadline, good);
        CreatureMarket.Listing memory l = market.getListing(_id(0));
        assertEq(l.seller, alice);
        assertEq(l.price, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.IsListed.selector, _id(0)));
        vm.prank(alice);
        market.list(_id(0), 1 ether, deadline, good);
    }

    function test_List_Checks() public {
        _claim(alice, _id(0));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _attest(settlerPk, bob, _id(0), 1 ether, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotOwner.selector, _id(0)));
        vm.prank(bob);
        market.list(_id(0), 1 ether, deadline, sig);

        sig = _attest(settlerPk, alice, _id(0), 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.InvalidPrice.selector, 0));
        vm.prank(alice);
        market.list(_id(0), 0, deadline, sig);

        uint256 tooHigh = uint256(type(uint64).max) + 1;
        sig = _attest(settlerPk, alice, _id(0), tooHigh, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.InvalidPrice.selector, tooHigh));
        vm.prank(alice);
        market.list(_id(0), tooHigh, deadline, sig);
    }

    function test_Buy_PaysSellerAndTransfers() public {
        _claim(alice, _id(0));
        _list(alice, _id(0), 1 ether);
        uint256 before = alice.balance;

        vm.expectEmit(true, true, true, true, address(market));
        emit CreatureMarket.Sold(_id(0), alice, bob, 1 ether);
        vm.prank(bob);
        market.buy{value: 1 ether}(_id(0));

        assertEq(alice.balance, before + 1 ether);
        assertEq(market.getHolding(_id(0)).owner, bob);
        assertEq(market.getListing(_id(0)).seller, address(0));
        assertEq(address(market).balance, 0);

        // The buyer owns it now: alice can do nothing, bob can redeem.
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotOwner.selector, _id(0)));
        vm.prank(alice);
        market.redeem(_id(0));
        vm.prank(bob);
        market.redeem(_id(0));
        // Buying doesn't count as claiming: bob can still claim one himself.
        _claim(bob, _id(1));
    }

    function test_Buy_Checks() public {
        _claim(alice, _id(0));
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotListed.selector, _id(0)));
        vm.prank(bob);
        market.buy{value: 1 ether}(_id(0));

        _list(alice, _id(0), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.WrongPayment.selector, 0.5 ether, 1 ether));
        vm.prank(bob);
        market.buy{value: 0.5 ether}(_id(0));

        vm.deal(alice, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.OwnListing.selector, _id(0)));
        vm.prank(alice);
        market.buy{value: 1 ether}(_id(0));
    }

    function test_Unlist() public {
        _claim(alice, _id(0));
        _list(alice, _id(0), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotListed.selector, _id(0)));
        vm.prank(bob);
        market.unlist(_id(0));

        vm.expectEmit(true, true, false, false, address(market));
        emit CreatureMarket.Unlisted(_id(0), alice);
        vm.prank(alice);
        market.unlist(_id(0));
        vm.expectRevert(abi.encodeWithSelector(CreatureMarket.NotListed.selector, _id(0)));
        vm.prank(bob);
        market.buy{value: 1 ether}(_id(0));
        vm.prank(alice);
        market.redeem(_id(0)); // unlisted again: redeemable
    }

    function test_Buy_SellerRejectingEthFails() public {
        HostileSeller seller = new HostileSeller(market, false);
        uint256 deadline = block.timestamp + 10 minutes;
        seller.claim(_id(0), LAT, LON, deadline, _ticket(humanPk, address(seller), _id(0), deadline));
        seller.list(_id(0), 1 ether, deadline, _attest(settlerPk, address(seller), _id(0), 1 ether, deadline));
        vm.expectRevert(CreatureMarket.PaymentFailed.selector);
        vm.prank(bob);
        market.buy{value: 1 ether}(_id(0));
        assertEq(market.getHolding(_id(0)).owner, address(seller), "nothing changed");
    }

    function test_Buy_ReentrancyBlocked() public {
        HostileSeller seller = new HostileSeller(market, true);
        uint256 deadline = block.timestamp + 10 minutes;
        seller.claim(_id(0), LAT, LON, deadline, _ticket(humanPk, address(seller), _id(0), deadline));
        seller.list(_id(0), 1 ether, deadline, _attest(settlerPk, address(seller), _id(0), 1 ether, deadline));
        vm.expectRevert(CreatureMarket.PaymentFailed.selector); // the re-entrant buy reverts inside receive()
        vm.prank(bob);
        market.buy{value: 1 ether}(_id(0));
    }

    // ------------------------------------------------------------------ admin

    function test_Admin_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        market.setHumanSigner(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        market.setSettler(alice);

        market.setSettler(carol);
        assertEq(market.settler(), carol);
        vm.expectRevert(CreatureMarket.ZeroAddress.selector);
        market.setHumanSigner(address(0));
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_ClaimRadius(int32 dLat, int32 dLon) public {
        dLat = int32(bound(dLat, -2000, 2000));
        dLon = int32(bound(dLon, -2000, 2000));
        uint256 d2 = market.distanceSquaredUm(LAT + dLat, LON + dLon, LAT, LON);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _ticket(humanPk, alice, _id(0), deadline);
        if (d2 > 2500e12) vm.expectRevert();
        vm.prank(alice);
        market.claim(_id(0), LAT + dLat, LON + dLon, deadline, sig);
    }
}
