// The Creature entity as stored on Arkiv — ONE definition shared by the worker (prepares and
// verifies) and the frontend (the business signs the writes in MetaMask).
//
// This file has no imports: the caller passes the @arkiv-network/sdk module in, so it resolves the
// SDK from its own node_modules (worker/ or frontend/) and both sides use the exact same schema.
//
// Ownership: Arkiv sets $creator and $owner to the account that signs the create transaction. The
// business signs, so both are the business wallet — the schema deliberately has no "business"
// column. Verify authenticity with `$creator = <campaign.business read from the contract>`.

export const DEFAULT_SCHEMA_NAME = "ethglobal-mumbai-2026.creature.v2";

const BLOCK_SECONDS = 2; // Arkiv block time (Rabdi: 2 s blocks)

/** Creation flags. Not `readonly`: listed / catched / redeemed / price change over a creature's life
 *  (only the owner can patch). `permissionlessExtension` lets anyone (e.g. the worker) keep a
 *  creature alive with extendEntity without being able to change it. */
export const CREATURE_FLAGS = Object.freeze({ readonly: false, permissionlessExtension: true });

/** @param sdk the "@arkiv-network/sdk" module */
export function defineCreatureSchema(sdk, name = DEFAULT_SCHEMA_NAME) {
  const { defineSchema, str, u64, i32, addr, bool } = sdk;
  return defineSchema(name, {
    creatureId: str().indexed(), // uint256 as decimal string: (campaignId << 32) | index
    campaignId: u64().indexed(),
    creatureIndex: u64(),
    chainId: u64().indexed(),
    contract: addr().indexed(),
    businessName: str(),
    rarity: str().indexed(), // COMMON | RARE | EPIC | LEGENDARY
    discountCode: str(),
    discountDescription: str(),
    totalCreatures: u64(),
    latitudeE6: i32().indexed(),
    longitudeE6: i32().indexed(),
    expiresAtUnix: u64().indexed(), // 0 = campaign never expires
    swarmReference: str(), // this creature's own .glb
    campaignSwarmReference: str(), // the campaign's base .glb
    createdAt: u64(),
    campaignTxHash: str(),
    allocationTxHash: str(),
    vrfRequestId: str(),
    // Lifecycle (mutable by the owner).
    listed: bool().indexed().default(false),
    catched: bool().indexed().default(false),
    redeemed: bool().indexed().default(false),
    price: u64().indexed().optional(), // integer; absent (null) until a price is set
  });
}

/** Plain JSON payload (as produced by the worker) -> typed Arkiv values. */
export function toCreatureValues(sdk, p) {
  const { u64, addr } = sdk;
  const values = {
    creatureId: String(p.creatureId),
    campaignId: u64(BigInt(p.campaignId)),
    creatureIndex: u64(BigInt(p.creatureIndex)),
    chainId: u64(BigInt(p.chainId)),
    contract: addr(p.contract),
    businessName: String(p.businessName),
    rarity: String(p.rarity),
    discountCode: String(p.discountCode),
    discountDescription: String(p.discountDescription),
    totalCreatures: u64(BigInt(p.totalCreatures)),
    latitudeE6: Number(p.latitudeE6),
    longitudeE6: Number(p.longitudeE6),
    expiresAtUnix: u64(BigInt(p.expiresAtUnix)),
    swarmReference: String(p.swarmReference),
    campaignSwarmReference: String(p.campaignSwarmReference),
    createdAt: u64(BigInt(p.createdAt)),
    campaignTxHash: String(p.campaignTxHash ?? ""),
    allocationTxHash: String(p.allocationTxHash ?? ""),
    vrfRequestId: String(p.vrfRequestId),
    listed: Boolean(p.listed ?? false),
    catched: Boolean(p.catched ?? false),
    redeemed: Boolean(p.redeemed ?? false),
  };
  // null / undefined price = attribute not written (the column is optional).
  if (p.price !== null && p.price !== undefined && p.price !== "") values.price = u64(BigInt(p.price));
  return values;
}

/**
 * Arkiv entities always have a finite lifetime (at most MAX_LIFETIME blocks ~= 182.5 days, docs
 * "Expiration"). No campaign expiration -> maximum lifetime (expiresAtUnix stays 0 so readers know
 * it is open-ended); a campaign ending sooner expires its entities at that date.
 */
export function creatureExpiration(sdk, expiresAtUnix, nowMs = Date.now()) {
  const { ExpirationTime, MAX_LIFETIME } = sdk;
  const maxSeconds = Number(MAX_LIFETIME) * BLOCK_SECONDS;
  const exp = Number(expiresAtUnix);
  if (!exp) return { expiration: ExpirationTime.max(), mode: "max-lifetime" };
  const secondsLeft = exp - Math.floor(nowMs / 1000);
  // Leave a margin for blocks produced between now and inclusion.
  if (secondsLeft >= maxSeconds - 3600) return { expiration: ExpirationTime.max(), mode: "max-lifetime (campaign ends later)" };
  return {
    expiration: ExpirationTime.atDate(new Date(exp * 1000), { atLeast: ExpirationTime.fromMinutes(10) }),
    mode: "campaign-expiration",
  };
}

/** The `creates` list for one walletClient.executeBatch call. */
export function creatureCreates(sdk, schema, payloads, expiration) {
  return payloads.map((p) => ({ schema, values: toCreatureValues(sdk, p), expiration, flags: { ...CREATURE_FLAGS } }));
}
