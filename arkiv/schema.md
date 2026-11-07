# Schema: the Creature entity

One entity per creature. The definition is shared by the worker, the business app and the player app:
[`shared/creatureEntity.js`](../shared/creatureEntity.js). Its schema name is
**`ethglobal-mumbai-2026.creature.v2`**, which the SDK writes as the indexed `arkiv.schema` attribute on every entity.

## Fields

### Identity
| Field | Type | Indexed | Meaning |
|---|---|:---:|---|
| `creatureId` | `str` | ✅ | `(campaignId << 32) \| index`, a uint256 as a decimal string |
| `campaignId` | `u64` | ✅ | Campaign on the `CreatureCampaignManager` contract |
| `creatureIndex` | `u64` | | Position inside the campaign (the order was shuffled by Chainlink VRF) |
| `chainId` | `u64` | ✅ | Chain of the contracts (84532 = Base Sepolia) |
| `contract` | `addr` | ✅ | `CreatureCampaignManager` address |

### Business and reward
| Field | Type | Indexed | Meaning |
|---|---|:---:|---|
| `businessName` | `str` | | Display name |
| `rarity` | `str` | ✅ | `COMMON` · `RARE` · `EPIC` · `LEGENDARY` |
| `discountCode` | `str` | | **Encrypted** (`e1.` + AES-256-GCM); see [why-arkiv.md](why-arkiv.md#what-we-kept-off-arkiv-and-why) |
| `discountDescription` | `str` | | Public reward text, e.g. "25% off any drink" |
| `totalCreatures` | `u64` | | Campaign size |

### Location and lifetime
| Field | Type | Indexed | Meaning |
|---|---|:---:|---|
| `latitudeE6` / `longitudeE6` | `i32` | ✅ | Spawn point in micro-degrees (the map queries a bounding box) |
| `expiresAtUnix` | `u64` | ✅ | Campaign end, unix seconds (`0` = no end date) |

### Provenance
| Field | Type | Indexed | Meaning |
|---|---|:---:|---|
| `swarmReference` | `str` | | This creature's own 3D model on Swarm ([swarm.md](swarm.md)) |
| `campaignSwarmReference` | `str` | | The campaign's base model on Swarm |
| `createdAt` | `u64` | | When VRF allocated the creature (unix seconds) |
| `campaignTxHash` / `allocationTxHash` | `str` | | Chain transactions: campaign creation and VRF allocation |
| `vrfRequestId` | `str` | | Chainlink VRF request that shuffled the campaign |

### Lifecycle
| Field | Type | Indexed | Meaning |
|---|---|:---:|---|
| `catched` | `bool` | ✅ | Claimed by a player (default `false`) |
| `listed` | `bool` | ✅ | On the marketplace (default `false`) |
| `redeemed` | `bool` | ✅ | Discount used; can never be sold again (default `false`) |
| `price` | `u64` (optional) | ✅ | Asking price in wei while listed; absent otherwise |

### System fields (set by Arkiv)
| Field | Type | Meaning |
|---|---|---|
| `$key` | `key` | Entity key |
| `$creator` | `addr` | **Always the business wallet.** Immutable, so it is our proof of authenticity |
| `$owner` | `addr` | Whoever holds the creature now (see below) |
| `$expiresAt` | `u64` | Block number at which Arkiv deletes the entity |

Anyone can write an entity with this schema name. Every reader therefore also requires
`$creator = <the campaign's business, read from the contract>`, and the business is never taken from the entity.

## Who owns it, and who can edit it

Only the current `$owner` can patch an entity or transfer it; that is an Arkiv rule. `$creator` never changes.
`readonly = false` (lifecycle flags change), and `permissionlessExtension = true` (anyone may extend its lifetime,
but not change it).

| Stage | `$owner` | Who signs the change |
|---|---|---|
| Created, **Approval** campaign | business | business (MetaMask) creates it |
| Created, **Auto settle** campaign | settler wallet | business creates + transfers, in **one atomic batch** |
| Claimed | player | Approval: business clicks Approve. Auto: the settler, automatically. Patch `catched = true` + transfer |
| Redeemed | player | player: patch `redeemed = true` |
| Listed for sale | settler (escrow) | player: patch `listed = true`, `price` + transfer to the settler, in one batch |
| Sold / unlisted | buyer / seller | settler: transfer + `listed = false`, `price` unset |

The contract `CreatureMarket` decides who may hold a creature. The settler only moves an entity to match the
chain, and repairs any field that doesn't match it.

## When it expires

Arkiv entities always have a lifetime (at most `MAX_LIFETIME` ≈ 182.5 days on Rabdi), set at creation by
`creatureExpiration()`:

| Campaign | Arkiv lifetime |
|---|---|
| Ends on a date (`expiresAtUnix > 0`) | `ExpirationTime.atDate(campaign end)`, so the entity disappears when the campaign ends |
| No end date, or ends after ~182 days | `ExpirationTime.max()`; `permissionlessExtension` lets a keeper extend it |

Expired campaigns therefore leave the map, the marketplace and every query on their own.

## Example queries

Arkiv's query language works like a SQL `WHERE` clause (`AND`, `OR`, `BETWEEN`, comparisons), with **typed
literals**: `str('…')`, `u64(…)`, `i32(…)`, `addr(0x…)`, and bare `true` / `false`. Paste any of these into the
[entity explorer](https://rabdi.explorer.arkiv.network/entity-explorer). **All were run against Rabdi on 7 Nov 2026.**
The values are our Base Sepolia deployment: business `0x0913…4fBa`, settler `0x84aA…672b`, contract `0xF0Cb…8F83`.

**1. Every creature of one business** (what the business page verifies)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $creator = addr(0x0913B468eeba5099cF6AEb61242423294D604fBa)
AND chainId = u64(84532) AND contract = addr(0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83)
```

**2. The map: uncaught, unexpired creatures near Bandra-Kurla Complex** (the player app's first query)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND chainId = u64(84532) AND contract = addr(0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83)
AND latitudeE6 BETWEEN i32(19013752) AND i32(19113752)
AND longitudeE6 BETWEEN i32(72816245) AND i32(72916245)
AND catched = false
AND (expiresAtUnix = u64(0) OR expiresAtUnix > u64(1794015057))
```

**3. One creature** (what the claim modal loads)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $creator = addr(0x0913B468eeba5099cF6AEb61242423294D604fBa)
AND creatureId = str('34359738368')
```

**4. Rare drops of one campaign**
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $creator = addr(0x0913B468eeba5099cF6AEb61242423294D604fBa)
AND campaignId = u64(8) AND (rarity = str('LEGENDARY') OR rarity = str('EPIC'))
```

**5. The marketplace** (escrowed with the settler, listed, not redeemed)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $owner = addr(0x84aAd29baB0668fC7DdF227f0f68e37a7142672b)
AND listed = true AND catched = true AND redeemed = false
```

**6. A player's collection** (the Profile page)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $owner = addr(0x<player wallet>) AND catched = true
```

**7. Brand insight: how many rewards were actually redeemed**
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $creator = addr(0x0913B468eeba5099cF6AEb61242423294D604fBa)
AND redeemed = true
```

**8. Brand insight: listings above 0.001 ETH** (in the SDK, sort with `orderBy: desc("price", "u64")`)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND listed = true AND price >= u64(1000000000000000)
```

**9. Auto-settle stock still waiting for a player** (held by the settler, not yet caught)
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2')
AND $creator = addr(0x0913B468eeba5099cF6AEb61242423294D604fBa)
AND $owner = addr(0x84aAd29baB0668fC7DdF227f0f68e37a7142672b) AND catched = false
```

The same query in the SDK (player app, `user-frontend/lib/arkiv.ts`):

```ts
client.select("*").from(CreatureSchema, { onMismatch: "skip" })
  .where(and(eq("chainId", u64(84532n)), eq("contract", addr(CAMPAIGN_MANAGER)),
             between("latitudeE6", i32(minLat), i32(maxLat)), between("longitudeE6", i32(minLon), i32(maxLon)),
             eq("catched", bool(false)), or(eq("expiresAtUnix", u64(0n)), gt("expiresAtUnix", u64(now)))))
  .orderBy(asc("$key")).limit(100).fetch();   // keyset paging: gt("$key", key(last)) for the next page
```

**Typing pitfall** (see [friction.md](friction.md)): `campaignId = 8` returns **0 rows without an error**. Write
`campaignId = u64(8)`.
