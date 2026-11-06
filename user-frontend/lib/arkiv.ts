// Arkiv (Rabdi testnet): creature entities published by the business. Display only: the chain decides
// catches, ownership and redemption (lib/chain.ts). Writes go through MetaMask (no backend):
//   settleCatches  (business)  catched = true + ownership -> catcher
//   syncSold       (seller)    ownership -> buyer, after an on-chain sale
//   markRedeemed   (owner)     redeemed = true

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, between, eq, gt, or } from "@arkiv-network/sdk/query";
import { bool, defineSchema, i32, key, str, u64 } from "@arkiv-network/sdk/schema";
import { custom, http, isAddressEqual, zeroAddress, type Address, type EIP1193Provider, type Hex } from "viem";
import { ownersOf, walletFor } from "@/lib/chain";

/** The business wallet that publishes creatures. Only its entities are trusted (anyone can write
 *  an entity with our schema tag); once caught, an entity's ownership moves to the catcher. */
export const CREATURE_OWNER = "0x0913B468eeba5099cF6AEb61242423294D604fBa";

// Named schema → the SDK adds `arkiv.schema = "ethglobal-mumbai-2026.creature.v2"` to every query.
// Column types match what the node reports for these entities ($attributeSchema).
const CreatureSchema = defineSchema("ethglobal-mumbai-2026.creature.v2", {
  creatureId: str().indexed(),
  campaignId: u64().indexed(),
  businessName: str(),
  rarity: str().indexed(),
  discountCode: str(), // plaintext, or "e1.…" ciphertext (revealed only through redeem)
  discountDescription: str(),
  latitudeE6: i32().indexed(),
  longitudeE6: i32().indexed(),
  expiresAtUnix: u64().indexed(),
  swarmReference: str(), // Swarm manifest of this creature's GLB model
  catched: bool().indexed(),
  listed: bool().indexed(),
  redeemed: bool().indexed(),
});

export type Creature = {
  creatureId: string;
  campaignId: string;
  businessName: string;
  rarity: string;
  discountCode: string | null; // null when encrypted
  discountDescription: string;
  lat: number;
  lng: number;
  expiresAtUnix: number; // 0 = never expires
  modelUrl: string; // GLB on Swarm
};

const SWARM_GATEWAY = process.env.NEXT_PUBLIC_SWARM_GATEWAY || "https://api.gateway.ethswarm.org";
/** The manifest's index document is the GLB (served as model/gltf-binary, CORS open). */
export const swarmUrl = (reference: string) => `${SWARM_GATEWAY}/bzz/${reference}/`;

// An access key is not a secret (it ships with the app); without one the public endpoint is rate limited.
const rabdiChain = rabdi({ accessKey: process.env.NEXT_PUBLIC_ARKIV_ACCESS_KEY || "" });
const client = createPublicClient({ chain: rabdiChain, transport: http() });

const M_PER_DEG_LAT = 111_320;

/**
 * Uncaught, unexpired creatures within `radiusM` metres (bounding box, filtered server-side) of a point.
 * Callers still check exact distance and expiry.
 */
export async function fetchCreaturesNear(lat: number, lng: number, radiusM: number): Promise<Creature[]> {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const e6 = (deg: number) => i32(Math.round(deg * 1e6));
  const now = u64(Math.floor(Date.now() / 1000));

  const box = {
    lat: [e6(lat - dLat), e6(lat + dLat)],
    lng: [e6(lng - dLng), e6(lng + dLng)],
  } as const;

  const out: Creature[] = [];
  let after: Hex = `0x${"0".repeat(64)}`; // entity keys are 32 bytes; start below the smallest
  // Page by $key so pages line up even while new entities are written (100 rows per page max).
  for (;;) {
    const rows = await fetchPage(box, now, after);
    out.push(...rows.map(toCreature));
    if (rows.length < PAGE) return out;
    after = rows[rows.length - 1].$key;
  }
}

const PAGE = 100;
type Range = readonly [ReturnType<typeof i32>, ReturnType<typeof i32>];

const fetchPage = async (box: { lat: Range; lng: Range }, now: ReturnType<typeof u64>, after: Hex) =>
  (
    await client
      .select({
        $key: true,
        creatureId: true,
        campaignId: true,
        businessName: true,
        rarity: true,
        discountCode: true,
        discountDescription: true,
        latitudeE6: true,
        longitudeE6: true,
        expiresAtUnix: true,
        swarmReference: true,
      })
      .from(CreatureSchema, { onMismatch: "throw" })
      .where(
        and(
          between("latitudeE6", ...box.lat),
          between("longitudeE6", ...box.lng),
          or(eq("expiresAtUnix", u64(0)), gt("expiresAtUnix", now)), // 0 = no expiry
          eq("catched", bool(false)),
          gt("$key", key(after)),
        ),
      )
      .ownedBy(CREATURE_OWNER)
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch()
  ).entities;

