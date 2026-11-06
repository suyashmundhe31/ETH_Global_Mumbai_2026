// THE SETTLER: keeps every creature entity it holds on Arkiv in line with CreatureMarket (the authority).
//
//   Auto settle   The business launched with "Auto settle", so its uncaught creatures are held by the
//                 settler ($creator = business). CreatureClaimed -> one atomic Arkiv batch:
//                 catched = true (+ chain-truth fields) and ownership -> the player. The business sees it
//                 in its campaign's notification feed. "Approval" campaigns are left to the business.
//   Marketplace   To sell, the owner moves the entity into the settler's escrow (listed = true, price),
//                 asks the worker for a listing attestation (attestListing: ownership, not redeemed, data
//                 untampered) and lists on chain with it. Then, automatically:
//                   Sold      -> ownership -> buyer, listed = false, price unset
//                   Unlisted  -> ownership -> seller, listed = false, price unset
//                   never listed on chain (escrow timed out / data tampered) -> back to the owner
//                 Every transfer also rewrites any field that does not match the chain (repairs tampering).
//
// The chain decides; nothing here trusts a request or an event payload: each step re-reads the contract
// and Arkiv. Only entities CREATED BY the campaign's business (read from the contract) are considered.
//
// Write safety (Arkiv skills: arkiv-write-safety): one signer, one transaction at a time; intent is saved
// before sending; every known hash is kept; an uncertain send is reconciled, never blindly resent.
import * as sdk from "@arkiv-network/sdk";
import { isAddress } from "viem";
import { toCreatureValues } from "../../shared/creatureEntity.js";
import { buildCreaturePayload } from "./campaignArkiv.js";
import { LISTING_TYPES, marketDomain } from "./marketChain.js";
import { campaignKey } from "./state.js";
import { createLogger, errMessage, sleep } from "./util.js";

export const JOB = {
  QUEUED: "QUEUED", // something changed on chain (or a sweep found the entity): reconcile it
  ESCROW: "ESCROW", // the seller moved the entity to the settler; waiting for the on-chain listing
  WAITING_ENTITY: "WAITING_ENTITY", // the business has not signed this creature onto Arkiv yet
  SENDING: "SENDING", // durable intent saved; the transaction may be in flight
  PENDING_TX: "PENDING_TX", // sent; waiting for Arkiv to show the outcome of pendingTxHash
  UNCERTAIN: "UNCERTAIN", // send failed without a hash; reconciled before any new attempt
  DONE: "DONE", // Arkiv matches the chain
  APPROVAL: "APPROVAL", // claimed in an Approval campaign: the business approves it
  SKIPPED: "SKIPPED", // nothing the settler may do (not created by the business, never claimed, ...)
};
const OPEN = new Set([JOB.QUEUED, JOB.ESCROW, JOB.WAITING_ENTITY, JOB.SENDING, JOB.PENDING_TX, JOB.UNCERTAIN]);
const IN_FLIGHT = new Set([JOB.SENDING, JOB.PENDING_TX, JOB.UNCERTAIN]);
const ZERO = "0x0000000000000000000000000000000000000000";
const RARITY = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
const MAX_U64 = (1n << 64n) - 1n;
const FEED_LIMIT = 200;

export const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Columns that must equal what the chain says (the rest are either lifecycle or worker-generated). */
const TRUTH_COLUMNS = [
  "creatureId", "campaignId", "creatureIndex", "chainId", "contract", "businessName", "rarity", "discountCode",
  "discountDescription", "totalCreatures", "latitudeE6", "longitudeE6", "expiresAtUnix", "campaignSwarmReference",
  "createdAt", "vrfRequestId",
];
/** Worker-generated columns, checked only when the worker's journal knows their value. */
const JOURNAL_COLUMNS = ["swarmReference"];

