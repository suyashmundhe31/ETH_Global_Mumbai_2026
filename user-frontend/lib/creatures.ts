import { createPublicClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { and, asc, eq, gt, or } from "@arkiv-network/sdk/query"
import { addr, bool, defineSchema, i32, key, str, u64 } from "@arkiv-network/sdk/schema"
import { http, type Hex } from "viem"

// Same columns as the entities on Arkiv (11 of them are indexed).
export const Creature = defineSchema("ethglobal-mumbai-2026.creature.v2", {
  allocationTxHash: str(),
  businessName: str(),
  campaignId: u64().indexed(),
  campaignSwarmReference: str(),
  campaignTxHash: str(),
  catched: bool().indexed(),
  chainId: u64().indexed(),
  contract: addr().indexed(),
  createdAt: u64(),
  creatureId: str().indexed(),
  creatureIndex: u64(),
  discountCode: str(),
  discountDescription: str(),
  expiresAtUnix: u64().indexed(),
  latitudeE6: i32().indexed(),
  listed: bool().indexed(),
  longitudeE6: i32().indexed(),
  rarity: str().indexed(),
  redeemed: bool().indexed(),
  swarmReference: str(),
  totalCreatures: u64(),
  vrfRequestId: str(),
})

// Anyone can write entities with this schema name, so only trust ones created by the business wallet.
const CREATOR = (process.env.CREATURE_CREATOR ?? "0x0913B468eeba5099cF6AEb61242423294D604fBa") as Hex

const client = createPublicClient({
  chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }),
  transport: http(),
})

const PAGE = 100

// Every matching entity (paged by $key), as plain strings so it can be sent as JSON (u64 values are bigint).
// market: listed & unredeemed; otherwise not listed, or redeemed (redeemed ones stay in the profile).
async function fetchAll(market: boolean, owner?: Hex) {
  const filter = market
    ? and(eq("listed", bool(true)), eq("redeemed", bool(false)))
    : or(eq("listed", bool(false)), eq("redeemed", bool(true)))
  const out: Record<string, string>[] = []
  let after: Hex = `0x${"0".repeat(64)}`
  for (;;) {
    const q = client
      .select({
        $key: true, $owner: true, businessName: true, campaignId: true, catched: true, creatureId: true,
        discountCode: true, discountDescription: true, expiresAtUnix: true, listed: true, rarity: true,
        redeemed: true, swarmReference: true,
      })
      .from(Creature)
      .where(and(filter, gt("$key", key(after))))
      .createdBy(CREATOR)
      .orderBy(asc("$key"))
      .limit(PAGE)
    const { entities } = await (owner ? q.ownedBy(owner) : q).fetch()
    for (const e of entities) {
      out.push(
        Object.fromEntries(
          Object.entries(e).map(([k, v]) => [k, typeof v === "object" && v && "value" in v ? String(v.value) : String(v)]),
        ),
      )
    }
    if (entities.length < PAGE) return out
    after = entities[entities.length - 1].$key
  }
}

// Profile: creatures `owner` holds that aren't on the market. Redeemed ones always stay here.
export const getCreatures = (owner: string) =>
  fetchAll(false, owner as Hex)
