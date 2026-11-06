import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@arkiv-network/sdk";
import { creatureCreates, creatureExpiration, defineCreatureSchema } from "../../shared/creatureEntity.js";
import { expirationFor } from "../src/arkiv.js";
import { ARKIV_STATUS, CampaignArkivService, NotAllocatedError, NotReadyError } from "../src/campaignArkiv.js";
import { JsonStateStore } from "../src/state.js";
import { BUSINESS, FakeChain, FakeSwarm, MemoryArkiv, STRANGER } from "./fakes.js";

const quiet = { info() {}, warn() {}, error() {}, child: () => quiet };
const schema = defineCreatureSchema(sdk);

function setup(opts = {}) {
  const chain = new FakeChain(opts.chain);
  const swarm = new FakeSwarm();
  const arkiv = new MemoryArkiv();
  const state = new JsonStateStore(null); // in-memory
  const service = new CampaignArkivService({ chain, swarm, arkiv, state, expirationFor, batchSize: opts.batchSize ?? 3, logger: quiet });
  return { chain, swarm, arkiv, state, service };
}

/** What the browser does: sign the plan in batches with the given wallet, report the keys. */
async function sign(service, arkiv, plan, { as = BUSINESS } = {}) {
  const wallet = arkiv.walletFor(as);
  const { expiration } = creatureExpiration(sdk, plan.expiresAtUnix);
  for (let i = 0; i < plan.payloads.length; i += plan.batchSize) {
    const group = plan.payloads.slice(i, i + plan.batchSize);
    try {
      const res = await wallet.executeBatch({ creates: creatureCreates(sdk, schema, group, expiration) });
      await service.recordSubmission(1n, { txHash: res.txHash, entries: group.map((p, j) => ({ creatureId: p.creatureId, entityKey: res.createdEntities[j] })) });
    } catch {
      /* failed batch: shows up as missing in the next plan */
    }
  }
}

const creatorsOf = (arkiv) => new Set([...arkiv.entities.values()].map((e) => e.creator));
function assertNoDuplicates(arkiv) {
  const ids = [...arkiv.entities.values()].filter((e) => e.creator === BUSINESS).map((e) => e.values.creatureId);
  assert.equal(new Set(ids).size, ids.length, "duplicate Arkiv entities");
}

test("prepare: one distinct Swarm asset per creature, idempotent", async () => {
  const { swarm, service } = setup();
  const r = await service.prepare(1n);
  assert.equal(r.prepared, true);
  assert.equal(swarm.uploads, 10);
  await service.prepare(1n);
  assert.equal(swarm.uploads, 10, "no re-uploads once prepared");
  const plan = await service.plan(1n);
  assert.equal(new Set(plan.payloads.map((p) => p.swarmReference)).size, 10);
});

test("plan: payloads carry the new lifecycle fields and no business column", async () => {
  const { service } = setup();
  const plan = await service.plan(1n);
  assert.equal(plan.business, BUSINESS);
  assert.equal(plan.payloads.length, 10);
  for (const p of plan.payloads) {
    assert.equal(p.listed, false);
    assert.equal(p.catched, false);
    assert.equal(p.redeemed, false);
    assert.equal(p.price, null);
    assert.equal("business" in p, false);
    assert.equal(p.discountCode, `${p.rarity}-CODE`);
  }
  // Typed for Arkiv by the shared module: bools, and price left out (null).
  const [c] = creatureCreates(sdk, schema, plan.payloads.slice(0, 1), creatureExpiration(sdk, 0).expiration);
  assert.equal(c.values.listed, false);
  assert.equal("price" in c.values, false);
  assert.equal("business" in schema.columns, false);
  assert.equal(c.flags.readonly, false, "lifecycle fields must stay patchable by the owner");
});

test("the business signs: $creator = $owner = business wallet, verify COMPLETE", async () => {
  const { arkiv, service } = setup();
  await sign(service, arkiv, await service.plan(1n));
  const report = await service.verify(1n);
  assert.equal(report.status, ARKIV_STATUS.COMPLETE);
  assert.equal(report.stored, 10);
  assert.equal(report.creator, BUSINESS);
  for (const e of arkiv.entities.values()) {
    assert.equal(e.creator, BUSINESS);
    assert.equal(e.owner, BUSINESS);
  }
  assertNoDuplicates(arkiv);
  assert.equal((await service.plan(1n)).payloads.length, 0, "nothing left to sign");
});

test("partial failure: 7 of 10 written, retry plans and writes only the 3 missing", async () => {
  const { arkiv, service } = setup({ batchSize: 1 });
  const failing = ["4294967296", "4294967297", "4294967298"]; // (1<<32)|0..2
  failing.forEach((id) => arkiv.failCreatureIds.add(id));

  await sign(service, arkiv, await service.plan(1n));
  const first = await service.verify(1n);
  assert.equal(first.status, ARKIV_STATUS.PARTIAL);
  assert.equal(first.stored, 7);
  assert.deepEqual([...first.missing].sort(), failing);

  arkiv.failCreatureIds.clear();
  const retry = await service.plan(1n);
  assert.deepEqual(retry.payloads.map((p) => p.creatureId).sort(), failing, "only the missing creatures are planned");
  const before = arkiv.batchCalls;
  await sign(service, arkiv, retry);
  assert.equal(arkiv.batchCalls - before, 3);
  assert.equal((await service.verify(1n)).status, ARKIV_STATUS.COMPLETE);
  assert.equal(arkiv.entities.size, 10);
  assertNoDuplicates(arkiv);
});

