// SERVER ONLY (route handlers). The worker is the app's backend for chain/Arkiv configuration, listing
// attestations, discount-code reveal and Swarm downloads. Its URL never reaches the browser.

export class WorkerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function base() {
  const url = process.env.WORKER_URL;
  if (!url) throw new WorkerError(500, "WORKER_URL is not set");
  return url.replace(/\/+$/, "");
}

export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${base()}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    if (e instanceof WorkerError) throw e;
    throw new WorkerError(502, `Worker unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function workerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await workerFetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new WorkerError(res.status, (body as { error?: string }).error || `Worker error ${res.status}`);
  return body as T;
}

export const workerPost = <T>(path: string, body: unknown) =>
  workerJson<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** What the app needs to know about the deployment (all public values). */
export type AppConfig = {
  chainId: number;
  rpcUrl: string;
  campaignManager: `0x${string}`;
  creatureMarket: `0x${string}`;
  settlerAddress: `0x${string}`;
  arkivNetwork: string;
  arkivSchema: string;
  arkivRpcUrl: string | null;
};

let cached: { at: number; value: AppConfig } | null = null;

// The Base Sepolia deployment (contracts/broadcast/*/84532/run-latest.json and CreatureMarket.settler()).
// Used when WORKER_URL is not set, so the map, collection and marketplace still read chain + Arkiv directly.
// Listing attestations and discount-code reveals always need the worker (it holds the settler and code keys).
const DEFAULT_DEPLOYMENT = {
  chainId: 84532,
  campaignManager: "0xF0Cbd7c4F16C62f12196FF2Bd6ff7cc733d18F83",
  creatureMarket: "0x7bb39cc991aF6558fbD15aaee401acD58222e4b3",
  settlerAddress: "0x84aAd29baB0668fC7DdF227f0f68e37a7142672b",
  arkivSchema: "ethglobal-mumbai-2026.creature.v2",
} as const;

const hexAddr = (v: string | undefined, fallback: `0x${string}`) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : fallback);

function envConfig(env = process.env): AppConfig {
  return {
    chainId: Number(env.CHAIN_ID || DEFAULT_DEPLOYMENT.chainId),
    rpcUrl: env.PUBLIC_RPC_URL || env.NEXT_PUBLIC_BASE_SEPOLIA_RPC || "", // sent to the browser: public RPCs only
    campaignManager: hexAddr(env.CAMPAIGN_MANAGER_ADDRESS, DEFAULT_DEPLOYMENT.campaignManager),
    creatureMarket: hexAddr(env.CREATURE_MARKET_ADDRESS, DEFAULT_DEPLOYMENT.creatureMarket),
    settlerAddress: hexAddr(env.SETTLER_ADDRESS, DEFAULT_DEPLOYMENT.settlerAddress),
    arkivNetwork: env.ARKIV_NETWORK || "rabdi",
    arkivSchema: env.ARKIV_SCHEMA_NAME || DEFAULT_DEPLOYMENT.arkivSchema,
    arkivRpcUrl: env.ARKIV_RPC_URL || null,
  };
}

export async function appConfig(): Promise<AppConfig> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  if (!process.env.WORKER_URL) {
    cached = { at: Date.now(), value: envConfig() };
    return cached.value;
  }
  const c = await workerJson<AppConfig & Record<string, unknown>>("/api/config");
  const value: AppConfig = {
    chainId: Number(c.chainId),
    rpcUrl: String(c.rpcUrl || ""),
    campaignManager: c.campaignManager,
    creatureMarket: c.creatureMarket,
    settlerAddress: c.settlerAddress,
    arkivNetwork: String(c.arkivNetwork || "rabdi"),
    arkivSchema: String(c.arkivSchema),
    arkivRpcUrl: (c.arkivRpcUrl as string | null) ?? null,
  };
  cached = { at: Date.now(), value };
  return value;
}

/** JSON error response for a route handler. */
export function errorResponse(e: unknown) {
  const status = e instanceof WorkerError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  if (status >= 500) console.error(message);
  return Response.json({ error: message }, { status });
}
