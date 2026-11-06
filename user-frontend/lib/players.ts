import fs from "fs";

// One verified human (World ID nullifier) <-> one wallet. players.json in the app folder (git-ignored);
// writes are atomic (temp file + rename) so a crash never leaves a half-written file.
const FILE = "players.json"; // relative to the app folder (where `next start` / `next dev` runs)
type DB = Record<string, { wallet: string; createdAt: string }>;

const load = (): DB => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});

function save(db: DB) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export const getPlayer = (id: string) => load()[id] ?? null;

// One human <-> one wallet. Wallet must be lowercase.
export function loginPlayer(nullifier: string, wallet: string) {
  const id = BigInt(nullifier).toString(); // decimal avoids hex casing/format bugs
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
  save(db);
  return { ok: true as const, id, isNew: true };
}

export const idByWallet = (wallet: string) => Object.entries(load()).find(([, p]) => p.wallet === wallet)?.[0] ?? null;