test("a batch that landed but whose receipt was lost is not planned again", async () => {
  const { arkiv, service } = setup({ batchSize: 10 });
  arkiv.landThenThrow = 1;
  await sign(service, arkiv, await service.plan(1n));
  assert.equal((await service.plan(1n)).payloads.length, 0);
  assert.equal((await service.verify(1n)).status, ARKIV_STATUS.COMPLETE);
  assertNoDuplicates(arkiv);
});

test("query index lag cannot cause duplicates (reported keys are re-read directly)", async () => {
  const { arkiv, service } = setup();
  await sign(service, arkiv, await service.plan(1n));
  for (const key of arkiv.entities.keys()) arkiv.hiddenFromQuery.add(key);
  assert.equal((await service.plan(1n)).payloads.length, 0);
  assert.equal((await service.verify(1n)).status, ARKIV_STATUS.COMPLETE);
});

test("look-alike entities created by another wallet are ignored", async () => {
  const { arkiv, service } = setup({ batchSize: 10 });
  const plan = await service.plan(1n);
  await sign(service, arkiv, plan, { as: STRANGER }); // same payloads, wrong signer
  const report = await service.verify(1n);
  assert.equal(report.stored, 0, "a stranger cannot complete someone else's campaign");
  assert.equal((await service.plan(1n)).payloads.length, 10);
  assert.deepEqual(creatorsOf(arkiv), new Set([STRANGER]));
});

test("entities that do not match the chain (rarity / reward) are not counted", async () => {
  const { arkiv, service } = setup({ batchSize: 10 });
  const plan = await service.plan(1n);
  plan.payloads[0] = { ...plan.payloads[0], rarity: "LEGENDARY", discountCode: "LEGENDARY-CODE" }; // forged upgrade
  await sign(service, arkiv, plan);
  const report = await service.verify(1n);
  assert.equal(report.stored, 9);
  assert.equal(report.mismatched.length, 1);
  assert.deepEqual(report.missing, [plan.payloads[0].creatureId]);
});

test("submissions are validated (campaign membership, key format)", async () => {
  const { service } = setup();
  await service.prepare(1n);
  await assert.rejects(service.recordSubmission(1n, { entries: [{ creatureId: String((2n << 32n) | 0n), entityKey: "0x" + "1".repeat(64) }] }), TypeError);
  await assert.rejects(service.recordSubmission(1n, { entries: [{ creatureId: String(1n << 32n), entityKey: "nope" }] }), TypeError);
  await assert.rejects(service.recordSubmission(1n, { entries: [] }), TypeError);
});

test("Swarm failure: plan is not offered until every creature has its asset", async () => {
  const { swarm, service } = setup();
  swarm.failFor.add(`creature-${(1n << 32n) | 5n}.glb`);
  await assert.rejects(service.plan(1n), NotReadyError);
  swarm.failFor.clear();
  assert.equal((await service.plan(1n)).payloads.length, 10);
});

test("refuses campaigns whose VRF allocation has not completed", async () => {
  const { service } = setup({ chain: { status: "RANDOMNESS_REQUESTED" } });
  await assert.rejects(service.prepare(1n), NotAllocatedError);
  await assert.rejects(service.plan(1n), NotAllocatedError);
});

test("a campaign the listener recorded as PENDING becomes READY_TO_SIGN once prepared", async () => {
  const { state, service } = setup();
  state.updateCampaign(service.key(1n), { status: "PENDING", campaignId: "1" });
  await service.prepare(1n);
  assert.equal(state.getCampaign(service.key(1n)).status, ARKIV_STATUS.READY_TO_SIGN);
});

test("a stale record from an older schema (COMPLETE, other owner's keys) is re-verified, not trusted", async () => {
  const { arkiv, state, service } = setup();
  const key = service.key(1n);
  state.updateCampaign(key, { status: "COMPLETE", stored: 10, arkivSchema: "ethglobal-mumbai-2026.creature.v1", campaignId: "1" });
  state.updateCreature(key, String(1n << 32n), { arkivEntityKey: "0x" + "9".repeat(64), arkivStatus: "STORED" });
  await service.prepare(1n);
  assert.equal(state.getCampaign(key).status, ARKIV_STATUS.READY_TO_SIGN, "old COMPLETE is not carried over");
  const report = await service.verify(1n);
  assert.equal(report.stored, 0);
  assert.equal(state.getCampaign(key).creatures[String(1n << 32n)].arkivEntityKey, null, "unverified key is forgotten");
  assert.equal((await service.plan(1n)).payloads.length, 10);
  assert.equal(arkiv.entities.size, 0);
});

test("concurrent prepare calls share one run", async () => {
  const { swarm, service } = setup();
  const [a, b] = await Promise.all([service.prepare(1n), service.prepare(1n)]);
  assert.equal(a, b);
  assert.equal(swarm.uploads, 10);
});
