// Arkiv READ access for the worker, using the official @arkiv-network/sdk (v1).
// Docs: https://docs.arkiv.network  (schemas, query builder, getEntity, ExpirationTime)
//
// The worker never writes creatures: the business signs the Arkiv transactions in MetaMask, so
// Arkiv records the business wallet as each entity's $creator and $owner. The worker only prepares
// the payloads and verifies what the business wrote — it needs no Arkiv private key.
import * as sdk from "@arkiv-network/sdk";
import { addr, createPublicClient, NoEntityFoundError, u64 } from "@arkiv-network/sdk";
import { localhost, rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { bool, key, str } from "@arkiv-network/sdk/schema";
import { http } from "viem";
import { creatureExpiration, defineCreatureSchema, DEFAULT_SCHEMA_NAME } from "../../shared/creatureEntity.js";

const MAX_PAGE = 100; // MAX_LIMIT of the query engine
const MAX_PAGES = 20; // 2,000 entities per campaign scan; campaigns hold at most 500 creatures

export { DEFAULT_SCHEMA_NAME };
export const creatureSchema = (name = DEFAULT_SCHEMA_NAME) => defineCreatureSchema(sdk, name);
export const expirationFor = (expiresAtUnix, nowMs) => creatureExpiration(sdk, expiresAtUnix, nowMs);

export function arkivChain({ network, accessKey, rpcUrl }) {
  if (network === "rabdi") return rabdi({ accessKey: accessKey ?? "" });
  if (network === "localhost") {
    return rpcUrl ? { ...localhost, rpcUrls: { default: { http: [rpcUrl] } } } : localhost;
  }
  throw new Error(`Unknown ARKIV_NETWORK "${network}" (use "rabdi" or "localhost")`);
}

/** One entity as reconciliation sees it. */
function toSummary(row) {
  return {
    key: row.$key,
    creator: row.$creator,
    owner: row.$owner,
    creatureId: row.creatureId?.value,
    rarity: row.rarity?.value,
    discountCode: row.discountCode?.value,
    swarmReference: row.swarmReference?.value,
  };
}

/** One entity with every column as a plain value (bigint for u64, string, number, boolean). */
function toFull(row) {
  const values = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith("$")) values[k] = v && typeof v === "object" && "value" in v ? v.value : v;
  return { key: row.$key, creator: row.$creator, owner: row.$owner, values };
}

export class ArkivCreatureStore {
  constructor({ network, accessKey, rpcUrl, schemaName, explorerUrl, client }) {
    this.chain = arkivChain({ network, accessKey, rpcUrl });
    this.schema = creatureSchema(schemaName);
    this.schemaName = schemaName;
    this.explorerUrl = explorerUrl;
    // Fresh reads only (arkiv-query / app-integration recipes): no response or block-number caching.
    this.publicClient =
      client ||
      createPublicClient({
        chain: this.chain,
        cacheTime: 0,
        transport: http(undefined, { fetchOptions: { cache: "no-store", redirect: "error" } }),
      });
  }

  /**
   * Map<creatureId, summary[]> of the creature entities of one campaign that were CREATED BY the
   * campaign's business. Filtering on $creator (taken from the contract, never from the request)
   * means look-alike entities written by anyone else are ignored.
   *
   * Keyset traversal ordered by the immutable $key (arkiv-query recipe): unlike offset paging it
   * cannot skip an entity that existed before the scan when new ones land mid-scan, and
   * onMismatch "throw" stops a page of schema-mismatched rows from silently ending the scan.
   * Missing an existing creature here would make the plan ask the business to sign it twice.
   */
  async findCampaignEntities({ creator, chainId, contract, campaignId }) {
    const found = new Map();
    let last;
    for (let page = 0; page < MAX_PAGES; page++) {
      const builder = this.publicClient
        .select({ $key: true, $creator: true, $owner: true, creatureId: true, rarity: true, discountCode: true, swarmReference: true })
        .from(this.schema, { onMismatch: "throw" })
        .createdBy(creator)
        .where(and(eq("chainId", u64(BigInt(chainId))), eq("contract", addr(contract)), eq("campaignId", u64(BigInt(campaignId)))))
        .orderBy(asc("$key"))
        .limit(MAX_PAGE);
      if (last) builder.where(gt("$key", key(last)));
      const res = await builder.fetch();
      for (const row of res.entities) {
        const e = toSummary(row);
        found.set(e.creatureId, [...(found.get(e.creatureId) || []), e]);
      }
      if (res.entities.length < MAX_PAGE) return found;
      const next = res.entities.at(-1).$key;
      if (last && next.toLowerCase() <= last.toLowerCase()) throw new Error("Arkiv keyset traversal did not advance");
      last = next;
    }
    throw new Error("Arkiv scan exceeded its page budget; refusing to plan from an incomplete result");
  }

