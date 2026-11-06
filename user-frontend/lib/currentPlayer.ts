import { cookies } from "next/headers";
import { connection } from "next/server";
import { read } from "@/lib/session";
import { getPlayer } from "@/lib/players";

// The logged-in, World ID verified player for this request, or null.
export async function currentPlayer() {
  await connection(); // request-time only (the session expiry check reads the clock)
  const id = read((await cookies()).get("session")?.value);
  const player = id ? getPlayer(id) : null;
  return player && id ? { id, ...player, wallet: player.wallet as `0x${string}` } : null;
}