const plain = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);
const norm = (v) => {
  const p = plain(v);
  if (p === undefined || p === null) return "";
  const s = String(p);
  return /^0x[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : s;
};

export class SettlerRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function txHashOf(err) {
  for (let e = err; e; e = e.cause) {
    if (typeof e.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(e.txHash)) return e.txHash;
  }
  return undefined;
}

export class MarketSettler {
  /**
   * @param deps.chain   CampaignChain (campaigns + creatures: the truth for entity fields)
   * @param deps.market  MarketChain (holdings, listings, events)
   * @param deps.arkiv   reader: findCreatureEntities, findHeldBy, transactionStatus, nonceIdle
   * @param deps.wallet  the settler's Arkiv wallet client (executeBatch)
   * @param deps.account the settler's viem account (address + signTypedData for attestations)
   * @param deps.txParamsFor (batch) => TxParams (Rabdi gas policy), optional
   */
  constructor({
    chain, market, arkiv, wallet, account, schema, state, txParamsFor, startBlock = null, confirmations = 0n,
    pollIntervalMs = 3000, logRange = 2000n, retryDelayMs = 30_000, sweepIntervalMs = 60_000,
    escrowGraceMs = 15 * 60_000, attestTtlSeconds = 600, now = () => Date.now(), logger,
  }) {
    Object.assign(this, {
      chain, market, arkiv, wallet, account, schema, state, txParamsFor, startBlock, confirmations, pollIntervalMs,
      logRange, retryDelayMs, sweepIntervalMs, escrowGraceMs, attestTtlSeconds, now,
    });
    this.settler = account.address;
    this.log = logger || createLogger("settler");
    this.checkpointName = `market:${chain.chainId}:${String(market.address).toLowerCase()}`;
    this.stopped = false;
    this.nextAttemptAt = new Map(); // creatureId -> ms
    this.lastSweepAt = 0;
  }

  // ------------------------------------------------------------------ journal

  key(campaignId) {
    return campaignKey(this.chain.chainId, this.chain.address, BigInt(campaignId));
  }

  job(creatureId) {
    const id = BigInt(creatureId);
    return this.state.getCampaign(this.key(id >> 32n))?.creatures?.[id.toString()]?.market;
  }

  _save(creatureId, patch) {
    const id = BigInt(creatureId);
    const k = this.key(id >> 32n);
    if (!this.state.getCampaign(k)) this.state.updateCampaign(k, { chainId: this.chain.chainId, contract: this.chain.address, campaignId: (id >> 32n).toString() });
    const market = { ...(this.job(id) || { creatureId: id.toString() }), ...patch, updatedAt: new Date(this.now()).toISOString() };
    this.state.updateCreature(k, id.toString(), { market });
    return market;
  }

  _feed(creatureId, entry) {
    const k = this.key(BigInt(creatureId) >> 32n);
    const feed = [{ creatureId: String(creatureId), at: new Date(this.now()).toISOString(), ...entry }, ...(this.state.getCampaign(k)?.feed || [])];
    this.state.updateCampaign(k, { feed: feed.slice(0, FEED_LIMIT) });
  }

  /** Marks a creature for reconciliation (events, sweeps, attestations). A transaction in flight keeps its status. */
  queue(creatureId, patch = {}) {
    const prev = this.job(creatureId);
    const status = prev && IN_FLIGHT.has(prev.status) ? prev.status : JOB.QUEUED;
    this.nextAttemptAt.delete(String(creatureId));
    return this._save(creatureId, { ...patch, status, queuedAt: new Date(this.now()).toISOString() });
  }

  openJobs() {
    const out = [];
    for (const c of this.state.listCampaigns()) {
      if (!same(c.contract, this.chain.address)) continue;
      for (const rec of Object.values(c.creatures || {})) if (rec.market && OPEN.has(rec.market.status)) out.push(rec.market);
    }
    return out.sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  }

  // ------------------------------------------------------------------ inputs: events + sweep

  /** Scans new blocks for CreatureMarket events and queues the creatures they touch. */
  async pollOnce() {
    const head = (await this.market.getBlockNumber()) - this.confirmations;
    let last = this.state.getCheckpoint(this.checkpointName);
    if (last === undefined) {
      if (this.startBlock === null) {
        this.state.setCheckpoint(this.checkpointName, head); // first run without a start block: from now on
        return;
      }
      last = this.startBlock - 1n;
    }
    for (let from = last + 1n; from <= head; ) {
      const to = from + this.logRange - 1n < head ? from + this.logRange - 1n : head;
      for (const ev of await this.market.getEvents(from, to)) {
        const id = ev.args?.creatureId;
        if (id === undefined || ev.eventName === "Redeemed") continue; // redeem: the owner holds the entity
        const patch = { lastEvent: ev.eventName, lastEventTx: ev.transactionHash };
        if (ev.eventName === "Sold") patch.lastSale = { seller: ev.args.seller, buyer: ev.args.buyer, price: String(ev.args.price), tx: ev.transactionHash };
        if (ev.eventName === "CreatureClaimed") patch.claim = { player: ev.args.player, rarity: RARITY[Number(ev.args.rarity)], tx: ev.transactionHash };
        this.queue(id, patch);
      }
      this.state.setCheckpoint(this.checkpointName, to);
      from = to + 1n;
    }
  }

  /** Queues every caught creature the settler holds (escrows), so nothing depends on seeing an event. */
  async sweep() {
    for (const e of await this.arkiv.findHeldBy({ owner: this.settler, catched: true })) {
      if (!/^\d+$/.test(String(e.creatureId ?? ""))) continue;
      const j = this.job(e.creatureId);
      if (!j || !OPEN.has(j.status)) this.queue(e.creatureId, { lastEvent: "sweep", escrowUntil: null, escrowSeenAt: null });
    }
  }

  async settleAll() {
    const now = this.now();
    for (const job of this.openJobs()) {
      if ((this.nextAttemptAt.get(job.creatureId) ?? 0) > now) continue;
      try {
        await this.reconcile(BigInt(job.creatureId));
      } catch (err) {
        this.log.warn(`creature ${job.creatureId}: ${errMessage(err)}`);
        this._save(job.creatureId, { lastError: errMessage(err) });
      }
      const after = this.job(job.creatureId);
      if (after?.status === JOB.ESCROW && after.escrowUntil) this.nextAttemptAt.set(job.creatureId, Math.max(after.escrowUntil, now + 1000));
      else if (after && OPEN.has(after.status)) this.nextAttemptAt.set(job.creatureId, now + this.retryDelayMs);
      else this.nextAttemptAt.delete(job.creatureId);
    }
  }

  // ------------------------------------------------------------------ truth

  /** What every chain-derived column of this creature must hold (from the contracts + worker journal). */
  async truthFor(creatureId, campaign) {
    const id = BigInt(creatureId);
    const creature = await this.chain.getCreature(id);
    const rec = this.state.getCampaign(this.key(id >> 32n)) || {};
    const known = rec.creatures?.[id.toString()] || {};
    const payload = buildCreaturePayload({
      creature,
      campaign,
      chainId: this.chain.chainId,
      contract: this.chain.address,
      swarmReference: known.swarmReference ?? "",
      txs: { creationTxHash: rec.creationTxHash ?? "", allocationTxHash: rec.allocationTxHash ?? "" },
    });
    const typed = toCreatureValues(sdk, payload);
    const expected = Object.fromEntries(TRUTH_COLUMNS.map((c) => [c, typed[c]]));
    for (const c of JOURNAL_COLUMNS) if (payload[c]) expected[c] = typed[c];
    return expected;
  }

  /** Columns of `entity` that differ from `expected` (name list). */
  static mismatches(entity, expected) {
    return Object.keys(expected).filter((c) => norm(entity.values[c]) !== norm(expected[c]));
  }

  async _context(id) {
    const campaignId = id >> 32n;
    const [holding, listing, campaign] = await Promise.all([this.market.getHolding(id), this.market.getListing(id), this.chain.getCampaign(campaignId)]);
    const entities = await this.arkiv.findCreatureEntities({ creator: campaign.business, chainId: this.chain.chainId, contract: this.chain.address, creatureId: id });
    return { holding, listing, campaign, entities, mine: entities.find((e) => same(e.owner, this.settler)) };
  }

  // ------------------------------------------------------------------ reconcile one creature

  async reconcile(id) {
    const job = this.job(id) || this._save(id, { status: JOB.QUEUED });

    // 1. Anything already sent is reconciled before signing again.
    if (job.pendingTxHash) {
      const status = await this.arkiv.transactionStatus(job.pendingTxHash);
      if (status === "pending") return job;
      if (status === "unknown" && !(await this.arkiv.nonceIdle(this.settler))) return job;
      this._save(id, { pendingTxHash: null }); // mined (re-check the result below) or dropped: safe to re-plan
    } else if (job.status === JOB.SENDING || job.status === JOB.UNCERTAIN) {
      if (!(await this.arkiv.nonceIdle(this.settler))) return job; // no hash: wait until nothing is in flight
    }

    const { holding, listing, campaign, entities, mine } = await this._context(id);
    const claimed = !same(holding.owner, ZERO);

    if (!mine) {
      if (job.sentTo && entities.some((e) => same(e.owner, job.sentTo))) return this._transferred(id, job, job.sentTo, job.pendingTxHashSeen ?? null, job.sentKind);
      if (!entities.length) return this._save(id, { status: claimed ? JOB.WAITING_ENTITY : JOB.SKIPPED, lastError: null });
      if (claimed && entities.some((e) => same(e.owner, campaign.business)) && !same(holding.owner, campaign.business)) {
        return this._save(id, { status: JOB.APPROVAL, lastError: null }); // Approval campaign: the business approves
      }
      return this._save(id, { status: JOB.DONE, lastError: null }); // with its owner already (or not ours to move)
    }

    if (!claimed) {
      // An uncaught Auto-settle creature waits with the settler. Anything else here is not a real creature state.
      return this._save(id, { status: mine.values.catched ? JOB.SKIPPED : JOB.DONE, lastError: mine.values.catched ? "held by the settler but never claimed" : null });
    }

    const expected = await this.truthFor(id, campaign);
    const listed = !same(listing.seller, ZERO) && same(listing.seller, holding.owner);
    let owner;
    const set = { ...expected, catched: true };
    let unsetPrice = false;
    if (listed) {
      owner = this.settler; // stays in escrow while listed
      Object.assign(set, { redeemed: false, listed: true, price: sdk.u64(BigInt(listing.price)) });
    } else {
      // The escrow simply ends after a sale (the chain shows a new owner than the attested seller) or after a
      // Sold / Unlisted event; otherwise the seller may still be listing (decided from the chain, not from the
      // order in which events and sweeps are seen).
      const soldAway = Boolean(job.seller) && !same(holding.owner, job.seller);
      const midListing = !soldAway && !["Sold", "Unlisted", "Listed"].includes(job.lastEvent);
      if (midListing && mine.values.listed === true && mine.values.catched === true) {
        // In escrow without an on-chain listing: give the seller time to list (attestation deadline), then return it.
        const until = job.escrowUntil ?? (job.escrowSeenAt ?? this.now()) + this.escrowGraceMs;
        if (!job.escrowUntil && !job.escrowSeenAt) this._save(id, { escrowSeenAt: this.now() });
        if (this.now() < until) return this._save(id, { status: JOB.ESCROW, escrowUntil: until, lastError: null });
      }
      owner = holding.owner;
      Object.assign(set, { redeemed: Boolean(holding.redeemed), listed: false });
      unsetPrice = true;
    }

    // 2. Minimal atomic batch: only the columns that differ, then the ownership change (SDK order: patches first).
    const changed = Object.fromEntries(Object.entries(set).filter(([c, v]) => norm(mine.values[c]) !== norm(v)));
    const dropPrice = unsetPrice && mine.values.price !== undefined && mine.values.price !== null;
    const move = !same(owner, this.settler);
    if (!Object.keys(changed).length && !dropPrice && !move) return this._save(id, { status: JOB.DONE, escrowUntil: null, escrowSeenAt: null, lastError: null });

    const patch = { schema: this.schema, entityKey: mine.key, set: changed };
    if (dropPrice) patch.unset = ["price"];
    const batch = { patches: Object.keys(changed).length || dropPrice ? [patch] : [], ownershipChanges: move ? [{ entityKey: mine.key, newOwner: owner }] : [] };
    const sold = job.lastEvent === "Sold" || (Boolean(job.seller) && !same(owner, job.seller));
    const kind = !move ? "repair" : !mine.values.catched ? "claim" : sold ? "sale" : job.lastEvent === "Unlisted" ? "unlisted" : "escrow-returned";
    const repaired = TRUTH_COLUMNS.concat(JOURNAL_COLUMNS).filter((c) => c in changed);

    const txParams = this.txParamsFor ? await this.txParamsFor(batch) : undefined; // throws before any send
    this._save(id, { status: JOB.SENDING, sentTo: move ? owner : null, sentKind: kind, entityKey: mine.key, attempts: (job.attempts ?? 0) + 1 });
    let res;
    try {
      res = await this.wallet.executeBatch(batch, txParams);
    } catch (err) {
      const hash = txHashOf(err);
      this._save(id, hash ? { status: JOB.PENDING_TX, pendingTxHash: hash, pendingTxHashSeen: hash, lastError: errMessage(err) } : { status: JOB.UNCERTAIN, lastError: errMessage(err) });
      throw err;
    }
    if (repaired.length) this.log.warn(`creature ${id}: restored tampered Arkiv columns from the chain: ${repaired.join(", ")}`);
    if (!move) return this._save(id, { status: JOB.DONE, sentTo: null, lastError: null, arkivTxHash: res.txHash });
    return this._transferred(id, this.job(id), owner, res.txHash, kind, { rarity: norm(expected.rarity), repaired });
  }

  _transferred(id, job, to, arkivTxHash, kind, extra = {}) {
    const k = this.key(id >> 32n);
    this.state.updateCreature(k, id.toString(), { arkivOwner: to });
    this._feed(id, {
      kind,
      to,
      rarity: extra.rarity ?? job.claim?.rarity ?? null,
      arkivTxHash,
      chainTxHash: job.lastEventTx ?? null,
      price: kind === "sale" ? job.lastSale?.price ?? job.price ?? null : undefined,
      repaired: extra.repaired?.length ? extra.repaired : undefined,
    });
    this.log.info(`${kind}: creature ${id} -> ${to} on Arkiv${arkivTxHash ? ` (tx ${arkivTxHash})` : ""}`);
    return this._save(id, { status: JOB.DONE, sentTo: null, sentKind: null, pendingTxHash: null, pendingTxHashSeen: null, escrowUntil: null, escrowSeenAt: null, seller: null, price: null, lastError: null, arkivTxHash, settledAt: new Date(this.now()).toISOString() });
  }

  // ------------------------------------------------------------------ listing attestation

  /**
   * Signs the EIP-712 Listing attestation CreatureMarket.list requires, after checking: the seller owns the
   * creature on chain, it is not redeemed or listed, its Arkiv entity (created by the business) is in the
   * settler's escrow with listed = true at exactly this price, and every chain-derived column is untampered.
   */
  async attestListing({ creatureId, seller, price }) {
    if (!/^\d+$/.test(String(creatureId ?? ""))) throw new SettlerRequestError(400, "creatureId must be a decimal integer");
    if (!isAddress(String(seller))) throw new SettlerRequestError(400, "seller must be an address");
    if (!/^\d+$/.test(String(price ?? ""))) throw new SettlerRequestError(400, "price must be an integer amount of wei");
    const id = BigInt(creatureId);
    const wei = BigInt(price);
    if (wei <= 0n || wei > MAX_U64) throw new SettlerRequestError(400, `price must be between 1 and ${MAX_U64} wei`);

    let ctx;
    try {
      ctx = await this._context(id);
    } catch (err) {
      throw new SettlerRequestError(404, `Creature ${id} not found: ${errMessage(err)}`);
    }
    const { holding, listing, campaign, entities, mine } = ctx;
    if (!same(holding.owner, seller)) throw new SettlerRequestError(403, "The seller does not own this creature on chain");
    if (holding.redeemed) throw new SettlerRequestError(409, "A redeemed creature cannot be sold");
    if (!same(listing.seller, ZERO)) throw new SettlerRequestError(409, "Already listed");
    if (!mine) {
      const theirs = entities.some((e) => same(e.owner, seller));
      throw new SettlerRequestError(409, theirs ? "Move the creature into the marketplace escrow on Arkiv first" : "No Arkiv entity of this creature is in escrow");
    }
    if (mine.values.listed !== true || norm(mine.values.price) !== wei.toString()) {
      throw new SettlerRequestError(409, "The escrowed entity must have listed = true and the same price");
    }
    const expected = { ...(await this.truthFor(id, campaign)), catched: true, redeemed: false };
    const bad = MarketSettler.mismatches(mine, expected);
    if (bad.length) {
      this.queue(id, { lastEvent: "tampered", escrowUntil: this.now() }); // restore the data and hand it back
      throw new SettlerRequestError(422, `Arkiv data does not match the chain (${bad.join(", ")}); it will be restored and returned to you`);
    }

    const deadline = BigInt(Math.floor(this.now() / 1000) + this.attestTtlSeconds);
    const signature = await this.account.signTypedData({
      domain: marketDomain({ chainId: this.chain.chainId, address: this.market.address }),
      types: LISTING_TYPES,
      primaryType: "Listing",
      message: { seller, creatureId: id, price: wei, deadline },
    });
    // Keep the escrow until the attestation can no longer be used (plus mining slack), then check the chain.
    this.queue(id, { lastEvent: "attested", seller, price: wei.toString(), escrowUntil: (Number(deadline) + 120) * 1000 });
    this.nextAttemptAt.set(id.toString(), (Number(deadline) + 120) * 1000);
    return { creatureId: id.toString(), seller, price: wei.toString(), deadline: deadline.toString(), signature, settler: this.settler, market: this.market.address };
  }

  // ------------------------------------------------------------------ loop

  async run() {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.log.warn(`market event scan failed: ${errMessage(err)}`);
      }
      if (this.now() - this.lastSweepAt >= this.sweepIntervalMs) {
        this.lastSweepAt = this.now();
        await this.sweep().catch((err) => this.log.warn(`escrow sweep failed: ${errMessage(err)}`));
      }
      await this.settleAll();
      await sleep(this.pollIntervalMs);
    }
  }

  stop() {
    this.stopped = true;
  }
}

