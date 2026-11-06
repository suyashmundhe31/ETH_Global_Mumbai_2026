import { NextResponse } from "next/server";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { isAddress, verifyMessage } from "viem";
import { SESSION_COOKIE, sign, tagOk } from "@/lib/session";
import { loginPlayer } from "@/lib/players";

// World ID login (docs.world.org, IDKit v4 "Verify on your backend"):
//   1. the wallet signed OUR fresh challenge (it owns the address),
//   2. the proof's signal is this wallet (the proof is bound to it),
//   3. World's verify API accepts the proof (never trust the client's result alone),
//   4. one human (nullifier) <-> one wallet.
// Any failure answers 403 "unverified" so the page can show it.
const ENV = process.env.NEXT_PUBLIC_WORLD_ENV ?? "production";
const deny = (error: string, status = 403) => NextResponse.json({ error, unverified: true }, { status });

export async function POST(req: Request) {
  const RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID;
  if (!RP_ID) return NextResponse.json({ error: "NEXT_PUBLIC_WORLD_RP_ID is not set" }, { status: 500 });
  const { idkitResponse, address, message, message_tag, signature } = await req.json().catch(() => ({}));
  if (!isAddress(address ?? "") || idkitResponse?.environment !== ENV) return deny("Verification failed: wrong wallet or World ID environment", 400);
  const wallet = address.toLowerCase();

  // 1. The wallet really signed our challenge (proves ownership, not just an address).
  const expires = Number(/Expires: (\d+)$/.exec(message ?? "")?.[1]);
  const fresh = expires > Date.now() / 1000;
  const mine = typeof message === "string" && message.includes(`Wallet: ${wallet}\n`) && tagOk(message, message_tag ?? "");
  const owns = fresh && mine && (await verifyMessage({ address, message, signature }).catch(() => false));
  if (!owns) return deny("Wallet signature check failed", 400);

  // 2. The World ID proof was made for THIS wallet (signal = wallet address).
  const r = idkitResponse.responses?.[0];
  if (r?.signal_hash !== hashSignal(wallet)) return deny("The World ID proof is not bound to this wallet");

  // 3. World validates the proof (payload forwarded as-is).
  const res = await fetch(`https://developer.world.org/api/v4/verify/${RP_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...idkitResponse, environment: ENV }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) return NextResponse.json({ error: "World ID verification service unreachable; try again" }, { status: 502 });
  const v = await res.json().catch(() => null);
  if (!res.ok || v?.success !== true || v?.environment !== ENV || !r?.nullifier) {
    console.warn("World ID verify rejected:", res.status, v?.code ?? v?.detail ?? "");
    return deny("World ID could not verify you as a unique human");
  }

  // 4. One human <-> one wallet.
  let result;
  try {
    result = loginPlayer(r.nullifier, wallet);
  } catch {
    return deny("Verification failed");
  }
  if (!result.ok) return deny(result.error);

  const out = NextResponse.json({ success: true, isNew: result.isNew });
  out.cookies.set("session", sign(result.id), SESSION_COOKIE);
  return out;
}
