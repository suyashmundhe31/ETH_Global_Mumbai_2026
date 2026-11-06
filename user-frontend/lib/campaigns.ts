// A spawn as the map and the AR camera draw it: one per campaign, at the campaign's on-chain spawn point,
// showing that campaign's NEXT creature (lib/creatures.ts loadSpawns, verified against CreatureMarket).
// The claim itself is CreatureMarket.claim (lib/market.ts), which checks the same 50 m radius.

import mapboxgl from "mapbox-gl";
import { modelUrl } from "@/lib/arkiv";
import type { MapSpawn } from "@/lib/creatures";
import { CLAIM_RADIUS_M, VISIBLE_RADIUS_M } from "@/lib/geo";

export const VISIBLE_RADIUS = VISIBLE_RADIUS_M; // m — spawns shown on the map
export const CATCH_RADIUS = CLAIM_RADIUS_M; // m — CreatureMarket.CLAIM_RADIUS_M

export type Campaign = {
  /** Spawn id = campaign id (one spawn per campaign). */
  id: string;
  campaignId: string;
  businessName: string;
  discountDescription: string;
  lngLat: mapboxgl.LngLat;
  modelUrl: string; // the next creature's own GLB on Swarm
  expiresAt: number; // unix seconds, 0 = never
  spawn: MapSpawn;
};

export function toCampaign(s: MapSpawn): Campaign {
  return {
    id: s.campaignId,
    campaignId: s.campaignId,
    businessName: s.businessName,
    discountDescription: s.description,
    lngLat: new mapboxgl.LngLat(s.longitudeE6 / 1e6, s.latitudeE6 / 1e6),
    modelUrl: modelUrl(s.entity.swarmReference || s.entity.campaignSwarmReference),
    expiresAt: s.expiresAt,
    spawn: s,
  };
}
