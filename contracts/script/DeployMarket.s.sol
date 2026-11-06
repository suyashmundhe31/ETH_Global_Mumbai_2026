// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";
import {CreatureMarket} from "../src/CreatureMarket.sol";

/// @notice Deploys CreatureMarket (claim / redeem / marketplace) next to an existing CreatureCampaignManager,
///         on any network (local Anvil or testnet). Run it after Deploy / DeployLocal.
///
///   CAMPAIGN_MANAGER_ADDRESS  optional; default: campaignManager from deployments/<chainId>.json
///   HUMAN_SIGNER_ADDRESS      address of the user-frontend's HUMAN_SIGNER_PRIVATE_KEY (claim tickets)
///   SETTLER_ADDRESS           address of the worker's SETTLER_PRIVATE_KEY (listing attestations)
///
/// forge script script/DeployMarket.s.sol:DeployMarket --rpc-url sepolia --broadcast
/// Adds creatureMarket + marketDeployBlock to deployments/<chainId>.json.
contract DeployMarket is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        address manager = vm.envOr("CAMPAIGN_MANAGER_ADDRESS", address(0));
        if (manager == address(0)) manager = vm.parseJsonAddress(vm.readFile(path), ".campaignManager");
        require(manager.code.length > 0, "No CreatureCampaignManager at CAMPAIGN_MANAGER_ADDRESS");
        address humanSigner = vm.envAddress("HUMAN_SIGNER_ADDRESS");
        address settler = vm.envAddress("SETTLER_ADDRESS");

        vm.startBroadcast(pk);
        CreatureMarket market = new CreatureMarket(CreatureCampaignManager(manager), humanSigner, settler, vm.addr(pk));
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(market)), path, ".creatureMarket");
        vm.writeJson(vm.toString(block.number), path, ".marketDeployBlock");

        console2.log("CreatureMarket:", address(market));
        console2.log("  campaign manager:", manager);
        console2.log("  human signer:", humanSigner);
        console2.log("  settler:", settler);
        console2.log("  deploy block:", block.number);
    }
}