  /**
   * Every entity of one creature CREATED BY `creator` (the campaign's business, read from the contract),
   * with all its columns as plain values. Normally one; look-alikes from other writers are excluded.
   */
  async findCreatureEntities({ creator, chainId, contract, creatureId }) {
    const res = await this.publicClient
      .select("*")
      .from(this.schema, { onMismatch: "throw" })
      .createdBy(creator)
      .where(and(eq("creatureId", str(String(creatureId))), eq("chainId", u64(BigInt(chainId))), eq("contract", addr(contract))))
      .orderBy(asc("$key"))
      .limit(10)
      .fetch();
    return res.entities.map(toFull);
  }

  /**
   * Keys and creature ids of the creature entities held by `owner`, optionally only those with
   * catched = `catched` (keyset traversal; bounded by MAX_PAGES).
   */
  async findHeldBy({ owner, catched }) {
    const out = [];
    let last;
    for (let page = 0; page < MAX_PAGES; page++) {
      const filters = [];
      if (catched !== undefined) filters.push(eq("catched", bool(catched)));
      if (last) filters.push(gt("$key", key(last)));
      const builder = this.publicClient
        .select({ $key: true, $creator: true, creatureId: true, campaignId: true })
        .from(this.schema, { onMismatch: "skip" })
        .ownedBy(owner)
        .orderBy(asc("$key"))
        .limit(MAX_PAGE);
      if (filters.length) builder.where(filters.length === 1 ? filters[0] : and(...filters));
      const res = await builder.fetch();
      for (const r of res.entities) out.push({ key: r.$key, creator: r.$creator, creatureId: r.creatureId?.value, campaignId: r.campaignId?.value });
      if (res.entities.length < MAX_PAGE) return out;
      last = res.entities.at(-1).$key;
    }
    return out; // bounded: the next sweep continues from the start
  }

  /** True when `address` has no transaction in flight (latest nonce == pending nonce). */
  async nonceIdle(address) {
    const [latest, pending] = await Promise.all([
      this.publicClient.getTransactionCount({ address, blockTag: "latest" }),
      this.publicClient.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    return latest === pending;
  }

  /** The transaction as the Arkiv node knows it (mempool or mined), or null if it does not. */
  async getTransaction(hash) {
    return this.publicClient.getTransaction({ hash }).catch((err) => {
      if (err?.name === "TransactionNotFoundError") return null;
      throw err;
    });
  }

  /**
   * "success" | "reverted" (mined), "pending" (known, not mined) or "unknown" (the node does not know
   * it: dropped or never broadcast). An RPC error is thrown, never reported as a status.
   */
  async transactionStatus(hash) {
    const receipt = await this.publicClient.getTransactionReceipt({ hash }).catch((err) => {
      if (err?.name === "TransactionReceiptNotFoundError") return null;
      throw err;
    });
    if (receipt) return receipt.status;
    return (await this.getTransaction(hash)) ? "pending" : "unknown";
  }

  /** Reads one entity through the schema; null if it does not exist (or does not fit the schema). */
  async getCreatureEntity(entityKey) {
    try {
      return toSummary(await this.publicClient.getEntity(entityKey, this.schema));
    } catch (err) {
      if (err instanceof NoEntityFoundError || err?.name === "SchemaMismatchError") return null;
      throw err;
    }
  }
}
