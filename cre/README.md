# Creature contracts + CRE referee

Chainlink CRE is the referee: a catch only goes through if the player is within `catchRadiusMeters` of the
spawn, and a discount code is only revealed (sealed to the owner's key) if the requester still owns the
creature and it was never redeemed. Base Sepolia (84532), no backend.

```
cre/
  src/                      CreatureCampaignManager (campaigns, VRF rarity), RarityShuffle,
                            CatchManager (catch, redeem, trading), CatchReceiver + ReceiverTemplate (CRE entry)
  test/CatchFlow.t.sol      Foundry tests (VRFCoordinatorV2_5Mock, test contract as forwarder)
  script/Deploy.s.sol       run(): Base Sepolia deploy   localStack(): anvil-fork stack for sim-fork.sh
  workflow/                 CRE project: project.yaml, secrets.yaml, .env.example
    referee/                the workflow (main.ts), pure helpers (referee.ts) + bun tests
    sim-fork.sh             end-to-end simulation on an anvil fork
```

Tooling used: Foundry 1.9.0, CRE CLI v1.39.0, Bun 1.4.4 (`cre` shells out to `bun`; keep `~/.bun/bin` on PATH).
Pinned: `@chainlink/cre-sdk` 1.23.0, `@noble/ciphers` 1.3.0, `tweetnacl` 1.0.3, `viem` 2.57.16,
chainlink-brownie-contracts 1.3.0, openzeppelin-contracts v5.7.0.

## Flow

| Step | On chain | CRE (`referee`) |
|---|---|---|
| Catch | `requestCatch(campaignId, lat, lon, 0x)` → `CatchRequested` (player + spawn coords) | log trigger 0: haversine ≤ radius → report 1 `(attemptId, approved, 0)` |
| | `onVerification` → VRF → `CatchResolved` | |
| Redeem | `requestRedeem(creatureId, playerPubKey)` → `RedeemRequested` | log trigger 1: read `getCaught`, `redeemed`, `getCreature`; decrypt the `e1.` code (AES-256-GCM + AAD); `nacl.box` it to `playerPubKey` → report 2 `(creatureId, approved, sealed)` |
| | `onRedeemVerified` → `redeemed = true` (never reset), `sealedCodes[id]`, `CodeRevealed` | |
| Trade | `list` / `unlist` / `buy` (exact price, pays the seller). `list`/`buy` revert once redeemed or while a redeem is pending | |

Report = `abi.encode(uint64 chainSelector, uint8 reportType, bytes payload)`; CatchReceiver rejects a wrong
selector. Stale, duplicate or late reports are ignored without reverting (a redeem verdict is dropped if the
creature changed hands after the request). Box nonce = first 24 bytes of `keccak256(uint256 creatureId)`, so
every DON node builds the same report. World ID is not checked by the workflow (nullifier 0). Catch rates in
`Deploy.s.sol` are 100% for every rarity, so a verified catch always lands.

## Environment variables

`cre/workflow/.env` (copy `.env.example`; read by `cre workflow simulate`):

| Var | |
|---|---|
| `CRE_ETH_PRIVATE_KEY` | Pays gas for `simulate --broadcast` (the MockKeystoneForwarder call). A funded dev key |
| `BASE_SEPOLIA_RPC` | RPC for the staging/production targets, e.g. `https://sepolia.base.org` |
| `CODE_ENCRYPTION_KEY_ALL` | → secret `CODE_ENCRYPTION_KEY`: the AES-256 key (base64, 32 bytes) the business app encrypts codes with |
| `WORKFLOW_BOX_SK_ALL` | → secret `WORKFLOW_BOX_SK`: X25519 secret key (hex, 32 bytes) the workflow seals codes with |

Generate the box key pair (the public key goes to the frontend):

```sh
cd cre/workflow/referee && bun install && bun -e 'import n from "tweetnacl"; const k = n.box.keyPair();
const h = (b) => "0x" + Buffer.from(b).toString("hex");
console.log("WORKFLOW_BOX_SK_ALL=" + h(k.secretKey)); console.log("NEXT_PUBLIC_WORKFLOW_BOX_PUBKEY=" + h(k.publicKey))'
```

Deploy (`forge script`): `PRIVATE_KEY` (passed as `--private-key`), optional `CAMPAIGN_MANAGER`
(default `0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83`) and `CRE_FORWARDER` (default: the MockKeystoneForwarder).

`frontend/.env`:

| Var | |
|---|---|
| `NEXT_PUBLIC_CATCH_MANAGER` | CatchManager address (required for the map, catching, redeem, settle) |
| `NEXT_PUBLIC_CAMPAIGN_MANAGER` | defaults to `0xF0Cbd7…3F83` |
| `NEXT_PUBLIC_WORKFLOW_BOX_PUBKEY` | workflow's X25519 public key (from the command above) |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC` | optional; defaults to viem's Base Sepolia RPC |
| `NEXT_PUBLIC_ARKIV_ACCESS_KEY` | optional Arkiv key (the public endpoint is rate limited) |

## Deploy order (Base Sepolia)

1. **Campaign manager**: already deployed at `0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83` (no changes needed).
2. **CatchManager + CatchReceiver**: reuses the campaign manager's VRF coordinator, key hash and subscription.
   ```sh
   cd cre
   forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
   # prints CATCH_MANAGER=… CATCH_RECEIVER=… VRF_COORDINATOR=… VRF_SUB_ID=…
   ```
   The receiver starts on the MockKeystoneForwarder (simulation). See "Forwarder" below for production.
3. **Add CatchManager as a VRF consumer.** Only the subscription owner can do this (currently
   `0x005466Bf8cC92bd84201F50cC10325DB3c2e34D9`, the campaign manager's deployer). In the VRF UI
   (vrf.chain.link → Base Sepolia → the subscription → Add consumer), or:
   ```sh
   cast send 0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE "addConsumer(uint256,address)" $VRF_SUB_ID $CATCH_MANAGER \
     --rpc-url $BASE_SEPOLIA_RPC --private-key $SUB_OWNER_KEY
   ```
   Without it, an approved catch reverts in `onVerification` (the VRF request is refused) and the attempt stays
   VERIFYING until it can be expired after 30 minutes. Keep the subscription funded.
4. **Workflow config**: put `catchManager` and `catchReceiver` in `workflow/referee/config.json`.
5. **Frontend**: set the `NEXT_PUBLIC_*` vars above. Players need Base Sepolia ETH (catch, redeem); the business
   and players need Rabdi tGLM for Arkiv writes (settle, sync sold, redeemed flag).

## Forwarder: MockKeystoneForwarder vs KeystoneForwarder

From the CRE Forwarder Directory, Base Sepolia (`ethereum-testnet-sepolia-base-1`, selector `10344971235874465080`):

| | Address | Used by |
|---|---|---|
| MockKeystoneForwarder | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` | `cre workflow simulate --broadcast` |
| KeystoneForwarder | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | deployed workflows |

- Simulation: keep the receiver on the mock and **don't** set workflow checks (the mock sends no workflow metadata,
  so `setExpectedWorkflow` would make every simulated report revert).
- Production, after `cre workflow deploy`: the CatchReceiver owner (the deployer) runs
  ```sh
  cast send $CATCH_RECEIVER "setForwarder(address)" 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 ...
  cast send $CATCH_RECEIVER "setExpectedWorkflow(bytes32,bytes10,address)" $WORKFLOW_ID $WORKFLOW_NAME $WORKFLOW_OWNER ...
  ```
  Simulation stops working against that receiver afterwards; point it back at the mock (and clear the expected
  workflow with zeros) to simulate again. Or redeploy with `CRE_FORWARDER=0xF834…4482`.

## Tests and simulation

```sh
cd cre && forge test                          # contracts: far-away rejected, redeem by non-owner, redeem once,
                                              # no listing after redeem, replayed report ignored, trading, ...
cd cre/workflow/referee && bun install && bun test     # haversine, e1 decrypt + AAD, nacl.box seal
```

**End to end on an anvil fork** (no testnet funds, no deployment needed; uses anvil's dev keys and a VRF mock):

```sh
cre/workflow/sim-fork.sh              # deploy, campaign with encrypted codes, catch 2 km (rejected),
                                      # catch 50 m (CRE + VRF), redeem (owner opens the code), second redeem
                                      # and listing after redeem revert. Exits non-zero on any FAIL.
KEEP_FORK=1 cre/workflow/sim-fork.sh  # same, but leaves anvil on http://127.0.0.1:8546 (detached) and prints
                                      # the addresses + env for pointing the app at the fork; kill the pid after
```

Every slow step runs under `timeout` (`T=300` s by default). The script refuses to start if an anvil is already
on port 8546 (`pkill -f 'anvil .*--port 8546'`).

**Against Base Sepolia** after deploying (log triggers take the tx hash and log index; both txs emit one event):

```sh
cd cre/workflow
cre workflow simulate referee --target staging-settings --non-interactive --broadcast \
  --trigger-index 0 --evm-tx-hash <requestCatch tx> --evm-event-index 0     # CatchRequested
cre workflow simulate referee --target staging-settings --non-interactive --broadcast \
  --trigger-index 1 --evm-tx-hash <requestRedeem tx> --evm-event-index 0    # RedeemRequested
```

There is no manual VRF step on Base Sepolia: the real coordinator answers an approved catch within a few blocks.
Don't trust the simulator's write status alone; check `getAttempt` / `redeemed` on chain.

**Deploying the workflow** (the account currently shows `Deploy Access: Not enabled` in `cre whoami`):

```sh
cd cre/workflow
cre secrets create secrets.yaml --target production-settings
cre workflow deploy referee --target production-settings
```

## Arkiv (business app, MetaMask)

- `/business` → **Settle catches**: for every creature of the business's campaigns that has an on-chain owner
  (`getCaught`), finds its Arkiv entity still owned by the business and sends `executeBatch` in chunks of 20:
  patch `catched = true` + ownership → the current on-chain owner. Entities the business no longer owns are
  skipped, so clicking again finishes a failed chunk.
- Player → **Sync sold creatures**: Arkiv entities the seller still holds whose creature now has another owner on
  chain move to that owner.
- After redeem, the owner's entity gets `redeemed = true` (display only).

The public Base Sepolia RPC caps `eth_getLogs` at 200 blocks, so the app never scans event history: settle reads
the same facts from contract state (every successful `CatchResolved` sets `getCaught(id).owner`), and the sealed
code is read from `sealedCodes(id)` instead of the `CodeRevealed` log.
