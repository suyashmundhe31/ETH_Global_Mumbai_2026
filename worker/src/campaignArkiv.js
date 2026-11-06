// Prepares and verifies the Arkiv creature entities of a campaign. The BUSINESS writes them (signed
// in MetaMask, so Arkiv records the business as $creator and $owner); this service never signs.
//
// Guarantees:
//  * exactly one Arkiv entity per Creature ID is asked for: every plan is computed AFTER re-reading
//    Arkiv (entities created by the campaign's business, filtered by chainId + contract + campaignId),
//    so a retry only asks the business to sign the creatures that are still missing
//  * Arkiv writes are not assumed atomic across creatures: the business signs independent batches and
//    a failed batch simply shows up as "missing" in the next plan
//  * keys the browser reports are never trusted blindly: they are re-read from Arkiv and must have the
//    business as $creator and the on-chain rarity / reward
//  * per-creature .glb variants are deterministic, so re-uploading to Swarm yields the same reference
import { stampCreatureMetadata } from "./glb.js";
import { campaignKey } from "./state.js";
import { createLogger, errMessage } from "./util.js";

export const ARKIV_STATUS = {
  WAITING_FOR_VRF: "WAITING_FOR_VRF",
  PREPARING: "PREPARING", // per-creature Swarm assets being uploaded
  READY_TO_SIGN: "READY_TO_SIGN", // payloads ready; waiting for the business to sign
  PARTIAL: "PARTIAL",
  COMPLETE: "COMPLETE",
};

