// Pure logic tests (node --test, Node's built-in TypeScript type stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_RADIUS_M, boundingBoxE6, distanceM, distanceSquaredUm, withinClaimRadius } from "../lib/geo.ts";
import { selectSpawns, type CampaignCandidate } from "../lib/spawns.ts";

const LAT = 19_076_090;
const LON = 72_877_426;

test("claim radius matches CreatureMarket exactly (same cases as the Foundry tests)", () => {
  assert.equal(withinClaimRadius(LAT + 449, LON, LAT, LON), true); // 49.98 m north
  assert.equal(withinClaimRadius(LAT + 450, LON, LAT, LON), false); // 50.09 m north
  assert.equal(withinClaimRadius(LAT, LON - 470, LAT, LON), true); // ~49.4 m west
  assert.equal(withinClaimRadius(LAT, LON + 480, LAT, LON), false); // ~50.5 m east
  assert.equal(CLAIM_RADIUS_M, 50);
});

test("distances agree with the contract's known values", () => {
  assert.ok(Math.abs(distanceM(LAT + 8983, LON, LAT, LON) - 1000) < 2);
  assert.ok(Math.abs(distanceM(LAT, LON + 9505, LAT, LON) - 1000) < 10);
  assert.equal(distanceSquaredUm(0, 180_000_000, 0, -179_999_999), BigInt(111_320) * BigInt(111_320)); // antimeridian
});

test("bounding box covers the radius", () => {
  const box = boundingBoxE6(19.07609, 72.877426, 500);
  assert.ok(distanceM(box.maxLat, LON, LAT, LON) > 500);
  assert.ok(distanceM(LAT, box.maxLon, LAT, LON) > 500);
});

const c = (o: Partial<CampaignCandidate>): CampaignCandidate => ({
  campaignId: "1",
  business: "0xaaa",
  latitudeE6: LAT,
  longitudeE6: LON,
  nextCreatureId: "4294967296",
  available: true,
  claimedByPlayer: false,
  ...o,
});

test("one creature per business: the nearest campaign wins", () => {
  const spawns = selectSpawns(
    [
      c({ campaignId: "1", latitudeE6: LAT + 2000 }), // ~220 m
      c({ campaignId: "2", latitudeE6: LAT + 500 }), // ~56 m
      c({ campaignId: "3", business: "0xbbb", latitudeE6: LAT + 1000 }),
    ],
    LAT,
    LON,
  );
  assert.deepEqual(spawns.map((s) => s.campaignId), ["2", "3"]);
});

test("claimed, unavailable and far campaigns are hidden", () => {
  const spawns = selectSpawns(
    [
      c({ campaignId: "1", claimedByPlayer: true }),
      c({ campaignId: "2", business: "0xbbb", available: false }),
      c({ campaignId: "3", business: "0xccc", latitudeE6: LAT + 4600 }), // ~512 m
      c({ campaignId: "4", business: "0xddd", latitudeE6: LAT + 4400 }), // ~490 m
    ],
    LAT,
    LON,
  );
  assert.deepEqual(spawns.map((s) => s.campaignId), ["4"]);
});

test("a business whose nearest campaign was claimed by the player shows its next campaign", () => {
  const spawns = selectSpawns([c({ campaignId: "1", claimedByPlayer: true }), c({ campaignId: "2", latitudeE6: LAT + 3000 })], LAT, LON);
  assert.deepEqual(spawns.map((s) => s.campaignId), ["2"]);
});
