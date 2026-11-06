import { NextResponse } from "next/server";
import { ownsWallet } from "@/lib/wallet";
import { idByWallet, linkTestPlayer } from "@/lib/players";
import { SESSION_COOKIE, sign } from "@/lib/session";

// Step 2 of login: the wallet signed our challenge. Every real login then continues with World ID (/api/verify):
// a session is only ever granted to a wallet whose human proved, just now, that they're the one linked to it.
// SKIP_WORLD_ID=true (testing only): any wallet that signed the challenge gets in, no World ID step.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (!(await ownsWallet(b))) return NextResponse.json({ error: "Wallet signature check failed. Try again." }, { status: 400 });
  const wallet = b.address.toLowerCase();

  if (process.env.SKIP_WORLD_ID === "true") {
    const id = (await idByWallet(wallet)) ?? (await linkTestPlayer(wallet));
    const out = NextResponse.json({ registered: true });
    out.cookies.set("session", sign(id), SESSION_COOKIE);
    return out;
  }
  // Tell the client whether this wallet already belongs to a human (it only changes the wording on screen).
  return NextResponse.json({ registered: false, known: !!(await idByWallet(wallet)) });
}