export class NotAllocatedError extends Error {}
export class NotReadyError extends Error {}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
// Arkiv's native entity-operation address (arkiv router recipe; SDK ARKIV_ADDRESS).
export const ARKIV_ENTITY_ADDRESS = "0x4400000000000000000000000000000000000044";
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export class CampaignArkivService {
  /**
   * @param {object} deps
   * @param {import('./chain.js').CampaignChain} deps.chain
   * @param {{download: Function, uploadGlb: Function}} deps.swarm
   * @param {{findCampaignEntities: Function, getCreatureEntity: Function}} deps.arkiv
   * @param {import('./state.js').JsonStateStore} deps.state
   * @param {(expiresAtUnix: bigint) => {mode: string}} deps.expirationFor
   */
  constructor({ chain, swarm, arkiv, state, expirationFor, batchSize = 10, settler = null, logger }) {
    Object.assign(this, { chain, swarm, arkiv, state, expirationFor, batchSize, settler });
    this.log = logger || createLogger("arkiv-campaigns");
    this._preparing = new Map();
  }

  key(campaignId) {
    return campaignKey(this.chain.chainId, this.chain.address, BigInt(campaignId));
  }

  async _allocated(campaignId) {
    const campaign = await this.chain.getCampaign(campaignId);
    if (campaign.statusName !== "ALLOCATED") {
      throw new NotAllocatedError(`Campaign ${campaignId} is ${campaign.statusName}, not ALLOCATED`);
    }
    const total = Number(campaign.totalCreatures);
    const creatures = await this.chain.getAllCreatures(campaignId, total);
    if (creatures.length !== total) throw new Error(`Expected ${total} creatures on-chain, read ${creatures.length}`);
    return { campaign, creatures, total };
  }

  /** Builds every creature's Swarm asset. Idempotent; concurrent calls for a campaign share one run. */
  prepare(campaignId) {
    const id = BigInt(campaignId).toString();
    if (!this._preparing.has(id)) {
      const p = this._prepare(BigInt(id)).finally(() => this._preparing.delete(id));
      this._preparing.set(id, p);
    }
    return this._preparing.get(id);
  }

  async _prepare(campaignId) {
    const { chainId, address: contract } = this.chain;
    const key = this.key(campaignId);
    const log = this.log.child(`campaign-${campaignId}`);
    const { campaign, creatures, total } = await this._allocated(campaignId);
    const prev = this.state.getCampaign(key);
    const txs = prev?.creationTxHash ? { creationTxHash: prev.creationTxHash, allocationTxHash: prev.allocationTxHash } : await this.chain.getCampaignTxHashes(campaignId);
    const { mode: expirationMode } = this.expirationFor(campaign.expiresAt);

    this.state.updateCampaign(key, {
      chainId,
      contract,
      campaignId: campaignId.toString(),
      business: campaign.business,
      businessName: campaign.businessName,
      totalCreatures: total,
      expiresAtUnix: campaign.expiresAt.toString(),
      vrfRequestId: campaign.vrfRequestId.toString(),
      campaignSwarmReference: campaign.swarmReference,
      ...txs,
      expirationMode,
      // Keep a result verified under THIS schema; anything else (the listener's PENDING, a record from
      // an older schema version) starts over as PREPARING and is re-verified against Arkiv.
      status: prev?.arkivSchema === this.arkiv.schemaName && [ARKIV_STATUS.PARTIAL, ARKIV_STATUS.COMPLETE].includes(prev?.status) ? prev.status : ARKIV_STATUS.PREPARING,
      arkivSchema: this.arkiv.schemaName,
    });

    const pending = creatures.filter((c) => !this.state.getCampaign(key)?.creatures?.[c.creatureId.toString()]?.swarmReference);
    const errors = [];
    if (pending.length) {
      log.info(`preparing ${pending.length}/${total} per-creature Swarm assets`);
      const base = await this.swarm.download(campaign.swarmReference); // also proves it is retrievable
      for (const c of pending) {
        try {
          await this._ensureCreatureAsset(key, c, base.data, campaign);
        } catch (err) {
          errors.push({ creatureId: c.creatureId.toString(), stage: "swarm", error: errMessage(err) });
          this.state.updateCreature(key, c.creatureId.toString(), { swarmStatus: "FAILED", lastError: errMessage(err) });
        }
      }
    }
    const prepared = errors.length === 0;
    const after = this.state.getCampaign(key);
    this.state.updateCampaign(key, {
      prepared,
      preparedCount: total - errors.length,
      lastError: prepared ? null : errors.at(-1).error,
      status: prepared && after.status === ARKIV_STATUS.PREPARING ? ARKIV_STATUS.READY_TO_SIGN : after.status,
    });
    if (pending.length) log.info(prepared ? `all ${total} creatures ready for the business to sign` : `${errors.length} Swarm uploads failed`);
    return { campaignId: campaignId.toString(), prepared, total, ready: total - errors.length, errors };
  }

  /**
   * What the business still has to sign: the payloads of the creatures that have no valid entity
   * on Arkiv yet. Re-reads Arkiv every time, so calling it again after any failure is the retry.
   */
  async plan(campaignId) {
    const key = this.key(campaignId);
    if (!this.state.getCampaign(key)?.prepared) {
      const r = await this.prepare(campaignId);
      if (!r.prepared) throw new NotReadyError(`Swarm assets ready for ${r.ready}/${r.total} creatures; retrying`);
    }
    const { campaign, creatures, total } = await this._allocated(campaignId);
    const { valid } = await this._reconcile(key, campaignId, campaign, creatures);
    // arkiv-write-safety: a creature whose earlier transaction may still land is never planned again.
    const pending = await this._unresolvedTransactions(key, valid);
    const held = new Set(pending.flatMap((p) => p.creatureIds));
    const st = this.state.getCampaign(key);
    const missing = creatures.filter((c) => !valid.has(c.creatureId.toString()) && !held.has(c.creatureId.toString()));
    const payloads = missing.map((c) =>
      buildCreaturePayload({
        creature: c,
        campaign,
        chainId: this.chain.chainId,
        contract: this.chain.address,
        swarmReference: st.creatures[c.creatureId.toString()].swarmReference,
        txs: st,
      }),
    );
    return {
      campaignId: campaignId.toString(),
      business: campaign.business,
      chainId: this.chain.chainId,
      contract: this.chain.address,
      expiresAtUnix: campaign.expiresAt.toString(),
      expirationMode: st.expirationMode,
      batchSize: this.batchSize,
      total,
      stored: valid.size,
      payloads,
      // Transactions whose outcome is not settled yet: their creatures are held back, not re-planned.
      pending,
      // Approval / Auto settle, inferred from who owns the entities already written (null = none yet, the
      // business chooses). A campaign never mixes modes: the page follows this once it is known.
      settlement: { mode: inferSettlementMode(valid, campaign.business, this.settler), settler: this.settler },
    };
  }

  /**
   * Creatures held back because an earlier business transaction for them is still pending or was
   * applied but is not yet visible. Released only when Arkiv shows the transaction reverted or
   * the node no longer knows it (dropped).
   */
  async _unresolvedTransactions(key, valid) {
    const byHash = new Map();
    for (const [creatureId, rec] of Object.entries(this.state.getCampaign(key)?.creatures || {})) {
      if (!rec.pendingTxHash) continue;
      if (valid.has(creatureId)) {
        this.state.updateCreature(key, creatureId, { pendingTxHash: null });
        continue;
      }
      byHash.set(rec.pendingTxHash, [...(byHash.get(rec.pendingTxHash) || []), creatureId]);
    }
    const unresolved = [];
    for (const [txHash, creatureIds] of byHash) {
      const status = await this.arkiv.transactionStatus(txHash);
      if (status === "pending" || status === "success") unresolved.push({ txHash, status, creatureIds });
      else for (const id of creatureIds) this.state.updateCreature(key, id, { pendingTxHash: null, arkivStatus: "MISSING" });
    }
    return unresolved;
  }

  /**
   * Records what a business transaction did, as reported by the browser:
   *  - entries: creatureId -> entityKey of a confirmed batch (re-read from Arkiv before it counts)
   *  - pending: creatureIds of a batch whose outcome is uncertain (sent, receipt unknown). The hash
   *    must be a real Arkiv transaction from the campaign's business to the entity address.
   */
  async recordSubmission(campaignId, { txHash, entries, pending }) {
    const key = this.key(campaignId);
    const st = this.state.getCampaign(key);
    if (!st) throw new NotReadyError(`Campaign ${campaignId} has not been prepared`);
    const total = BigInt(st.totalCreatures);
    const checkId = (raw) => {
      const id = BigInt(String(raw));
      if (id >> 32n !== BigInt(campaignId) || (id & 0xffffffffn) >= total) throw new TypeError(`creature ${raw} is not part of campaign ${campaignId}`);
      return id.toString();
    };

    if (pending !== undefined) {
      if (!Array.isArray(pending) || pending.length === 0) throw new TypeError("pending must be a non-empty array of creature IDs");
      if (!HEX_KEY.test(String(txHash))) throw new TypeError("txHash is required for a pending batch");
      const ids = pending.map(checkId);
      const tx = await this.arkiv.getTransaction(txHash);
      if (!tx) throw new TypeError(`Arkiv does not know transaction ${txHash}`);
      if (!sameAddress(tx.from, st.business) || !sameAddress(tx.to, ARKIV_ENTITY_ADDRESS)) {
        throw new TypeError("Transaction is not an Arkiv entity write from this campaign's business");
      }
      for (const id of ids) this.state.updateCreature(key, id, { pendingTxHash: txHash, arkivStatus: "PENDING_TX" });
      return { recorded: ids.length, pending: true };
    }

    if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("entries must be a non-empty array");
    for (const e of entries) {
      checkId(e.creatureId);
      if (!HEX_KEY.test(String(e.entityKey))) throw new TypeError(`invalid entity key for creature ${e.creatureId}`);
    }
    for (const e of entries) {
      this.state.updateCreature(key, String(e.creatureId), { submittedKey: e.entityKey, arkivTxHash: txHash ?? null, arkivStatus: "SUBMITTED", pendingTxHash: null });
    }
    return { recorded: entries.length };
  }

  /** Verifies the campaign against Arkiv itself (not against our own bookkeeping). */
  async verify(campaignId) {
    const key = this.key(campaignId);
    const { campaign, creatures, total } = await this._allocated(campaignId);
    if (!this.state.getCampaign(key)) await this.prepare(campaignId).catch(() => {});
    const { valid, mismatched } = await this._reconcile(key, campaignId, campaign, creatures);

    for (const [creatureId, entries] of valid) {
      this.state.updateCreature(key, creatureId, {
        arkivEntityKey: entries[0].key,
        arkivOwner: entries[0].owner,
        arkivStatus: "STORED",
        pendingTxHash: null,
        duplicateKeys: entries.slice(1).map((e) => e.key),
        lastError: null,
      });
    }
    const missing = creatures.map((c) => c.creatureId.toString()).filter((id) => !valid.has(id));
    // Forget keys that did not verify (wrong creator, older schema, forged data, not found).
    for (const id of missing) {
      const rec = this.state.getCampaign(key)?.creatures?.[id];
      if (rec?.arkivEntityKey || rec?.arkivStatus === "STORED") {
        this.state.updateCreature(key, id, { arkivEntityKey: null, arkivOwner: null, duplicateKeys: [], arkivStatus: "MISSING" });
      }
    }
    const duplicates = [...valid].filter(([, e]) => e.length > 1).map(([creatureId, e]) => ({ creatureId, keys: e.map((x) => x.key) }));
    const status = missing.length === 0 ? ARKIV_STATUS.COMPLETE : valid.size === 0 ? (this.state.getCampaign(key)?.prepared ? ARKIV_STATUS.READY_TO_SIGN : ARKIV_STATUS.PREPARING) : ARKIV_STATUS.PARTIAL;
    this.state.updateCampaign(key, {
      status,
      arkivSchema: this.arkiv.schemaName,
      stored: valid.size,
      missing,
      duplicates,
      mismatched,
      verifiedAt: new Date().toISOString(),
    });
    this.log.child(`campaign-${campaignId}`).info(`verified ${status}: ${valid.size}/${total} entities created by ${campaign.business}`);
    return { campaignId: campaignId.toString(), status, expected: total, stored: valid.size, missing, duplicates, mismatched, creator: campaign.business };
  }

  /**
   * Entities on Arkiv for this campaign that are valid: created by the campaign's business and
   * matching the on-chain creature (rarity + reward). Primary source: a $creator-filtered query.
   * Keys recorded from the browser that the query does not (yet) return are re-read directly, so a
   * lagging index can never make us ask for a duplicate.
   */
  async _reconcile(key, campaignId, campaign, creatures) {
    const { chainId, address: contract } = this.chain;
    const business = campaign.business;
    const found = await this.arkiv.findCampaignEntities({ creator: business, chainId, contract, campaignId });
    const recorded = this.state.getCampaign(key)?.creatures || {};
    for (const [creatureId, rec] of Object.entries(recorded)) {
      for (const k of [rec.submittedKey, rec.arkivEntityKey]) {
        if (!k || found.get(creatureId)?.some((e) => e.key === k)) continue;
        const e = await this.arkiv.getCreatureEntity(k);
        if (e && sameAddress(e.creator, business) && String(e.creatureId) === creatureId) {
          found.set(creatureId, [...(found.get(creatureId) || []), e]);
        }
      }
    }
    const byId = new Map(creatures.map((c) => [c.creatureId.toString(), c]));
    const valid = new Map();
    const mismatched = [];
    for (const [creatureId, entries] of found) {
      const c = byId.get(creatureId);
      for (const e of entries) {
        if (c && sameAddress(e.creator, business) && e.rarity === c.rarityName && e.discountCode === c.discountCode) {
          valid.set(creatureId, [...(valid.get(creatureId) || []), e]);
        } else {
          mismatched.push({ creatureId, key: e.key });
        }
      }
    }
    return { valid, mismatched };
  }

  async _ensureCreatureAsset(key, creature, baseGlb, campaign) {
    const id = creature.creatureId.toString();
    const variant = stampCreatureMetadata(baseGlb, {
      creatureId: id,
      campaignId: creature.campaignId.toString(),
      rarity: creature.rarityName,
      business: creature.business,
      chainId: this.chain.chainId,
      contract: this.chain.address,
      campaignSwarmReference: campaign.swarmReference,
    });
    const up = await this.swarm.uploadGlb(variant, `creature-${id}.glb`);
    this.state.updateCreature(key, id, { swarmReference: up.reference, swarmStatus: "UPLOADED", rarity: creature.rarityName, lastError: null });
    return up.reference;
  }
}

