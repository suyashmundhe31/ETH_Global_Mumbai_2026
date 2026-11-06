import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@arkiv-network/sdk";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { creatureCreates, creatureExpiration, defineCreatureSchema } from "../../shared/creatureEntity.js";
import { expirationFor } from "../src/arkiv.js";
import { CampaignArkivService } from "../src/campaignArkiv.js";
import { LISTING_TYPES, marketDomain } from "../src/marketChain.js";
import { JOB, MarketSettler, SettlerRequestError, settlementView } from "../src/settler.js";
import { campaignKey, JsonStateStore } from "../src/state.js";
import { BUSINESS, FakeChain, FakeMarket, FakeSwarm, MemoryArkiv } from "./fakes.js";

const quiet = { info() {}, warn() {}, error() {}, child: () => quiet };
const schema = defineCreatureSchema(sdk);
// Anvil dev account #3 (public test key).
const ACCOUNT = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const SETTLER = ACCOUNT.address;
const PLAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const BUYER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const GRACE = 60_000;

function setup() {
  const chain = new FakeChain();
  const arkiv = new MemoryArkiv();
  const state = new JsonStateStore(null);
  const service = new CampaignArkivService({ chain, swarm: new FakeSwarm(), arkiv, state, expirationFor, batchSize: 10, settler: SETTLER, logger: quiet });
  const market = new FakeMarket();
  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const settler = new MarketSettler({
    chain, market, arkiv, wallet: arkiv.walletFor(SETTLER), account: ACCOUNT, schema, state,
    startBlock: 1n, retryDelayMs: 0, escrowGraceMs: GRACE, now: () => clock.now, logger: quiet,
  });
  return { chain, arkiv, state, service, market, settler, clock };
}

/** The business signs its creatures (what the page does). Auto settle: same batch hands them to the settler. */
async function businessSigns({ arkiv, service }, mode) {
  const plan = await service.plan(1n);
  const creates = creatureCreates(sdk, schema, plan.payloads, creatureExpiration(sdk, 0).expiration);
  const batch = { creates };
  if (mode === "auto") {
    const predicted = await arkiv.predictEntityKeys({ owner: BUSINESS, count: creates.length });
    batch.ownershipChanges = predicted.map((p) => ({ entityKey: p.key, newOwner: SETTLER }));
  }
  const res = await arkiv.walletFor(BUSINESS).executeBatch(batch);
  await service.recordSubmission(1n, { txHash: res.txHash, entries: plan.payloads.map((p, i) => ({ creatureId: p.creatureId, entityKey: res.createdEntities[i] })) });
  await service.verify(1n);
  return res.createdEntities;
}

const entry = (arkiv, creatureId) => [...arkiv.entities].find(([, e]) => e.values.creatureId === String(creatureId));
const entityOf = (arkiv, creatureId) => entry(arkiv, creatureId)?.[1];
const keyOf = (arkiv, creatureId) => entry(arkiv, creatureId)?.[0];
const tick = async (settler) => {
  await settler.pollOnce();
  await settler.settleAll();
};

/** Auto campaign + one claimed creature now owned by PLAYER on Arkiv. */
async function ownedByPlayer(ctx) {
  await businessSigns(ctx, "auto");
  const id = ctx.market.claim({ player: PLAYER });
  await tick(ctx.settler);
  assert.equal(entityOf(ctx.arkiv, id).owner, PLAYER);
  return id;
}

/** What the profile page does to sell: one atomic batch (listed, price, ownership -> settler escrow). */
function escrow(ctx, id, price, set = {}) {
  return ctx.arkiv.walletFor(PLAYER).executeBatch({
    patches: [{ schema, entityKey: keyOf(ctx.arkiv, id), set: { listed: true, price: sdk.u64(price), ...set } }],
    ownershipChanges: [{ entityKey: keyOf(ctx.arkiv, id), newOwner: SETTLER }],
  });
}

test("auto settle: a claim transfers the creature to the player (catched = true) and notifies the business", async () => {
  const ctx = setup();
  await businessSigns(ctx, "auto");
  const id = ctx.market.claim({ player: PLAYER, rarity: 0 });
  await tick(ctx.settler);

  const e = entityOf(ctx.arkiv, id);
  assert.equal(e.owner, PLAYER);
  assert.equal(e.creator, BUSINESS);
  assert.equal(e.values.catched, true);
  assert.equal(ctx.settler.job(id).status, JOB.DONE);
  // Other creatures stay with the settler, uncaught.
  assert.equal(entityOf(ctx.arkiv, (1n << 32n) | 1n).owner, SETTLER);
  assert.equal(entityOf(ctx.arkiv, (1n << 32n) | 1n).values.catched, false);

  const view = settlementView({ state: ctx.state, key: campaignKey(31337, ctx.chain.address, 1n), settler: SETTLER, business: BUSINESS });
  assert.equal(view.mode, "auto");
  assert.equal(view.autoSettled.length, 1);
  assert.equal(view.autoSettled[0].player, PLAYER);
  assert.equal(view.autoSettled[0].rarity, "COMMON");

  // Idempotent: another pass changes nothing.
  const calls = ctx.arkiv.batchCalls;
  ctx.settler.queue(id);
  await tick(ctx.settler);
  assert.equal(ctx.arkiv.batchCalls, calls);
});

