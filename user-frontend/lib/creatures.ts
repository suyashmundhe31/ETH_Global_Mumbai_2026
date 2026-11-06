import { createPublicClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { addr, defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema"
import { http } from "viem"

// Same columns as the entities already on Arkiv (9 of them are indexed).
export const Creature = defineSchema("ethglobal-mumbai-2026.creature.v1", {
  allocationTxHash: str(),
  business: addr().indexed(),
  businessName: str(),
  campaignId: u64().indexed(),
  campaignSwarmReference: str(),
  campaignTxHash: str(),
  chainId: u64().indexed(),
  contract: addr().indexed(),
  createdAt: u64(),
  creatureId: str().indexed(),
  creatureIndex: u64(),
  discountCode: str(),
  discountDescription: str(),
  expiresAtUnix: u64().indexed(),
  latitudeE6: i32().indexed(),
  longitudeE6: i32().indexed(),
  rarity: str().indexed(),
  swarmReference: str(),
  totalCreatures: u64(),
  vrfRequestId: str(),
})

// Anyone can write entities with this schema name, so only trust ones made by our issuer.
const ISSUER = (process.env.CREATURE_ISSUER ?? "0x448c0810c8bcacb84f9343a6adbd1b0ab71da220") as `0x${string}`

const client = createPublicClient({
  chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }),
  transport: http(),
})

// Creatures currently owned by `owner`.
export async function getCreatures(owner: string) {
  const { entities } = await client
    .select({
      $key: true, allocationTxHash: true, business: true, businessName: true, campaignId: true,
      campaignSwarmReference: true, campaignTxHash: true, chainId: true, contract: true,
      createdAt: true, creatureId: true, creatureIndex: true, discountCode: true,
      discountDescription: true, expiresAtUnix: true, latitudeE6: true, longitudeE6: true,
      rarity: true, swarmReference: true, totalCreatures: true, vrfRequestId: true,
    })
    .from(Creature)
    .ownedBy(owner as `0x${string}`)
    .createdBy(ISSUER)
    .fetch()

  // Plain strings, so the result can be sent as JSON (u64 values are bigint).
  return entities.map((e) =>
    Object.fromEntries(
      Object.entries(e).map(([k, v]) => [k, typeof v === "object" && v && "value" in v ? String(v.value) : String(v)]),
    ),
  )
}