const toCreature = (r: Awaited<ReturnType<typeof fetchPage>>[number]): Creature => ({
  creatureId: r.creatureId.value,
  campaignId: r.campaignId.value.toString(),
  businessName: r.businessName.value,
  rarity: r.rarity.value,
  discountCode: r.discountCode.value.startsWith("e1.") ? null : r.discountCode.value,
  discountDescription: r.discountDescription.value,
  lat: r.latitudeE6.value / 1e6,
  lng: r.longitudeE6.value / 1e6,
  expiresAtUnix: Number(r.expiresAtUnix.value),
  modelUrl: swarmUrl(r.swarmReference.value),
});

// ---------------------------------------------------------------------------------------------------------
// Ownership-scoped reads and MetaMask writes
// ---------------------------------------------------------------------------------------------------------

export type OwnedEntity = { key: Hex; creatureId: bigint; catched: boolean; redeemed: boolean };

/** Every creature entity `owner` holds on Arkiv. */
export async function entitiesOwnedBy(owner: Address): Promise<OwnedEntity[]> {
  const out: OwnedEntity[] = [];
  let after: Hex = `0x${"0".repeat(64)}`;
  for (;;) {
    const page = await client
      .select({ $key: true, creatureId: true, catched: true, redeemed: true })
      .from(CreatureSchema)
      .where(gt("$key", key(after)))
      .ownedBy(owner)
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch();
    for (const r of page.entities) {
      out.push({ key: r.$key, creatureId: BigInt(r.creatureId.value), catched: r.catched.value, redeemed: r.redeemed.value });
    }
    if (page.entities.length < PAGE) return out;
    after = page.entities[page.entities.length - 1].$key;
  }
}

const CHUNK = 20;

async function arkivWallet(account: Address) {
  await walletFor(rabdiChain, account); // switch (or add) MetaMask to Rabdi
  const eth = (window as unknown as { ethereum: EIP1193Provider }).ethereum;
  return createWalletClient({ chain: rabdiChain, transport: custom(eth), account });
}

type Move = { key: Hex; to: Address; markCatched: boolean };

/** One executeBatch per CHUNK. Re-running after a failure is safe: callers recompute the work from current state. */
async function runMoves(account: Address, moves: Move[], onProgress: (done: number, total: number) => void) {
  if (!moves.length) return 0;
  const wallet = await arkivWallet(account);
  onProgress(0, moves.length);
  for (let i = 0; i < moves.length; i += CHUNK) {
    const chunk = moves.slice(i, i + CHUNK);
    await wallet.executeBatch({
      patches: chunk.filter((m) => m.markCatched).map((m) => ({ schema: CreatureSchema, entityKey: m.key, set: { catched: true } })),
      ownershipChanges: chunk.map((m) => ({ entityKey: m.key, newOwner: m.to })),
    });
    onProgress(Math.min(i + CHUNK, moves.length), moves.length);
  }
  return moves.length;
}

/**
 * Business: move every caught creature's entity to its current on-chain owner (catched = true).
 * Entities the business no longer owns are skipped, so clicking again finishes a failed chunk.
 */
export async function settleCatches(business: Address, caught: { creatureId: bigint; owner: Address }[], onProgress: (done: number, total: number) => void) {
  const mine = new Map((await entitiesOwnedBy(business)).map((e) => [e.creatureId, e]));
  const moves = caught.flatMap(({ creatureId, owner }) => {
    const e = mine.get(creatureId);
    return e && !isAddressEqual(owner, business) ? [{ key: e.key, to: owner, markCatched: true }] : [];
  });
  return runMoves(business, moves, onProgress);
}

/** Seller: entities this wallet still holds whose creature now belongs to someone else on chain -> that owner. */
export async function syncSold(seller: Address, onProgress: (done: number, total: number) => void) {
  const held = (await entitiesOwnedBy(seller)).filter((e) => e.catched);
  const owners = await ownersOf(held.map((e) => e.creatureId));
  const moves = held.flatMap((e, i) => {
    const owner = owners[i].owner;
    return owner !== zeroAddress && !isAddressEqual(owner, seller) ? [{ key: e.key, to: owner, markCatched: false }] : [];
  });
  return runMoves(seller, moves, onProgress);
}

/** Owner: mirror the on-chain redemption on their Arkiv entity (no-op if they don't hold it yet). */
export async function markRedeemed(owner: Address, creatureId: bigint) {
  const e = (await entitiesOwnedBy(owner)).find((x) => x.creatureId === creatureId);
  if (!e || e.redeemed) return false;
  const wallet = await arkivWallet(owner);
  await wallet.patchEntity(CreatureSchema, e.key, { set: { redeemed: true } });
  return true;
}