test("approval campaign: the settler never moves a business-held creature", async () => {
  const ctx = setup();
  await businessSigns(ctx, "approval");
  const id = ctx.market.claim({ player: PLAYER });
  const calls = ctx.arkiv.batchCalls;
  await tick(ctx.settler);
  assert.equal(entityOf(ctx.arkiv, id).owner, BUSINESS);
  assert.equal(ctx.settler.job(id).status, JOB.APPROVAL);
  assert.equal(ctx.arkiv.batchCalls, calls);
  const view = settlementView({ state: ctx.state, key: campaignKey(31337, ctx.chain.address, 1n), settler: SETTLER, business: BUSINESS });
  assert.equal(view.mode, "approval");
  assert.equal(view.autoSettled.length, 0);
});

test("marketplace: escrow -> attestation -> listed -> sold moves the entity to the buyer", async () => {
  const ctx = setup();
  const id = await ownedByPlayer(ctx);
  await escrow(ctx, id, 5000n);

  const att = await ctx.settler.attestListing({ creatureId: id.toString(), seller: PLAYER, price: "5000" });
  const valid = await verifyTypedData({
    address: SETTLER,
    domain: marketDomain({ chainId: 31337, address: ctx.market.address }),
    types: LISTING_TYPES,
    primaryType: "Listing",
    message: { seller: PLAYER, creatureId: id, price: 5000n, deadline: BigInt(att.deadline) },
    signature: att.signature,
  });
  assert.ok(valid, "CreatureMarket would accept the attestation");

  ctx.market.list(id, 5000n);
  await tick(ctx.settler);
  assert.equal(entityOf(ctx.arkiv, id).owner, SETTLER, "stays in escrow while listed");
  assert.equal(ctx.settler.job(id).status, JOB.DONE);

  ctx.market.buy(id, BUYER);
  await tick(ctx.settler);
  const e = entityOf(ctx.arkiv, id);
  assert.equal(e.owner, BUYER);
  assert.equal(e.values.listed, false);
  assert.equal(e.values.price, undefined, "price unset");
  assert.equal(e.values.catched, true);
  const view = settlementView({ state: ctx.state, key: campaignKey(31337, ctx.chain.address, 1n), settler: SETTLER, business: BUSINESS });
  assert.equal(view.sales.length, 1);
  assert.equal(view.sales[0].buyer, BUYER);
  assert.equal(view.sales[0].price, "5000");
});

test("marketplace: unlisting returns the entity to the seller", async () => {
  const ctx = setup();
  const id = await ownedByPlayer(ctx);
  await escrow(ctx, id, 7n);
  await ctx.settler.attestListing({ creatureId: id.toString(), seller: PLAYER, price: "7" });
  ctx.market.list(id, 7n);
  await tick(ctx.settler);
  ctx.market.unlist(id);
  await tick(ctx.settler);
  const e = entityOf(ctx.arkiv, id);
  assert.equal(e.owner, PLAYER);
  assert.equal(e.values.listed, false);
  assert.equal(e.values.price, undefined);
});

test("marketplace: an escrow never listed on chain goes back to the owner after the grace period", async () => {
  const ctx = setup();
  const id = await ownedByPlayer(ctx);
  await escrow(ctx, id, 9n);
  await ctx.settler.sweep();
  await tick(ctx.settler);
  assert.equal(entityOf(ctx.arkiv, id).owner, SETTLER, "kept while the seller may still list");
  assert.equal(ctx.settler.job(id).status, JOB.ESCROW);

  ctx.clock.now += GRACE + 1;
  ctx.settler.nextAttemptAt.clear();
  await tick(ctx.settler);
  assert.equal(entityOf(ctx.arkiv, id).owner, PLAYER);
  assert.equal(entityOf(ctx.arkiv, id).values.listed, false);
});

test("attestation: every check must pass", async () => {
  const ctx = setup();
  const id = await ownedByPlayer(ctx);
  const ask = (o) => ctx.settler.attestListing({ creatureId: id.toString(), seller: PLAYER, price: "10", ...o });
  const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof SettlerRequestError && e.status === status && (!re || re.test(e.message)));

  await rejects(ask({}), 409, /escrow/); // still held by the player
  await rejects(ask({ seller: BUYER }), 403); // not the owner
  await rejects(ask({ price: "0" }), 400);
  await escrow(ctx, id, 10n);
  await rejects(ask({ price: "11" }), 409, /same price/);
  ctx.market.redeem(id);
  await rejects(ask({}), 409, /redeemed/);
});

