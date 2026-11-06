import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { isAddress } from "viem";
import { tag } from "@/lib/session";

export async function POST(req: Request) {
  const { address } = await req.json().catch(() => ({}));
  if (!isAddress(address ?? "")) return NextResponse.json({ error: "Bad address" }, { status: 400 });
  if (!process.env.RP_SIGNING_KEY) return NextResponse.json({ error: "RP_SIGNING_KEY is not set" }, { status: 500 });

  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: process.env.RP_SIGNING_KEY!,
    action: "game-login",
  });
  // Message the wallet must sign to prove it owns the address.
  const message = `Sign in to Game\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
  return NextResponse.json({
    sig, nonce, created_at: createdAt, expires_at: expiresAt,
    message, message_tag: tag(message),
  });
}