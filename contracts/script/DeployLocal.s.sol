// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {CreatureCampaignManager} from "../src/CreatureCampaignManager.sol";

/// @notice LOCAL ONLY. Deploys Chainlink's official VRFCoordinatorV2_5Mock, creates + funds a subscription,
///         deploys the manager and registers it as consumer — all inside ONE transaction.
/// @dev The mock derives subscription IDs from blockhash(block.number - 1). In a multi-transaction forge
///      script the ID computed during simulation differs from the one minted on-chain, so later
///      fund/addConsumer transactions would target a non-existent subscription. Doing everything in one
///      constructor keeps the subscription ID on-chain only.
contract LocalVrfStack {
    VRFCoordinatorV2_5Mock public immutable coordinator;
    CreatureCampaignManager public immutable manager;
    uint256 public immutable subscriptionId;

    constructor(address finalOwner, bytes32 keyHash, uint32 callbackGasLimit) {
        // Constructor values from Chainlink's local-testing guide.
        coordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4e15);
        subscriptionId = coordinator.createSubscription();
        coordinator.fundSubscription(subscriptionId, 1_000_000 ether);
        manager = new CreatureCampaignManager(
            address(coordinator),
            CreatureCampaignManager.VrfConfig({
                keyHash: keyHash,
                subscriptionId: subscriptionId,
                requestConfirmations: 1,
                callbackGasLimit: callbackGasLimit,
                nativePayment: false
            })
        );
        coordinator.addConsumer(subscriptionId, address(manager));
        // ConfirmedOwner two-step transfer; the deployer accepts in the next transaction.
        manager.transferOwnership(finalOwner);
    }
}

/// forge script script/DeployLocal.s.sol:DeployLocal --rpc-url local --broadcast
contract DeployLocal is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint32 callbackGasLimit = uint32(vm.envOr("VRF_CALLBACK_GAS_LIMIT", uint256(2_000_000)));
        // Any non-zero key hash works with the mock.
        bytes32 keyHash = vm.envOr("VRF_KEY_HASH", keccak256("local-key-hash"));

        // createSubscription() reads blockhash(block.number - 1): the chain must be past block 0.
        require(block.number > 0, "Local chain is at block 0: start `anvil --block-time 1` or mine one block first");

        vm.startBroadcast(pk);
        LocalVrfStack stack = new LocalVrfStack(vm.addr(pk), keyHash, callbackGasLimit);
        CreatureCampaignManager manager = stack.manager();
        manager.acceptOwnership();
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeString(k, "vrfMode", "mock");
        vm.serializeAddress(k, "vrfCoordinator", address(stack.coordinator()));
        // The real ID is only known on-chain: read it with manager.vrfConfig().
        vm.serializeString(k, "subscriptionId", "on-chain: CreatureCampaignManager.vrfConfig()");
        string memory json = vm.serializeAddress(k, "campaignManager", address(manager));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("CreatureCampaignManager:", address(manager));
        console2.log("VRFCoordinatorV2_5Mock:", address(stack.coordinator()));
    }
}
