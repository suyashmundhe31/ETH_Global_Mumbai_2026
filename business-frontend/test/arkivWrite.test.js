import assert from "node:assert/strict";
import { test } from "node:test";
import { approveCatches, arkivChainFor, isUserRejection, rabdiBatchTxParams, writeCreatureBatches } from "../src/arkivWrite.js";

const payload = (i) => ({
  creatureId: String((1n << 32n) | BigInt(i)),
  campaignId: "1",
  creatureIndex: i,
  chainId: 84532,
  contract: "0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83",
  businessName: "CoinHub",
  rarity: "COMMON",
  discountCode: "COM10",
  discountDescription: "10% off",
  totalCreatures: 5,
  latitudeE6: 19063713,
  longitudeE6: 72867346,
  expiresAtUnix: "0",
  swarmReference: "a".repeat(64),
  campaignSwarmReference: "b".repeat(64),
  createdAt: "1793923798",
  campaignTxHash: "0x" + "1".repeat(64),
  allocationTxHash: "0x" + "2".repeat(64),
  vrfRequestId: "7",
  listed: false,
  catched: false,
  redeemed: false,
  price: null,
});
const plan = (n, batchSize) => ({ payloads: Array.from({ length: n }, (_, i) => payload(i)), batchSize, expiresAtUnix: "0" });

const HASH = (n) => "0x" + n.toString(16).padStart(64, "0");

function fakeWallet({ failOn = new Set(), rejectOn = new Set(), lostReceiptOn = new Set() } = {}) {
  const calls = [];
  const txParams = [];
  let next = 1;
  return {
    calls,
    txParams,
    async executeBatch({ creates }, params) {
      calls.push(creates);
      txParams.push(params);
      const n = calls.length;
      if (rejectOn.has(n)) throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError", code: 4001 });
      if (failOn.has(n)) throw new Error("rpc error");
      // Sent, but the receipt was lost: the SDK's EntityMutationError keeps the hash.
      if (lostReceiptOn.has(n)) throw Object.assign(new Error("Transaction failed"), { name: "EntityMutationError", txHash: HASH(0xabc) });
      return { txHash: `0xtx${n}`, createdEntities: creates.map(() => HASH(next++)) };
    },
  };
}

test("signs in batches of batchSize and reports creatureId -> entityKey per batch", async () => {
  const wallet = fakeWallet();
  const reports = [];
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(5, 2), onBatch: (x) => reports.push(x) });
  assert.equal(wallet.calls.length, 3);
  assert.deepEqual(wallet.calls.map((c) => c.length), [2, 2, 1]);
  assert.equal(r.written, 5);
  assert.deepEqual(reports.flatMap((x) => x.entries.map((e) => e.creatureId)), plan(5, 2).payloads.map((p) => p.creatureId));
  // Typed by the shared schema: lifecycle defaults, no price, patchable, extendable by anyone.
  const c = wallet.calls[0][0];
  assert.equal(c.values.listed, false);
  assert.equal(c.values.catched, false);
  assert.equal(c.values.redeemed, false);
  assert.equal("price" in c.values, false);
  assert.equal("business" in c.values, false);
  assert.deepEqual(c.flags, { readonly: false, permissionlessExtension: true });
});

test("a failed batch stops the run (outcome uncertain) instead of sending more", async () => {
  const wallet = fakeWallet({ failOn: new Set([2]) });
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(5, 2) });
  assert.equal(wallet.calls.length, 2, "no third batch after an uncertain failure");
  assert.equal(r.written, 2);
  assert.equal(r.failed.length, 2);
  assert.equal(r.rejected, false);
  assert.equal(r.uncertain, true);
});

test("a sent batch whose receipt was lost reports its transaction hash", async () => {
  const wallet = fakeWallet({ lostReceiptOn: new Set([1]) });
  const reports = [];
  await writeCreatureBatches({ walletClient: wallet, plan: plan(4, 2), onBatch: (x) => reports.push(x) });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].sent, true);
  assert.equal(reports[0].txHash, HASH(0xabc), "hash kept so the worker can hold these creatures back");
  assert.deepEqual(reports[0].creatureIds, plan(4, 2).payloads.slice(0, 2).map((p) => p.creatureId));
});

