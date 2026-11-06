"use client";

// Profile: every creature this wallet owns on chain (catches + bought ones), with its Arkiv data.
// Unredeemed & unlisted -> choose: Redeem (reveal the code) or List on market (a listing entity on Arkiv).
// Listed ones move to the marketplace; redeemed ones always stay here.

import { useCallback, useEffect, useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { creatureRows, entitiesOwnedBy, listCreature, listedSellers, markRedeemed } from "@/lib/arkiv";
import { RARITIES, ownedCreatures, redeem } from "@/lib/chain";

// The SDK wraps wallet/RPC failures in a generic message; walk the cause chain to show the real reason.
type Err = { code?: number; message?: string; shortMessage?: string; details?: string; cause?: unknown };
const HINT: Record<number, string> = {
  4001: "You rejected the request in MetaMask",
  4100: "Connect this account to the site on the Rabdi network in MetaMask",
  [-32002]: "A MetaMask request is already open: open MetaMask and approve or reject it, then try again",
};
const errMsg = (e: unknown) => {
  console.warn(e); // warn, not error: console.error pops the Next.js dev overlay
  const msgs: string[] = [];
  for (let x = e as Err | undefined; x && typeof x === "object"; x = x.cause as Err | undefined) {
    if (x.code !== undefined && HINT[x.code]) return HINT[x.code];
    msgs.push(x.details ?? x.shortMessage ?? x.message?.split("\n")[0] ?? (x.code !== undefined ? `code ${x.code}` : ""));
  }
  return [...new Set(msgs.filter(Boolean))].join(" ← ") || JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})) || String(e);
};
const BTN: React.CSSProperties = { minHeight: 36, padding: "0 12px", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", color: "#fff" };

async function fetchItems(player: Address) {
  const bought = await entitiesOwnedBy(player).then((es) => es.map((e) => e.creatureId)).catch(() => []);
  const owned = await ownedCreatures(player, bought);
  const [rows, sellers] = await Promise.all([creatureRows(owned.map((c) => c.creatureId)), listedSellers()]);
  return owned.map((c) => {
    const seller = sellers.get(c.creatureId.toString());
    return { c, row: rows.get(c.creatureId.toString()), listed: !!seller && isAddressEqual(seller, player) };
  });
}

export default function MyCreatures({ wallet }: { wallet: string }) {
  const player = wallet as Address;
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchItems>> | null>(null);
  const [busy, setBusy] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const load = useCallback(() => fetchItems(player).then(setItems, (e) => setError(errMsg(e))), [player]);
  useEffect(() => {
    fetchItems(player).then(setItems, (e) => setError(errMsg(e)));
  }, [player]);

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setError("");
    setBusy(`${id}:${label}`);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
    setBusy("");
  };

  if (error && !items) return <p>{error}</p>;
  if (!items) return <p>Loading…</p>;
  const shown = items.filter(({ c, listed }) => c.redeemed || !listed); // listed -> marketplace
  if (!shown.length) return <p>No creatures yet.</p>;

  return (
    <>
      {error && <p style={{ color: "#fca5a5" }}>{error}</p>}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {shown.map(({ c, row }) => {
          const id = c.creatureId.toString();
          return (
            <div key={id} style={{ padding: 12, borderRadius: 12, border: "1px solid #ffffff2a" }}>
              <strong>{row?.rarity ?? RARITIES[c.rarity]}</strong> · {row?.businessName ?? "?"}
              <div>ID {id} · campaign {(c.creatureId >> BigInt(32)).toString()}</div>
              <div style={{ opacity: 0.75 }}>{row?.description}</div>
              {codes[id] && <code style={{ fontSize: 18, fontWeight: 700 }}>{codes[id]}</code>}
              {c.redeemed ? (
                !codes[id] && (
                  <button style={{ ...BTN, background: "#3a3f4a", marginTop: 8 }} disabled={!!busy}
                    onClick={() => run(id, "show", async () => {
                      const code = await redeem(player, c.creatureId, () => {}); // already redeemed: sign only, no tx
                      setCodes((m) => ({ ...m, [id]: code }));
                    })}>
                    {busy === `${id}:show` ? "…" : "Redeemed · Show code"}
                  </button>
                )
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={{ ...BTN, background: "#16a34a" }} disabled={!!busy}
                    onClick={() => run(id, "redeem", async () => {
                      const code = await redeem(player, c.creatureId, () => {});
                      setCodes((m) => ({ ...m, [id]: code }));
                      await markRedeemed(player, c.creatureId).catch(() => null); // Arkiv mirror, best effort
                    })}>
                    {busy === `${id}:redeem` ? "Redeeming…" : "Redeem"}
                  </button>
                  <button style={{ ...BTN, background: "#2563eb" }} disabled={!!busy}
                    onClick={() => run(id, "list", () => listCreature(player, c.creatureId))}>
                    {busy === `${id}:list` ? "Listing…" : "List on market"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
