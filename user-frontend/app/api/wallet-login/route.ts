import { NextResponse } from "next/server";
import { ownsWallet } from "@/lib/wallet";
import { idByWallet, linkTestPlayer } from "@/lib/players";
import { sign } from "@/lib/session";

export async function POST(req: Request) {
  const b = await req.json();
  if (!(await ownsWallet(b))) return NextResponse.json({ error: "Wallet signature check failed" }, { status: 400 });

  // Wallet already linked to a verified human -> log in without asking World ID again.
  // SKIP_WORLD_ID=true (testing only): any wallet that signed the challenge gets in, no World ID step.
  const wallet = b.address.toLowerCase();
  const id = (await idByWallet(wallet)) ?? (process.env.SKIP_WORLD_ID === "true" ? await linkTestPlayer(wallet) : null);
  const out = NextResponse.json({ registered: !!id });
  if (id) out.cookies.set("session", sign(id), { httpOnly: true, sameSite: "lax", path: "/" });
  return out;
}