/** Settlement view of one campaign for the API: mode, settler, the business's notification feed. */
export function settlementView({ state, key, settler, business }) {
  const st = state.getCampaign(key) || {};
  const feed = st.feed || [];
  const owners = Object.values(st.creatures || {}).map((c) => c.arkivOwner).filter(Boolean);
  let mode = null;
  if (settler && (owners.some((o) => same(o, settler)) || feed.some((f) => f.kind === "claim"))) mode = "auto";
  else if (owners.some((o) => same(o, business))) mode = "approval";
  const jobs = Object.values(st.creatures || {}).map((c) => c.market).filter(Boolean);
  return {
    mode,
    settler: settler || null,
    autoSettled: feed.filter((f) => f.kind === "claim").map(({ creatureId, rarity, to, arkivTxHash, chainTxHash, at }) => ({ creatureId, rarity, player: to, arkivTxHash, catchTxHash: chainTxHash, settledAt: at })),
    sales: feed.filter((f) => f.kind === "sale").map(({ creatureId, rarity, to, price, arkivTxHash, chainTxHash, at }) => ({ creatureId, rarity, buyer: to, price, arkivTxHash, saleTxHash: chainTxHash, at })),
    pending: jobs.filter((j) => OPEN.has(j.status)).map(({ creatureId, status, lastError }) => ({ creatureId, status, lastError: lastError ?? null })),
  };
}
