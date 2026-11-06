// ArkivCreatureStore.findCampaignEntities: keyset traversal (arkiv-query recipe), checked against a
// fake query builder that behaves like the node: current state at every fetch, ordered by $key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ArkivCreatureStore } from "../src/arkiv.js";

const BUSINESS = "0x0913B468eeba5099cF6AEb61242423294D604fBa";
const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
const entity = (k, i) => ({
  $key: hex(k),
  $creator: BUSINESS,
  $owner: BUSINESS,
  creatureId: { value: String((1n << 32n) | BigInt(i)) },
  rarity: { value: "COMMON" },
  discountCode: { value: "e1.x" },
  swarmReference: { value: "a".repeat(64) },
});

/** Fake client: every fetch reads the CURRENT rows, applies `$key > boundary`, sorts by $key, limits. */
function fakeClient(rows, { onFetch } = {}) {
  const log = { fetches: 0, options: [], orders: [], creators: [] };
  const client = {
    select() {
      let boundary = null;
      let limit = 100;
      const b = {
        from(_schema, opts) {
          log.options.push(opts);
          return b;
        },
        createdBy(a) {
          log.creators.push(a);
          return b;
        },
        where(expr) {
          const m = /^\$key > key\((0x[0-9a-f]{64})\)$/.exec(String(expr));
          if (m) boundary = BigInt(m[1]);
          return b;
        },
        orderBy(o) {
          log.orders.push(o);
          return b;
        },
        limit(n) {
          limit = n;
          return b;
        },
        async fetch() {
          log.fetches++;
          onFetch?.(log.fetches, rows);
          const page = rows
            .filter((r) => boundary === null || BigInt(r.$key) > boundary)
            .sort((x, y) => (BigInt(x.$key) < BigInt(y.$key) ? -1 : 1))
            .slice(0, limit);
          return { entities: page, blockNumber: 1n };
        },
      };
      return b;
    },
  };
  return { client, log };
}

const store = (client) => new ArkivCreatureStore({ network: "rabdi", accessKey: "", schemaName: "t.v2", client });
const query = (s) => s.findCampaignEntities({ creator: BUSINESS, chainId: 84532, contract: "0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83", campaignId: 1n });

test("walks every page by $key with onMismatch 'throw' and the business as creator", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => entity(1000 + i * 7, i));
  const { client, log } = fakeClient(rows);
  const found = await query(store(client));
  assert.equal(found.size, 250);
  assert.equal(log.fetches, 3);
  assert.ok(log.options.every((o) => o?.onMismatch === "throw"));
  assert.ok(log.orders.every((o) => o.name === "$key" && o.direction === "asc"));
  assert.ok(log.creators.every((c) => c === BUSINESS));
});

test("rows disappearing mid-scan (expiry/deletion) cannot make later existing ones be skipped", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => entity(1000 + i * 7, i));
  const survivors = new Set(rows.slice(30).map((r) => r.creatureId.value));
  // After the first page, 30 already-returned entities expire. Offset paging would now skip the
  // 30 rows that shift into the already-read range; a $key boundary is unaffected.
  const { client } = fakeClient(rows, {
    onFetch: (n, r) => {
      if (n === 2) r.splice(0, r.length, ...r.filter((x) => BigInt(x.$key) >= BigInt(hex(1000 + 30 * 7))));
    },
  });
  const found = await query(store(client));
  for (const id of survivors) assert.ok(found.has(id), `existing creature ${id} was skipped`);
});

test("a traversal that does not advance fails instead of returning a partial result", async () => {
  const stuck = {
    select() {
      const b = { from: () => b, createdBy: () => b, where: () => b, orderBy: () => b, limit: () => b, fetch: async () => ({ entities: Array.from({ length: 100 }, (_, i) => entity(5, i)) }) };
      return b;
    },
  };
  await assert.rejects(query(store(stuck)), /did not advance/);
});
