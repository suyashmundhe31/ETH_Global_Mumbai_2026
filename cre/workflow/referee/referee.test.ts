import { describe, expect, test } from "bun:test";
import { gcm } from "@noble/ciphers/aes";
import nacl from "tweetnacl";
import { bytesToHex, hexToBytes } from "viem";
import { base64ToBytes, boxNonce, codeAad, decryptCode, haversineMeters, sealCode } from "./referee";

const SPAWN = { lat: 19_063_702, lon: 72_867_181 }; // Reliance campaign
const CAMPAIGN_MANAGER = "0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83";
const BUSINESS = "0x0913B468eeba5099cF6AEb61242423294D604fBa";

/** Same format as the friend's encryptor: "e1." + base64url(iv | ciphertext | tag). */
function encrypt(code: string, key: Uint8Array, aad: Uint8Array, iv = crypto.getRandomValues(new Uint8Array(12))) {
  const ct = gcm(key, iv, aad).encrypt(new TextEncoder().encode(code));
  const raw = new Uint8Array([...iv, ...ct]);
  return "e1." + Buffer.from(raw).toString("base64url");
}

describe("distance", () => {
  test("50 m away is within 100 m, 2 km away is not", () => {
    const north50m = SPAWN.lat + 450; // 0.00045° ≈ 50 m
    const north2km = SPAWN.lat + 18_000; // 0.018° ≈ 2 km
    expect(haversineMeters(north50m, SPAWN.lon, SPAWN.lat, SPAWN.lon)).toBeCloseTo(50, -1);
    expect(haversineMeters(north50m, SPAWN.lon, SPAWN.lat, SPAWN.lon)).toBeLessThanOrEqual(100);
    expect(haversineMeters(north2km, SPAWN.lon, SPAWN.lat, SPAWN.lon)).toBeGreaterThan(1990);
    expect(haversineMeters(SPAWN.lat, SPAWN.lon, SPAWN.lat, SPAWN.lon)).toBe(0);
  });
});

describe("discount code decryption", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const aad = codeAad(84532, CAMPAIGN_MANAGER, BUSINESS, 3);

  test("AAD uses lowercase addresses and the numeric rarity", () => {
    expect(new TextDecoder().decode(aad)).toBe(
      `creature-discount-code|v1|84532|${CAMPAIGN_MANAGER.toLowerCase()}|${BUSINESS.toLowerCase()}|3`,
    );
  });

  test("round-trips the e1 format", () => {
    expect(decryptCode(encrypt("LEG10", key, aad), key, aad)).toBe("LEG10");
  });

  test("a 4-char code gives the 32-byte payload seen in Arkiv", () => {
    const stored = encrypt("R10X", key, aad);
    expect(base64ToBytes(stored.slice(3)).length).toBe(32);
  });

  test("rejects a wrong key, another rarity's AAD, or a tampered ciphertext", () => {
    const stored = encrypt("LEG10", key, aad);
    expect(() => decryptCode(stored, crypto.getRandomValues(new Uint8Array(32)), aad)).toThrow();
    expect(() => decryptCode(stored, key, codeAad(84532, CAMPAIGN_MANAGER, BUSINESS, 0))).toThrow();
    const raw = base64ToBytes(stored.slice(3));
    raw[14] ^= 1;
    expect(() => decryptCode("e1." + Buffer.from(raw).toString("base64url"), key, aad)).toThrow();
  });

  test("legacy plaintext codes pass through", () => {
    expect(decryptCode("COM10", key, aad)).toBe("COM10");
  });

  test("base64ToBytes matches Buffer for base64url and padded base64", () => {
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(bytesToHex(base64ToBytes(Buffer.from(b).toString("base64url")))).toBe(bytesToHex(b));
      expect(bytesToHex(base64ToBytes(Buffer.from(b).toString("base64")))).toBe(bytesToHex(b));
    }
  });
});

describe("sealing to the player", () => {
  const workflow = nacl.box.keyPair();
  const player = nacl.box.keyPair();
  const creatureId = 17179869185n;

  test("only the player's key opens it, with the workflow public key", () => {
    const sealed = hexToBytes(sealCode("LEG10", creatureId, bytesToHex(player.publicKey), workflow.secretKey));
    const opened = nacl.box.open(sealed, boxNonce(creatureId), workflow.publicKey, player.secretKey);
    expect(opened && new TextDecoder().decode(opened)).toBe("LEG10");
    const stranger = nacl.box.keyPair();
    expect(nacl.box.open(sealed, boxNonce(creatureId), workflow.publicKey, stranger.secretKey)).toBeNull();
  });

  test("deterministic, so every DON node produces the same report", () => {
    const a = sealCode("LEG10", creatureId, bytesToHex(player.publicKey), workflow.secretKey);
    const b = sealCode("LEG10", creatureId, bytesToHex(player.publicKey), workflow.secretKey);
    expect(a).toBe(b);
    expect(boxNonce(creatureId).length).toBe(24);
  });
});
