// Encrypted discount codes — the parts shared by the worker (holds the key) and business-frontend
// (never sees the key). No imports, so both packages can use it.
//
// Format of an encrypted code:  "e1." + base64url( iv[12] | AES-256-GCM ciphertext | tag[16] )
// A 16-byte code encrypts to 62 characters, which fits the contract's MAX_CODE_BYTES (64) and
// Arkiv's 128-byte string limit, so the same ciphertext is stored on-chain and on Arkiv.

export const ENCRYPTED_CODE_PREFIX = "e1.";
export const MAX_PLAINTEXT_CODE_BYTES = 16;
/** A signed reveal request is accepted for this long after `issuedAt`. */
export const REVEAL_MAX_AGE_SECONDS = 300;

export const isEncryptedCode = (value) => typeof value === "string" && value.startsWith(ENCRYPTED_CODE_PREFIX);

/**
 * Additional authenticated data: binds a ciphertext to one chain, contract, business and rarity, so it
 * cannot be copied into another business's campaign (and then revealed by that business).
 */
export function codeAad({ chainId, contract, business, rarity }) {
  return `creature-discount-code|v1|${Number(chainId)}|${String(contract).toLowerCase()}|${String(business).toLowerCase()}|${Number(rarity)}`;
}

/**
 * The exact text the wallet signs (EIP-191 personal_sign) to ask the worker to decrypt codes.
 * The worker rebuilds it from the request fields, so a signature only ever authorizes this request.
 * creatureId = null -> all four rarity codes of the campaign (business only).
 */
export function revealMessage({ chainId, contract, campaignId, creatureId = null, address, issuedAt }) {
  return [
    "Reveal discount codes",
    `Campaign: ${String(campaignId)}`,
    `Creature: ${creatureId === null || creatureId === undefined ? "all" : String(creatureId)}`,
    `Chain: ${Number(chainId)}`,
    `Contract: ${String(contract).toLowerCase()}`,
    `Wallet: ${String(address).toLowerCase()}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}
