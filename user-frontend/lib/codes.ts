"use client";

// Discount code reveal: the player signs the reveal message (EIP-191, no gas); the worker decrypts only for
// the creature's on-chain owner after CreatureMarket.redeem.

import { reloadTo } from "@/lib/nav";
import { createWalletClient, custom, type Address } from "viem";
import { revealMessage } from "../../shared/discountCodes.js";
import type { AppConfig } from "@/lib/config";
import { provider } from "@/lib/metamask";
import { campaignOf } from "@/lib/market";

export async function revealCode(cfg: AppConfig, player: Address, creatureId: string): Promise<string> {
  const issuedAt = new Date().toISOString();
  const message = revealMessage({
    chainId: cfg.chainId,
    contract: cfg.campaignManager,
    campaignId: campaignOf(BigInt(creatureId)).toString(),
    creatureId,
    address: player,
    issuedAt,
  });
  const signature = await createWalletClient({ transport: custom(provider()), account: player }).signMessage({ account: player, message });
  const res = await fetch("/api/codes/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatureId, issuedAt, signature }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Reveal failed (${res.status})`);
  return String(body.code);
}

/** POST JSON to this app's API; throws the server's error message. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) reloadTo("/");
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out as T;
}
