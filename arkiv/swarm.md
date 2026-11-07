# Swarm: where the 3D creatures live

Arkiv strings are limited to 128 bytes, and a creature's 3D model is 3 KB to 4 MB. So the **model lives on Swarm**,
and the Arkiv entity carries its **content address** (`swarmReference`).

## Flow

1. **The business picks a `.glb`** (business app). The worker validates it (GLB header, chunks, size ≤ 10 MB) and
   uploads it with `bee.file.upload` (bee-js 13). This is the campaign's base model: `campaignSwarmReference`,
   also stored on chain in the campaign.
2. **Verify.** The worker downloads it again and compares SHA-256 before using the reference. If that fails, nothing
   goes on chain.
3. **One model per creature.** After Chainlink VRF allocates the campaign, the worker stamps each creature's own copy
   with its identity inside the glTF (`asset.extras.creature` = creatureId, campaignId, rarity, business, chain,
   contract) and uploads it.
   - Different bytes give a different, **content-addressed** reference per creature (`swarmReference`).
   - The output is deterministic, so re-uploading gives the same reference: retries are idempotent.
4. **Arkiv links it.** The entity's `swarmReference` points at that file; the business signs it into Arkiv.
5. **Players see it.** The map, the claim modal, the profile and the marketplace load `/bzz/<swarmReference>/` and
   render it with three.js.

## Why this split works

- **Tamper-evident:** a Swarm reference is the hash of the content. If anyone changed the model, the reference would
  change and no longer match the entity.
- **Self-describing:** the file itself says which creature it is (`asset.extras.creature`), so it can be checked
  without our servers.
- **Cheap, open queries:** the small, queryable facts (rarity, location, owner, flags) stay on Arkiv; the heavy bytes
  stay on Swarm.

## Configuration

| Setting | Demo | Production |
|---|---|---|
| `SWARM_BEE_URL` | `https://api.gateway.ethswarm.org` (public gateway stamps uploads itself) | your own Bee node |
| `SWARM_POSTAGE_BATCH_ID` | empty (`NULL_STAMP`) | a usable batch with enough TTL (checked with `bee.stamp.get` before uploading) |
| Read gateway | `https://download.gateway.ethswarm.org` (CORS open) | same, or your node |

The public gateway is for demos: its batch is short-lived. For durable storage we need our own Bee node and
postage batch (see [reach.md](reach.md#after-mumbai)).
