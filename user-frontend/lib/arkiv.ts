"use client";

// Arkiv: the creature entities (schema shared with the worker and the business app). Reads come straight from
// Arkiv; writes are signed by the player in MetaMask on the Arkiv network:
//   escrowForSale  listed = true, price, ownership -> settler (the marketplace escrow), one atomic batch
//   markRedeemed   redeemed = true (after CreatureMarket.redeem)
// Anyone can write an entity with this schema name, so an entity is only trusted when its $creator is the
// campaign's business READ FROM THE CONTRACT (checked by the callers).

import * as sdk from "@arkiv-network/sdk";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { localhost, rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, between, eq, gt, or } from "@arkiv-network/sdk/query";
import { addr, bool, i32, key, str, u64 } from "@arkiv-network/sdk/schema";
import { custom, http, type Address, type Hex } from "viem";
import { rabdiBatchTxParams } from "../../shared/arkivGas.js";
import { defineCreatureSchema } from "../../shared/creatureEntity.js";
import { isEncryptedCode } from "../../shared/discountCodes.js";
import type { AppConfig } from "@/lib/config";
import { ensureWallet, provider } from "@/lib/metamask";

const PAGE = 100; // query engine maximum
const MAX_PAGES = 20;

export type CreatureEntity = {
  key: Hex;
  creator: Address;
  owner: Address;
  creatureId: string;
  campaignId: string;
  index: number;
  businessName: string;
  rarity: string;
  discountDescription: string;
  discountCodeEncrypted: boolean;
  latitudeE6: number;
  longitudeE6: number;
  expiresAtUnix: number;
  swarmReference: string;
  listed: boolean;
  catched: boolean;
  redeemed: boolean;
  price: bigint | null;
};

/** The creature's own 3D model on Swarm, served through this app (/api/swarm -> worker). */
export const modelUrl = (swarmReference: string) => `/api/swarm/${swarmReference}`;

export function arkivChain(cfg: AppConfig) {
  if (cfg.arkivNetwork === "localhost") return cfg.arkivRpcUrl ? { ...localhost, rpcUrls: { default: { http: [cfg.arkivRpcUrl] } } } : localhost;
  return rabdi({ accessKey: "" }); // public endpoint; reads are light
}

const schemas = new Map<string, ReturnType<typeof defineCreatureSchema>>();
const schemaOf = (cfg: AppConfig) => {
  let s = schemas.get(cfg.arkivSchema);
  if (!s) schemas.set(cfg.arkivSchema, (s = defineCreatureSchema(sdk, cfg.arkivSchema)));
  return s;
};

let reader: { id: string; client: ReturnType<typeof createPublicClient> } | null = null;
function client(cfg: AppConfig) {
  const id = `${cfg.arkivNetwork}:${cfg.arkivRpcUrl}`;
  if (!reader || reader.id !== id) reader = { id, client: createPublicClient({ chain: arkivChain(cfg), transport: http(), cacheTime: 0 }) };
  return reader.client;
}

type Row = Record<string, unknown> & { $key: Hex; $creator: Address; $owner: Address };
const v = (row: Row, k: string) => {
  const x = row[k] as { value?: unknown } | undefined;
  return x && typeof x === "object" && "value" in x ? x.value : x;
};

function toEntity(row: Row): CreatureEntity {
  const price = v(row, "price");
  return {
    key: row.$key,
    creator: row.$creator,
    owner: row.$owner,
    creatureId: String(v(row, "creatureId")),
    campaignId: String(v(row, "campaignId")),
    index: Number(v(row, "creatureIndex")),
    businessName: String(v(row, "businessName") ?? ""),
    rarity: String(v(row, "rarity") ?? ""),
    discountDescription: String(v(row, "discountDescription") ?? ""),
    discountCodeEncrypted: isEncryptedCode(String(v(row, "discountCode") ?? "")),
    latitudeE6: Number(v(row, "latitudeE6")),
    longitudeE6: Number(v(row, "longitudeE6")),
    expiresAtUnix: Number(v(row, "expiresAtUnix") ?? 0),
    swarmReference: String(v(row, "swarmReference") ?? ""),
    listed: v(row, "listed") === true,
    catched: v(row, "catched") === true,
    redeemed: v(row, "redeemed") === true,
    price: price === undefined || price === null ? null : BigInt(price as bigint),
  };
}

const deployment = (cfg: AppConfig) => and(eq("chainId", u64(BigInt(cfg.chainId))), eq("contract", addr(cfg.campaignManager)));

/** Keyset traversal over every page of a query (ordered by the immutable $key). */
async function all(cfg: AppConfig, build: (after: Hex | null) => { fetch: () => Promise<{ entities: readonly unknown[] }> }) {
  const out: CreatureEntity[] = [];
  let after: Hex | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = (await build(after).fetch()).entities as Row[];
    out.push(...rows.map(toEntity));
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].$key;
  }
  return out;
}

