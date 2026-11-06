import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@arkiv-network/sdk";
import { toCreatureValues } from "../../shared/creatureEntity.js";
import { creatureSchema, expirationFor } from "../src/arkiv.js";
import { GlbValidationError, parseGlb, stampCreatureMetadata } from "../src/glb.js";
import { BASE_GLB } from "./fakes.js";

test("valid GLB parses", () => {
  const { json, bin } = parseGlb(BASE_GLB);
  assert.equal(json.asset.version, "2.0");
  assert.ok(bin.length > 0);
});

test("rejects non-GLB data and oversize files", () => {
  assert.throws(() => parseGlb(Buffer.from("hello world, definitely not glb")), GlbValidationError);
  assert.throws(() => parseGlb(BASE_GLB, { maxBytes: 100 }), GlbValidationError);
  const wrongLen = Buffer.from(BASE_GLB);
  wrongLen.writeUInt32LE(5, 8);
  assert.throws(() => parseGlb(wrongLen), /length/);
});

test("per-creature stamping: valid, deterministic, unique, geometry untouched", () => {
  const a1 = stampCreatureMetadata(BASE_GLB, { creatureId: "1" });
  const a2 = stampCreatureMetadata(BASE_GLB, { creatureId: "1" });
  const b = stampCreatureMetadata(BASE_GLB, { creatureId: "2" });
  assert.ok(a1.equals(a2), "deterministic");
  assert.ok(!a1.equals(b), "unique per creature");
  const parsed = parseGlb(a1);
  assert.equal(parsed.json.asset.extras.creature.creatureId, "1");
  assert.ok(parsed.bin.equals(parseGlb(BASE_GLB).bin), "BIN chunk unchanged");
});

test("Arkiv schema fits the attribute limit", () => {
  const s = creatureSchema("test.creature.v2");
  assert.ok(Object.keys(s.columns).length <= 31);
  for (const c of ["listed", "catched", "redeemed", "price"]) assert.ok(c in s.columns, c);
  assert.equal("business" in s.columns, false);
});

test("expiration: no campaign expiry -> maximum Arkiv lifetime", () => {
  assert.match(expirationFor(0n).mode, /max-lifetime/);
});

test("expiration: campaign ending in 7 days -> entity expires at that date", () => {
  const now = Date.UTC(2026, 10, 6);
  const exp = BigInt(now / 1000 + 7 * 86400);
  assert.equal(expirationFor(exp, now).mode, "campaign-expiration");
});

test("expiration: campaign beyond Arkiv max lifetime -> clamped to max", () => {
  const now = Date.UTC(2026, 10, 6);
  const exp = BigInt(now / 1000 + 400 * 86400);
  assert.match(expirationFor(exp, now).mode, /max-lifetime/);
});

test("payload maps to typed Arkiv values", () => {
  const v = toCreatureValues(sdk, {
    creatureId: "4294967296",
    campaignId: 1n,
    creatureIndex: 0,
    chainId: 31337,
    contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    businessName: "Chai Point",
    rarity: "EPIC",
    discountCode: "EPIC50",
    discountDescription: "50% off",
    totalCreatures: 10,
    latitudeE6: -33868820,
    longitudeE6: 151209290,
    expiresAtUnix: 0n,
    swarmReference: "b".repeat(64),
    campaignSwarmReference: "a".repeat(64),
    createdAt: 1750000000n,
    campaignTxHash: "0x1",
    allocationTxHash: "0x2",
    vrfRequestId: 7n,
    price: 250,
  });
  assert.equal(v.campaignId.type, "u64");
  assert.equal(v.contract.type, "addr");
  assert.equal(v.latitudeE6, -33868820);
  assert.equal(v.vrfRequestId, "7");
  assert.equal(v.listed, false);
  assert.equal(v.catched, false);
  assert.equal(v.redeemed, false);
  assert.equal(v.price.type, "u64");
  assert.equal(v.price.value, 250n);
});
