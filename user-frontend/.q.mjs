import { createPublicClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { and, eq } from "@arkiv-network/sdk/query"
import { str } from "@arkiv-network/sdk/schema"
import { http, formatEther } from "viem"
const c = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http(undefined, { timeout: 30000, retryCount: 2 }) })
const r = await c.select({ $key: true, $owner: true, catched: true, redeemed: true })
  .where(and(eq("arkiv.schema", str("ethglobal-mumbai-2026.creature.v2")), eq("creatureId", str("21474836481")))).fetch()
for (const e of r.entities) console.log("Tata 21474836481 owner", e.$owner, "catched", e.catched?.value, "redeemed", e.redeemed?.value)
console.log("Rabdi tGLM of 0x0054:", formatEther(await c.getBalance({ address: "0x005466Bf8cC92bd84201F50cC10325DB3c2e34D9" })))
