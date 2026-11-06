// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IVRFSubscriptionV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFSubscriptionV2Plus.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";

/// @notice Testnet / any live network deployment against a real Chainlink VRF v2.5 coordinator.
///         All network-specific values come from environment variables (see .env.example);
///         take them from https://docs.chain.link/vrf/v2-5/supported-networks.
/// forge script script/Deploy.s.sol --rpc-url sepolia --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address coordinator = vm.envAddress("VRF_COORDINATOR");
        CreatureCampaignManager.VrfConfig memory cfg = CreatureCampaignManager.VrfConfig({
            keyHash: vm.envBytes32("VRF_KEY_HASH"),
            subscriptionId: vm.envUint("VRF_SUBSCRIPTION_ID"),
            requestConfirmations: uint16(vm.envOr("VRF_REQUEST_CONFIRMATIONS", uint256(3))),
            callbackGasLimit: uint32(vm.envOr("VRF_CALLBACK_GAS_LIMIT", uint256(2_000_000))),
            nativePayment: vm.envOr("VRF_NATIVE_PAYMENT", false)
        });
        // Only works when the deployer also owns the subscription; otherwise add the consumer
        // in the Chainlink subscription manager UI (vrf.chain.link).
        bool addConsumer = vm.envOr("VRF_ADD_CONSUMER", false);

        vm.startBroadcast(pk);
        CreatureCampaignManager manager = new CreatureCampaignManager(coordinator, cfg);
        if (addConsumer) {
            IVRFSubscriptionV2Plus(coordinator).addConsumer(cfg.subscriptionId, address(manager));
        }
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeString(k, "vrfMode", "chainlink");
        vm.serializeAddress(k, "vrfCoordinator", coordinator);
        vm.serializeString(k, "subscriptionId", vm.toString(cfg.subscriptionId));
        string memory json = vm.serializeAddress(k, "campaignManager", address(manager));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("CreatureCampaignManager:", address(manager));
        if (!addConsumer) console2.log("Remember to add this address as a consumer of subscription", cfg.subscriptionId);
    }
}
