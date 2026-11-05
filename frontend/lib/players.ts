import fs from "fs";

const FILE = "players.json"; // swap for a real DB later; keep the same functions
type DB = Record<string, { wallet: string; createdAt: string }>;
const load = (): DB => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});

export const getPlayer = (id: string) => load()[id] ?? null;

// One human <-> one wallet. Wallet must be lowercase.
export function loginPlayer(nullifierHex: string, wallet: string) {
  const id = BigInt(nullifierHex).toString(); // decimal avoids hex casing/format bugs
  const db = load();
  const mine = db[id];
  if (mine) {
    // Known human: only their original wallet may log in.
    return mine.wallet === wallet ? { ok: true as const, id, isNew: false } : { ok: false as const, error: "This World ID is linked to a different wallet." };
  }
  // New human: the wallet must not already belong to someone else.
  if (Object.values(db).some((p) => p.wallet === wallet)) {
    return { ok: false as const, error: "This wallet is linked to a different World ID." };
  }
  db[id] = { wallet, createdAt: new Date().toISOString() };
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  return { ok: true as const, id, isNew: true };
}