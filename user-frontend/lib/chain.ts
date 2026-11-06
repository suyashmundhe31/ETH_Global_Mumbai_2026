// Base Sepolia: CatchManager / CreatureCampaignManager reads and MetaMask writes. The chain decides who
// owns a creature, whether it can still be caught, and whether it's redeemed; Arkiv is display only.
//
// The public Base Sepolia RPC caps eth_getLogs at 200 blocks, so nothing here scans event history:
// state comes from view calls (multicall), and tx results from their own receipts.

import nacl from "tweetnacl";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  fallback,
  hexToBytes,
  http,
  isAddressEqual,
  keccak256,
  numberToHex,
  padHex,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";

export const CATCH_MANAGER = (process.env.NEXT_PUBLIC_CATCH_MANAGER || "") as Address;
export const CAMPAIGN_MANAGER = (process.env.NEXT_PUBLIC_CAMPAIGN_MANAGER || "0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83") as Address;
/** X25519 public key of the CRE workflow (pair of its WORKFLOW_BOX_SK secret). */
const WORKFLOW_BOX_PUBKEY = (process.env.NEXT_PUBLIC_WORKFLOW_BOX_PUBKEY || "") as Hex;
export const chainConfigured = /^0x[0-9a-fA-F]{40}$/.test(CATCH_MANAGER) && CATCH_MANAGER !== zeroAddress;

export const RARITIES = ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const;
const UNLOCK_MESSAGE = "Unlock my creature codes v1";

export const catchAbi = parseAbi([
  "event CatchRequested(uint256 indexed attemptId, uint256 indexed campaignId, address indexed player, int32 playerLatE6, int32 playerLonE6, int32 spawnLatE6, int32 spawnLonE6, bytes worldIdProof)",
  "function requestCatch(uint256 campaignId, int32 latE6, int32 lonE6, bytes worldIdProof) returns (uint256)",
  "function getAttempt(uint256 attemptId) view returns ((address player, uint8 status, uint64 createdAt, uint32 totalCreatures, uint256 campaignId, uint256 vrfRequestId, uint256 creatureId))",
  "function activeAttempt(address player, uint256 campaignId) view returns (uint256)",
  "function expireAttempt(uint256 attemptId)",
  "function ATTEMPT_TIMEOUT() view returns (uint64)",
  "function getCaught(uint256 creatureId) view returns ((address owner, uint64 floatE18, uint64 caughtAt, uint8 rarity, uint256 attemptId))",
  "function getPlayerCatches(address player) view returns (uint256[])",
  "function canSpawnFor(address player, uint256 campaignId) view returns (bool)",
  "function requestRedeem(uint256 creatureId, bytes32 playerPubKey)",
  "function redeemed(uint256 creatureId) view returns (bool)",
  "function sealedCodes(uint256 creatureId) view returns (bytes)",
  "function pendingRedeem(uint256 creatureId) view returns (address owner, uint64 requestedAt)",
]);
const campaignAbi = parseAbi([
  "function getBusinessCampaigns(address business) view returns (uint256[])",
  "function getCampaign(uint256 campaignId) view returns ((address business, uint8 status, int32 latitudeE6, int32 longitudeE6, uint64 expiresAt, uint64 createdAt, uint64 requestedAt, uint64 allocatedAt, uint32 totalCreatures, uint32[4] rarityCounts, uint256 vrfRequestId, uint256 randomWord, string businessName, string swarmReference))",
]);

// Public Base Sepolia RPCs rate-limit hard (HTTP 429), so without a configured RPC we fall through several
// keyless ones: a 429 on one moves the request to the next instead of failing the catch.
const PUBLIC_BASE_SEPOLIA_RPCS = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.drpc.org",
  "https://base-sepolia.gateway.tenderly.co",
  "https://sepolia.base.org",
];
export const chain = createPublicClient({
  chain: baseSepolia,
  transport: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC
    ? http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC)
    : fallback(PUBLIC_BASE_SEPOLIA_RPCS.map((url) => http(url, { retryCount: 1 }))),
});

// --- MetaMask ---------------------------------------------------------------------------------------------

function provider(): EIP1193Provider {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("MetaMask not found");
  return eth;
}

