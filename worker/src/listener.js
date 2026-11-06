// Polls the chain for RarityAllocated events and has each allocated campaign prepared (per-creature
// Swarm assets) so the business can sign its Arkiv entities.
// Polling getLogs with a persisted checkpoint survives restarts and works with any HTTP RPC.
import { campaignKey } from "./state.js";
import { createLogger, errMessage, sleep } from "./util.js";

export class AllocationListener {
  constructor({ chain, state, service, confirmations = 0n, pollIntervalMs = 3000, logRange = 2000n, retryDelayMs = 60_000, logger }) {
    Object.assign(this, { chain, state, service, confirmations, pollIntervalMs, logRange, retryDelayMs });
    this.log = logger || createLogger("listener");
    this.checkpointName = `allocations:${chain.chainId}:${chain.address.toLowerCase()}`;
    this.queue = [];
    this.retryAt = new Map(); // campaignId -> timestamp of the next automatic retry
    this.stopped = false;
  }

  enqueue(campaignId) {
    const id = BigInt(campaignId);
    if (!this.queue.includes(id)) this.queue.push(id);
  }

  /** Records the campaign before anything can fail, so a crash or error never loses it (see resumeIncomplete). */
  track(campaignId) {
    const key = campaignKey(this.chain.chainId, this.chain.address, campaignId);
    if (!this.state.getCampaign(key)) {
      this.state.updateCampaign(key, {
        chainId: this.chain.chainId,
        contract: this.chain.address,
        campaignId: campaignId.toString(),
        status: "PENDING",
      });
    }
  }

  async pollOnce() {
    const head = (await this.chain.getBlockNumber()) - this.confirmations;
    const last = this.state.getCheckpoint(this.checkpointName);
    let from = last === undefined ? this.chain.startBlock : last + 1n;
    while (from <= head) {
      const to = from + this.logRange - 1n < head ? from + this.logRange - 1n : head;
      const events = await this.chain.getAllocatedEvents(from, to);
      for (const ev of events) {
        this.log.info(`RarityAllocated campaign=${ev.args.campaignId} tx=${ev.transactionHash}`);
        this.track(ev.args.campaignId);
        this.enqueue(ev.args.campaignId);
      }
      this.state.setCheckpoint(this.checkpointName, to);
      from = to + 1n;
    }
  }

  async drainQueue() {
    while (this.queue.length) {
      const id = this.queue.shift();
      try {
        const result = await this.service.prepare(id);
        if (result && result.prepared === false) this.scheduleRetry(id);
        else this.retryAt.delete(id);
      } catch (err) {
        this.log.error(`preparing campaign ${id} failed: ${errMessage(err)} (retrying in ${this.retryDelayMs / 1000}s)`);
        this.scheduleRetry(id);
      }
    }
  }

  scheduleRetry(id) {
    this.retryAt.set(id, Date.now() + this.retryDelayMs);
  }

  enqueueDueRetries(now = Date.now()) {
    for (const [id, at] of this.retryAt) {
      if (at <= now) {
        this.retryAt.delete(id);
        this.enqueue(id);
      }
    }
  }

  /** Re-queues campaigns a previous run left incomplete (crash, Arkiv outage, partial failure). */
  resumeIncomplete() {
    for (const c of this.state.listCampaigns()) {
      if (c.contract?.toLowerCase() === this.chain.address.toLowerCase() && !c.prepared) {
        this.log.info(`resuming campaign ${c.campaignId} (status ${c.status})`);
        this.enqueue(c.campaignId);
      }
    }
  }

  async run() {
    this.resumeIncomplete();
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.log.warn(`poll failed: ${errMessage(err)}`);
      }
      this.enqueueDueRetries();
      await this.drainQueue();
      await sleep(this.pollIntervalMs);
    }
  }

  stop() {
    this.stopped = true;
  }
}
