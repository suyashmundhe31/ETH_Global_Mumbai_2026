// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";
import {CatchManager} from "../src/CatchManager.sol";
import {CatchReceiver} from "../src/CatchReceiver.sol";

/// forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
///   Deploys CatchManager + CatchReceiver next to the existing CreatureCampaignManager, reusing its VRF
///   coordinator, key hash and subscription. Afterwards the subscription owner must add CatchManager as a
///   consumer (see README).
/// --sig "localStack()": the same contracts plus a fresh campaign manager on a VRFCoordinatorV2_5Mock, for the
///   anvil fork. Env VRF_COORDINATOR + VRF_SUB_ID: the mock and a subscription created beforehand (the mock derives
///   sub ids from the block hash, so one created inside the script would differ between simulation and broadcast).
contract Deploy is Script {
    uint64 constant BASE_SEPOLIA_SELECTOR = 10344971235874465080;
    address constant MOCK_FORWARDER = 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5; // simulation
    address constant DEFAULT_CAMPAIGN_MANAGER = 0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83;

    function run() external {
        CreatureCampaignManager campaigns =
            CreatureCampaignManager(vm.envOr("CAMPAIGN_MANAGER", DEFAULT_CAMPAIGN_MANAGER));
        address forwarder = vm.envOr("CRE_FORWARDER", MOCK_FORWARDER);
        (bytes32 keyHash, uint256 subId, uint16 confirmations, uint32 gasLimit, bool native) = campaigns.vrfConfig();
        address coordinator = address(campaigns.s_vrfCoordinator());

        vm.startBroadcast();
        (CatchManager catches, CatchReceiver receiver) = _deploy(
            coordinator, CatchManager.VrfConfig(keyHash, subId, confirmations, gasLimit, native), campaigns, forwarder
        );
        vm.stopBroadcast();
        _print(address(campaigns), catches, receiver, coordinator, subId);
    }

    function localStack() external {
        VRFCoordinatorV2_5Mock vrf = VRFCoordinatorV2_5Mock(payable(vm.envAddress("VRF_COORDINATOR")));
        uint256 subId = vm.envUint("VRF_SUB_ID");
        vm.startBroadcast();
        vrf.fundSubscription(subId, 1000 ether);
        CatchManager.VrfConfig memory cfg = CatchManager.VrfConfig(bytes32(uint256(1)), subId, 3, 2_500_000, false);
        CreatureCampaignManager campaigns = new CreatureCampaignManager(
            address(vrf), CreatureCampaignManager.VrfConfig(cfg.keyHash, subId, 3, 2_500_000, false)
        );
        vrf.addConsumer(subId, address(campaigns));
        (CatchManager catches, CatchReceiver receiver) = _deploy(address(vrf), cfg, campaigns, MOCK_FORWARDER);
        vrf.addConsumer(subId, address(catches));
        vm.stopBroadcast();
        _print(address(campaigns), catches, receiver, address(vrf), subId);
    }

    function _deploy(address coordinator, CatchManager.VrfConfig memory cfg, CreatureCampaignManager campaigns, address forwarder)
        internal
        returns (CatchManager catches, CatchReceiver receiver)
    {
        // Catch success rate per rarity in bps (COMMON, RARE, EPIC, LEGENDARY). 100% = every verified catch lands.
        catches = new CatchManager(coordinator, cfg, campaigns, [uint16(10_000), 10_000, 10_000, 10_000]);
        receiver = new CatchReceiver(forwarder, catches, BASE_SEPOLIA_SELECTOR);
        catches.setCatchReceiver(address(receiver));
    }

    function _print(address campaigns, CatchManager catches, CatchReceiver receiver, address coordinator, uint256 subId)
        internal
        pure
    {
        console.log("CAMPAIGN_MANAGER=%s", campaigns);
        console.log("CATCH_MANAGER=%s", address(catches));
        console.log("CATCH_RECEIVER=%s", address(receiver));
        console.log("VRF_COORDINATOR=%s", coordinator);
        console.log("VRF_SUB_ID=%s", subId);
    }
}
