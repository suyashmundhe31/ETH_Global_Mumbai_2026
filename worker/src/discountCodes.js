// Symmetric encryption of discount codes (AES-256-GCM, Node's built-in crypto) and the authorized
// reveal. The key (CODE_ENCRYPTION_KEY) lives only in worker/.env — never in the frontend bundle.
//
// Who may decrypt (proved with a wallet signature over revealMessage(), checked with viem):
//   * the campaign's business wallet (read from the contract): all codes of its campaign
//   * the current Arkiv $owner of a creature entity created by that business: that creature's code
//     (today that is the business too; after a capture transfer it is the player)
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isAddress, isHex, verifyMessage } from "viem";
import {
  codeAad,
  ENCRYPTED_CODE_PREFIX,
  isEncryptedCode,
  MAX_PLAINTEXT_CODE_BYTES,
  REVEAL_MAX_AGE_SECONDS,
  revealMessage,
} from "../../shared/discountCodes.js";

export { isEncryptedCode, MAX_PLAINTEXT_CODE_BYTES };

const IV_BYTES = 12;
const TAG_BYTES = 16;
const RARITY = ["COMMON", "RARE", "EPIC", "LEGENDARY"];

export class CodeAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Parses CODE_ENCRYPTION_KEY: 32 random bytes, base64 encoded. */
export function parseCodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64");
  if (key.length !== 32) throw new Error("CODE_ENCRYPTION_KEY must be 32 bytes, base64 encoded (npm run gen-code-key)");
  return key;
}

export class CodeCipher {
  constructor(keyBase64) {
    this.key = parseCodeKey(keyBase64);
  }

  /** @param ctx {chainId, contract, business, rarity} — bound into the ciphertext as AAD */
  encrypt(code, ctx) {
    const plain = Buffer.from(String(code), "utf8");
    if (plain.length === 0 || plain.length > MAX_PLAINTEXT_CODE_BYTES) {
      throw new TypeError(`A discount code must be 1-${MAX_PLAINTEXT_CODE_BYTES} bytes`);
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(codeAad(ctx), "utf8"));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return ENCRYPTED_CODE_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  }

  /** Returns the plaintext; throws if the value was tampered with, encrypted for another context or key. */
  decrypt(value, ctx) {
    if (!isEncryptedCode(value)) return value; // campaigns created before encryption: already public
    const raw = Buffer.from(value.slice(ENCRYPTED_CODE_PREFIX.length), "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new Error("Malformed encrypted discount code");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(codeAad(ctx), "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

export class DiscountCodeService {
  /**
   * @param deps.chain CampaignChain (chainId, address, getCampaign, getRewards, read)
   * @param deps.arkiv reader with findCampaignEntities({creator, chainId, contract, campaignId})
   * @param deps.cipher CodeCipher
   */
  constructor({ chain, arkiv, cipher, now = () => Date.now() }) {
    Object.assign(this, { chain, arkiv, cipher, now });
  }

  ctx(business, rarity) {
    return { chainId: this.chain.chainId, contract: this.chain.address, business, rarity };
  }

  /** Encrypts the four rarity codes for `business` before createCampaign. Empty codes stay empty. */
  encryptRewardCodes({ business, codes }) {
    if (!isAddress(String(business))) throw new TypeError("business must be an address");
    if (!Array.isArray(codes) || codes.length !== 4) throw new TypeError("codes must be an array of 4 (COMMON, RARE, EPIC, LEGENDARY)");
    return codes.map((code, rarity) => (String(code ?? "").trim() === "" ? "" : this.cipher.encrypt(String(code).trim(), this.ctx(business, rarity))));
  }

  /** Verifies the signed request and returns the plaintext code(s) the signer may see. */
  async reveal({ campaignId, creatureId = null, address, issuedAt, signature }) {
    if (!isAddress(String(address))) throw new CodeAccessError(400, "address must be an address");
    if (!isHex(String(signature))) throw new CodeAccessError(400, "signature must be hex");
    const issuedMs = Date.parse(String(issuedAt));
    if (Number.isNaN(issuedMs)) throw new CodeAccessError(400, "issuedAt must be an ISO date");
    const ageSec = (this.now() - issuedMs) / 1000;
    if (ageSec > REVEAL_MAX_AGE_SECONDS || ageSec < -60) throw new CodeAccessError(401, "Signature expired; sign a new request");

    const id = BigInt(campaignId);
    const creature = creatureId === null || creatureId === undefined || creatureId === "" ? null : BigInt(String(creatureId));
    const message = revealMessage({ chainId: this.chain.chainId, contract: this.chain.address, campaignId: id, creatureId: creature, address, issuedAt });
    const valid = await verifyMessage({ address, message, signature }).catch(() => false);
    if (!valid) throw new CodeAccessError(401, "Invalid signature");

    const campaign = await this.chain.getCampaign(id);
    if (!campaign || campaign.statusName === "NONE") throw new CodeAccessError(404, `Campaign ${id} not found`);
    const rewards = await this.chain.getRewards(id);
    const isBusiness = address.toLowerCase() === campaign.business.toLowerCase();
    const decryptFor = (rarity) => ({
      rarity: RARITY[rarity],
      code: this.cipher.decrypt(rewards[rarity].code, this.ctx(campaign.business, rarity)),
      wasEncrypted: isEncryptedCode(rewards[rarity].code),
    });

    if (creature === null) {
      if (!isBusiness) throw new CodeAccessError(403, "Only the campaign's business wallet can reveal all of its codes");
      return { campaignId: id.toString(), codes: [0, 1, 2, 3].filter((r) => rewards[r].code !== "").map(decryptFor) };
    }

    if (creature >> 32n !== id) throw new CodeAccessError(400, `Creature ${creature} is not part of campaign ${id}`);
    const record = await this.chain.read("getCreature", [creature]);
    const rarity = Number(record.rarity);
    if (!isBusiness) {
      const entities = await this.arkiv.findCampaignEntities({ creator: campaign.business, chainId: this.chain.chainId, contract: this.chain.address, campaignId: id });
      const owner = entities.get(creature.toString())?.[0]?.owner;
      if (!owner || owner.toLowerCase() !== address.toLowerCase()) {
        throw new CodeAccessError(403, "Only the business or the creature's current Arkiv owner can reveal its code");
      }
    }
    return { campaignId: id.toString(), creatureId: creature.toString(), ...decryptFor(rarity) };
  }
}