/** "auto" when entities are held by the settler, "approval" when held by the business, else null. */
export function inferSettlementMode(valid, business, settler) {
  const owners = [...valid.values()].flat().map((e) => e.owner);
  if (settler && owners.some((o) => sameAddress(o, settler))) return "auto";
  if (owners.some((o) => sameAddress(o, business))) return "approval";
  return null;
}

/** Arkiv payload for one creature: plain JSON (the shared module maps it to typed Arkiv values). */
export function buildCreaturePayload({ creature, campaign, chainId, contract, swarmReference, txs }) {
  return {
    creatureId: creature.creatureId.toString(),
    campaignId: creature.campaignId.toString(),
    creatureIndex: Number(creature.index),
    chainId,
    contract,
    businessName: creature.businessName,
    rarity: creature.rarityName,
    discountCode: creature.discountCode,
    discountDescription: creature.discountDescription,
    totalCreatures: Number(campaign.totalCreatures),
    latitudeE6: Number(creature.latitudeE6),
    longitudeE6: Number(creature.longitudeE6),
    expiresAtUnix: creature.expiresAt.toString(),
    swarmReference,
    campaignSwarmReference: creature.swarmReference,
    createdAt: creature.createdAt.toString(),
    campaignTxHash: txs.creationTxHash ?? "",
    allocationTxHash: txs.allocationTxHash ?? "",
    vrfRequestId: campaign.vrfRequestId.toString(),
    listed: false,
    catched: false,
    redeemed: false,
    price: null,
  };
}
