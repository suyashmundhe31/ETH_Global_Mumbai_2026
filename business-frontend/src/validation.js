// Pure campaign-form validation (no DOM, no wallet) so it can be unit tested with node:test.
// Limits mirror CreatureCampaignManager.sol; the contract re-validates everything on-chain.
// Discount codes are encrypted before they go on-chain, so the plaintext limit is the one that keeps
// the ciphertext within the contract's 64 bytes (see shared/discountCodes.js).
import { MAX_PLAINTEXT_CODE_BYTES } from "../../shared/discountCodes.js";

export const RARITIES = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
export const LIMITS = { maxCreatures: 500, name: 64, code: MAX_PLAINTEXT_CODE_BYTES, description: 128 };
const SWARM_REF = /^[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/;

const utf8Len = (s) => new TextEncoder().encode(s).length;

function parseCount(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return NaN;
  return Number(s);
}

/**
 * @param {object} form raw form values (strings)
 * @param {number} nowSec current unix time
 * @returns {{ errors: string[], input?: object }} `input` matches the contract's CampaignInput struct
 */
export function validateCampaign(form, nowSec = Math.floor(Date.now() / 1000)) {
  const errors = [];
  const name = String(form.businessName ?? "").trim();
  if (!name) errors.push("Business name is required.");
  else if (utf8Len(name) > LIMITS.name) errors.push(`Business name must be at most ${LIMITS.name} bytes.`);

  const total = parseCount(form.totalCreatures);
  const counts = RARITIES.map((r) => parseCount(form.counts?.[r]));
  if (!Number.isInteger(total) || total < 1 || total > LIMITS.maxCreatures) {
    errors.push(`Total creatures must be an integer between 1 and ${LIMITS.maxCreatures}.`);
  }
  counts.forEach((c, i) => {
    if (!Number.isInteger(c)) errors.push(`${RARITIES[i]} count must be a non-negative integer.`);
  });
  if (counts.every(Number.isInteger) && Number.isInteger(total)) {
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum !== total) errors.push(`Common + Rare + Epic + Legendary = ${sum}, but Total = ${total}. They must be equal.`);
  }

  const rewards = RARITIES.map((r, i) => {
    const code = String(form.rewards?.[r]?.code ?? "").trim();
    const description = String(form.rewards?.[r]?.description ?? "").trim();
    if (utf8Len(code) > LIMITS.code) errors.push(`${r} discount code must be at most ${LIMITS.code} bytes.`);
    if (utf8Len(description) > LIMITS.description) errors.push(`${r} description must be at most ${LIMITS.description} bytes.`);
    if (counts[i] > 0 && (!code || !description)) errors.push(`${r} has creatures, so it needs a discount code and description.`);
    return { code, description };
  });

  const lat = Number(form.latitude);
  const lon = Number(form.longitude);
  if (String(form.latitude ?? "").trim() === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.push("Latitude must be between -90 and 90.");
  }
  if (String(form.longitude ?? "").trim() === "" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    errors.push("Longitude must be between -180 and 180.");
  }

  let expiresAt = 0n; // 0 = no expiration
  if (form.expiration) {
    const ms = Date.parse(form.expiration);
    if (Number.isNaN(ms)) errors.push("Expiration date is invalid.");
    else if (Math.floor(ms / 1000) <= nowSec) errors.push("Expiration must be in the future (or left empty).");
    else expiresAt = BigInt(Math.floor(ms / 1000));
  }

  if (!form.asset || !/\.glb$/i.test(form.asset)) errors.push("Select a .glb model from the assets folder.");
  if (form.swarmReference !== undefined && !SWARM_REF.test(form.swarmReference)) errors.push("Invalid Swarm reference.");

  if (errors.length) return { errors };
  return {
    errors,
    input: {
      businessName: name,
      swarmReference: form.swarmReference ?? "",
      latitudeE6: Math.round(lat * 1e6),
      longitudeE6: Math.round(lon * 1e6),
      expiresAt,
      totalCreatures: total,
      rarityCounts: counts,
      rewards,
    },
  };
}
