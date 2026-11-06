// Which creatures the map shows (pure logic, no imports besides geo; tested with `node --test`).
//
//   * Only campaigns within VISIBLE_RADIUS_M of the player, verified on chain (the Arkiv entity's creator is
//     the campaign's business, the campaign is allocated, not expired, not depleted).
//   * Never a campaign this player already claimed from (one creature per player per campaign).
//   * The creature shown is the campaign's NEXT one on CreatureMarket: creature indexes were shuffled by
//     Chainlink VRF, so its rarity is random and nobody can pick another.
//   * One creature per business: if a business has several campaigns nearby, only the nearest is shown.
//   * Remaining / total counts are never exposed to the UI.

import { VISIBLE_RADIUS_M, distanceM } from "./geo.ts";

export type CampaignCandidate = {
  campaignId: string;
  business: string; // from the contract
  latitudeE6: number;
  longitudeE6: number;
  nextCreatureId: string; // CreatureMarket.nextCreature
  available: boolean; // CreatureMarket.nextCreature: allocated, not expired, not depleted
  claimedByPlayer: boolean; // CreatureMarket.claimedIn(player, campaign) != 0
};

export type Spawn = CampaignCandidate & { distanceM: number };

export function selectSpawns(candidates: CampaignCandidate[], playerLatE6: number, playerLonE6: number): Spawn[] {
  const best = new Map<string, Spawn>();
  for (const c of candidates) {
    if (!c.available || c.claimedByPlayer) continue;
    const d = distanceM(playerLatE6, playerLonE6, c.latitudeE6, c.longitudeE6);
    if (d > VISIBLE_RADIUS_M) continue;
    const key = c.business.toLowerCase();
    const prev = best.get(key);
    // Nearest campaign of the business wins; ties go to the lower campaign id (stable across refreshes).
    if (!prev || d < prev.distanceM || (d === prev.distanceM && BigInt(c.campaignId) < BigInt(prev.campaignId))) {
      best.set(key, { ...c, distanceM: d });
    }
  }
  return [...best.values()].sort((a, b) => a.distanceM - b.distanceM);
}
