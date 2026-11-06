import { getCloudflareContext } from "@opennextjs/cloudflare";

// Players live in the PLAYERS Workers KV namespace (wrangler.jsonc). `next dev` gets a local emulated
// namespace through initOpenNextCloudflareForDev() in next.config.ts.
//   player:<id>       -> { wallet, createdAt }   (id = World ID nullifier as a decimal string)
//   wallet:<wallet>   -> <id>                    (reverse index, wallet lowercase)
type Player = { wallet: string; createdAt: string };

const kv = async () => (await getCloudflareContext({ async: true })).env.PLAYERS;

export const getPlayer = async (id: string): Promise<Player | null> =>
  (await kv()).get<Player>(`player:${id}`, "json");

export const idByWallet = async (wallet: string): Promise<string | null> => (await kv()).get(`wallet:${wallet}`);

// One human <-> one wallet. Wallet must be lowercase.
// KV is not transactional: two simultaneous first logins could race. Acceptable for this game.
export async function loginPlayer(nullifierHex: string, wallet: string) {
  const id = BigInt(nullifierHex).toString(); // decimal avoids hex casing/format bugs
  const store = await kv();
  const mine = await store.get<Player>(`player:${id}`, "json");
  if (mine) {
    // Known human: only their original wallet may log in.
    return mine.wallet === wallet ? { ok: true as const, id, isNew: false } : { ok: false as const, error: "This World ID is linked to a different wallet." };
  }
  // New human: the wallet must not already belong to someone else.
  if (await store.get(`wallet:${wallet}`)) {
    return { ok: false as const, error: "This wallet is linked to a different World ID." };
  }
  const player: Player = { wallet, createdAt: new Date().toISOString() };
  await store.put(`player:${id}`, JSON.stringify(player));
  await store.put(`wallet:${wallet}`, id);
  return { ok: true as const, id, isNew: true };
}

// Testing only (SKIP_WORLD_ID=true): link a signed-in wallet without a World ID proof.
// The id is "test-<wallet>" so these players are easy to find and delete later.
export async function linkTestPlayer(wallet: string) {
  const store = await kv();
  const existing = await store.get(`wallet:${wallet}`);
  if (existing) return existing;
  const id = `test-${wallet}`;
  await store.put(`player:${id}`, JSON.stringify({ wallet, createdAt: new Date().toISOString() }));
  await store.put(`wallet:${wallet}`, id);
  return id;
}