/** A wallet client for `target`, switching MetaMask to it first (adding it if MetaMask doesn't know it). */
export async function walletFor(target: Chain, expected?: string) {
  const eth = provider();
  const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
  if (expected && account.toLowerCase() !== expected.toLowerCase()) throw new Error(`Switch MetaMask to ${expected}`);
  const client = createWalletClient({ chain: target, transport: custom(eth), account });
  if ((await client.getChainId()) !== target.id) {
    try {
      await client.switchChain({ id: target.id });
    } catch {
      await client.addChain({ chain: target }); // unknown chain: add (MetaMask then offers to switch)
      await client.switchChain({ id: target.id });
    }
  }
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Spawns and catching ----------------------------------------------------------------------------------

/** Campaign ids (as strings) whose spawn this player may see: CatchManager.canSpawnFor. */
export async function spawnableCampaigns(player: Address, campaignIds: string[]): Promise<Set<string>> {
  if (!campaignIds.length) return new Set();
  const results = await chain.multicall({
    contracts: campaignIds.map((id) => ({
      address: CATCH_MANAGER,
      abi: catchAbi,
      functionName: "canSpawnFor" as const,
      args: [player, BigInt(id)] as const,
    })),
  });
  return new Set(campaignIds.filter((_, i) => results[i].status === "success" && results[i].result === true));
}

export type CatchPhase = "clearing" | "confirm" | "verifying" | "rolling" | "caught" | "missed" | "rejected" | "expired";
export type Caught = { creatureId: bigint; rarity: number; float: number };

/**
 * requestCatch, then follow the attempt: CRE verdict (VERIFYING -> ROLLING/REJECTED), then VRF (CAUGHT/FAILED).
 * The contract allows one open attempt per player and campaign, so an open one is handled first instead of
 * sending a requestCatch that reverts with AttemptInProgress: past ATTEMPT_TIMEOUT it is expired (one extra
 * MetaMask confirmation), otherwise we keep following it.
 */
export async function catchCreature(
  player: Address,
  campaignId: string,
  lat: number,
  lng: number,
  onPhase: (p: CatchPhase) => void,
): Promise<Caught | null> {
  const open = await chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "activeAttempt", args: [player, BigInt(campaignId)] });
  if (open !== BigInt(0)) {
    const [a, timeout, block] = await Promise.all([
      chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "getAttempt", args: [open] }),
      chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "ATTEMPT_TIMEOUT" }),
      chain.getBlock(),
    ]);
    if (block.timestamp < a.createdAt + timeout) {
      onPhase(a.status === 2 ? "rolling" : "verifying");
      return followAttempt(open, onPhase);
    }
    onPhase("clearing");
    const wallet = await walletFor(baseSepolia, player);
    const expireHash = await wallet.writeContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "expireAttempt", args: [open] });
    const expired = await chain.waitForTransactionReceipt({ hash: expireHash });
    if (expired.status !== "success") throw new Error("expireAttempt reverted");
  }

  onPhase("confirm");
  const wallet = await walletFor(baseSepolia, player);
  const hash = await wallet.writeContract({
    address: CATCH_MANAGER,
    abi: catchAbi,
    functionName: "requestCatch",
    args: [BigInt(campaignId), Math.round(lat * 1e6), Math.round(lng * 1e6), "0x"],
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("requestCatch reverted");
  const log = receipt.logs.find((l) => isAddressEqual(l.address, CATCH_MANAGER));
  if (!log) throw new Error("CatchRequested not found in the receipt");
  const { args } = decodeEventLog({ abi: catchAbi, eventName: "CatchRequested", topics: log.topics, data: log.data });
  onPhase("verifying");
  return followAttempt(args.attemptId, onPhase);
}

/** Poll an attempt until it resolves. AttemptStatus: 1 VERIFYING, 2 ROLLING, 3 CAUGHT, 4 FAILED, 5 REJECTED, 6 EXPIRED */
async function followAttempt(attemptId: bigint, onPhase: (p: CatchPhase) => void): Promise<Caught | null> {
  for (let i = 0; i < 400; i++) {
    const a = await chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "getAttempt", args: [attemptId] });
    if (a.status === 2) onPhase("rolling");
    if (a.status === 3) {
      const c = await chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "getCaught", args: [a.creatureId] });
      onPhase("caught");
      return { creatureId: a.creatureId, rarity: c.rarity, float: Number(c.floatE18) / 1e18 };
    }
    if (a.status >= 4) {
      onPhase(a.status === 4 ? "missed" : a.status === 5 ? "rejected" : "expired");
      return null;
    }
    await sleep(3000);
  }
  throw new Error("No verdict yet. The attempt can be expired after 30 minutes.");
}

// --- Ownership --------------------------------------------------------------------------------------------

export type Owned = { creatureId: bigint; rarity: number; float: number; redeemed: boolean };

/** Creatures this player owns on chain: their catches plus `extraIds` (e.g. bought ones known from Arkiv). */
export async function ownedCreatures(player: Address, extraIds: bigint[] = []): Promise<Owned[]> {
  const catches = await chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "getPlayerCatches", args: [player] });
  const ids = [...new Set([...catches, ...extraIds].map(String))].map(BigInt);
  const owners = await ownersOf(ids, true);
  return ids.flatMap((creatureId, i) => {
    const o = owners[i];
    return o && isAddressEqual(o.owner, player) ? [{ creatureId, rarity: o.rarity, float: o.float, redeemed: o.redeemed }] : [];
  });
}