test("attestation: tampered Arkiv data is refused, restored from the chain and handed back", async () => {
  const ctx = setup();
  const id = await ownedByPlayer(ctx);
  // The owner tries to sell a COMMON as LEGENDARY.
  await escrow(ctx, id, 10n, { rarity: "LEGENDARY" });
  await assert.rejects(ctx.settler.attestListing({ creatureId: id.toString(), seller: PLAYER, price: "10" }), (e) => e.status === 422 && /rarity/.test(e.message));
  await ctx.settler.settleAll();
  const e = entityOf(ctx.arkiv, id);
  assert.equal(e.owner, PLAYER);
  assert.equal(e.values.rarity, "COMMON", "restored");
  assert.equal(e.values.listed, false);
});

test("a lost receipt is reconciled, never sent twice", async () => {
  const ctx = setup();
  await businessSigns(ctx, "auto");
  const id = ctx.market.claim({ player: PLAYER });
  ctx.arkiv.landThenThrow = 1;
  await tick(ctx.settler);
  assert.equal(ctx.settler.job(id).status, JOB.PENDING_TX);
  assert.equal(entityOf(ctx.arkiv, id).owner, PLAYER, "the transaction did land");
  const calls = ctx.arkiv.batchCalls;
  await tick(ctx.settler);
  assert.equal(ctx.arkiv.batchCalls, calls, "no second transaction");
  assert.equal(ctx.settler.job(id).status, JOB.DONE);
  const view = settlementView({ state: ctx.state, key: campaignKey(31337, ctx.chain.address, 1n), settler: SETTLER, business: BUSINESS });
  assert.equal(view.autoSettled.length, 1);
});

test("a claim before the business signed waits, then settles", async () => {
  const ctx = setup();
  const id = ctx.market.claim({ player: PLAYER });
  await tick(ctx.settler);
  assert.equal(ctx.settler.job(id).status, JOB.WAITING_ENTITY);
  await businessSigns(ctx, "auto");
  await ctx.settler.settleAll();
  assert.equal(entityOf(ctx.arkiv, id).owner, PLAYER);
});

test("look-alike entities written by someone else are ignored", async () => {
  const ctx = setup();
  await businessSigns(ctx, "auto");
  const id = ctx.market.claim({ player: PLAYER });
  // A stranger creates a copy and gives it to the settler: it must not be moved or trusted.
  const fake = { ...entityOf(ctx.arkiv, id).values };
  const res = await ctx.arkiv.walletFor(BUYER).executeBatch({ creates: [{ values: fake, flags: {}, expiration: 1 }] });
  await ctx.arkiv.walletFor(BUYER).executeBatch({ ownershipChanges: [{ entityKey: res.createdEntities[0], newOwner: SETTLER }] });
  await tick(ctx.settler);
  assert.equal(ctx.arkiv.entities.get(res.createdEntities[0]).owner, SETTLER, "copy untouched");
  assert.equal(entityOf(ctx.arkiv, id).owner, PLAYER, "the real one moved");
});

test("a sale seen by the escrow sweep before its Sold event is still a sale (no grace wait)", async () => {
  const ctx = setup();
  const id = await ownedByPlayer(ctx);
  await escrow(ctx, id, 5000n);
  await ctx.settler.attestListing({ creatureId: id.toString(), seller: PLAYER, price: "5000" });
  ctx.market.list(id, 5000n);
  await tick(ctx.settler);
  await ctx.settler.sweep(); // re-queues the (listed) escrow
  await ctx.settler.settleAll();
  ctx.market.buy(id, BUYER);
  await ctx.settler.sweep(); // the sweep runs before the Sold event is polled
  await ctx.settler.settleAll();
  assert.equal(entityOf(ctx.arkiv, id).owner, BUYER, "moved at once, without waiting for the grace period");
  const view = settlementView({ state: ctx.state, key: campaignKey(31337, ctx.chain.address, 1n), settler: SETTLER, business: BUSINESS });
  assert.deepEqual(view.sales.map((x) => [x.buyer, x.price]), [[BUYER, "5000"]]);
  // The buyer escrows without listing: the grace period applies again (no stale seller).
  const key = keyOf(ctx.arkiv, id);
  await ctx.arkiv.walletFor(BUYER).executeBatch({ patches: [{ schema, entityKey: key, set: { listed: true, price: sdk.u64(9n) } }], ownershipChanges: [{ entityKey: key, newOwner: SETTLER }] });
  await ctx.settler.sweep();
  await ctx.settler.settleAll();
  assert.equal(ctx.settler.job(id).status, JOB.ESCROW, "kept for the grace period");
  assert.equal(entityOf(ctx.arkiv, id).owner, SETTLER);
});
