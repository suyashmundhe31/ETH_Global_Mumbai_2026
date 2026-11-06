// Frontend configuration. Only PUBLIC values belong here (Vite inlines VITE_* into the bundle).
// Contract address / chain come from VITE_* env vars; anything unset falls back to the worker's
// /api/config (which reads contracts/deployments/<chainId>.json).
const env = import.meta.env;

export const API_URL = (env.VITE_API_URL || "http://localhost:8787").replace(/\/+$/, "");

// Display defaults only; any VITE_* value overrides them.
const KNOWN_CHAINS = {
  31337: { name: "Anvil (local)" },
  11155111: { name: "Sepolia", explorer: "https://sepolia.etherscan.io" },
  84532: { name: "Base Sepolia", explorer: "https://sepolia.basescan.org" },
};

export async function loadConfig() {
  let remote = {};
  try {
    const res = await fetch(`${API_URL}/api/config`);
    if (res.ok) remote = await res.json();
  } catch {
    /* worker offline: rely on VITE_* values */
  }
  const chainId = Number(env.VITE_CHAIN_ID || remote.chainId || 31337);
  const known = KNOWN_CHAINS[chainId] || {};
  return {
    chainId,
    chainName: env.VITE_CHAIN_NAME || known.name || `Chain ${chainId}`,
    // Only used when MetaMask does not know the chain yet (wallet_addEthereumChain). Reads/writes go
    // through MetaMask itself.
    rpcUrl: env.VITE_RPC_URL || remote.rpcUrl || (chainId === 31337 ? "http://127.0.0.1:8545" : ""),
    explorerUrl: env.VITE_BLOCK_EXPLORER_URL || known.explorer || "",
    campaignManager: env.VITE_CAMPAIGN_MANAGER_ADDRESS || remote.campaignManager || "",
    vrfMode: remote.vrfMode || "unknown",
    swarmGateway: remote.swarmGateway || "",
    arkivExplorer: remote.arkivExplorer || "",
  };
}
