"use client";

// The player's profile and collection in one place: every creature this wallet owns on chain (catches +
// bought ones) with its Arkiv data.
//   Ready (unredeemed, unlisted) -> Redeem reward (CRE reveals the code sealed to this wallet's key) or List on market
//   Redeemed                     -> Show code again (sign only, no tx)
//   Listed                       -> View on market, or Unlist (back to Redeem / List)

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { isAddressEqual, type Address } from "viem";
import * as arkiv from "@/lib/arkiv";
import { creatureRows, entitiesOwnedBy, listCreature, listedSellers, markRedeemed } from "@/lib/arkiv";
import { RARITIES, chainConfigured, ownedCreatures, redeem, type RedeemPhase } from "@/lib/chain";
import Avatar, { shortAddr } from "@/components/Avatar";
import CreatureCard, { RARITY_ORDER, titleCase } from "@/components/CreatureCard";
import { IconAlert, IconCheck, IconClose, IconCopy, IconGift, IconMap, IconPaw, IconShield, IconTag } from "@/components/icons";

// The Arkiv side of unlisting lives in lib/arkiv.ts (`unlistCreature(owner, creatureId)`, same shape as
// listCreature). Looked up at runtime so the page still builds and runs before that code is merged.
type Unlist = (owner: Address, creatureId: bigint) => Promise<unknown>;
const unlistCreature: Unlist = (owner, creatureId) => {
  const fn = (arkiv as unknown as { unlistCreature?: Unlist }).unlistCreature;
  if (!fn) return Promise.reject(new Error("Unlisting isn't available yet: lib/arkiv.ts has no unlistCreature."));
  return fn(owner, creatureId);
};

// The SDK wraps wallet/RPC failures in a generic message; walk the cause chain to show the real reason.
type Err = { code?: number; message?: string; shortMessage?: string; details?: string; cause?: unknown };
const HINT: Record<number, string> = {
  4001: "You rejected the request in your wallet.",
  4100: "Connect this account to the site on the Rabdi network in MetaMask.",
  [-32002]: "A MetaMask request is already open. Open MetaMask, approve or reject it, then try again.",
};
const errMsg = (e: unknown) => {
  console.warn(e); // warn, not error: console.error pops the Next.js dev overlay
  const msgs: string[] = [];
  for (let x = e as Err | undefined; x && typeof x === "object"; x = x.cause as Err | undefined) {
    if (x.code !== undefined && HINT[x.code]) return HINT[x.code];
    msgs.push(x.details ?? x.shortMessage ?? x.message?.split("\n")[0] ?? (x.code !== undefined ? `code ${x.code}` : ""));
  }
  return [...new Set(msgs.filter(Boolean))].join(" ← ") || String(e);
};

const PHASE: Record<RedeemPhase, string> = {
  sign: "Sign to unlock…",
  confirm: "Confirm in wallet…",
  verifying: "Verifying ownership…",
};

async function fetchItems(player: Address) {
  const bought = await entitiesOwnedBy(player).then((es) => es.map((e) => e.creatureId)).catch(() => []);
  const owned = await ownedCreatures(player, bought);
  const [rows, sellers] = await Promise.all([creatureRows(owned.map((c) => c.creatureId)), listedSellers()]);
  return owned
    .map((c) => {
      const seller = sellers.get(c.creatureId.toString());
      const row = rows.get(c.creatureId.toString());
      return { c, row, rarity: row?.rarity ?? RARITIES[c.rarity] ?? "COMMON", listed: !!seller && isAddressEqual(seller, player) && !c.redeemed };
    })
    .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.c.float - a.c.float);
}
type Item = Awaited<ReturnType<typeof fetchItems>>[number];

type Filter = "all" | "ready" | "redeemed" | "listed";
const FILTERS: { id: Filter; label: string; test: (i: Item) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "ready", label: "Ready to redeem", test: (i) => !i.c.redeemed && !i.listed },
  { id: "redeemed", label: "Redeemed", test: (i) => i.c.redeemed },
  { id: "listed", label: "Listed", test: (i) => i.listed },
];

