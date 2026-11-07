# How we use Arkiv

## Do the filters, edit rights and expiry fit what the app does?

### What we filter on is exactly what the screens need

Only fields we query are indexed (`shared/creatureEntity.js`). Everything else is stored but not indexed.

| Screen | Filter (indexed fields) |
|---|---|
| **Map:** creatures within 500 m | `latitudeE6` / `longitudeE6` `BETWEEN` (bounding box), `catched = false`, `expiresAtUnix` (0 or in the future), `chainId` + `contract` |
| **Claim modal:** this exact creature | `creatureId` + `$creator` = the campaign's business |
| **Profile:** my creatures | `$owner` = my wallet (+ `catched`) |
| **Marketplace:** for sale | `$owner` = settler, `listed = true`, `redeemed = false` |
| **Business page:** verify campaign / approvals | `$creator` = business, `campaignId`, `chainId`, `contract` |
| **Settler:** escrows to reconcile | `$owner` = settler, `catched = true` |
| **Brand insights** | `rarity`, `redeemed`, `listed`, `price` |

`businessName`, `discountDescription`, `discountCode`, the Swarm references and transaction hashes are shown, but
never filtered on, so they are **not indexed**. Every query pages by `$key` (keyset), so no row is skipped while new
creatures land.

### Who can edit each entity matches who owns the creature

- **`$creator` = business, forever.** It is our proof of authenticity; every reader checks it against the contract.
- **`$owner` follows the creature:**
  - business (Approval) or settler (Auto settle) before a claim;
  - the player after a claim;
  - the settler while listed (escrow);
  - the buyer after a sale.
- Only the current owner can change the lifecycle flags (`catched`, `listed`, `redeemed`, `price`), so a player can't
  touch a business's stock, and a business can't take back a player's creature.
- `readonly = false`, because flags must change. `permissionlessExtension = true`, so anyone can keep a campaign alive
  but can't edit it.
- If an owner tampers with a chain-derived field (for example, rarity), the settler refuses to list the creature and
  restores the field from the chain.

### Expiry matches the campaign

- **Campaign with an end date:** entities expire at that date (`ExpirationTime.atDate`). Expired campaigns vanish from
  the map, profiles and the marketplace with no clean-up job.
- **Campaign with no end date:** maximum lifetime (≈182.5 days), extendable by anyone.

## Does each Arkiv feature change something users see?

| Arkiv feature | What the user sees |
|---|---|
| **`$creator`** (immutable author) | Only genuine creatures appear on the map. A look-alike written by another wallet is ignored |
| **`$owner` + `changeOwnership`** | A claimed creature moves into the player's Profile; a bought one into the buyer's |
| **Atomic `executeBatch`** (patches + transfer in one transaction) | A claim, sale or listing is never half-done: a creature is never "sold but still listed" |
| **`predictEntityKeys` + create-then-transfer** | Auto settle: creatures are born in the settler's custody, so claims are delivered instantly |
| **Indexed attributes + `BETWEEN`** | The map loads only creatures near you |
| **`bool` flags** | Profile badges (Redeemed, For sale, Awaiting approval); the marketplace shows only unredeemed listings |
| **Optional `price` with `unset`** | Prices show only while listed and disappear after a sale |
| **Entity expiration** | Ended campaigns disappear by themselves; the map never shows expired rewards |
| **Public query engine + explorer** | Businesses can verify their campaign and approve claims; anyone can audit the data |
| **Typed schema (SDK)** | One schema shared by three apps; wrong types fail before they reach the chain |
