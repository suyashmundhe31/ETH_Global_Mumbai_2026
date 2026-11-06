import { test } from "node:test";
import assert from "node:assert/strict";
import { AllocationListener } from "../src/listener.js";
import { CampaignChain } from "../src/chain.js";
import { JsonStateStore, campaignKey } from "../src/state.js";

const ADDRESS = "0x00000000000000000000000000000000000000AA";
const silent = { info() {}, warn() {}, error() {} };

function fakeChain(events) {
  return {
    chainId: 84532,
    address: ADDRESS,
    startBlock: 100n,
    getBlockNumber: async () => 1000n,
    getAllocatedEvents: async (from, to) => events.filter((e) => e.blockNumber >= from && e.blockNumber <= to),
  };
}

test("listener records a campaign before preparing it, so a failed first attempt is never lost", async () => {
  const state = new JsonStateStore(null);
  let calls = 0;
  const service = {
    prepare: async () => {
      calls++;
      throw new Error("RPC Request failed");
    },
  };
  const chain = fakeChain([{ blockNumber: 500n, transactionHash: "0x1", args: { campaignId: 7n } }]);
  const listener = new AllocationListener({ chain, state, service, logRange: 200n, retryDelayMs: 0, logger: silent });

  await listener.pollOnce();
  await listener.drainQueue();
  assert.equal(calls, 1);
  assert.equal(state.getCheckpoint(listener.checkpointName), 1000n, "checkpoint moved past the event");
  assert.equal(state.getCampaign(campaignKey(84532, ADDRESS, 7n)).status, "PENDING", "campaign still tracked");

  // Automatic retry in the same process.
  listener.enqueueDueRetries(Date.now() + 1);
  assert.deepEqual(listener.queue, [7n]);

  // And after a restart: resumeIncomplete finds it from state alone.
  const restarted = new AllocationListener({ chain, state, service, logger: silent });
  restarted.resumeIncomplete();
  assert.deepEqual(restarted.queue, [7n]);
});

test("listener retries until the campaign is prepared, then stops", async () => {
  const state = new JsonStateStore(null);
  const results = [false, true];
  const service = { prepare: async () => ({ prepared: results.shift() }) };
  const listener = new AllocationListener({ chain: fakeChain([]), state, service, retryDelayMs: 0, logger: silent });

  listener.enqueue(3n);
  await listener.drainQueue();
  assert.ok(listener.retryAt.has(3n));
  listener.enqueueDueRetries(Date.now() + 1);
  await listener.drainQueue();
  assert.equal(listener.retryAt.size, 0);
});

test("getCampaignTxHashes scans backwards in LOG_RANGE windows and never exceeds the range", async () => {
  const ranges = [];
  const events = {
    CampaignCreated: { blockNumber: 450n, transactionHash: "0xcreate" },
    RarityAllocated: { blockNumber: 470n, transactionHash: "0xalloc" },
  };
  const client = {
    getBlockNumber: async () => 1000n,
    getContractEvents: async ({ eventName, fromBlock, toBlock }) => {
      ranges.push(toBlock - fromBlock + 1n);
      const ev = events[eventName];
      return ev.blockNumber >= fromBlock && ev.blockNumber <= toBlock ? [ev] : [];
    },
  };
  const chain = new CampaignChain({ chainId: 84532, rpcUrl: "http://127.0.0.1:1", campaignManager: ADDRESS, startBlock: 100n, logRange: 200n, client });

  assert.deepEqual(await chain.getCampaignTxHashes(1n), { creationTxHash: "0xcreate", allocationTxHash: "0xalloc" });
  assert.ok(ranges.every((r) => r <= 200n), `ranges: ${ranges}`);
  assert.ok(ranges.length <= 8, "stops once both events are found");
});
