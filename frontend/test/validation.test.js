import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCampaign } from "../src/validation.js";

const NOW = 1_800_000_000;
const valid = () => ({
  businessName: "Chai Point",
  totalCreatures: "10",
  counts: { COMMON: "6", RARE: "2", EPIC: "1", LEGENDARY: "1" },
  rewards: {
    COMMON: { code: "C10", description: "10% off" },
    RARE: { code: "R25", description: "25% off" },
    EPIC: { code: "E50", description: "50% off" },
    LEGENDARY: { code: "L100", description: "Free meal" },
  },
  latitude: "19.07609",
  longitude: "72.877426",
  expiration: "",
  asset: "ember-fox.glb",
});

test("valid form produces contract input", () => {
  const { errors, input } = validateCampaign(valid(), NOW);
  assert.deepEqual(errors, []);
  assert.deepEqual(input.rarityCounts, [6, 2, 1, 1]);
  assert.equal(input.latitudeE6, 19076090);
  assert.equal(input.expiresAt, 0n, "empty expiration -> 0 (none)");
});

test("distribution must sum to total", () => {
  const f = valid();
  f.totalCreatures = "11";
  assert.match(validateCampaign(f, NOW).errors.join(), /must be equal/);
});

test("rarity with creatures needs a reward; unused rarity may be empty", () => {
  const f = valid();
  f.counts.LEGENDARY = "0";
  f.counts.COMMON = "7";
  f.rewards.LEGENDARY = { code: "", description: "" };
  assert.deepEqual(validateCampaign(f, NOW).errors, []);
  f.counts.LEGENDARY = "1";
  f.totalCreatures = "11";
  assert.match(validateCampaign(f, NOW).errors.join(), /LEGENDARY has creatures/);
});

test("rejects bad coordinates, past expiration, non-integer counts, too many creatures", () => {
  const f = valid();
  f.latitude = "91";
  f.expiration = new Date((NOW - 10) * 1000).toISOString();
  f.counts.RARE = "1.5";
  const errs = validateCampaign(f, NOW).errors.join("\n");
  assert.match(errs, /Latitude/);
  assert.match(errs, /future/);
  assert.match(errs, /RARE count/);
  const g = valid();
  g.totalCreatures = "501";
  g.counts.COMMON = "497";
  assert.match(validateCampaign(g, NOW).errors.join(), /between 1 and 500/);
});

test("future expiration converts to unix seconds", () => {
  const f = valid();
  f.expiration = new Date((NOW + 86400) * 1000).toISOString();
  assert.equal(validateCampaign(f, NOW).input.expiresAt, BigInt(NOW + 86400));
});

test("discount codes are limited to 16 bytes (so the encrypted code fits the contract)", () => {
  const f = valid();
  f.rewards.EPIC.code = "SUMMER2026-VIP16"; // exactly 16
  assert.deepEqual(validateCampaign(f, NOW).errors, []);
  f.rewards.EPIC.code = "SUMMER2026-VIP-17";
  assert.match(validateCampaign(f, NOW).errors.join(" "), /EPIC discount code must be at most 16 bytes/);
});
