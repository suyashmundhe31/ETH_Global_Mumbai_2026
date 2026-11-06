"use client";

// Deployment config for the browser: fetched once from /api/config (the server asks the worker), so no
// contract address or network has to be duplicated in this app's env.

import { reloadTo } from "@/lib/nav";
import { createPublicClient, defineChain, fallback, http, type Address, type Chain } from "viem";
import { anvil, baseSepolia, sepolia } from "viem/chains";

export type AppConfig = {
  chainId: number;
  rpcUrl: string;
  campaignManager: Address;
  creatureMarket: Address;
  settlerAddress: Address;
  arkivNetwork: string;
  arkivSchema: string;
  arkivRpcUrl: string | null;
};

// Public Base Sepolia RPCs rate-limit hard (HTTP 429): without a configured RPC, fall through several.
const PUBLIC_BASE_SEPOLIA_RPCS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.drpc.org",
  "https://base-sepolia.gateway.tenderly.co",
];

let pending: Promise<AppConfig> | null = null;

export function loadConfig(): Promise<AppConfig> {
  if (!pending) {
    pending = fetch("/api/config", { cache: "no-store" }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (r.status === 401) {
        reloadTo("/"); // session ended: back to the World ID login
        throw new Error("Session expired");
      }
      if (!r.ok) throw new Error(body.error || `Config unavailable (${r.status})`);
      return body as AppConfig;
    });
    pending.catch(() => (pending = null)); // retry on the next call
  }
  return pending;
}

/** The campaign chain (Base Sepolia in production, Anvil locally) with this deployment's RPC. */
export function campaignChain(cfg: AppConfig): Chain {
  const known = [baseSepolia, sepolia, anvil].find((c) => c.id === cfg.chainId);
  const base =
    known ??
    defineChain({ id: cfg.chainId, name: `Chain ${cfg.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  return cfg.rpcUrl ? { ...base, rpcUrls: { default: { http: [cfg.rpcUrl] } } } : base;
}

const clients = new Map<string, ReturnType<typeof createPublicClient>>();

/** Read client for the campaign chain (JSON-RPC batching; several public RPCs as fallback). */
export function chainReader(cfg: AppConfig) {
  const id = `${cfg.chainId}:${cfg.rpcUrl}`;
  let c = clients.get(id);
  if (!c) {
    const urls = cfg.rpcUrl ? [cfg.rpcUrl] : cfg.chainId === baseSepolia.id ? PUBLIC_BASE_SEPOLIA_RPCS : campaignChain(cfg).rpcUrls.default.http;
    c = createPublicClient({
      chain: campaignChain(cfg),
      transport: fallback(urls.map((u) => http(u, { batch: true, retryCount: 1 }))),
    });
    clients.set(id, c);
  }
  return c;
}

export const shortAddr = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