test("beforeBatch (account/chain re-check) stops before anything is sent", async () => {
  const wallet = fakeWallet();
  const reports = [];
  let checks = 0;
  const r = await writeCreatureBatches({
    walletClient: wallet,
    plan: plan(4, 2),
    beforeBatch: async () => {
      if (++checks === 2) throw new Error("MetaMask account changed");
    },
    onBatch: (x) => reports.push(x),
  });
  assert.equal(wallet.calls.length, 1, "second batch never reached the wallet");
  assert.equal(reports[1].sent, false);
  assert.equal(r.uncertain, false, "a pre-send stop is not an uncertain write");
});

test("explicit txParams are passed to every batch", async () => {
  const wallet = fakeWallet();
  await writeCreatureBatches({ walletClient: wallet, plan: plan(3, 2), txParamsFor: async (batch) => ({ gas: BigInt(batch.creates.length) * 7n }) });
  assert.deepEqual(wallet.txParams, [{ gas: 14n }, { gas: 7n }]);
});

// ------------------------------------------------------------------ Rabdi gas policy
function fakeNode({ estimate = 300_000n, blockGasLimit = 60_000_000n } = {}) {
  const seen = [];
  return {
    seen,
    async request({ method, params }) {
      seen.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x76edaf";
        case "eth_blockNumber":
          return "0x100";
        case "eth_estimateGas":
          assert.equal(params[1], "latest", "estimates at latest");
          return "0x" + estimate.toString(16);
        case "eth_getBlockByNumber":
          return { gasLimit: "0x" + blockGasLimit.toString(16), number: "0x100" };
        case "eth_gasPrice":
          return "0x3b9aca00";
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
}
const creates10 = async (n) => {
  const sdk = await import("@arkiv-network/sdk");
  const { creatureCreates, creatureExpiration, defineCreatureSchema } = await import("../../shared/creatureEntity.js");
  return creatureCreates(sdk, defineCreatureSchema(sdk), plan(n, n).payloads, creatureExpiration(sdk, 0).expiration);
};

test("gas = max(1M + 400k × (ops − 1), 2 × estimate), from the SDK's own unsigned estimate", async () => {
  const node = fakeNode({ estimate: 300_000n });
  const chain = arkivChainFor({ network: "rabdi" });
  const p = await rabdiBatchTxParams({ request: node.request, account: "0x0913B468eeba5099cF6AEb61242423294D604fBa", chain, creates: await creates10(10) });
  assert.equal(p.estimate, 300_000n);
  assert.equal(p.gas, 1_000_000n + 400_000n * 9n, "floor wins for a small estimate");
  assert.equal(p.gasPrice, 1_000_000_000n);
  assert.ok(!node.seen.some((m) => /send|sign/i.test(m)), "nothing signed or sent while estimating");

  const big = fakeNode({ estimate: 5_000_000n });
  assert.equal((await rabdiBatchTxParams({ request: big.request, account: "0x0913B468eeba5099cF6AEb61242423294D604fBa", chain, creates: await creates10(10) })).gas, 10_000_000n, "2 × estimate wins");
});

test("a batch above half the block gas limit is refused before signing", async () => {
  const node = fakeNode({ estimate: 5_000_000n, blockGasLimit: 15_000_000n });
  const chain = arkivChainFor({ network: "rabdi" });
  await assert.rejects(
    rabdiBatchTxParams({ request: node.request, account: "0x0913B468eeba5099cF6AEb61242423294D604fBa", chain, creates: await creates10(10) }),
    /lower ARKIV_BATCH_SIZE/,
  );
});

test("rejecting the signature in MetaMask stops the run", async () => {
  const wallet = fakeWallet({ rejectOn: new Set([1]) });
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(5, 2) });
  assert.equal(wallet.calls.length, 1);
  assert.equal(r.rejected, true);
  assert.equal(r.written, 0);
});

test("user rejection is detected through error causes", () => {
  assert.equal(isUserRejection(new Error("x", { cause: { code: 4001 } })), true);
  assert.equal(isUserRejection(new Error("rpc")), false);
});

test("Arkiv chain: Rabdi testnet, tGLM", () => {
  const chain = arkivChainFor({ network: "rabdi" });
  assert.equal(chain.id, 7794095);
  assert.equal(chain.nativeCurrency.symbol, "tGLM");
});