export default function MyCreatures({ wallet }: { wallet: string }) {
  const player = wallet as Address;
  const [items, setItems] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<{ id: string; label: string } | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => fetchItems(player).then(setItems, (e) => setError(errMsg(e))), [player]);
  useEffect(() => {
    if (!chainConfigured) return;
    fetchItems(player).then(setItems, (e) => setError(errMsg(e)));
  }, [player]);

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setError("");
    setBusy({ id, label });
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
    setBusy(null);
  };

  const reveal = (id: string, c: Item["c"], mirror: boolean) =>
    run(id, "Preparing…", async () => {
      const code = await redeem(player, c.creatureId, (phase) => setBusy({ id, label: PHASE[phase] }));
      setCodes((m) => ({ ...m, [id]: code }));
      if (mirror) await markRedeemed(player, c.creatureId).catch(() => null); // Arkiv display mirror, best effort
    });

  const copy = (id: string, code: string) =>
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(id);
        setTimeout(() => setCopied(""), 1400);
      })
      .catch(() => null);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, items?.filter(f.test).length ?? 0])) as Record<Filter, number>, [items]);
  const shown = items?.filter(FILTERS.find((f) => f.id === filter)!.test) ?? [];

  return (
    <>
      <section className="profile-card" aria-label="Profile">
        <div className="profile-id">
          <Avatar address={wallet} size={56} />
          <div style={{ minWidth: 0 }}>
            <h1>Your collection</h1>
            <div className="profile-addr">
              <span className="num">{shortAddr(wallet)}</span>
              <span aria-hidden="true">·</span>
              <span className="verified">
                <IconShield />
                Verified human
              </span>
            </div>
          </div>
        </div>
        <div className="profile-stats">
          <div className="profile-stat">
            <b>{items ? items.length : "–"}</b>
            <span>Creatures</span>
          </div>
          <div className="profile-stat">
            <b>{items ? counts.ready : "–"}</b>
            <span>Ready</span>
          </div>
          <div className="profile-stat">
            <b>{items ? counts.redeemed : "–"}</b>
            <span>Redeemed</span>
          </div>
        </div>
      </section>

      <div className="toolbar">
        <div className="filters" role="group" aria-label="Filter creatures">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              <span className="count">{items ? counts[f.id] : ""}</span>
            </button>
          ))}
        </div>
      </div>

      {(error || !chainConfigured) && (
        <div className="notice notice-error" style={{ marginBottom: 16 }} role="status">
          <IconAlert />
          <span>{!chainConfigured ? "Set NEXT_PUBLIC_CATCH_MANAGER to load your creatures." : error}</span>
        </div>
      )}

      {!items && chainConfigured && !error && (
        <div className="grid" aria-busy="true" aria-label="Loading creatures">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      )}

      {items && shown.length === 0 && (
        <div className="empty">
          <span className="empty-icon">
            <IconPaw />
          </span>
          <h3>{filter === "all" ? "No creatures yet" : "Nothing here"}</h3>
          <p>
            {filter === "all"
              ? "Head out on the map, walk within 100 m of a spawn and catch your first creature. Every catch carries a real reward."
              : "No creatures match this filter."}
          </p>
          {filter === "all" && (
            <Link href="/" className="btn btn-primary">
              <IconMap />
              Open the map
            </Link>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid">
          {shown.map(({ c, row, rarity, listed }) => {
            const id = c.creatureId.toString();
            const here = busy?.id === id;
            const code = codes[id];
            return (
              <CreatureCard
                key={id}
                rarity={rarity}
                title={row?.businessName ?? `${titleCase(rarity)} creature`}
                offer={row?.description}
                modelUrl={row?.modelUrl}
                status={
                  c.redeemed ? (
                    <span className="status status-ok">
                      <IconCheck />
                      Redeemed
                    </span>
                  ) : listed ? (
                    <span className="status">
                      <IconTag />
                      Listed
                    </span>
                  ) : undefined
                }
                facts={[
                  ["Float", <span key="f" className="mono">{c.float.toFixed(6)}</span>],
                  ["Creature", `#${(c.creatureId & BigInt(0xffffffff)).toString()}`],
                  ["Campaign", (c.creatureId >> BigInt(32)).toString()],
                ]}
              >
                {code && (
                  <div className="code-box">
                    <code>{code}</code>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(id, code)} aria-label="Copy code">
                      {copied === id ? <IconCheck /> : <IconCopy />}
                      {copied === id ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
                {!code && (
                  <div className="creature-actions">
                    {c.redeemed ? (
                      <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void reveal(id, c, false)}>
                        {here ? <span className="spinner" /> : <IconGift />}
                        {here ? busy.label : "Show code"}
                      </button>
                    ) : listed ? (
                      <>
                        <Link href="/marketplace" className="btn btn-secondary">
                          <IconTag />
                          Market
                        </Link>
                        <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void run(id, "unlist", () => unlistCreature(player, c.creatureId))}>
                          {here && busy.label === "unlist" ? <span className="spinner" /> : <IconClose />}
                          {here && busy.label === "unlist" ? "Unlisting…" : "Unlist"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void reveal(id, c, true)}>
                          {here && busy.label !== "list" ? <span className="spinner" /> : <IconGift />}
                          {here && busy.label !== "list" ? busy.label : "Redeem"}
                        </button>
                        <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void run(id, "list", () => listCreature(player, c.creatureId))}>
                          {here && busy.label === "list" ? <span className="spinner" /> : <IconTag />}
                          {here && busy.label === "list" ? "Listing…" : "List"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </CreatureCard>
            );
          })}
        </div>
      )}
    </>
  );
}
