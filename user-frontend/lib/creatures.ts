"use client";

// What each page shows: Arkiv entities cross-checked against the contracts (the authority).

import type { Address } from "viem";
import { campaignsInBox, creatureEntity, entitiesOwnedBy, type CreatureEntity } from "@/lib/arkiv";
import type { AppConfig } from "@/lib/config";
import { VISIBLE_RADIUS_M, boundingBoxE6, toE6 } from "@/lib/geo";
import { RARITIES, campaignOf, campaignState, getCampaign, getCreature, getHolding, getListing, getPlayerClaims, isZero, type Holding, type Listing } from "@/lib/market";
import { selectSpawns, type CampaignCandidate, type Spawn } from "@/lib/spawns";

export const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Campaign id -> business wallet, read from the contract (cached for the page's lifetime). */
const businessCache = new Map<string, Promise<Address>>();
function businessOf(cfg: AppConfig, campaignId: string): Promise<Address> {
  let p = businessCache.get(campaignId);
  if (!p) {
    p = getCampaign(cfg, BigInt(campaignId)).then((c) => c.business);
    p.catch(() => businessCache.delete(campaignId));
    businessCache.set(campaignId, p);
  }
  return p;
}

/** Only entities written by their campaign's business are real creatures. */
async function trusted(cfg: AppConfig, entities: CreatureEntity[]) {
  const ok = await Promise.all(entities.map(async (e) => same(e.creator, await businessOf(cfg, e.campaignId).catch(() => null))));
  return entities.filter((_, i) => ok[i]);
}

// ------------------------------------------------------------------ map

export type MapSpawn = Spawn & {
  entity: CreatureEntity;
  rarity: string;
  businessName: string;
  description: string;
  expiresAt: number; // unix seconds, 0 = never
  mode: "auto" | "approval";
};

/**
 * The creatures this player may claim around (lat, lon): Arkiv entities within VISIBLE_RADIUS_M, verified on
 * chain, one per business (lib/spawns.ts), each being its campaign's next creature.
 */
export async function loadSpawns(cfg: AppConfig, player: Address, lat: number, lon: number): Promise<MapSpawn[]> {
  const groups = await campaignsInBox(cfg, boundingBoxE6(lat, lon, VISIBLE_RADIUS_M));
  const candidates = (
    await Promise.all(
      [...groups].map(async ([campaignId, creators]): Promise<CampaignCandidate | null> => {
        const s = await campaignState(cfg, BigInt(campaignId), player).catch(() => null);
        if (!s || !creators.has(s.campaign.business.toLowerCase())) return null; // only the business's own entities
        return {
          campaignId,
          business: s.campaign.business,
          latitudeE6: s.campaign.latitudeE6,
          longitudeE6: s.campaign.longitudeE6,
          nextCreatureId: s.nextCreatureId.toString(),
          available: s.available,
          claimedByPlayer: s.claimedByPlayer,
        };
      }),
    )
  ).filter((c): c is CampaignCandidate => c !== null);

  const spawns = selectSpawns(candidates, toE6(lat), toE6(lon));
  const resolved = await Promise.all(
    spawns.map(async (s): Promise<MapSpawn | null> => {
      const [entity, creature] = await Promise.all([
        creatureEntity(cfg, s.nextCreatureId, s.business as Address),
        getCreature(cfg, BigInt(s.nextCreatureId)).catch(() => null),
      ]);
      if (!entity || !creature || entity.catched) return null; // not on Arkiv yet
      const rarity = RARITIES[creature.rarity];
      if (entity.rarity !== rarity) return null; // Arkiv must agree with the chain
      const mode = same(entity.owner, cfg.settlerAddress) ? "auto" : same(entity.owner, s.business) ? "approval" : null;
      if (!mode) return null;
      return {
        ...s,
        entity,
        rarity,
        businessName: creature.businessName,
        description: creature.discountDescription,
        expiresAt: Number(creature.expiresAt),
        mode,
      };
    }),
  );
  return resolved.filter((s): s is MapSpawn => s !== null);
}

// ------------------------------------------------------------------ profile

export type ProfileStatus =
  | "owned" // Arkiv entity is the player's
  | "listed" // for sale: in the settler's escrow and listed on chain
  | "escrow" // in escrow without an on-chain listing (listing in progress, or being returned)
  | "awaiting-approval" // claimed on chain; the business has not approved the Arkiv transfer yet
  | "transferring"; // claimed on chain; the settler is moving it on Arkiv

export type ProfileItem = { creatureId: string; entity: CreatureEntity; holding: Holding; listing: Listing; status: ProfileStatus };

export async function loadProfile(cfg: AppConfig, player: Address): Promise<ProfileItem[]> {
  const [owned, escrowed, claims] = await Promise.all([
    entitiesOwnedBy(cfg, player).then((es) => trusted(cfg, es)),
    entitiesOwnedBy(cfg, cfg.settlerAddress, { catched: true }).then((es) => trusted(cfg, es)),
    getPlayerClaims(cfg, player),
  ]);
  const byId = new Map<string, { entity: CreatureEntity; held: "player" | "escrow" }>();
  for (const e of owned) byId.set(e.creatureId, { entity: e, held: "player" });
  for (const e of escrowed) if (!byId.has(e.creatureId)) byId.set(e.creatureId, { entity: e, held: "escrow" });

  // Claims whose entity is not with the player yet (approval pending / auto transfer in progress).
  const missing = claims.map(String).filter((id) => !byId.has(id));
  await Promise.all(
    missing.map(async (id) => {
      const e = await creatureEntity(cfg, id, await businessOf(cfg, campaignOf(BigInt(id)).toString()));
      if (e) byId.set(id, { entity: e, held: "escrow" });
    }),
  );

  const items = await Promise.all(
    [...byId].map(async ([id, { entity, held }]): Promise<ProfileItem | null> => {
      const [holding, listing] = await Promise.all([getHolding(cfg, BigInt(id)), getListing(cfg, BigInt(id))]);
      const mineOnChain = same(holding.owner, player);
      if (held === "player") return mineOnChain ? { creatureId: id, entity, holding, listing, status: "owned" } : null;
      if (same(listing.seller, player)) return { creatureId: id, entity, holding, listing, status: "listed" };
      if (!mineOnChain) return null;
      if (entity.catched && same(entity.owner, cfg.settlerAddress)) return { creatureId: id, entity, holding, listing, status: "escrow" };
      if (same(entity.owner, cfg.settlerAddress)) return { creatureId: id, entity, holding, listing, status: "transferring" };
      return { creatureId: id, entity, holding, listing, status: "awaiting-approval" };
    }),
  );
  return items.filter((i): i is ProfileItem => i !== null).sort((a, b) => Number(b.holding.claimedAt - a.holding.claimedAt));
}

// ------------------------------------------------------------------ marketplace

export type MarketItem = { creatureId: string; entity: CreatureEntity; seller: Address; price: bigint; mine: boolean };

/** Verified listings: escrowed with the settler (listed = true) AND listed on chain at the same price. */
export async function loadMarket(cfg: AppConfig, player: Address): Promise<MarketItem[]> {
  const escrowed = await trusted(cfg, await entitiesOwnedBy(cfg, cfg.settlerAddress, { listed: true, catched: true }));
  const items = await Promise.all(
    escrowed.map(async (e): Promise<MarketItem | null> => {
      const [listing, holding] = await Promise.all([getListing(cfg, BigInt(e.creatureId)), getHolding(cfg, BigInt(e.creatureId))]);
      if (isZero(listing.seller) || holding.redeemed || e.price === null || listing.price !== e.price) return null;
      return { creatureId: e.creatureId, entity: e, seller: listing.seller, price: listing.price, mine: same(listing.seller, player) };
    }),
  );
  return items.filter((i): i is MarketItem => i !== null);
}

/** Polls Arkiv until `creatureId`'s entity (created by its business) is owned by `owner`. */
export async function waitForArkivOwner(cfg: AppConfig, creatureId: string, owner: Address, timeoutMs = 120_000) {
  const business = await businessOf(cfg, campaignOf(BigInt(creatureId)).toString());
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const e = await creatureEntity(cfg, creatureId, business).catch(() => null);
    if (e && same(e.owner, owner)) return e;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}
