# contracts — CreatureCampaignManager

Standalone Foundry project; it does not depend on the worker or frontend.

- [src/CreatureCampaignManager.sol](src/CreatureCampaignManager.sol) — campaigns, Chainlink VRF v2.5 consumer
  (`VRFConsumerBaseV2Plus`), rarity allocation, creature views.
- [src/RarityShuffle.sol](src/RarityShuffle.sol) — predefined rarity array, unbiased Fisher–Yates shuffle.
- [script/DeployLocal.s.sol](script/DeployLocal.s.sol) — Anvil: official `VRFCoordinatorV2_5Mock` + subscription + manager in one tx.
- [script/Deploy.s.sol](script/Deploy.s.sol) — testnets: real coordinator from env vars.
- Deploy scripts write `deployments/<chainId>.json` (address + deploy block) for the worker/frontend.

```bash
forge build
```

```bash
forge test -vv
```

```bash
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url local --broadcast
```

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast
```

Interface summary

| Function | Who | Notes |
|---|---|---|
| `createCampaign(CampaignInput)` | any business | validates, stores, requests 1 VRF word |
| `retryRandomness(id)` | campaign business | only while waiting for VRF and ≥ 1 h after the last request |
| `cancelCampaign(id)` | campaign business | only before allocation |
| `setVrfConfig(cfg)` | owner | key hash, subscription, confirmations, callback gas, native payment |
| `getCampaign`, `getRewards`, `getRarities`, `getCreature`, `getCreatures` | view | `creatureId = (campaignId << 32) \| index` |

Events: `CampaignCreated`, `RandomnessRequested`, `RandomnessFulfilled`, `RarityAllocated`,
`FulfillmentIgnored`, `CampaignCancelled`, `VrfConfigUpdated`.

See the root [README](../README.md) for the full setup.
