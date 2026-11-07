# Friction: what we'd improve in Arkiv

Overall, building on Arkiv was smooth. **Nothing broke in a way that cost us data**: every write either landed or
failed cleanly, and the SDK's typed schemas caught most mistakes before they reached the chain. These are the places
where we spent real time, in order of impact, each with what we expected, what happened, and how to reproduce it.

## 1. Transferring ownership is the hardest part of the model

**What we needed:** a player catches a creature; the entity should become theirs. Later, on a resale, the buyer's.

**What Arkiv gives:** only the current `$owner` can `changeOwnership`. There is no approval, delegation or "operator"
role, and no way to pre-authorise a transfer under a condition.

**What it cost us:**
- **Approval mode:** the business must come back and sign every transfer in MetaMask.
- **Auto settle:** we had to build a **custodial settler wallet** (a server key) that holds creatures and moves them
  when our contract says so.
- **Marketplace:** the seller must first hand the entity to that settler (escrow), and our server must sign an
  attestation so the sale contract accepts it.
- **Creating straight into custody** (create + transfer in one atomic batch) needed `predictEntityKeys` plus the
  `salt` trick, which we only found by reading the SDK source.

**What would make it simple, in order of preference:**
1. **Delegated transfer:** `approve(entityKey, operator)` / `setOperator(owner, operator)`, like ERC-721, so a
   contract or service can move an entity without holding it.
2. **Contract-controlled ownership:** let an EVM contract (or a signed message from the owner) authorise
   `changeOwnership`, so "whoever the contract says owns it" is enforceable natively.
3. **A `createFor(owner)` option** on create, so a creator can mint directly into someone else's ownership without
   predicting keys.

## 2. No private fields: we had to bring our own encryption

**What we needed:** each creature carries a **discount code**, which must stay secret until the owner redeems it.

**What happened:** every attribute is public, so we couldn't store the code as is.

**What we did:**
- AES-256-GCM in our worker, with the ciphertext bound to chain, contract, business and rarity (AAD).
- Format `e1.<base64url>`, sized to fit Arkiv's 128-byte string limit.
- The plaintext is revealed only to the on-chain owner after redemption.

**What would help:**
- A first-class "encrypted attribute" type, or an SDK helper with key-per-reader (for example, sealed to the current
  `$owner`).
- Docs showing the recommended pattern. The `arkiv-encryption` skill exists, but its library wasn't confirmed for
  SDK 1.0.

## 3. Typed literals: one silent failure

**Expected:** a type mismatch in a query is an error. Untagged strings already are:
`rarity = 'LEGENDARY'` → *"untagged strings are only valid for system attributes — write str('…')"*. Very helpful.

**What happened:** a bare **number** compared with a `u64` column returns **zero rows, silently**. The bare number is
read as `i32`, and the column is `u64`.

**Reproduce** (Rabdi, 7 Nov 2026):
```sql
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2') AND campaignId = 8        -- 0 rows, no error
arkiv.schema = str('ethglobal-mumbai-2026.creature.v2') AND campaignId = u64(8)   -- 22 rows
```

**Ask:** reject (or warn on) a literal whose type never matches the column's type in the schema, the same way
untagged strings are rejected.

Two smaller inconsistencies:
- `bool(true)` is rejected (*"bool takes no wrapper"*) while every other type requires its wrapper.
- `orderBy: desc("price")` without a schema fails until the type is given (`desc("price", "u64")`).

## 4. Gas estimation for batches

**Expected:** `executeBatch` with the wallet's default gas just works.

**What happened:** batches of 10 creatures needed **15.74M gas**, over half of Rabdi's 30M block gas limit. We
measured about 0.83M gas per creature at maximum field sizes, and wallet estimates were not reliable for these.

**What we built:** a shared gas policy (`shared/arkivGas.js`):
- an unsigned estimate through a guarded transport;
- `gas = max(1M + 400k·(ops−1), 2×estimate)`;
- automatic batch splitting above half the block gas limit.

**Ask:** an SDK helper that returns a safe gas limit for a batch, or splits a batch, plus the per-operation gas cost
in the docs.

## 5. Idempotent creates are the app's job

There is no unique constraint (for example, "one entity per `creatureId` per creator"). A retried create after a lost
receipt can produce a **duplicate**. We prevent it ourselves:
- plan only the creatures not yet on Arkiv (keyset scan by `$creator`);
- hold back creatures whose earlier transaction may still land;
- reconcile by transaction hash.

**Ask:** an optional uniqueness key on create (rejected if an entity with the same creator + key exists), or a
documented idempotency-key pattern.

## 6. Smaller things

- **Lifetime is capped** at ≈182.5 days. Open-ended campaigns need a keeper that calls `extendEntity`
  (`permissionlessExtension` helps; a built-in "auto-renew while funded" would remove the keeper).
- **MetaMask on Rabdi:** account permissions are per network, so the first write on Rabdi fails with 4100
  ("not authorized") until the site is re-authorised for that network. A note in the wallet-integration docs would
  save time.
- **The public endpoint is heavily rate-limited** without an access key. Clear, but easy to hit while testing; a
  per-IP dev quota would help.

## Did anything break?

No data was lost and no transaction was corrupted. The closest to "broken" was item 3 (a query silently returning
nothing), which we hit during development and now guard against by always using typed literals and shared schema
code.
