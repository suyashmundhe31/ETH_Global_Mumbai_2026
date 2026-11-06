// Read access to CreatureMarket (contracts/src/CreatureMarket.sol): claims, redemptions, listings and
// sales. It is the authority on who owns a creature; Arkiv mirrors it. ABI items copied from the source.
import { parseAbi } from "viem";

export const MARKET_ABI = parseAbi([
  "event CreatureClaimed(uint256 indexed creatureId, uint256 indexed campaignId, address indexed player, address business, uint8 rarity)",
  "event Redeemed(uint256 indexed creatureId, address indexed owner)",
  "event Listed(uint256 indexed creatureId, address indexed seller, uint256 price)",
  "event Unlisted(uint256 indexed creatureId, address indexed seller)",
  "event Sold(uint256 indexed creatureId, address indexed seller, address indexed buyer, uint256 price)",
  "function getHolding(uint256 creatureId) view returns ((address owner, uint64 claimedAt, bool redeemed))",
  "function getListing(uint256 creatureId) view returns ((address seller, uint256 price))",
  "function claimedCount(uint256 campaignId) view returns (uint32)",
  "function settler() view returns (address)",
  "function humanSigner() view returns (address)",
  "function campaignManager() view returns (address)",
  "function MAX_TICKET_TTL() view returns (uint256)",
]);

/** EIP-712 typed data of a listing attestation (must match CreatureMarket.LISTING_TYPEHASH). */
export const LISTING_TYPES = {
  Listing: [
    { name: "seller", type: "address" },
    { name: "creatureId", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const marketDomain = ({ chainId, address }) => ({ name: "CreatureMarket", version: "1", chainId, verifyingContract: address });

export class MarketChain {
  /** @param chain CampaignChain (same chain and client) */
  constructor({ chain, address }) {
    this.client = chain.client;
    this.chainId = chain.chainId;
    this.address = address;
  }

  read(functionName, args = []) {
    return this.client.readContract({ address: this.address, abi: MARKET_ABI, functionName, args });
  }

  getBlockNumber() {
    return this.client.getBlockNumber();
  }

  /** Every CreatureMarket event in [fromBlock, toBlock], in chain order. */
  getEvents(fromBlock, toBlock) {
    return this.client.getContractEvents({ address: this.address, abi: MARKET_ABI, fromBlock, toBlock });
  }

  getHolding(creatureId) {
    return this.read("getHolding", [BigInt(creatureId)]);
  }

  getListing(creatureId) {
    return this.read("getListing", [BigInt(creatureId)]);
  }

  async claimedCount(campaignId) {
    return Number(await this.read("claimedCount", [BigInt(campaignId)]));
  }
}
