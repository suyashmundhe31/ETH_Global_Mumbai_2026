// Pure helpers for the creature referee workflow (no CRE runtime calls), unit-tested in referee.test.ts.
// Kept out of main.ts: the WASM compiler (javy) rejects exported functions with parameters in the entry file.
import { gcm } from "@noble/ciphers/aes";
import nacl from "tweetnacl";
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, numberToHex, padHex, type Hex } from "viem";

/** Great-circle distance in metres between two E6 coordinates. */
export function haversineMeters(lat1E6: number, lon1E6: number, lat2E6: number, lon2E6: number): number {
  const R = 6_371_000;
  const rad = (e6: number) => (e6 / 1e6) * (Math.PI / 180);
  const dLat = rad(lat2E6 - lat1E6);
  const dLon = rad(lon2E6 - lon1E6);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1E6)) * Math.cos(rad(lat2E6)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Base64 or base64url (padding optional) -> bytes. No atob/Buffer dependency. */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("invalid base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

/** Additional data bound into every encrypted discount code (friend's shared/discountCodes.js). */
export function codeAad(chainId: number, campaignManager: string, business: string, rarity: number): Uint8Array {
  return new TextEncoder().encode(
    `creature-discount-code|v1|${chainId}|${campaignManager.toLowerCase()}|${business.toLowerCase()}|${rarity}`,
  );
}

/** "e1." + base64url(iv[12] | ciphertext | tag[16]) -> plaintext. Codes without the prefix are legacy plaintext. */
export function decryptCode(stored: string, key: Uint8Array, aad: Uint8Array): string {
  if (!stored.startsWith("e1.")) return stored;
  const raw = base64ToBytes(stored.slice(3));
  if (raw.length < 12 + 16) throw new Error("ciphertext too short");
  const plain = gcm(key, raw.subarray(0, 12), aad).decrypt(raw.subarray(12)); // throws if tag/AAD mismatch
  return new TextDecoder().decode(plain);
}

/** Deterministic across DON nodes (and a creature is revealed at most once). */
export const boxNonce = (creatureId: bigint) => hexToBytes(keccak256(padHex(numberToHex(creatureId), { size: 32 }))).subarray(0, 24);

export function sealCode(code: string, creatureId: bigint, playerPubKey: Hex, workflowSk: Uint8Array): Hex {
  const sealed = nacl.box(new TextEncoder().encode(code), boxNonce(creatureId), hexToBytes(playerPubKey), workflowSk);
  return bytesToHex(sealed);
}

export const encodeReport = (chainSelector: bigint, reportType: number, payload: Hex) =>
  encodeAbiParameters([{ type: "uint64" }, { type: "uint8" }, { type: "bytes" }], [chainSelector, reportType, payload]);
