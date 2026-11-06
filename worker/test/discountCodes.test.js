import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { revealMessage } from "../../shared/discountCodes.js";
import { CodeAccessError, CodeCipher, DiscountCodeService, isEncryptedCode } from "../src/discountCodes.js";

const KEY = randomBytes(32).toString("base64");
const CONTRACT = "0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83";
const business = privateKeyToAccount(generatePrivateKey());
const player = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const ctx = (rarity, who = business.address) => ({ chainId: 84532, contract: CONTRACT, business: who, rarity });

test("round trip; ciphertext fits the contract (64 bytes) and Arkiv (128 bytes)", () => {
  const c = new CodeCipher(KEY);
  const enc = c.encrypt("SUMMER2026-VIP16", ctx(3)); // 16 bytes = the maximum
  assert.ok(isEncryptedCode(enc));
  assert.ok(Buffer.byteLength(enc) <= 64, `${Buffer.byteLength(enc)} bytes`);
  assert.equal(c.decrypt(enc, ctx(3)), "SUMMER2026-VIP16");
  assert.notEqual(c.encrypt("COM10", ctx(0)), c.encrypt("COM10", ctx(0)), "random IV");
});

test("rejects codes longer than 16 bytes or empty", () => {
  const c = new CodeCipher(KEY);
  assert.throws(() => c.encrypt("THIS-CODE-IS-TOO-LONG", ctx(0)), TypeError);
  assert.throws(() => c.encrypt("", ctx(0)), TypeError);
});

test("ciphertext is bound to its business / rarity / contract and to the key", () => {
  const c = new CodeCipher(KEY);
  const enc = c.encrypt("LEG100", ctx(3));
  assert.throws(() => c.decrypt(enc, ctx(3, stranger.address)), "copied into another business's campaign");
  assert.throws(() => c.decrypt(enc, ctx(0)), "moved to another rarity");
  assert.throws(() => new CodeCipher(randomBytes(32).toString("base64")).decrypt(enc, ctx(3)), "wrong key");
  const tampered = enc.slice(0, -2) + (enc.at(-2) === "A" ? "B" : "A") + enc.at(-1);
  assert.throws(() => c.decrypt(tampered, ctx(3)), "tampered");
});

test("campaigns created before encryption keep their (already public) plaintext", () => {
  assert.equal(new CodeCipher(KEY).decrypt("COM10", ctx(0)), "COM10");
});

test("the key must be 32 bytes base64", () => {
  assert.throws(() => new CodeCipher("short"));
  assert.throws(() => new CodeCipher(""));
});

// ------------------------------------------------------------------ reveal authorization
function setup({ owner = business.address, redeemed = false, now = Date.UTC(2026, 10, 6, 12) } = {}) {
  const cipher = new CodeCipher(KEY);
  const codes = ["COM10", "RAR25", "EPI50", "LEG100"];
  const rewards = codes.map((code, r) => ({ code: cipher.encrypt(code, ctx(r)), description: `${code} reward` }));
  const chain = {
    chainId: 84532,
    address: CONTRACT,
    getCampaign: async () => ({ business: business.address, statusName: "ALLOCATED" }),
    getRewards: async () => rewards,
    read: async (fn, [id]) => ({ creatureId: id, rarity: Number(id & 3n) }), // creature index -> rarity
  };
  // CreatureMarket: creature (2 << 32) | 3 is held by `owner`.
  const market = { getHolding: async (id) => (id === ((2n << 32n) | 3n) ? { owner, redeemed } : { owner: "0x0000000000000000000000000000000000000000", redeemed: false }) };
  const service = new DiscountCodeService({ chain, market, cipher, now: () => now });
  const sign = async (account, { creatureId = null, issuedAt = new Date(now).toISOString() } = {}) => ({
    campaignId: 2n,
    creatureId,
    address: account.address,
    issuedAt,
    signature: await account.signMessage({ message: revealMessage({ chainId: 84532, contract: CONTRACT, campaignId: 2n, creatureId, address: account.address, issuedAt }) }),
  });
  return { service, sign, now };
}

test("the business reveals all codes of its campaign", async () => {
  const { service, sign } = setup();
  const r = await service.reveal(await sign(business));
  assert.deepEqual(r.codes.map((c) => c.code), ["COM10", "RAR25", "EPI50", "LEG100"]);
  assert.ok(r.codes.every((c) => c.wasEncrypted));
});

test("a stranger cannot reveal, even with a valid signature of their own", async () => {
  const { service, sign } = setup();
  await assert.rejects(service.reveal(await sign(stranger)), (e) => e instanceof CodeAccessError && e.status === 403);
  await assert.rejects(service.reveal(await sign(stranger, { creatureId: String((2n << 32n) | 3n) })), (e) => e.status === 403);
});

test("the creature's owner sees its code only after redeeming it on chain", async () => {
  const before = setup({ owner: player.address, redeemed: false });
  await assert.rejects(before.service.reveal(await before.sign(player, { creatureId: String((2n << 32n) | 3n) })), (e) => e.status === 403 && /Redeem/.test(e.message));
  const { service, sign } = setup({ owner: player.address, redeemed: true });
  const r = await service.reveal(await sign(player, { creatureId: String((2n << 32n) | 3n) }));
  assert.equal(r.code, "LEG100");
  assert.equal(r.rarity, "LEGENDARY");
  await assert.rejects(service.reveal(await sign(player)), (e) => e.status === 403, "not all codes");
});

test("a signature for one request cannot be reused for another, and expires", async () => {
  const { service, sign, now } = setup();
  const req = await sign(business);
  await assert.rejects(service.reveal({ ...req, creatureId: String((2n << 32n) | 3n) }), (e) => e.status === 401, "different creature");
  await assert.rejects(service.reveal({ ...req, address: stranger.address }), (e) => e.status === 401, "different wallet");
  const old = await sign(business, { issuedAt: new Date(now - 10 * 60 * 1000).toISOString() });
  await assert.rejects(service.reveal(old), (e) => e.status === 401, "expired");
});

test("encryptRewardCodes keeps empty codes empty and binds each to its rarity", async () => {
  const { service } = setup();
  const out = service.encryptRewardCodes({ business: business.address, codes: ["COM10", "", "EPI50", "LEG100"] });
  assert.equal(out[1], "");
  assert.equal(new CodeCipher(KEY).decrypt(out[3], ctx(3)), "LEG100");
  assert.throws(() => service.encryptRewardCodes({ business: "nope", codes: ["a", "b", "c", "d"] }), TypeError);
});
