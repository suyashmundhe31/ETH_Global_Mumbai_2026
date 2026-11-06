// Campaigns = uncaught Arkiv creatures grouped by campaignId, shown when the chain says this player may
// catch there (CatchManager.canSpawnFor). The catch itself is on chain: lib/chain.ts catchCreature.

import mapboxgl from "mapbox-gl";
import type { Creature } from "@/lib/arkiv";

export const VISIBLE_RADIUS = 1000; // m — campaigns shown on the map
export const CATCH_RADIUS = 100; // m — catch button enabled (CRE enforces the same radius)

export type Campaign = {
  campaignId: string;
  businessName: string;
  discountDescription: string;
  lngLat: mapboxgl.LngLat;
  creatures: Creature[]; // uncaught, unexpired (per Arkiv)
  remaining: number;
  modelUrl: string; // GLB shown on the map: the first creature still up for grabs
};

/** One campaign per campaignId, within VISIBLE_RADIUS of `player`, limited to `spawnable` campaign ids. */
export function visibleCampaigns(creatures: Creature[], spawnable: Set<string>, player: mapboxgl.LngLat): Campaign[] {
  const now = Date.now() / 1000;
  const groups = new Map<string, Creature[]>();
  for (const c of creatures) {
    if (c.expiresAtUnix !== 0 && c.expiresAtUnix <= now) continue; // 0 = no expiry
    if (!spawnable.has(c.campaignId)) continue;
    groups.set(c.campaignId, [...(groups.get(c.campaignId) ?? []), c]);
  }
  const out: Campaign[] = [];
  for (const [campaignId, list] of groups) {
    // All creatures of a campaign share its location; average in case they ever differ slightly.
    const lng = list.reduce((s, c) => s + c.lng, 0) / list.length;
    const lat = list.reduce((s, c) => s + c.lat, 0) / list.length;
    const lngLat = new mapboxgl.LngLat(lng, lat);
    if (lngLat.distanceTo(player) > VISIBLE_RADIUS) continue;
    out.push({
      campaignId,
      businessName: list[0].businessName,
      discountDescription: list[0].discountDescription,
      lngLat,
      creatures: list,
      remaining: list.length,
      modelUrl: list.reduce((a, c) => (c.creatureId < a.creatureId ? c : a)).modelUrl, // stable pick
    });
  }
  return out;
}
