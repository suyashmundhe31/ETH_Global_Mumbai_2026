# AR Creature Campaigns — ETHGlobal Mumbai 2026

Businesses deploy digital **Creatures** at a location; players find and catch them for business rewards.
The repo has two web apps that share the contracts, the worker and the Arkiv schema:

| App | Folder | Who | What | Stack | Port |
|---|---|---|---|---|---|
| **Business interface** | [`business-frontend/`](business-frontend) | Businesses | Launch Campaign flow, end to end (below) | Vite, viem, `@arkiv-network/sdk` | 5173 |
| **User interface** | [`user-frontend/`](user-frontend) | Players | World ID login bound to a wallet, Mapbox game map with a 3D player avatar (see [User interface](#user-interface)) | Next.js 16, React 19, `@worldcoin/idkit`, mapbox-gl, three | 3000 |

```
.
├── business-frontend/   Business interface (Vite)
├── user-frontend/       User interface (Next.js)
├── worker/              Node API + chain listener (Swarm, Arkiv prepare/verify, discount codes)
├── contracts/           Foundry: CreatureCampaignManager + Chainlink VRF
├── shared/              Code used by worker + business-frontend (Arkiv schema, discount-code format)
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
| `contracts/` | Campaigns, VRF request/fulfilment, on-chain Fisher–Yates rarity allocation, authoritative creature records | Solidity 0.8.28, Foundry, Chainlink VRF v2.5 |
| `worker/` | Swarm uploads, chain event listener, Arkiv payload preparation + verification (read-only, no Arkiv key), HTTP API, local VRF simulator | Node 22, viem, `@ethersphere/bee-js`, `@arkiv-network/sdk` |
| `business-frontend/` | Launch Campaign page: form, MetaMask, `.glb` preview, map, status; the business signs the Arkiv entities | Vite, viem, `@arkiv-network/sdk`, `<model-viewer>`, Leaflet |
| `user-frontend/` | Player login (World ID + wallet) and game map | Next.js, React, `@worldcoin/idkit`, mapbox-gl, three |
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
  `chainId + contract + campaignId` — only creatures without a valid entity are offered for signing;
- the business signs independent batches (each one atomic `executeBatch`); a failed batch does not stop the
  others, a rejected signature stops the run;
- entity keys returned by each transaction are reported (`/arkiv/submissions`) and re-read with `getEntity`,
  so a lagging query index can never cause a duplicate — and they are never trusted blindly ($creator,
  rarity and reward must match the chain);
- `POST /api/campaigns/:id/arkiv/verify` checks Arkiv itself and reports `COMPLETE` or `PARTIAL` with the exact
  missing creature IDs; the "Sign missing creatures" button re-plans and signs only those.

Example: 10 creatures, 7 written → the retry plan contains exactly the 3 missing creatures (covered by
`worker/test/campaignArkiv.test.js` and the end-to-end test).

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
| [worker/.env.example](worker/.env.example) | `worker/.env` | chain RPC, Swarm node + postage batch, Arkiv network + access key (no Arkiv key) |
| [business-frontend/.env.example](business-frontend/.env.example) | `business-frontend/.env.local` | **public** values only: API URL, chain id, RPC, contract address, optional Arkiv access key |
| [user-frontend/.env.example](user-frontend/.env.example) | `user-frontend/.env.local` | World ID app / RP id / environment, Mapbox token + style (public), `RP_SIGNING_KEY` (**secret**, server-side only) |

Secrets (deployer key, Swarm batch, RPC provider keys) live only in `contracts/.env` / `worker/.env`.
Nobody's private key reaches the frontend or the worker at runtime: the business signs both the campaign
transaction and the Arkiv creature entities in MetaMask.

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

`ARKIV_PRIVATE_KEY` is no longer used (the worker warns if it is still set): the business signs the entities.

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

Terminal 3 — worker (set `LOCAL_VRF_FULFILLER_PRIVATE_KEY` in `worker/.env` first):

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
  - the current **Arkiv `$owner`** of a creature created by that business: that creature's code (today the
    business; after a capture transfer, the player).
  Signatures expire after 5 minutes. The page's "Reveal discount codes" button does this for the business.

## User interface

`user-frontend/` (Next.js App Router) is the players' app. Run it next to the business interface:

```bash
npm --prefix user-frontend run dev
```

then open http://localhost:3000 (production build: `npm --prefix user-frontend run build` then
`npm --prefix user-frontend start`; lint: `npm --prefix user-frontend run lint`). Configure
`user-frontend/.env.local` from [user-frontend/.env.example](user-frontend/.env.example) first.

Flow:
1. **Login** (`components/LoginButton.tsx`): MetaMask connects; `POST /api/rp-signature` returns a World ID RP
   signature and a challenge message the wallet signs; IDKit runs a World ID proof-of-human with the wallet
   address as the signal.
2. **Verify** (`app/api/verify/route.ts`): checks the wallet signature and that the challenge came from this
   server, that the proof is bound to the wallet (`signal_hash`), validates the proof with World's
   `developer.world.org/api/v4/verify`, then links **one human (nullifier) to one wallet**
   (`lib/players.ts`, stored in `players.json`, git-ignored) and sets an HMAC-signed `session` cookie.
3. **Map** (`app/page.tsx` → `components/MapClient.tsx` / `GameMap.tsx`): verified players get the Mapbox map
   with a three.js player avatar (`public/models/player.glb`) following GPS; dev mode (default outside
   production) walks with clicks / arrow keys. `POST /api/logout` clears the session.

The user interface does not read campaigns or creatures yet: creatures for the map come from Arkiv (query by
`$creator` = the campaign's business, see [Arkiv setup](#8-arkiv-setup-and-data-model)).

## 9. Tests

| What | Command | Covers |
|---|---|---|
| Contracts (33 tests, incl. fuzz) | `cd contracts` then `forge test` | distribution preservation (fuzzed), Fisher–Yates permutation + uniform sampling, unique IDs, reward ↔ rarity, VRF only from coordinator, duplicate/stale/unknown fulfilment ignored without revert, cancel/retry access control, validation, 500-creature callback gas |
| Worker unit (35 tests) | `npm --prefix worker test` | GLB validation + per-creature stamping, shared schema (new fields, no `business`), expiration, prepare/plan/verify: business = `$creator` = `$owner`, partial failure 7/10 → retry plans 3, lost receipts, index lag, look-alikes from other wallets ignored, forged rarity rejected, stale schema records, Swarm failure, listener retries, windowed log queries; discount codes: round trip, 64-byte fit, binding to business/rarity/key, tamper, reveal by business / creature owner only, signature replay + expiry |
| User frontend | `npm --prefix user-frontend run lint` then `npm --prefix user-frontend run build` | ESLint (next/core-web-vitals + TypeScript) and a full type-checked production build |
| Business frontend unit (11 tests) | `npm --prefix business-frontend test` | form validation / contract input mapping (incl. 16-byte code limit); Arkiv signing: batching, key reporting, failed batch continues, MetaMask rejection stops, Rabdi chain |
| End-to-end | `npm --prefix worker run e2e` | spawns Anvil (chain 31338, port 8546), deploys with forge, Swarm upload through the API, `createCampaign` from a business account, VRF mock fulfilment, on-chain allocation, listener → per-creature Swarm assets → plan → **the business signs** the Arkiv entities with the page's code → verification against chain + Arkiv + Swarm, `$creator = $owner = business`, empty re-plan |

The e2e test writes to **real Arkiv (Rabdi)**: set `E2E_BUSINESS_PRIVATE_KEY` to a test key funded with tGLM
(it is used as the business on both chains). `E2E_ARKIV=memory` (set in the environment) swaps in an
in-memory Arkiv double and also injects a 7/10 partial failure + retry; in that mode Arkiv itself is not
exercised. Swarm is real in both modes. Frontend dependencies must be installed (the e2e imports the page's
Arkiv module).

## 10. Dependency versions

All npm dependencies are pinned to exact versions (`package-lock.json` committed, install with `npm ci`).
Solidity libraries are git submodules pinned to tags (see `contracts/foundry.lock`).

| Package | Version |
|---|---|
| Node.js / npm | 22.22.0 / 10.9.4 (enforced) |
| Solidity / evm | 0.8.28 / cancun |
| forge-std | v1.17.0 |
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
  campaign = 50 confirmations at the default 10), and the business needs tGLM on Rabdi. Larger batches mean
  fewer confirmations but more gas per transaction; the SDK caps a transaction at 2^24 gas.
- **Owner can edit**: entities are not `readonly` so the owner can set `listed` / `catched` / `redeemed` /
  `price`; the owner can therefore also patch other columns. The worker's verification compares rarity and
  reward with the chain, which stays the authoritative record.
- **Capture transfer**: Arkiv only lets the current owner `changeOwnership` (no approvals / delegation), so
  transferring a creature to a player on capture needs a signature from the business wallet. Not implemented yet.
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
