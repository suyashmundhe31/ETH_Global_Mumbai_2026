# AR Creature Campaigns — ETHGlobal Mumbai 2026

Businesses deploy digital **Creatures** at a location; players find and catch them for business rewards.
The repo has two web apps that share the contracts, the worker and the Arkiv schema:

| App | Folder | Who | What | Stack | Port |
|---|---|---|---|---|---|
| **Business interface** | [`business-frontend/`](business-frontend) | Businesses | Launch Campaign flow, end to end (below) | Vite, viem, `@arkiv-network/sdk` | 5173 |
| **User interface** | [`user-frontend/`](user-frontend) | Players (World ID verified humans only) | Map (claim creatures within 50 m), Profile (redeem / sell), Marketplace (buy). See [Player flow](#player-flow-claim-settlement-redeem-marketplace) | Next.js 16, React 19, `@worldcoin/idkit`, mapbox-gl, three | 3000 |

```
.
├── business-frontend/   Business interface (Vite)
├── user-frontend/       User interface (Next.js)
├── worker/              Node API + chain listener (Swarm, Arkiv prepare/verify, discount codes) + settler
├── contracts/           Foundry: CreatureCampaignManager (Chainlink VRF) + CreatureMarket (claim / redeem / sell)
├── shared/              Code used by worker + both apps (Arkiv schema, gas policy, discount-code format)
├── assets/creatures/    .glb models offered in the business form
└── scripts/             ABI sync, sample .glb generator
```

```
Business (MetaMask) ──createCampaign──▶ CreatureCampaignManager ──requestRandomWords──▶ Chainlink VRF v2.5
        │                                       ▲  fulfillRandomWords (VRF callback)          │
        │ upload .glb                           └─────────── Fisher–Yates shuffle ◀───────────┘
        ▼                                                     RarityAllocated event
   Worker API ──▶ Swarm (campaign .glb + one .glb per creature)        │
        ▲                                                             ▼
        └── listener prepares payloads ◀──────────────────────────────┘
                     │ plan (only creatures still missing)
                     ▼
Business (MetaMask, Arkiv network) ──executeBatch──▶ Arkiv: one entity per Creature,
                                                     $creator = $owner = business wallet
Worker ──verify (query $creator = on-chain business)──▶ COMPLETE / PARTIAL (+ exact missing IDs)
```

| Layer | Responsibility | Tech |
|---|---|---|
| `contracts/` | Campaigns, VRF request/fulfilment, on-chain Fisher–Yates rarity allocation, authoritative creature records; `CreatureMarket`: claims (50 m, next creature, one per player per campaign, human ticket), redemption, listings and sales | Solidity 0.8.28, Foundry, Chainlink VRF v2.5, OpenZeppelin 5.7.0 |
| `worker/` | Swarm uploads, chain event listener, Arkiv payload preparation + verification, HTTP API, discount codes, the **settler** (Auto-settle transfers, marketplace escrow, listing attestations), local VRF simulator | Node 22, viem, `@ethersphere/bee-js`, `@arkiv-network/sdk` |
| `business-frontend/` | Launch Campaign page: form, MetaMask, `.glb` preview, map, status; the business signs the Arkiv entities | Vite, viem, `@arkiv-network/sdk`, `<model-viewer>`, Leaflet |
| `user-frontend/` | World ID login, map + claim, profile (redeem / sell), marketplace (buy); server routes issue claim tickets and proxy the worker | Next.js, React, `@worldcoin/idkit`, mapbox-gl, three |
| `shared/` | The Arkiv creature schema and discount-code format, used by worker and business-frontend | plain ESM, SDK passed in |
| `assets/creatures/` | `.glb` creature models offered in the form | glTF 2.0 binary |
| Arkiv | One entity per Creature (metadata + Swarm reference + lifecycle flags), created and owned by the business | Rabdi testnet |
| Swarm | Binary `.glb` assets | Bee node or public gateway |

Creatures are **not NFTs**: they are Arkiv entities whose 3D model lives on Swarm.

---

## 1. How it works

1. **Configure** (business-frontend): business name, wallet (MetaMask), reward code + description per rarity,
   exact counts per rarity (`Common + Rare + Epic + Legendary = Total`, validated client-side and on-chain),
   location (map / current location), optional expiration, `.glb` from `assets/creatures/`.
2. **Swarm upload** (worker `POST /api/swarm/upload`): validates the GLB header/chunks and size, uploads with
   `bee.file.upload`, then downloads it again and compares SHA-256 before returning the reference.
   Nothing goes on-chain if this fails.
   **Discount codes are encrypted first** (worker `POST /api/discount-codes/encrypt`, AES-256-GCM with
   `CODE_ENCRYPTION_KEY`), so the transaction, the contract and Arkiv only ever hold ciphertext — see
   [Encrypted discount codes](#encrypted-discount-codes).
3. **createCampaign** (signed in MetaMask): the contract validates everything, stores the campaign (with the
   encrypted codes) and requests one VRF random word (`numWords: 1`).
4. **VRF callback** (`fulfillRandomWords`): builds `[COMMON×c0, RARE×c1, EPIC×c2, LEGENDARY×c3]`, runs an
   in-contract Fisher–Yates shuffle seeded by `keccak256(word, campaignId)` with an unbiased
   (rejection-sampled) keccak expansion, stores the shuffled array (1 byte per creature) and emits
   `RandomnessFulfilled` + `RarityAllocated`. Allocation needs nothing off-chain.
5. **Creature records**: `creatureId = (campaignId << 32) | index` — globally unique, belongs to exactly one
   campaign. `getCreature(id)` / `getCreatures(campaignId, offset, limit)` return the full record (rarity,
   matching discount code + description, business, location, expiry, Swarm reference, creation time).
6. **Prepare** (worker, triggered by the `RarityAllocated` event): reads the finalized creatures from the
   chain and creates a **per-creature `.glb`** (base model + creature metadata in glTF `asset.extras`, so every
   creature has its own Swarm reference).
7. **The business creates the creatures on Arkiv** (business-frontend): the page asks the worker for the plan, checks
   that MetaMask is the campaign's business wallet and holds tGLM, switches MetaMask to the Arkiv network
   (adding it if needed) and the business signs **one Arkiv entity per creature** in batches
   (`ARKIV_BATCH_SIZE` per MetaMask confirmation). Because the business signs, Arkiv records the business
   wallet as `$creator` and `$owner` — nothing is hard-coded, and the worker holds no Arkiv key.
8. **Confirmation** (business-frontend): campaign ID, wallet, totals, distribution, tx hashes, VRF status, Arkiv
   status (`$creator = $owner`), Swarm references and a creature table (ID, rarity, code, Arkiv entity key,
   `$owner`, Swarm reference — click a reference to render that creature's model retrieved from Swarm).

### Reliability of the Arkiv writes
Arkiv writes are **not** assumed atomic across creatures (`worker/src/campaignArkiv.js`, `business-frontend/src/arkivWrite.js`):
- every plan (`POST /api/campaigns/:id/arkiv/plan`) is computed after re-reading Arkiv for entities **created by
  the campaign's business** (`$creator` = `business` read from the contract) with the same
  `chainId + contract + campaignId` — only creatures without a valid entity are offered for signing. The scan
  is a **keyset walk ordered by `$key`** with `onMismatch: "throw"` (offset paging can skip existing
  entities when others expire mid-scan, which would make the plan ask for them again);
- the business signs batches (each one atomic `executeBatch`). The run **stops at the first failed batch**: a
  JavaScript error does not prove the chain rejected a write. If that batch has a transaction hash, it is
  reported as pending and its creatures are **held back from every plan** until Arkiv shows the transaction
  reverted or dropped (the worker only accepts a hash the Arkiv node knows, sent by the campaign's business
  to the entity address `0x44…44`);
- account and chain are re-checked before every signature; gas is explicit:
  `max(1,000,000 + 400,000 × (n − 1), 2 × unsigned estimate)`, at most half the block gas limit — a batch that
  would not fit is split before anything is signed (measured on Rabdi: ~0.83M gas per creature at maximum
  field sizes, so the default `ARKIV_BATCH_SIZE` is 8);
- entity keys returned by each transaction are reported (`/arkiv/submissions`) and re-read with `getEntity`,
  so a lagging query index can never cause a duplicate — and they are never trusted blindly ($creator,
  rarity and reward must match the chain);
- `POST /api/campaigns/:id/arkiv/verify` checks Arkiv itself and reports `COMPLETE` or `PARTIAL` with the exact
  missing creature IDs; the "Sign missing creatures" button re-plans and signs only those.

Example: 10 creatures, batch 8 fails → 7 written, the retry plan contains exactly the 3 missing creatures
(covered by `worker/test/campaignArkiv.test.js` and the end-to-end test).

These rules follow Arkiv's official agent skills ([Arkiv-Network/skills](https://github.com/Arkiv-Network/skills):
`arkiv-write-safety`, `arkiv-query`, `arkiv-app-integration`, `arkiv-security-trust`), installed for Claude
Code in `.claude/skills/` (local, git-ignored; source commit in `.claude/skills/ARKIV_SKILLS_SOURCE.txt`).

---

## 2. Prerequisites (Windows, Linux, macOS)

- **Node.js 22.22.0 and npm 10.9.4, exactly** (npm 10.9.4 ships with Node 22.22.0: https://nodejs.org/dist/v22.22.0/).
  Pinned in `worker/`, `business-frontend/` and `user-frontend/` (`package.json` `engines` + `packageManager`), and `.npmrc` sets
  `engine-strict=true`, so `npm ci` refuses any other Node/npm version (`EBADENGINE`). `.nvmrc` /
  `.node-version` hold `22.22.0` for nvm, nvm-windows (`nvm use 22.22.0`), fnm and similar version managers.
- **Foundry** (`forge`, `anvil`, `cast`; tested with 1.8.7) — https://getfoundry.sh
- **Git** (contract libraries are pinned git submodules)
- **MetaMask** browser extension
- For Arkiv writes: the **business wallet** funded with tGLM on Arkiv Rabdi (https://hub.arkiv.network/faucet);
  recommended for the worker, a free access key (https://hub.arkiv.network/access-keys)

No OS-specific scripts are used: every command below is a plain `git`/`forge`/`npm`/`node` invocation.

## 3. Install

```bash
git clone --recurse-submodules <repo-url>
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

```bash
npm ci --prefix worker
```

```bash
npm ci --prefix business-frontend
```

```bash
npm ci --prefix user-frontend
```

Pinned versions: see [Dependency versions](#9-dependency-versions).

## 4. Configuration (environment variables)

Copy each `.env.example` and fill it in. Real `.env` files are git-ignored.

| File | Copy to | Contains |
|---|---|---|
| [contracts/.env.example](contracts/.env.example) | `contracts/.env` | RPC URLs, deployer key, VRF coordinator / key hash / subscription |
| [worker/.env.example](worker/.env.example) | `worker/.env` | chain RPC, Swarm node + postage batch, Arkiv network + access key, `CODE_ENCRYPTION_KEY`, `SETTLER_PRIVATE_KEY` (**secret**) |
| [business-frontend/.env.example](business-frontend/.env.example) | `business-frontend/.env.local` | **public** values only: API URL, chain id, RPC, contract address (no Arkiv key: the wallet uses its own Arkiv RPC) |
| [user-frontend/.env.example](user-frontend/.env.example) | `user-frontend/.env.local` | World ID app / RP id / environment, Mapbox token + style (public), `WORKER_URL`, `RP_SIGNING_KEY` and `HUMAN_SIGNER_PRIVATE_KEY` (**secrets**, server-side only) |

Secrets (deployer key, Swarm batch, RPC provider keys) live only in `contracts/.env` / `worker/.env`.
No private key reaches a browser: the business and players sign in MetaMask. The only server keys are the
worker's settler (Arkiv transfers + listing attestations) and the user app's human signer (claim tickets).

Key worker variables:

| Variable | Meaning |
|---|---|
| `CHAIN_ID`, `CHAIN_RPC_URL` | Chain where the contract is deployed (31337 local, 11155111 Sepolia) |
| `PUBLIC_RPC_URL` | RPC URL the browser may see (no API key). Empty = `CHAIN_RPC_URL` only if it is a local node |
| `CAMPAIGN_MANAGER_ADDRESS` | Optional; defaults to `contracts/deployments/<CHAIN_ID>.json` |
| `VRF_MODE` | `mock` (local only: worker fulfils via the official mock) or `chainlink` |
| `LOCAL_VRF_FULFILLER_PRIVATE_KEY` | Mock mode only — a local Anvil dev account |
| `SWARM_BEE_URL`, `SWARM_POSTAGE_BATCH_ID` | Your Bee node + usable batch, or the public gateway with an empty batch |
| `CODE_ENCRYPTION_KEY` | **Secret.** AES-256-GCM key for discount codes (32 bytes, base64): `npm --prefix worker run gen-code-key`. Back it up — without it codes cannot be decrypted |
| `ARKIV_ACCESS_KEY` | Rabdi RPC access key for the worker's reads (empty = rate-limited public endpoint) |
| `ARKIV_SCHEMA_NAME` | `ethglobal-mumbai-2026.creature.v2` |
| `ARKIV_BATCH_SIZE` | Creatures per business-signed Arkiv transaction (= one MetaMask confirmation each) |
| `CREATURE_MARKET_ADDRESS`, `MARKET_START_BLOCK` | Optional; default `creatureMarket` / `marketDeployBlock` from `contracts/deployments/<CHAIN_ID>.json` |
| `SETTLER_PRIVATE_KEY` | **Secret, required.** The settler wallet (`npm --prefix worker run gen-key -- SETTLER`); must equal `CreatureMarket.settler` (checked at start). Fund it with tGLM |
| `ESCROW_GRACE_MS` | How long an escrow may wait for its on-chain listing before it is handed back (default 15 min) |

`ARKIV_PRIVATE_KEY`, `CATCH_MANAGER_ADDRESS` and `CATCH_START_BLOCK` are no longer used (the worker warns).

## 5. Run locally (Anvil + Chainlink VRF mock)

Terminal 1 — local chain (`--block-time 1` is required: the VRF mock needs the chain past block 0):

```bash
anvil --block-time 1
```

Terminal 2 — deploy (writes `contracts/deployments/31337.json`, which worker and business-frontend read):

```bash
cd contracts
```

```bash
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url local --broadcast
```

`contracts/.env` needs `LOCAL_RPC_URL=http://127.0.0.1:8545` and `DEPLOYER_PRIVATE_KEY` (Anvil prints its dev
account keys on start; account #0 is fine locally).

Then CreatureMarket (adds `creatureMarket` to the same file). First generate the two signer keys with
`npm --prefix worker run gen-key -- SETTLER` and `npm --prefix worker run gen-key -- HUMAN_SIGNER`, then pass
their **addresses**:

```bash
HUMAN_SIGNER_ADDRESS=0x… SETTLER_ADDRESS=0x… forge script script/DeployMarket.s.sol:DeployMarket --rpc-url local --broadcast
```

Terminal 3 — worker (set `LOCAL_VRF_FULFILLER_PRIVATE_KEY` and `SETTLER_PRIVATE_KEY` in `worker/.env` first):

```bash
npm --prefix worker start
```

Terminal 4 — business interface, then open http://localhost:5173:

```bash
npm --prefix business-frontend run dev
```

MetaMask for local testing: the page offers to add the "Anvil (local)" network (chain 31337,
`http://127.0.0.1:8545`); import one of Anvil's dev accounts as the business wallet. On a fresh Anvil chain,
clear the account's activity/nonce data in MetaMask's advanced settings if transactions get stuck on stale nonces.
After VRF, the page switches MetaMask to **Arkiv Rabdi** and the same business account signs the creature
entities — it needs tGLM there (https://hub.arkiv.network/faucet). Anvil's dev keys are public, so for Arkiv
prefer your own test account: give it local ETH with
`cast rpc anvil_setBalance <address> 0x56BC75E2D63100000 --rpc-url local`.

Without MetaMask (demo): with the worker running, this creates a campaign the way the page does, using Anvil
account #2 (the Arkiv step then needs that account to sign on the page, or run the e2e test instead):

```bash
npm --prefix worker run demo
```

then open `http://localhost:5173/?campaign=<id>` to follow VRF + Arkiv progress.

## 6. Testnet deployment (Ethereum Sepolia)

Network values come from the official list: https://docs.chain.link/vrf/v2-5/supported-networks
(nothing network-specific is hard-coded in the contracts or scripts).

1. Get Sepolia ETH and testnet LINK: https://faucets.chain.link
2. Create and fund a VRF v2.5 subscription at https://vrf.chain.link (LINK, or native ETH with
   `VRF_NATIVE_PAYMENT=true`). Note the subscription ID.
3. Fill `contracts/.env`: `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `VRF_COORDINATOR`, `VRF_KEY_HASH`,
   `VRF_SUBSCRIPTION_ID`, `VRF_REQUEST_CONFIRMATIONS` (≥ the network minimum, 3 on Sepolia),
   `VRF_CALLBACK_GAS_LIMIT` (default 2,000,000; a 500-creature allocation measured ≈1.2M incl. mock overhead;
   Sepolia max is 2,500,000), `VRF_ADD_CONSUMER=true` if the deployer owns the subscription.
4. Deploy (writes `contracts/deployments/11155111.json`):

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast
```

5. If `VRF_ADD_CONSUMER=false`, add the printed contract address as a consumer in the subscription UI.
   Then deploy CreatureMarket next to it (no VRF needed; adds `creatureMarket` + `marketDeployBlock` to the file;
   an existing campaign manager is read from the deployment file, or set `CAMPAIGN_MANAGER_ADDRESS`):
   `HUMAN_SIGNER_ADDRESS=0x… SETTLER_ADDRESS=0x… forge script script/DeployMarket.s.sol:DeployMarket --rpc-url sepolia --broadcast`
6. Worker: `CHAIN_ID=11155111`, `CHAIN_RPC_URL=<sepolia rpc>`, `VRF_MODE=chainlink`
   (the real Chainlink service fulfils; the worker only listens).
7. Frontend: `VITE_CHAIN_ID=11155111`, `VITE_CHAIN_NAME=Sepolia`, `VITE_RPC_URL=<public sepolia rpc>`,
   `VITE_BLOCK_EXPLORER_URL=https://sepolia.etherscan.io` (or leave chain/contract empty to use the worker's
   `/api/config`).
8. Business wallet: Sepolia ETH for `createCampaign` **and** tGLM on Arkiv Rabdi for the creature entities.

The same steps work on **Base Sepolia** (chain 84532; use that network's VRF values from the Chainlink page;
the public `https://sepolia.base.org` RPC caps `eth_getLogs` at 200 blocks, so set `LOG_RANGE=200`).

Optional verification: `forge verify-contract` with `ETHERSCAN_API_KEY`.

### Changing the contract address (any network)
- **Worker**: set `CAMPAIGN_MANAGER_ADDRESS` (and `START_BLOCK` = deployment block) in `worker/.env`, or just
  keep the deploy script's `contracts/deployments/<CHAIN_ID>.json` and set `CHAIN_ID`. Restart the worker.
- **Frontend**: set `VITE_CAMPAIGN_MANAGER_ADDRESS` (+ `VITE_CHAIN_ID`, `VITE_RPC_URL`) in
  `business-frontend/.env.local` and restart `npm run dev` (Vite reads env at start), or leave them empty to inherit
  the worker's configuration via `/api/config`.
- **ABI changes**: after editing the contract, run `forge build` in `contracts/` and then
  `node scripts/sync-abi.mjs` to refresh `worker/src/abi` and `business-frontend/src/abi`.

## 7. Swarm setup

- **Dev / demo** (default): `SWARM_BEE_URL=https://api.gateway.ethswarm.org`, empty `SWARM_POSTAGE_BATCH_ID`.
  bee-js uploads with `NULL_STAMP` and the gateway stamps the data with its own batch. Convenient, but
  **availability is not guaranteed** — the gateway's batch and retention policy are not under your control.
- **Durable**: run your own Bee node (https://docs.ethswarm.org/docs/bee/installation/getting-started),
  buy a postage batch (https://docs.ethswarm.org/docs/develop/tools-and-features/buy-a-stamp-batch), set
  `SWARM_BEE_URL=http://localhost:1633` and `SWARM_POSTAGE_BATCH_ID`. The worker checks the batch is
  `usable` before uploading. Data stays available only while the batch has TTL — top it up
  (`bee.stamp.topUp`) for long campaigns. `SWARM_PIN=true` additionally pins locally.
- **Local Swarm**: `bee dev` is deprecated; the docs point to `bee-factory` (Docker).
  Its Anvil also uses port 8545 — run our chain on another port (`anvil --port 8546 --block-time 1`)
  and update `LOCAL_RPC_URL` / `CHAIN_RPC_URL` accordingly.

## 8. Arkiv setup and data model

Network: **Rabdi** testnet (chain 7794095, 2 s blocks, gas in tGLM). **Each business** creates and owns its
creature entities: the business wallet needs tGLM on Rabdi (https://hub.arkiv.network/faucet); the page adds
the Arkiv network to MetaMask. The worker only reads — set `ARKIV_ACCESS_KEY` to avoid rate limits.

Ownership: Arkiv sets `$creator` and `$owner` to the account that signs the create transaction, so both are
the business wallet. Only the owner can patch, transfer (`changeOwnership`) or delete an entity; `$creator`
never changes, even after a transfer.

Schema `ethglobal-mumbai-2026.creature.v2` (defined once in `shared/creatureEntity.js`; one entity per creature):
`creatureId` (indexed), `campaignId` (indexed), `creatureIndex`, `chainId` (indexed), `contract` (indexed),
`businessName`, `rarity` (indexed), `discountCode`, `discountDescription`, `totalCreatures`,
`latitudeE6`/`longitudeE6` (indexed i32 micro-degrees, for geo range queries), `expiresAtUnix` (indexed,
0 = none), `swarmReference` (this creature's `.glb`), `campaignSwarmReference`, `createdAt`, `campaignTxHash`,
`allocationTxHash`, `vrfRequestId`, and the lifecycle fields:

| Field | Type | Default |
|---|---|---|
| `listed` | bool, indexed | `false` |
| `catched` | bool, indexed | `false` |
| `redeemed` | bool, indexed | `false` |
| `price` | u64 (integer), indexed, optional | not set (null) |

`discountCode` holds the **encrypted** code (same ciphertext as on-chain); `discountDescription` stays public.
There is no `business` column: use `$creator`. Creation flags: **not** `readonly` (the owner must be able to
update the lifecycle fields) and `permissionlessExtension` (anyone, e.g. the worker, may extend an entity's
lifetime without being able to change it). v1 entities (worker-owned, readonly) are not read by this version.

**Expiration semantics** (Arkiv docs, "Expiration"): every Arkiv entity has a finite lifetime measured in
blocks, at most `MAX_LIFETIME` = 7,884,000 blocks (≈182.5 days); there is no "never expires".
- Campaign expiration set and within that window → entity expires at that date (`ExpirationTime.atDate`).
- No expiration (stored on-chain as `0`) or later than the window → `ExpirationTime.max()`, and the real
  campaign expiry is kept in `expiresAtUnix` (0 = open-ended). Such entities must be extended with
  `extendEntity` before they lapse (not automated yet — see limitations).

Query example (explorer "Entities" page, https://rabdi.explorer.arkiv.network/entity-explorer):

```
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2') AND $creator = addr(<business wallet>) AND campaignId = u64(1) AND listed = false
```

Arkiv data is public and anyone can write look-alike entities, so always filter on `$creator` and check it
against the campaign's `business` in the contract (the worker's verification does exactly that).

### Encrypted discount codes

Everything on-chain and on Arkiv is public, so the discount code is encrypted **before** `createCampaign`
(`worker/src/discountCodes.js`, `shared/discountCodes.js`):

- **Algorithm**: AES-256-GCM (Node's built-in `crypto`), random 12-byte IV, 16-byte tag. Stored as
  `e1.` + base64url(iv | ciphertext | tag): 62 characters for a 16-byte code, so it fits the contract (64) and
  Arkiv (128). The same ciphertext is stored on-chain and in each creature's Arkiv `discountCode`.
- **Binding**: the AAD is `chainId | contract | business | rarity`, so a ciphertext copied into another
  business's campaign (or another rarity) does not decrypt.
- **Key**: `CODE_ENCRYPTION_KEY` in `worker/.env` only. It is **never** sent to the browser — a key in the
  frontend bundle would let anyone decrypt every code.
- **Reveal** (`POST /api/campaigns/:id/discount-codes/reveal`): the wallet signs a fixed text
  (`revealMessage`: campaign, creature or "all", chain, contract, wallet, time — no gas, no transaction); the
  worker rebuilds the text, verifies the signature (viem `verifyMessage`) and decrypts only for:
  - the campaign's **business wallet** (read from the contract): all codes of its campaign;
  - the creature's **owner on CreatureMarket**, and only after it was **redeemed** there: that creature's code.
  Signatures expire after 5 minutes. The page's "Reveal discount codes" button does this for the business.

## User interface

`user-frontend/` (Next.js App Router) is the players' app, with three tabs: **Profile**, **Marketplace**, **Map**.

```bash
npm --prefix user-frontend run dev
```

then open http://localhost:3000 (production: `npm --prefix user-frontend run build` then
`npm --prefix user-frontend start`). Configure `user-frontend/.env.local` from
[user-frontend/.env.example](user-frontend/.env.example): World ID, Mapbox, `WORKER_URL` and
`HUMAN_SIGNER_PRIVATE_KEY`. Contract addresses, networks and the settler come from the worker (`/api/config`).

**Login: verified humans only** (`components/LoginButton.tsx`, `app/api/verify/route.ts`). MetaMask signs a
server challenge. A wallet already linked to a verified human logs straight in. Otherwise IDKit runs World ID
proof-of-human with the wallet as the signal. The server checks the wallet signature, the signal binding and
World's `developer.world.org/api/v4/verify`. It then links one human (nullifier) to one wallet (`players.json`)
and sets an HMAC-signed, 7-day `session` cookie. Any failure shows an **Unverified** pop-up. Every page and API
route checks the session. Switching the MetaMask account ends it (`SessionGuard`).

## Player flow: claim, settlement, redeem, marketplace

Everything a player does is decided on chain by **`CreatureMarket`** (`contracts/src/CreatureMarket.sol`). Arkiv
mirrors it. There is no Chainlink CRE: its referee logic (distance, one creature per human per campaign) is in the
contract.

**Map** (`lib/creatures.ts` → `loadSpawns`, `lib/spawns.ts`, `components/Spawns.tsx`):
1. **Find campaigns.** Arkiv is queried for uncaught, unexpired creatures of this deployment inside a box around
   the player. Each campaign is checked on chain: the entity's `$creator` must be the campaign's business, and the
   campaign must be allocated, not expired and not depleted.
2. **Choose what to show.** Only campaigns within **500 m** are kept, and never one the player already claimed
   from. **One creature per business**: its nearest campaign. Counts are never shown.
3. **Pick the creature.** It is the campaign's **next** creature (`CreatureMarket.nextCreature`). Creature indexes
   were shuffled by Chainlink VRF, so its rarity is random and nobody can choose another one. Its Arkiv entity must
   agree with the chain (rarity).
4. **Open it.** Within **50 m** (the same integer math as the contract, `lib/geo.ts`), tapping the creature opens
   a modal with all its info (code 🔒 encrypted) and its 3D model. **Claim it** asks this app's server for a
   **claim ticket** (EIP-712, signed with `HUMAN_SIGNER_PRIVATE_KEY` for the session's wallet only), then sends
   `CreatureMarket.claim(creatureId, lat, lon, deadline, ticket)`.
5. **The contract checks**: the ticket, the 50 m radius, that this is the next creature, and one per player per
   campaign. Then it emits `CreatureClaimed`.

**Settlement** (business app, section **F**, chosen per campaign):

| | **Approval** (default) | **Auto settle** |
|---|---|---|
| Launch | `$creator` = `$owner` = business | The same atomic batches hand each creature to the settler: `$owner` = settler |
| Valid claim | The business sees it under "Claims awaiting your approval" and clicks **Approve**. MetaMask signs `catched = true` (+ `redeemed` as on chain) and ownership → player | The worker's **settler** sees `CreatureClaimed`, re-checks chain + Arkiv, and sends one atomic batch: `catched = true` (+ chain-truth fields) and ownership → player. The business is notified (feed + banner) |
| Invalid claim | Reverts on chain (too far, not next, second claim, bad ticket): nothing happens | Same: nothing |

**Profile** (`components/Profile.tsx`):
- **What it shows.** The wallet, and every creature it owns on Arkiv, cross-checked on chain. It also shows its
  listings and claims still on the way ("awaiting business approval" / "arriving").
- **Redeem.**
  1. `CreatureMarket.redeem` (final; a redeemed creature can never be sold).
  2. The player signs the reveal message. The worker decrypts the code only for the creature's on-chain owner,
     and only once it is redeemed.
  3. Arkiv `redeemed = true` (the owner signs).
- **Sell** (not redeemed).
  1. **Escrow on Arkiv**: one atomic batch sets `listed = true` and `price` and changes ownership → settler.
  2. The settler checks, then signs a **listing attestation** (`POST /api/market/attest`, EIP-712). It checks:
     - the seller owns the creature on chain;
     - it is not redeemed and not listed;
     - the escrowed entity is the business's, with this exact price;
     - **every chain-derived column is untampered**.
  3. `CreatureMarket.list` accepts only that attestation.
- **Tampered data.** It is refused and restored from the chain, and the creature is handed back.
- **Abandoned escrow.** An escrow never listed on chain returns after `ESCROW_GRACE_MS` (15 min).
- **Unlist.** `CreatureMarket.unlist`; the settler hands the entity back.

**Marketplace** (`components/Market.tsx`):
- **What it lists.** Only escrowed entities (`$owner` = settler, `listed = true`) whose on-chain listing has the
  same price and that are not redeemed.
- **Buy.** `CreatureMarket.buy` takes the exact price and pays the seller in the same transaction. The settler
  then moves the Arkiv entity to the buyer (`listed = false`, price unset). The business sees resales in its feed.

**The settler** (`worker/src/settler.js`):
- **Wallet.** It is one worker wallet (`SETTLER_PRIVATE_KEY` = `CreatureMarket.settler`) that holds Auto-settle
  creatures and escrows.
- **How it decides.** It scans `CreatureMarket` events and sweeps the escrows it holds. For each creature it
  converges Arkiv to the chain: the owner, `catched` / `redeemed` / `listed` / `price`, and any tampered column.
- **Write safety** (Arkiv skills `arkiv-write-safety`, `arkiv-entity-lifecycle`):
  - one signer and one transaction at a time;
  - intent is saved before sending;
  - lost receipts are reconciled by hash;
  - a send without a hash waits for an idle nonce;
  - gas is set explicitly for Rabdi (`shared/arkivGas.js`).
- **What it ignores.** Only entities created by the campaign's business (read from the contract) count.
- **Custody.** It never holds a creature that a player owns outside an escrow.

## 9. Tests

| What | Command | Covers |
|---|---|---|
| Contracts (54 tests, incl. fuzz) | `cd contracts` then `forge test` | CreatureMarket: next-creature claims, 50 m radius (exact edges + fuzz), one per campaign, race loser, human tickets (signer, player binding, expiry, max TTL), campaign states, redeem rules, settler attestation bound to price, buy pays the seller, unlist, payment failure + reentrancy, admin; campaign manager: distribution preservation (fuzzed), Fisher–Yates permutation + uniform sampling, unique IDs, reward ↔ rarity, VRF only from coordinator, duplicate/stale/unknown fulfilment ignored without revert, cancel/retry access control, validation, 500-creature callback gas |
| Worker unit (53 tests) | `npm --prefix worker test` | settler: auto claim → transfer + `catched` + business feed, approval campaign untouched, escrow → attestation (verified as EIP-712) → listed → sold → buyer, unlist → seller, abandoned escrow returned after grace, attestation checks (owner, price, redeemed, escrow), tampered data refused + restored, sale seen by a sweep before its event, lost receipt reconciled, look-alikes ignored; keyset scan;  GLB validation + per-creature stamping, shared schema (new fields, no `business`), expiration, prepare/plan/verify: business = `$creator` = `$owner`, partial failure 7/10 → retry plans 3, lost receipts, index lag, look-alikes from other wallets ignored, forged rarity rejected, stale schema records, Swarm failure, listener retries, windowed log queries; discount codes: round trip, 64-byte fit, binding to business/rarity/key, tamper, reveal by business / creature owner only, signature replay + expiry |
| User frontend (6 tests) | `npm --prefix user-frontend test`, `npm --prefix user-frontend run lint`, `npm --prefix user-frontend run build` | the 50 m check equals the contract's (same edge cases), spawn selection (one per business, nearest, claimed / unavailable / far hidden); ESLint; full type-checked production build |
| Business frontend unit (22 tests) | `npm --prefix business-frontend test` | form validation / contract input mapping (incl. 16-byte code limit); Arkiv signing: batching, key reporting, stop on failure, MetaMask rejection, account re-check, gas policy + auto split, Auto settle batches (predicted salts + transfer to the settler in the same batch), approval batches (`catched` + ownership → player, stop on rejection) |
| End-to-end | `npm --prefix worker run e2e` | spawns Anvil (chain 31338, port 8546), deploys with forge, Swarm upload through the API, `createCampaign` from a business account, VRF mock fulfilment, on-chain allocation, listener → per-creature Swarm assets → plan → **the business signs** the Arkiv entities with the page's code → verification against chain + Arkiv + Swarm, `$creator = business`, empty re-plan; then CreatureMarket: an **Auto settle** campaign (valid claim ~33 m away → transferred automatically + business feed; too far / second claim / foreign ticket refused on chain, nothing moves), the **Approval** campaign (claim listed for approval, approved with the business app's code), **redeem** (code only after redeeming, only for the owner), **marketplace** (escrow → attestation → list → buy pays the seller → buyer owns it on Arkiv; relist + unlist returns it; abandoned escrow returned) |

The e2e test writes to **real Arkiv (Rabdi)**: set `E2E_BUSINESS_PRIVATE_KEY` to a test key funded with tGLM
(it is used as the business on both chains). `E2E_ARKIV=memory` (set in the environment) swaps in an
in-memory Arkiv double and also injects a 7/10 partial failure + retry; in that mode Arkiv itself is not
exercised. Swarm is real unless `E2E_SWARM=memory` (an in-memory double, for when the public gateway is down).
Real Arkiv also needs `E2E_SETTLER_PRIVATE_KEY` (tGLM-funded); player-signed Arkiv writes (redeemed flag,
marketplace escrow) run in memory mode only, since the dev player keys hold no tGLM. Business-frontend
dependencies must be installed (the e2e imports the page's Arkiv module).

## 10. Dependency versions

All npm dependencies are pinned to exact versions (`package-lock.json` committed, install with `npm ci`).
Solidity libraries are git submodules pinned to tags (see `contracts/foundry.lock`).

| Package | Version |
|---|---|
| Node.js / npm | 22.22.0 / 10.9.4 (enforced) |
| Solidity / evm | 0.8.28 / cancun |
| forge-std | v1.17.0 |
| OpenZeppelin contracts | v5.7.0 |
| smartcontractkit/chainlink-brownie-contracts | 1.3.0 (mirror of `@chainlink/contracts`, VRF v2.5) |
| @arkiv-network/sdk | 1.0.1 |
| @ethersphere/bee-js | 13.2.0 |
| viem | 2.57.16 |
| typescript (Arkiv SDK peer) | 5.9.3 |
| vite | 7.3.7 |
| @google/model-viewer / three | 4.4.0 / 0.183.2 |
| leaflet | 1.9.4 |

## 11. Documented limitations

- **Arkiv lifetime**: entities cannot be permanent (max ≈182.5 days). Open-ended campaigns use the maximum
  lifetime; a scheduled `extendEntity` job is not implemented yet (entities are created with
  `permissionlessExtension`, so such a job does not need the business's key).
- **Business signs on Arkiv**: one MetaMask confirmation per `ARKIV_BATCH_SIZE` creatures (a 500-creature
  campaign = 63 confirmations at the default 8), and the business needs tGLM on Rabdi. Larger batches mean
  fewer confirmations but more gas per transaction; batches above the gas policy are split automatically.
- **Owner can edit**: entities are not `readonly` so the owner can set `listed` / `catched` / `redeemed` /
  `price`; the owner can therefore also patch other columns. The worker's verification compares rarity and
  reward with the chain, which stays the authoritative record.
- **Transfers on Arkiv**: Arkiv only lets the current owner `changeOwnership` (no delegation), so Approval needs
  the business's signature, and Auto settle / the marketplace rely on the settler's custody (keep its key
  server-side). Players need tGLM on Rabdi to redeem (flag) and to escrow a creature for sale.
- **Location is self-reported**: the contract checks the position the player's device sends (as the CRE referee
  did); a spoofed GPS cannot be detected on chain. The human ticket limits this to one verified human per wallet.
- **Tamper check**: a contract cannot read Arkiv, so the "untampered data" check of a listing is done by the
  settler before it signs the attestation that `CreatureMarket.list` requires.
- **Arkiv local node**: the official devnet harness (Kurtosis + Rust build) is marked "scaffold only", so local
  and e2e runs use the Rabdi testnet (or the in-memory double).
- **Swarm gateway** uploads (no own batch) are for demos only; durable storage requires your own Bee node and a
  postage batch with sufficient TTL. The bee-js 13 API is namespaced (`bee.file.upload`, `bee.stamp.get`);
  some docs pages still show the older `bee.uploadFile` form — the code follows the installed SDK's types.
- **VRF on Anvil**: there is no Chainlink node locally; the worker's `LocalVrfFulfiller` calls the official
  `VRFCoordinatorV2_5Mock.fulfillRandomWords` (as in Chainlink's local-testing guide). It is refused unless
  `CHAIN_ID=31337` and is never used on testnets. The mock's random words are not secure randomness.
- **Callback gas**: allocation runs inside `fulfillRandomWords`, so campaigns are capped at 500 creatures
  (`MAX_CREATURES`). If a callback ever failed, the business can call `retryRandomness` after 1 hour; the stale
  request is invalidated so it can never allocate twice.
- **On-chain storage**: creatures are retained on-chain as the campaign config + a 1-byte-per-creature shuffled
  rarity array; full creature records are derived by view functions (no per-creature storage writes).
- **Discount codes**: encrypted with one worker key (no rotation; losing or changing `CODE_ENCRYPTION_KEY`
  makes existing codes unreadable). Codes are limited to 16 bytes so the ciphertext fits the deployed
  contract's 64-byte limit (longer codes would need a contract change + redeploy). Campaigns created before
  encryption keep their codes in plaintext (they are already public on-chain). Descriptions stay public.
  Reveal signatures are verified as EOA (MetaMask) signatures; smart-contract wallets are not supported, and a
  signed reveal can be replayed by whoever intercepts it for up to 5 minutes (serve the worker over HTTPS).
