# Data quality

## Is the data up to date, and how does it stay that way?

**The chain is the source of truth, and Arkiv is kept in line with it continuously.**

- **Created from the chain:** each entity's payload is built by the worker from the contract after Chainlink VRF
  allocates the campaign (rarity, reward, location, expiry, VRF request id). The business signs exactly that.
- **Verified after writing:** the worker re-reads Arkiv (`$creator = business` + campaign) and compares each
  creature's rarity and encrypted reward with the chain. The campaign shows `COMPLETE`, or `PARTIAL` with the exact
  missing creature ids.
- **Kept current by the settler:** it follows `CreatureMarket` events (claim, list, unlist, sale) and sweeps the
  escrows it holds every minute. It converges each entity to the chain: owner, `catched`, `listed`, `redeemed`,
  `price`, and any tampered field.
- **Expires on time:** entities carry the campaign's end date as their Arkiv expiration, so ended campaigns leave
  every query automatically. What remains is live data.
- **No duplicates:** retries plan only creatures that are still missing, and a transaction whose outcome is unknown
  is reconciled by hash before anything is re-sent.

Live check (Rabdi, 7 Nov 2026): campaign 8 has **22 creatures on chain and exactly 22 entities**, one per
`creatureId`, with no duplicates.

## Can people filter it the way they actually search?

Yes. Arkiv gives us a **real query engine over decentralised storage**, so neither we nor anyone else has to write a
custom indexer:

- **Where?** A bounding box on `latitudeE6` / `longitudeE6`.
- **What?** `rarity`, `campaignId`, `creatureId`.
- **Whose?** `$creator` (issuing business) and `$owner` (current holder).
- **State?** `catched`, `listed`, `redeemed`, and `price` ranges.
- **Still running?** `expiresAtUnix`, and `$expiresAt` for the entity's lifetime.
- **Sorted:** `orderBy(desc("price", "u64"))`; paged by `$key`.

Ready-to-run examples are in [schema.md](schema.md#example-queries).

## Trust rules for anyone reading the data

1. Filter by **`$creator`** = the campaign's business (from `CreatureCampaignManager.getCampaign`). Anyone can copy
   the schema name.
2. For ownership, redemption and price, the **`CreatureMarket` contract** is the authority; Arkiv mirrors it within
   seconds (Auto settle and marketplace) or after the business approves (Approval).
3. **`discountCode` is ciphertext** by design.