test("an oversized batch is split before signing (nothing was sent), never sent too large", async () => {
  const wallet = fakeWallet();
  const { BatchTooLargeError } = await import("../src/arkivWrite.js");
  // Pretend only batches of at most 3 fit under half the block gas limit.
  const txParamsFor = async (batch) => {
    if (batch.creates.length > 3) throw new BatchTooLargeError("too large");
    return { gas: 1n };
  };
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(10, 10), txParamsFor });
  assert.equal(r.written, 10);
  assert.ok(wallet.calls.every((c) => c.length <= 3), `sent sizes ${wallet.calls.map((c) => c.length)}`);
  assert.deepEqual(wallet.calls.flat().map((c) => c.values.creatureId), plan(10, 10).payloads.map((p) => p.creatureId), "order preserved");
});

test("auto settle: each batch carries predicted salts and hands every created creature to the settler", async () => {
  const SETTLER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  let nonce = 100;
  const predictKeys = async (count) => Array.from({ length: count }, (_, i) => ({ key: HASH(nonce + i), salt: BigInt(7000 + nonce + i) }));
  const batches = [];
  const wallet = {
    async executeBatch(batch) {
      batches.push(batch);
      const keys = batch.creates.map((_, i) => HASH(nonce + i));
      nonce += batch.creates.length; // the business's entity nonce advances
      return { txHash: HASH(1), createdEntities: keys };
    },
  };
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(5, 3), settleTo: SETTLER, predictKeys });
  assert.equal(r.written, 5);
  assert.equal(batches.length, 2);
  for (const b of batches) {
    assert.equal(b.ownershipChanges.length, b.creates.length, "same atomic batch");
    b.creates.forEach((c, i) => assert.equal(c.salt, BigInt(7000) + BigInt(BigInt(b.ownershipChanges[i].entityKey))));
    assert.ok(b.ownershipChanges.every((o) => o.newOwner === SETTLER));
  }
});

test("approval (default): batches contain creates only, no ownership change", async () => {
  const wallet = fakeWallet();
  const batches = [];
  const spy = { executeBatch: (b, p) => (batches.push(b), wallet.executeBatch(b, p)) };
  await writeCreatureBatches({ walletClient: spy, plan: plan(3, 3) });
  assert.equal(batches[0].ownershipChanges, undefined);
});

test("auto settle: created keys that differ from the prediction stop the run", async () => {
  const wallet = { executeBatch: async ({ creates }) => ({ txHash: HASH(1), createdEntities: creates.map((_, i) => HASH(900 + i)) }) };
  const reports = [];
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(2, 2), settleTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", predictKeys: async (n) => Array.from({ length: n }, (_, i) => ({ key: HASH(1 + i), salt: 1n })), onBatch: (x) => reports.push(x) });
  assert.equal(r.uncertain, true);
  assert.equal(reports[0].txHash, HASH(1));
});

// ------------------------------------------------------------------ approval of claims
const approval = (i) => ({ creatureId: String((1n << 32n) | BigInt(i)), entityKey: HASH(100 + i), player: `0x${String(i + 1).padStart(40, "0")}`, redeemed: i === 1 });

test("approveCatches: catched = true + ownership -> player, one atomic batch per group", async () => {
  const batches = [];
  const walletClient = { executeBatch: async (b) => (batches.push(b), { txHash: HASH(batches.length), createdEntities: [] }) };
  const res = await approveCatches({ walletClient, approvals: [0, 1, 2].map(approval), schemaName: "ethglobal-mumbai-2026.creature.v2", batchSize: 2 });
  assert.equal(res.approved, 3);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].patches.map((p) => p.set), [{ catched: true, redeemed: false }, { catched: true, redeemed: true }]);
  assert.deepEqual(batches[0].ownershipChanges, [
    { entityKey: HASH(100), newOwner: approval(0).player },
    { entityKey: HASH(101), newOwner: approval(1).player },
  ]);
  assert.equal(batches[0].patches[0].entityKey, HASH(100));
});

test("approveCatches: stops at the first rejected batch", async () => {
  let n = 0;
  const walletClient = {
    executeBatch: async () => {
      if (++n === 2) throw Object.assign(new Error("User rejected"), { code: 4001 });
      return { txHash: HASH(n), createdEntities: [] };
    },
  };
  const res = await approveCatches({ walletClient, approvals: [0, 1, 2, 3, 4].map(approval), schemaName: "s", batchSize: 2 });
  assert.equal(res.approved, 2);
  assert.equal(res.rejected, true);
  assert.equal(res.uncertain, false);
  assert.equal(n, 2, "nothing sent after the rejection");
});
