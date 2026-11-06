import { NextResponse } from "next/server";
import { ownsWallet } from "@/lib/wallet";
import { idByWallet } from "@/lib/players";
import { sign } from "@/lib/session";

export async function POST(req: Request) {
  const b = await req.json();
  if (!(await ownsWallet(b))) return NextResponse.json({ error: "Wallet signature check failed" }, { status: 400 });

  // Wallet already linked to a verified human -> log in without asking World ID again.
  const id = idByWallet(b.address.toLowerCase());
  const out = NextResponse.json({ registered: !!id });
  if (id) out.cookies.set("session", sign(id), { httpOnly: true, sameSite: "lax", path: "/" });
  return out;
}