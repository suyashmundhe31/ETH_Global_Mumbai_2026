# HunterVerse on Arkiv

HunterVerse is an AR creature hunt. **Businesses** drop creatures on the map. **Players** catch them for real
discounts, then redeem or resell them. Every creature is an **Arkiv entity**: the business creates it, and its
ownership follows the creature from business → player → buyer, in the open.

| Document | What it answers |
|---|---|
| [schema.md](schema.md) | The entity, every field, which ones are queryable, who owns it, when it expires, example queries |
| [function.md](function.md) | Every Arkiv operation we use, where in the code, and what the user sees because of it |
| [swarm.md](swarm.md) | How the 3D models live on Swarm and how Arkiv points to them |
| [how-you-use-arkiv.md](how-you-use-arkiv.md) | **Judging:** filters, edit rights and expiry vs. what the app does |
| [why-arkiv.md](why-arkiv.md) | **Judging:** what users would lose on Postgres; what we kept off Arkiv |
| [reach.md](reach.md) | **Judging:** who it is for, can they try it, what's next |
| [friction.md](friction.md) | **Judging:** what got in our way, with reproductions |
| [data-quality.md](data-quality.md) | How the data stays current, verified and searchable |

**Network:** Arkiv **Rabdi** testnet. **SDK:** `@arkiv-network/sdk` 1.0.1. **Schema:** `ethglobal-mumbai-2026.creature.v2`.
**Explorer:** https://rabdi.explorer.arkiv.network/entity-explorer (paste any query from [schema.md](schema.md)).

```
Business wallet ──create (MetaMask)──▶ Creature entity  ($creator = business, forever)
                                          │ $owner moves with the creature:
   Approval:  business ──approve──▶ player ──escrow──▶ settler ──sale──▶ buyer
   Auto settle: settler ──claim──▶ player ──escrow──▶ settler ──sale──▶ buyer
                                          │ flags: catched · listed · redeemed · price
   3D model ◀── swarmReference ── Swarm (content-addressed .glb, one per creature)
   Truth for ownership/redemption ◀── CreatureMarket contract (Base Sepolia); Arkiv mirrors it
```
