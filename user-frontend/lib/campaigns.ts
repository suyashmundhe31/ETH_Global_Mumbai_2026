// Spawns = uncaught Arkiv creatures, placed at the exact coordinates stored on Arkiv (latitudeE6 /
// longitudeE6). Creatures of the same campaign at the same point share one spawn; a campaign placed at
// several points gets one spawn per point. Shown when the chain says this player may catch in that
// campaign (CatchManager.canSpawnFor). The catch itself is on chain: lib/chain.ts catchCreature.

import mapboxgl from "mapbox-gl";
import type { Creature } from "@/lib/arkiv";

export const VISIBLE_RADIUS = 1000; // m — spawns shown on the map
export const CATCH_RADIUS = 100; // m — catch button enabled (CRE enforces the same radius)

export type Campaign = {
  /** Spawn id: campaign + exact Arkiv coordinates. Unique per point on the map. */
  id: string;
  campaignId: string;
  businessName: string;
  discountDescription: string;
  lngLat: mapboxgl.LngLat; // exactly as stored on Arkiv
  creatures: Creature[]; // uncaught, unexpired (per Arkiv), at this point
  remaining: number;
  modelUrl: string; // GLB shown on the map: the first creature still up for grabs here
};

/** Arkiv stores coordinates as integer micro-degrees; the key uses them so equal points always match. */
const e6 = (deg: number) => Math.round(deg * 1e6);

/** One spawn per (campaign, exact point) within VISIBLE_RADIUS of `player`, limited to `spawnable` campaigns. */
export function visibleCampaigns(creatures: Creature[], spawnable: Set<string>, player: mapboxgl.LngLat): Campaign[] {
  const now = Date.now() / 1000;
  const groups = new Map<string, Creature[]>();
  for (const c of creatures) {
    if (c.expiresAtUnix !== 0 && c.expiresAtUnix <= now) continue; // 0 = no expiry
    if (!spawnable.has(c.campaignId)) continue;
    const key = `${c.campaignId}@${e6(c.lat)},${e6(c.lng)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: Campaign[] = [];
  for (const [id, list] of groups) {
    const first = list[0];
    const lngLat = new mapboxgl.LngLat(first.lng, first.lat);
    if (lngLat.distanceTo(player) > VISIBLE_RADIUS) continue;
    out.push({
      id,
      campaignId: first.campaignId,
      businessName: first.businessName,
      discountDescription: first.discountDescription,
      lngLat,
      creatures: list,
      remaining: list.length,
      modelUrl: list.reduce((a, c) => (c.creatureId < a.creatureId ? c : a)).modelUrl, // stable pick
    });
  }
  return out;
}
