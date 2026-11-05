import { NextResponse } from "next/server";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { isAddress, verifyMessage } from "viem";
import { sign, tagOk } from "@/lib/session";
import { loginPlayer } from "@/lib/players";

const ENV = process.env.NEXT_PUBLIC_WORLD_ENV ?? "production";
const RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID!;
const deny = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  const { idkitResponse, address, message, message_tag, signature } = await req.json();
  if (!isAddress(address) || idkitResponse?.environment !== ENV) return deny("Verification failed");
  const wallet = address.toLowerCase();

  // 1. The wallet really signed our challenge (proves ownership, not just an address).
  const expires = Number(/Expires: (\d+)$/.exec(message ?? "")?.[1]);
  const fresh = expires > Date.now() / 1000;
  const mine = typeof message === "string" && message.includes(`Wallet: ${wallet}\n`) && tagOk(message, message_tag ?? "");
  const owns = fresh && mine && (await verifyMessage({ address, message, signature }).catch(() => false));
  if (!owns) return deny("Wallet signature check failed");

  // 2. The World ID proof was made for THIS wallet (signal = wallet address).
  const r = idkitResponse.responses?.[0];
  if (r?.signal_hash !== hashSignal(wallet)) return deny("Proof is not bound to this wallet");

  // 3. World validates the proof. Never trust the client result alone.
  const res = await fetch(`https://developer.world.org/api/v4/verify/${RP_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...idkitResponse, environment: ENV }),
  }).catch(() => null);
  const v = res?.ok ? await res.json() : null;
  if (v?.success !== true || v?.environment !== ENV || !r?.nullifier) return deny("Verification failed");

  // 4. One human <-> one wallet.
  let result;
  try { result = loginPlayer(r.nullifier, wallet); } catch { return deny("Verification failed"); }
  if (!result.ok) return deny(result.error, 403);

  const out = NextResponse.json({ success: true, isNew: result.isNew });
  out.cookies.set("session", sign(result.id), { httpOnly: true, sameSite: "lax", path: "/" });
  return out;
}