# Reach: who it's for, and what happens after Mumbai

## Who it's for

| Who | What they get | Why they'd use it |
|---|---|---|
| **Local businesses** (cafés, shops, brands) | Footfall: players physically walk to their location to catch a creature, with a measurable campaign | A coupon campaign that people play, and every claim and redemption is countable |
| **Players** | A free AR game with real rewards (discounts), collectable rarities and a marketplace to trade them | Fun + value; rare creatures are worth something |
| **Brands and analysts** | An **open dataset of how people value brands**: which rewards get claimed, redeemed, or resold, and at what price | Insight no single company could collect alone (below) |

## The data others can build on

Every creature is a public Arkiv entity, created by the business, so the data is open, attributable and
machine-readable:

- **Claim rate per campaign:** `catched = true` vs. total. How strongly a location pulls people.
- **Redemption rate:** `redeemed = true`. Whether the reward actually converts to a visit or purchase.
- **Resale price by brand and rarity:** `listed = true` with `price`. **What people are willing to pay for a brand's
  reward.** A brand whose Legendary resells high has a strong image; one that never resells has a weak one.
- **Rarity premium:** price of `LEGENDARY` vs. `COMMON` for the same brand. How much people value scarcity and
  uniqueness, a signal of future trends.

All of this is a query away ([schema.md](schema.md) examples 7–8): no API key from us, no data-sharing agreement,
and nobody can quietly rewrite it.

## Who would use our copy on Arkiv after Mumbai

- **Businesses running campaigns** read their own funnel (created → claimed → redeemed → resold) straight from
  Arkiv, without trusting our dashboard.
- **Market researchers and brand teams** compare brands on the same open data: perceived value (resale prices),
  loyalty (redemptions), and reach (claims by location).
- **Other games and loyalty apps** can display or accept HunterVerse creatures, because the format is a public
  schema and `$creator` proves which business issued each one.
- **Auditors and players** can check that a campaign was fair: rarities come from Chainlink VRF on chain, ownership
  follows the contract, and Arkiv shows every transfer.

## Can they try it today?

Yes, on testnets:
- **Players:** the player app (Base Sepolia + Arkiv Rabdi). Log in with World ID, find a creature, claim it within
  50 m, redeem or sell it.
- **Businesses:** the business app. Launch a campaign with MetaMask, then watch claims and resales arrive.
- **Anyone:** open https://rabdi.explorer.arkiv.network/entity-explorer and paste a query from
  [schema.md](schema.md). The live data from our test campaigns is there now.

## After Mumbai

We plan to keep building:
1. **Pilot with real businesses in Mumbai:** a few cafés and shops in Bandra and Bandra-Kurla Complex (BKC) with real
   discounts, to measure footfall.
2. **Durability:** our own Swarm Bee node and postage batch, and a keeper that extends open-ended campaigns' Arkiv
   lifetimes.
3. **Brand insights page:** a public dashboard computed only from Arkiv queries (claim, redemption and resale
   metrics per brand).
4. **Mainnet**, when Arkiv's mainnet and our audits are ready.

Current reach: built and tested during ETHGlobal Mumbai 2026. Live on Rabdi are dozens of creature entities across
several test campaigns, with claims, redemptions and an auto-settled transfer.
