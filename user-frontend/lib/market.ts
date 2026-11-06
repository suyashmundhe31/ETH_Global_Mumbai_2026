"use client";

// CreatureMarket + CreatureCampaignManager (the authority): reads, and MetaMask writes that are simulated
// first so a revert reason shows before the wallet opens.

import { createWalletClient, custom, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { campaignChain, chainReader, type AppConfig } from "@/lib/config";
import { ensureWallet, provider } from "@/lib/metamask";

export const RARITIES = ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const;

export const marketAbi = parseAbi([
  "error TooFar(uint256 distanceM)",
  "error NotNextCreature(uint256 creatureId, uint256 nextCreatureId)",
  "error AlreadyClaimedInCampaign(uint256 campaignId, uint256 creatureId)",
  "error CampaignDepleted(uint256 campaignId)",
  "error CampaignExpired(uint256 campaignId)",
  "error CampaignNotActive(uint256 campaignId)",
  "error InvalidTicket()",
  "error TicketExpired(uint256 deadline)",
  "error TicketTooLong(uint256 deadline)",
  "error InvalidCoordinates()",
  "error NotOwner(uint256 creatureId)",
  "error AlreadyRedeemed(uint256 creatureId)",
  "error IsListed(uint256 creatureId)",
  "error NotListed(uint256 creatureId)",
  "error InvalidPrice(uint256 price)",
  "error OwnListing(uint256 creatureId)",
  "error WrongPayment(uint256 sent, uint256 price)",
  "error PaymentFailed()",
  "error CampaignNotFound(uint256 campaignId)",
  "function claim(uint256 creatureId, int32 latE6, int32 lonE6, uint256 deadline, bytes humanSig)",
  "function redeem(uint256 creatureId)",
  "function list(uint256 creatureId, uint256 price, uint256 deadline, bytes settlerSig)",
  "function unlist(uint256 creatureId)",
  "function buy(uint256 creatureId) payable",
  "function getHolding(uint256 creatureId) view returns ((address owner, uint64 claimedAt, bool redeemed))",
  "function getListing(uint256 creatureId) view returns ((address seller, uint256 price))",
  "function getPlayerClaims(address player) view returns (uint256[])",
  "function nextCreature(uint256 campaignId) view returns (uint256 creatureId, bool available)",
  "function claimedIn(address player, uint256 campaignId) view returns (uint256)",
]);

const campaignAbi = parseAbi([
  "error CampaignNotFound(uint256 campaignId)",
  "error CreatureNotFound(uint256 creatureId)",
  "function getCampaign(uint256 campaignId) view returns ((address business, uint8 status, int32 latitudeE6, int32 longitudeE6, uint64 expiresAt, uint64 createdAt, uint64 requestedAt, uint64 allocatedAt, uint32 totalCreatures, uint32[4] rarityCounts, uint256 vrfRequestId, uint256 randomWord, string businessName, string swarmReference))",
  "function getCreature(uint256 creatureId) view returns ((uint256 creatureId, uint256 campaignId, uint32 index, address business, string businessName, uint8 rarity, string discountCode, string discountDescription, int32 latitudeE6, int32 longitudeE6, uint64 expiresAt, string swarmReference, uint64 createdAt))",
]);

export type Holding = { owner: Address; claimedAt: bigint; redeemed: boolean };
export type Listing = { seller: Address; price: bigint };

export const campaignOf = (creatureId: bigint) => creatureId >> BigInt(32);
export const isZero = (a: string) => a.toLowerCase() === zeroAddress;

// ------------------------------------------------------------------ reads

export async function getCampaign(cfg: AppConfig, campaignId: bigint) {
  return chainReader(cfg).readContract({ address: cfg.campaignManager, abi: campaignAbi, functionName: "getCampaign", args: [campaignId] });
}

export async function getCreature(cfg: AppConfig, creatureId: bigint) {
  return chainReader(cfg).readContract({ address: cfg.campaignManager, abi: campaignAbi, functionName: "getCreature", args: [creatureId] });
}

export async function getHolding(cfg: AppConfig, creatureId: bigint): Promise<Holding> {
  return chainReader(cfg).readContract({ address: cfg.creatureMarket, abi: marketAbi, functionName: "getHolding", args: [creatureId] });
}

export async function getListing(cfg: AppConfig, creatureId: bigint): Promise<Listing> {
  return chainReader(cfg).readContract({ address: cfg.creatureMarket, abi: marketAbi, functionName: "getListing", args: [creatureId] });
}

export async function getPlayerClaims(cfg: AppConfig, player: Address): Promise<readonly bigint[]> {
  return chainReader(cfg).readContract({ address: cfg.creatureMarket, abi: marketAbi, functionName: "getPlayerClaims", args: [player] });
}

/** What the map needs per campaign: the contract's campaign, its next creature and whether `player` claimed there. */
export async function campaignState(cfg: AppConfig, campaignId: bigint, player: Address) {
  const r = chainReader(cfg);
  const [campaign, next, claimed] = await Promise.all([
    getCampaign(cfg, campaignId),
    r.readContract({ address: cfg.creatureMarket, abi: marketAbi, functionName: "nextCreature", args: [campaignId] }),
    r.readContract({ address: cfg.creatureMarket, abi: marketAbi, functionName: "claimedIn", args: [player, campaignId] }),
  ]);
  return { campaign, nextCreatureId: next[0], available: next[1], claimedByPlayer: claimed !== BigInt(0) };
}

// ------------------------------------------------------------------ writes (MetaMask)

type Write = { functionName: "claim" | "redeem" | "list" | "unlist" | "buy"; args: readonly unknown[]; value?: bigint };

/** Simulate (revert reasons before MetaMask opens), send, wait for the receipt. */
async function send(cfg: AppConfig, player: Address, w: Write, onSent?: (hash: Hex) => void): Promise<Hex> {
  const chain = campaignChain(cfg);
  await ensureWallet(chain, player);
  const reader = chainReader(cfg);
  const { request } = await reader.simulateContract({
    address: cfg.creatureMarket,
    abi: marketAbi,
    functionName: w.functionName,
    args: w.args,
    value: w.value,
    account: player,
  } as Parameters<typeof reader.simulateContract>[0]);
  const wallet = createWalletClient({ chain, transport: custom(provider()), account: player });
  const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
  onSent?.(hash);
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return hash;
}

export const claim = (cfg: AppConfig, player: Address, p: { creatureId: bigint; latE6: number; lonE6: number; deadline: bigint; signature: Hex }, onSent?: (h: Hex) => void) =>
  send(cfg, player, { functionName: "claim", args: [p.creatureId, p.latE6, p.lonE6, p.deadline, p.signature] }, onSent);

export const redeem = (cfg: AppConfig, player: Address, creatureId: bigint, onSent?: (h: Hex) => void) =>
  send(cfg, player, { functionName: "redeem", args: [creatureId] }, onSent);

export const list = (cfg: AppConfig, player: Address, p: { creatureId: bigint; price: bigint; deadline: bigint; signature: Hex }, onSent?: (h: Hex) => void) =>
  send(cfg, player, { functionName: "list", args: [p.creatureId, p.price, p.deadline, p.signature] }, onSent);

export const unlist = (cfg: AppConfig, player: Address, creatureId: bigint, onSent?: (h: Hex) => void) =>
  send(cfg, player, { functionName: "unlist", args: [creatureId] }, onSent);

export const buy = (cfg: AppConfig, player: Address, creatureId: bigint, price: bigint, onSent?: (h: Hex) => void) =>
  send(cfg, player, { functionName: "buy", args: [creatureId], value: price }, onSent);
