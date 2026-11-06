import { cookies } from "next/headers";
import { read } from "@/lib/session";
import { getPlayer } from "@/lib/players";

// The logged-in player for this request, or null.
export async function currentPlayer() {
  const id = read((await cookies()).get("session")?.value);
  const player = id ? await getPlayer(id) : null;
  return player && id ? { id, ...player } : null;
}
