# Every Arkiv operation we use

All from `@arkiv-network/sdk` 1.0.1 on Rabdi. Each row names who signs, where the code is, and what the user sees.

## Writes

| Operation | Who signs | Where | What the user sees |
|---|---|---|---|
| `executeBatch({ creates })`: one entity per creature, in batches of 8 | **Business**, in MetaMask | `business-frontend/src/arkivWrite.js` → `writeCreatureBatches` | After launch, the creatures appear on the map with `$creator` = their wallet |
| `executeBatch({ creates, ownershipChanges })` with **`predictEntityKeys` + `salt`** | Business | same, `settleTo` option | **Auto settle**: create + hand to the settler in **one atomic transaction**; never half-done |
| `executeBatch({ patches: catched, ownershipChanges })` | Business | `business-frontend/src/arkivWrite.js` → `approveCatches` | **Approval**: the claim moves to the player's Profile |
| `executeBatch({ patches, ownershipChanges })` | **Settler** (worker key) | `worker/src/settler.js` → `reconcile` | **Auto settle**: the claim reaches the player within seconds, no click |
| `executeBatch({ patches: listed + price, ownershipChanges → settler })` | **Player** | `user-frontend/lib/arkiv.ts` → `escrowForSale` | "Sell": the creature enters the marketplace escrow |
| `patches` with **`unset: ["price"]`** + transfer | Settler | `worker/src/settler.js` | After a sale or unlist, the price disappears and the buyer / seller owns it |
| `executeBatch({ patches: redeemed = true })` | Player | `user-frontend/lib/arkiv.ts` → `markRedeemed` | The card shows "Redeemed", and the creature can't be listed |
| Repair patch (chain-derived columns) | Settler | `worker/src/settler.js` | Tampered rarity or reward text is restored before anyone can buy it |

All three signers use one write-safety policy (`shared/arkivGas.js`, from the `arkiv-write-safety` skill):
- **Explicit gas:** `max(1,000,000 + 400,000 × (ops − 1), 2 × estimate)`, from an **unsigned** estimate made
  through a guarded transport that cannot sign.
- **Oversized batches split:** a batch over half the block gas limit is split before anything is signed.
- **No blind retries:** writing stops at the first failure.
- **Lost receipts are reconciled** by transaction hash (`getTransactionReceipt` / `getTransaction`); a send without
  a hash is retried only when `getTransactionCount(latest) == pending`.

## Reads

| Operation | Where | Used for |
|---|---|---|
| `select(...).from(schema, { onMismatch }).where(...).createdBy(business)` | worker `arkiv.js` → `findCampaignEntities` | Plan: only the creatures still missing are signed (so retries never create duplicates). Verify: compare with the chain |
| `between(latitudeE6)` + `between(longitudeE6)` + `catched = false` + expiry | player `lib/arkiv.ts` → `campaignsInBox` | Map: creatures within 500 m |
| `select("*") ... createdBy(business) ... eq(creatureId)` | player + worker | Claim modal, settler, listing attestation (tamper check) |
| `.ownedBy(player)` | player `entitiesOwnedBy` | Profile / collection |
| `.ownedBy(settler)` + `listed = true` | player `loadMarket` | Marketplace |
| `.ownedBy(settler)` + `catched = true` | worker `findHeldBy` | Settler's sweep of escrows |
| `orderBy(asc("$key"))` + `gt("$key", key(last))` | everywhere | **Keyset paging**: a page can't skip an entity while new ones land mid-scan |
| `getEntity(key, schema)` | worker | Re-read one entity after a write |
| `predictEntityKeys({ owner, count })` | business app | Know the keys before signing (atomic create + transfer) |

## Lifetime

| Operation | Where |
|---|---|
| `ExpirationTime.atDate(campaign end, { atLeast: 10 min })` / `ExpirationTime.max()` | `shared/creatureEntity.js` → `creatureExpiration` |
| Flags `{ readonly: false, permissionlessExtension: true }` | `CREATURE_FLAGS`: lifecycle stays editable by the owner; anyone may extend the lifetime |
