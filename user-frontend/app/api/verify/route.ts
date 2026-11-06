import { NextResponse } from "next/server";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { isAddress, verifyMessage } from "viem";
import { SESSION_COOKIE, sign, tagOk } from "@/lib/session";
import { loginPlayer } from "@/lib/players";

const ENV = process.env.NEXT_PUBLIC_WORLD_ENV ?? "production";
const RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID!;
const deny = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  const { idkitResponse, address, message, message_tag, signature } = await req.json().catch(() => ({}));
  if (!isAddress(address) || idkitResponse?.environment !== ENV) {
    console.error("World ID environment mismatch", { expected: ENV, sent: idkitResponse?.environment });
    return deny("Verification failed");
  }
  const wallet = address.toLowerCase();

  // 1. The wallet really signed our challenge (proves ownership, not just an address).
  const expires = Number(/Expires: (\d+)$/.exec(message ?? "")?.[1]);
  const fresh = expires > Date.now() / 1000;
  const mine = typeof message === "string" && message.includes(`Wallet: ${wallet}\n`) && tagOk(message, message_tag ?? "");
  const owns = fresh && mine && (await verifyMessage({ address, message, signature }).catch(() => false));
  if (!owns) {
    console.error("World ID login: wallet signature check failed", { fresh, mine });
    return deny("Wallet signature check failed");
  }

  // 2. The World ID proof was made for THIS wallet (signal = wallet address).
  const r = idkitResponse.responses?.[0];
  if (r?.signal_hash !== hashSignal(wallet)) {
    console.error("World ID proof not bound to this wallet");
    return deny("Proof is not bound to this wallet");
  }

  // 3. World validates the proof. Never trust the client result alone.
  const res = await fetch(`https://developer.world.org/api/v4/verify/${RP_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...idkitResponse, environment: ENV }),
  }).catch(() => null);
  const v = res ? await res.json().catch(() => null) : null;
  if (!res?.ok || v?.success !== true || v?.environment !== ENV || !r?.nullifier) {
    // Server log only (no secrets): World's reason for rejecting, to debug staging vs production mix-ups.
    console.error("World ID verify rejected", { status: res?.status, expected: ENV, sent: idkitResponse?.environment, world: v });
    return deny(v?.code === "max_verifications_reached" ? "This World ID can't verify this action again (verification limit reached)." : "World ID couldn't verify this proof. Please try again.");
  }

  // 4. One human <-> one wallet.
  let result;
  try { result = await loginPlayer(r.nullifier, wallet); } catch { return deny("Verification failed"); }
  if (!result.ok) return deny(result.error, 403);

  const out = NextResponse.json({ success: true, isNew: result.isNew });
  out.cookies.set("session", sign(result.id), SESSION_COOKIE);
  return out;
}