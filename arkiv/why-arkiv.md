# Why Arkiv (and not Postgres)

## If we swapped Arkiv for Postgres, what would users lose?

**1. Proof of who issued a creature.** On Arkiv, `$creator` is the business's own wallet, set by the network and
impossible to change. In Postgres, "issued by Café X" is a row we wrote and could rewrite. Players would have to trust
us that a Legendary really came from that business.

**2. Ownership that isn't ours to take back.** On Arkiv the creature's `$owner` is the player's wallet: only they can
patch it or hand it on. In Postgres the player would "own" a row that we (or anyone with database access) could
delete, re-assign or edit. You still own your data on Arkiv even though it is public.

**3. Public, verifiable history.** Every create, claim, approval, sale and redemption is an Arkiv transaction that
anyone can see. If a business, a player or we tried to cheat (quietly add a Legendary, move someone's creature,
inflate a rarity, fake a redemption), it would be visible to everyone. With Postgres, misconduct is invisible by
default.

**4. Open data without our permission.** Brands, researchers and other apps can run the same queries we do (rarity,
location, redeemed, listed, price) on the explorer or with the SDK. With Postgres they would need our API, our
uptime and our goodwill.

**5. Data that cleans itself up.** Creatures expire with their campaign (`ExpirationTime.atDate`). Postgres would
need our cron jobs; on Arkiv, an ended campaign disappears from every query on its own.

**6. A real query engine, not a custom indexer.** We filter by bounding box, `catched`, `listed`, `redeemed`,
`price` and `$owner` directly. With only a blockchain we'd have to build and host an indexer; with Postgres we'd be
back to trusting a server.

Our core rule: **the chain decides, Arkiv shows it to everyone, and nobody, including us, can quietly rewrite it.**

## What we kept off Arkiv, and why

| Kept off Arkiv | Where | Why |
|---|---|---|
| **Discount codes in plaintext** | Encrypted (`e1.` AES-256-GCM) before they reach the chain or Arkiv; the key is only in our worker | Arkiv is public. The code is the reward, revealed only to the owner after an on-chain redeem |
| **3D models** (3 KB to 4 MB) | Swarm; Arkiv stores the content hash ([swarm.md](swarm.md)) | Arkiv strings are ≤ 128 bytes; Swarm is built for files and is content-addressed |
| **Who owns a creature, redemption, sales and payments** | `CreatureMarket` contract on Base Sepolia | These move money and need atomic rules (exact price, seller paid in the same transaction, 50 m check, one claim per human). Arkiv mirrors the result |
| **Rarity randomness** | Chainlink VRF + on-chain Fisher–Yates | Provable fairness has to happen on chain before anything is written |
| **World ID ↔ wallet links** | The player app's private store | A nullifier tied to a wallet is personal data; publishing it would link a human's actions across campaigns |
| **Worker journal** (checkpoints, pending transactions) | Worker disk | Operational state that matters to nobody else |
