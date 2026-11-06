import assert from "node:assert/strict";
import { test } from "node:test";
import { arkivChainFor, isUserRejection, writeCreatureBatches } from "../src/arkivWrite.js";

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

function fakeWallet({ failOn = new Set(), rejectOn = new Set() } = {}) {
  const calls = [];
  let next = 1;
  return {
    calls,
    async executeBatch({ creates }) {
      calls.push(creates);
      const n = calls.length;
      if (rejectOn.has(n)) throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError", code: 4001 });
      if (failOn.has(n)) throw new Error("rpc error");
      return { txHash: `0xtx${n}`, createdEntities: creates.map(() => "0x" + (next++).toString(16).padStart(64, "0")) };
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

test("a failed batch does not stop the others", async () => {
  const wallet = fakeWallet({ failOn: new Set([2]) });
  const r = await writeCreatureBatches({ walletClient: wallet, plan: plan(5, 2) });
  assert.equal(wallet.calls.length, 3);
  assert.equal(r.written, 3);
  assert.equal(r.failed.length, 2);
  assert.equal(r.rejected, false);
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
