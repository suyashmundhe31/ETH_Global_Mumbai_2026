// Read-only access to the CreatureCampaignManager contract (the authoritative source of creatures).
import { createPublicClient, defineChain, http } from "viem";
import { anvil, baseSepolia, sepolia } from "viem/chains";
import managerAbi from "./abi/CreatureCampaignManager.json" with { type: "json" };

export const CAMPAIGN_STATUS = ["NONE", "RANDOMNESS_REQUESTED", "ALLOCATED", "CANCELLED"];
export const RARITY = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
const PAGE = 100;

export function chainFor(chainId, rpcUrl) {
  const known = { [anvil.id]: anvil, [sepolia.id]: sepolia, [baseSepolia.id]: baseSepolia }[chainId];
  if (known) return { ...known, rpcUrls: { default: { http: [rpcUrl] } } };
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export class CampaignChain {
  constructor({ chainId, rpcUrl, campaignManager, startBlock = 0n, logRange = 2000n, client }) {
    this.chainId = chainId;
    this.address = campaignManager;
    this.startBlock = startBlock;
    this.logRange = BigInt(logRange);
    this.chain = chainFor(chainId, rpcUrl);
    this.client = client || createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
  }

  read(functionName, args = []) {
    return this.client.readContract({ address: this.address, abi: managerAbi, functionName, args });
  }

  async getCampaign(campaignId) {
    const c = await this.read("getCampaign", [BigInt(campaignId)]);
    return { ...c, statusName: CAMPAIGN_STATUS[c.status] };
  }

  getRewards(campaignId) {
    return this.read("getRewards", [BigInt(campaignId)]);
  }

  /** All finalized creature records, read in pages from the contract. */
  async getAllCreatures(campaignId, total) {
    const out = [];
    for (let offset = 0; offset < total; offset += PAGE) {
      const page = await this.read("getCreatures", [BigInt(campaignId), offset, PAGE]);
      out.push(...page);
    }
    return out.map((c) => ({ ...c, rarityName: RARITY[c.rarity] }));
  }

  /** Transaction hashes of the creation tx and the VRF fulfillment (allocation) tx. */
  // Scans backwards from the head in LOG_RANGE windows (public RPCs cap eth_getLogs ranges, e.g. 200
  // blocks on https://sepolia.base.org) and stops as soon as both events are found.
  async getCampaignTxHashes(campaignId) {
    const id = BigInt(campaignId);
    const found = { CampaignCreated: null, RarityAllocated: null };
    let to = await this.client.getBlockNumber();
    while (to >= this.startBlock && (!found.CampaignCreated || !found.RarityAllocated)) {
      const from = to - this.logRange + 1n > this.startBlock ? to - this.logRange + 1n : this.startBlock;
      for (const eventName of Object.keys(found)) {
        if (found[eventName]) continue;
        const [ev] = await this.client.getContractEvents({
          address: this.address,
          abi: managerAbi,
          eventName,
          args: { campaignId: id },
          fromBlock: from,
          toBlock: to,
        });
        if (ev) found[eventName] = ev.transactionHash;
      }
      to = from - 1n;
    }
    return { creationTxHash: found.CampaignCreated, allocationTxHash: found.RarityAllocated };
  }

  getBlockNumber() {
    return this.client.getBlockNumber();
  }

  getAllocatedEvents(fromBlock, toBlock) {
    return this.client.getContractEvents({
      address: this.address,
      abi: managerAbi,
      eventName: "RarityAllocated",
      fromBlock,
      toBlock,
    });
  }
}
