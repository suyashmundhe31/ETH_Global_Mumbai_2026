// Distances exactly as CreatureMarket.distanceSquaredUm computes them (same integer math, BigInt), so the
// app enables "Claim it" if and only if the contract will accept the position. No imports: tested with
// `node --test` directly.

export const CLAIM_RADIUS_M = 50; // CreatureMarket.CLAIM_RADIUS_M
export const VISIBLE_RADIUS_M = 500; // creatures shown on the map

const UM_PER_MICRODEG = BigInt(111_320);
const BHASKARA_K = BigInt(32_400) * BigInt(10) ** BigInt(12);
const MAX_LON_E6 = BigInt(180_000_000);
const ZERO = BigInt(0);
const ONE_MILLION = BigInt(1_000_000);

export const toE6 = (deg: number) => Math.round(deg * 1e6);

const abs = (v: bigint) => (v < ZERO ? -v : v);

/** Squared distance in micrometres^2 from (latA, lonA) to (latB, lonB); cosine taken at latB (the spawn). */
export function distanceSquaredUm(latA: number, lonA: number, latB: number, lonB: number): bigint {
  const dLat = abs(BigInt(latA) - BigInt(latB));
  let dLon = abs(BigInt(lonA) - BigInt(lonB));
  if (dLon > MAX_LON_E6) dLon = BigInt(2) * MAX_LON_E6 - dLon;
  const lat = abs(BigInt(latB));
  const latSq = lat * lat;
  const dy = dLat * UM_PER_MICRODEG;
  const dx = (dLon * UM_PER_MICRODEG * (BHASKARA_K - BigInt(4) * latSq)) / (BHASKARA_K + latSq);
  return dx * dx + dy * dy;
}

/** Ground distance in metres between a player and a spawn, both in micro-degrees. */
export function distanceM(playerLatE6: number, playerLonE6: number, spawnLatE6: number, spawnLonE6: number): number {
  return Math.sqrt(Number(distanceSquaredUm(playerLatE6, playerLonE6, spawnLatE6, spawnLonE6))) / 1e6;
}

/** True exactly when CreatureMarket.claim accepts this position for this spawn. */
export function withinClaimRadius(playerLatE6: number, playerLonE6: number, spawnLatE6: number, spawnLonE6: number): boolean {
  const r = BigInt(CLAIM_RADIUS_M) * ONE_MILLION;
  return distanceSquaredUm(playerLatE6, playerLonE6, spawnLatE6, spawnLonE6) <= r * r;
}

/** Bounding box (micro-degrees) that contains the circle of `radiusM` around a point, with a 5% margin. */
export function boundingBoxE6(lat: number, lon: number, radiusM: number) {
  const dLat = (radiusM * 1.05) / 111_320;
  const dLon = (radiusM * 1.05) / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    minLat: toE6(Math.max(lat - dLat, -90)),
    maxLat: toE6(Math.min(lat + dLat, 90)),
    minLon: toE6(Math.max(lon - dLon, -180)),
    maxLon: toE6(Math.min(lon + dLon, 180)),
  };
}
