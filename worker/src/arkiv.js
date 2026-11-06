// Arkiv READ access for the worker, using the official @arkiv-network/sdk (v1).
// Docs: https://docs.arkiv.network  (schemas, query builder, getEntity, ExpirationTime)
//
// The worker never writes creatures: the business signs the Arkiv transactions in MetaMask, so
// Arkiv records the business wallet as each entity's $creator and $owner. The worker only prepares
// the payloads and verifies what the business wrote — it needs no Arkiv private key.
import * as sdk from "@arkiv-network/sdk";
import { addr, createPublicClient, NoEntityFoundError, u64 } from "@arkiv-network/sdk";
import { localhost, rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { creatureExpiration, defineCreatureSchema, DEFAULT_SCHEMA_NAME } from "../../shared/creatureEntity.js";

const MAX_PAGE = 100; // MAX_LIMIT of the query engine

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

export class ArkivCreatureStore {
  constructor({ network, accessKey, rpcUrl, schemaName, explorerUrl, client }) {
    this.chain = arkivChain({ network, accessKey, rpcUrl });
    this.schema = creatureSchema(schemaName);
    this.schemaName = schemaName;
    this.explorerUrl = explorerUrl;
    this.publicClient = client || createPublicClient({ chain: this.chain, transport: http() });
  }

  /**
   * Map<creatureId, summary[]> of the creature entities of one campaign that were CREATED BY the
   * campaign's business. Filtering on $creator (taken from the contract, never from the request)
   * means look-alike entities written by anyone else are ignored.
   */
  async findCampaignEntities({ creator, chainId, contract, campaignId }) {
    const found = new Map();
    for (let offset = 0; ; offset += MAX_PAGE) {
      const res = await this.publicClient
        .select({ $key: true, $creator: true, $owner: true, creatureId: true, rarity: true, discountCode: true, swarmReference: true })
        .from(this.schema)
        .where(
          and(
            eq("$creator", addr(creator)),
            eq("chainId", u64(BigInt(chainId))),
            eq("contract", addr(contract)),
            eq("campaignId", u64(BigInt(campaignId))),
          ),
        )
        .limit(MAX_PAGE)
        .offset(offset)
        .fetch();
      for (const row of res.entities) {
        const e = toSummary(row);
        found.set(e.creatureId, [...(found.get(e.creatureId) || []), e]);
      }
      if (res.entities.length < MAX_PAGE) break;
    }
    return found;
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
