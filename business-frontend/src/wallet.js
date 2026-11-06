// MetaMask (EIP-1193) connection + contract calls via viem. The business signs in its own wallet;
// no private key ever touches the frontend or the worker.
import { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, numberToHex } from "viem";
import managerAbi from "./abi/CreatureCampaignManager.json";

export const STATUS = ["NONE", "RANDOMNESS_REQUESTED", "ALLOCATED", "CANCELLED"];

export function hasMetaMask() {
  return typeof window !== "undefined" && !!window.ethereum;
}

function toChain(cfg) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorerUrl ? { default: { name: "Explorer", url: cfg.explorerUrl } } : undefined,
  });
}

export async function connectWallet(cfg) {
  if (!hasMetaMask()) throw new Error("MetaMask not detected. Install it and reload the page.");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureNetwork(cfg);
  const chain = toChain(cfg);
  return {
    address,
    chain,
    wallet: createWalletClient({ account: address, chain, transport: custom(window.ethereum) }),
    publicClient: createPublicClient({ chain, transport: custom(window.ethereum) }),
  };
}

/** Switches MetaMask to the configured chain, adding it if MetaMask does not know it. */
export async function ensureNetwork(cfg) {
  const current = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (current === cfg.chainId) return;
  const chainIdHex = numberToHex(cfg.chainId);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (err) {
    if (err?.code !== 4902) throw new Error(`Please switch MetaMask to ${cfg.chainName} (chain ${cfg.chainId}).`);
    if (!cfg.rpcUrl) {
      throw new Error(`MetaMask does not know chain ${cfg.chainId}. Add it in MetaMask, or set VITE_RPC_URL / the worker's PUBLIC_RPC_URL.`);
    }
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: cfg.chainName,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls: cfg.explorerUrl ? [cfg.explorerUrl] : undefined,
        },
      ],
    });
  }
  const after = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (after !== cfg.chainId) throw new Error(`Wrong network: expected chain ${cfg.chainId}, MetaMask is on ${after}.`);
}

/** Simulates (surfaces revert reasons before signing), sends createCampaign and waits for the receipt. */
export async function createCampaign(conn, contract, input) {
  const { request } = await conn.publicClient.simulateContract({
    address: contract,
    abi: managerAbi,
    functionName: "createCampaign",
    args: [input],
    account: conn.address,
  });
  const hash = await conn.wallet.writeContract(request);
  const receipt = await conn.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`createCampaign reverted (tx ${hash})`);
  let campaignId, requestId;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: managerAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "CampaignCreated") campaignId = ev.args.campaignId;
      if (ev.eventName === "RandomnessRequested") requestId = ev.args.requestId;
    } catch {
      /* not one of ours */
    }
  }
  if (campaignId === undefined) throw new Error("CampaignCreated event not found in receipt");
  return { hash, campaignId, requestId, blockNumber: receipt.blockNumber };
}

export async function readCampaign(conn, contract, campaignId) {
  const c = await conn.publicClient.readContract({ address: contract, abi: managerAbi, functionName: "getCampaign", args: [campaignId] });
  return { ...c, statusName: STATUS[c.status] };
}

export async function retryRandomness(conn, contract, campaignId) {
  const { request } = await conn.publicClient.simulateContract({
    address: contract,
    abi: managerAbi,
    functionName: "retryRandomness",
    args: [campaignId],
    account: conn.address,
  });
  const hash = await conn.wallet.writeContract(request);
  await conn.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
