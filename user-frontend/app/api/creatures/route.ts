import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { read } from "@/lib/session";
import { getPlayer } from "@/lib/players";
import { getCreatures } from "@/lib/creatures";

export async function GET() {
  const id = read((await cookies()).get("session")?.value);
  const player = id ? await getPlayer(id) : null;
  if (!player) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const owner = player.wallet; // only creatures of the logged-in wallet
  try {
    return NextResponse.json({ owner, creatures: await getCreatures(owner) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
