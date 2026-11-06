// Durable local index of Arkiv progress (Swarm assets, reported entity keys). It is only a
// cache/journal: Arkiv itself (queried by $creator = business + campaign) is the source of truth for
// "does this creature already have an entity?", so losing this file can never cause duplicates.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStateStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, checkpoints: {}, campaigns: {} };
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  _flush() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    // Atomic replace on Windows, Linux and macOS. On Windows, antivirus / sync tools (e.g. OneDrive)
    // can briefly lock the target, so retry transient EPERM/EBUSY errors.
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (i >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
      }
    }
  }

  getCheckpoint(name) {
    const v = this.data.checkpoints[name];
    return v === undefined ? undefined : BigInt(v);
  }

  setCheckpoint(name, block) {
    this.data.checkpoints[name] = block.toString();
    this._flush();
  }

  getCampaign(key) {
    return this.data.campaigns[key];
  }

  listCampaigns() {
    return Object.entries(this.data.campaigns).map(([key, v]) => ({ key, ...v }));
  }

  updateCampaign(key, patch) {
    const prev = this.data.campaigns[key] || { creatures: {} };
    this.data.campaigns[key] = { ...prev, ...patch, creatures: prev.creatures, updatedAt: new Date().toISOString() };
    this._flush();
    return this.data.campaigns[key];
  }

  updateCreature(key, creatureId, patch) {
    const campaign = this.data.campaigns[key] || { creatures: {} };
    campaign.creatures[creatureId] = { ...(campaign.creatures[creatureId] || {}), ...patch };
    this.data.campaigns[key] = campaign;
    this._flush();
    return campaign.creatures[creatureId];
  }
}

export const campaignKey = (chainId, contract, campaignId) =>
  `${chainId}:${contract.toLowerCase()}:${campaignId.toString()}`;