/**
 * Uncaught, unexpired creatures of this deployment inside a bounding box (micro-degrees): the candidates for
 * the map. Returns campaignId -> the creators that wrote entities for it (checked against the chain later).
 */
export async function campaignsInBox(cfg: AppConfig, box: { minLat: number; maxLat: number; minLon: number; maxLon: number }) {
  const now = u64(BigInt(Math.floor(Date.now() / 1000)));
  const rows = await all(cfg, (after) =>
    client(cfg)
      .select({ $key: true, $creator: true, $owner: true, campaignId: true })
      .from(schemaOf(cfg), { onMismatch: "skip" })
      .where(
        and(
          deployment(cfg),
          between("latitudeE6", i32(box.minLat), i32(box.maxLat)),
          between("longitudeE6", i32(box.minLon), i32(box.maxLon)),
          eq("catched", bool(false)),
          or(eq("expiresAtUnix", u64(BigInt(0))), gt("expiresAtUnix", now)),
          ...(after ? [gt("$key", key(after))] : []),
        ),
      )
      .orderBy(asc("$key"))
      .limit(PAGE),
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) out.set(r.campaignId, (out.get(r.campaignId) ?? new Set()).add(r.creator.toLowerCase()));
  return out;
}

/** The entity of one creature created by `creator` (the campaign's business), or null. */
export async function creatureEntity(cfg: AppConfig, creatureId: bigint | string, creator: Address): Promise<CreatureEntity | null> {
  const res = await client(cfg)
    .select("*")
    .from(schemaOf(cfg), { onMismatch: "skip" })
    .createdBy(creator)
    .where(and(deployment(cfg), eq("creatureId", str(String(creatureId)))))
    .orderBy(asc("$key"))
    .limit(1)
    .fetch();
  const row = res.entities[0] as Row | undefined;
  return row ? toEntity(row) : null;
}

/** Every creature entity of this deployment held by `owner` (callers verify each $creator on chain). */
export function entitiesOwnedBy(cfg: AppConfig, owner: Address, filter?: { listed?: boolean; catched?: boolean }) {
  return all(cfg, (after) => {
    const f: unknown[] = [deployment(cfg)];
    if (filter?.listed !== undefined) f.push(eq("listed", bool(filter.listed)));
    if (filter?.catched !== undefined) f.push(eq("catched", bool(filter.catched)));
    if (after) f.push(gt("$key", key(after)));
    const where = and(...(f as never[]));
    return client(cfg).select("*").from(schemaOf(cfg), { onMismatch: "skip" }).where(where).ownedBy(owner).orderBy(asc("$key")).limit(PAGE);
  });
}

// ------------------------------------------------------------------ writes (the player signs in MetaMask)

async function send(cfg: AppConfig, player: Address, batch: Parameters<ReturnType<typeof createWalletClient>["executeBatch"]>[0]) {
  const chain = arkivChain(cfg);
  await ensureWallet(chain, player);
  const eth = provider();
  const balance = BigInt((await eth.request({ method: "eth_getBalance", params: [player, "latest"] })) as string);
  if (balance === BigInt(0)) throw new Error(`Your wallet has no ${chain.nativeCurrency.symbol} on Arkiv ${chain.name}. Get some at https://hub.arkiv.network/faucet`);
  const request = (args: { method: string; params?: unknown }) => eth.request(args as Parameters<typeof eth.request>[0]);
  // arkiv-write-safety: explicit gas from an unsigned estimate (shared Rabdi gas policy).
  const txParams = await rabdiBatchTxParams({ createWalletClient, custom }, { request, account: player, chain, batch });
  const wallet = createWalletClient({ chain, transport: custom(eth), account: player });
  return wallet.executeBatch(batch, { gas: txParams.gas, gasPrice: txParams.gasPrice });
}

/** Marketplace escrow: listed = true + price, then ownership -> the settler, in ONE atomic transaction. */
export function escrowForSale(cfg: AppConfig, player: Address, entityKey: Hex, price: bigint) {
  return send(cfg, player, {
    patches: [{ schema: schemaOf(cfg), entityKey, set: { listed: true, price: u64(price) } }],
    ownershipChanges: [{ entityKey, newOwner: cfg.settlerAddress }],
  });
}

/** Mirror CreatureMarket.redeem on the player's entity. */
export function markRedeemed(cfg: AppConfig, player: Address, entityKey: Hex) {
  return send(cfg, player, { patches: [{ schema: schemaOf(cfg), entityKey, set: { redeemed: true } }] });
}
