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

export async function appConfig(): Promise<AppConfig> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
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
