// Bindings from wrangler.jsonc, merged into OpenNext's global CloudflareEnv.
// Hand-written on purpose: `wrangler types` also emits Workers runtime typings that replace the DOM
// fetch/Response types used by the client components (r.json() becomes unknown).
interface PlayersKV {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

interface CloudflareEnv {
  PLAYERS: PlayersKV;
  RP_SIGNING_KEY?: string;
  ARKIV_ACCESS_KEY?: string;
}
