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

## CreatureMarket

`src/CreatureMarket.sol` is the player side, and the authority Arkiv mirrors. It reads `CreatureCampaignManager`
and never changes it.

| Function | Rule |
|---|---|
| `claim(creatureId, lat, lon, deadline, humanSig)` | ticket signed by `humanSigner` for `msg.sender`; campaign allocated and not expired; `creatureId` is the campaign's next one (`claimedCount`); one per player per campaign; within `CLAIM_RADIUS_M` = 50 m (`distanceSquaredUm`) |
| `redeem(creatureId)` | owner only, once, not while listed |
| `list(creatureId, price, deadline, settlerSig)` | owner, not redeemed, not listed, 0 < price ≤ 2^64-1 wei, attestation signed by `settler` |
| `unlist` / `buy` | seller only / exact price, seller paid in the same transaction |

Deploy it after `Deploy` / `DeployLocal`. The script reads the campaign manager from `deployments/<chainId>.json` and
adds `creatureMarket` and `marketDeployBlock` to that file:

```bash
HUMAN_SIGNER_ADDRESS=0x… SETTLER_ADDRESS=0x… forge script script/DeployMarket.s.sol:DeployMarket --rpc-url sepolia --broadcast
```