/** On-chain owner (zero = not caught), rarity, float and redeemed flag per creature id. */
export async function ownersOf(ids: bigint[], withRedeemed = false) {
  if (!ids.length) return [];
  const caught = await chain.multicall({
    contracts: ids.map((id) => ({ address: CATCH_MANAGER, abi: catchAbi, functionName: "getCaught" as const, args: [id] as const })),
    allowFailure: false,
  });
  const redeemed = withRedeemed
    ? await chain.multicall({
        contracts: ids.map((id) => ({ address: CATCH_MANAGER, abi: catchAbi, functionName: "redeemed" as const, args: [id] as const })),
        allowFailure: false,
      })
    : ids.map(() => false);
  return caught.map((c, i) => ({ owner: c.owner, rarity: c.rarity, float: Number(c.floatE18) / 1e18, redeemed: redeemed[i] }));
}

/** Every caught creature of this business's campaigns with its current owner (the CatchResolved successes). */
export async function caughtFromBusiness(business: Address): Promise<{ creatureId: bigint; owner: Address }[]> {
  const campaignIds = await chain.readContract({ address: CAMPAIGN_MANAGER, abi: campaignAbi, functionName: "getBusinessCampaigns", args: [business] });
  const campaigns = await chain.multicall({
    contracts: campaignIds.map((id) => ({ address: CAMPAIGN_MANAGER, abi: campaignAbi, functionName: "getCampaign" as const, args: [id] as const })),
    allowFailure: false,
  });
  // creatureId = (campaignId << 32) | index
  const ids = campaignIds.flatMap((cid, i) => Array.from({ length: campaigns[i].totalCreatures }, (_, k) => (cid << BigInt(32)) | BigInt(k)));
  const owners = await ownersOf(ids);
  return ids.flatMap((creatureId, i) => (owners[i].owner !== zeroAddress ? [{ creatureId, owner: owners[i].owner }] : []));
}

// --- Redeem -----------------------------------------------------------------------------------------------

/** nacl.box key pair from keccak256(signature of UNLOCK_MESSAGE): same wallet -> same keys, on any device. */
async function boxKeys(player: Address) {
  const signature = (await provider().request({ method: "personal_sign", params: [stringToHex(UNLOCK_MESSAGE), player] })) as Hex;
  return nacl.box.keyPair.fromSecretKey(hexToBytes(keccak256(signature)));
}

const boxNonce = (creatureId: bigint) => hexToBytes(keccak256(padHex(numberToHex(creatureId), { size: 32 }))).subarray(0, 24);

function openCode(sealed: Hex, creatureId: bigint, secretKey: Uint8Array): string {
  const opened = nacl.box.open(hexToBytes(sealed), boxNonce(creatureId), hexToBytes(WORKFLOW_BOX_PUBKEY), secretKey);
  if (!opened) throw new Error("Couldn't open the code with this wallet's key");
  return new TextDecoder().decode(opened);
}

export type RedeemPhase = "sign" | "confirm" | "verifying";

/** Reveal the discount code. Already redeemed: re-open the stored sealed code (sign only, no tx). */
export async function redeem(player: Address, creatureId: bigint, onPhase: (p: RedeemPhase) => void): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(WORKFLOW_BOX_PUBKEY)) throw new Error("NEXT_PUBLIC_WORKFLOW_BOX_PUBKEY is not set");
  onPhase("sign");
  const keys = await boxKeys(player);
  const read = () => chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "sealedCodes", args: [creatureId] });
  const existing = await read();
  if (existing !== "0x") return openCode(existing, creatureId, keys.secretKey);

  onPhase("confirm");
  const wallet = await walletFor(baseSepolia, player);
  const hash = await wallet.writeContract({
    address: CATCH_MANAGER,
    abi: catchAbi,
    functionName: "requestRedeem",
    args: [creatureId, bytesToHex(keys.publicKey)],
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("requestRedeem reverted");
  onPhase("verifying");

  for (let i = 0; i < 400; i++) {
    await sleep(3000);
    const sealed = await read();
    if (sealed !== "0x") return openCode(sealed, creatureId, keys.secretKey);
    const [pendingOwner] = await chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "pendingRedeem", args: [creatureId] });
    if (pendingOwner !== zeroAddress) continue;
    // Pending cleared: either approved (the report may have landed between the two reads, or the RPC node that
    // answered the first read was a block behind) or rejected. Ask again before calling it a rejection.
    const isRedeemed = await chain.readContract({ address: CATCH_MANAGER, abi: catchAbi, functionName: "redeemed", args: [creatureId] });
    if (isRedeemed) {
      for (let j = 0; j < 10; j++) {
        const again = await read();
        if (again !== "0x") return openCode(again, creatureId, keys.secretKey);
        await sleep(2000); // lagging RPC node: same tx, give it a moment
      }
      throw new Error("Redeemed, but the code isn't readable yet; tap Show code in a moment");
    }
    throw new Error("CRE rejected the redeem (ownership changed?)");
  }
  throw new Error("No verdict yet; try again later");
}
