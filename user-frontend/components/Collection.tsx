"use client";

// "My creatures": what this wallet owns on chain, redeem (CRE reveals the code sealed to this wallet's
// key), and "Sync sold creatures" (moves Arkiv entities of creatures sold on chain to their buyers).

import { useCallback, useState } from "react";
import type { Address } from "viem";
import { entitiesOwnedBy, markRedeemed, syncSold } from "@/lib/arkiv";
import { RARITIES, chainConfigured, ownedCreatures, redeem, type Owned, type RedeemPhase } from "@/lib/chain";

const FONT = "system-ui, sans-serif";
const PANEL: React.CSSProperties = {
  position: "fixed",
  top: "calc(16px + env(safe-area-inset-top))",
  right: "calc(16px + env(safe-area-inset-right))",
  width: "min(360px, calc(100% - 32px))",
  maxHeight: "calc(100% - 180px)",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: 16,
  borderRadius: 16,
  background: "rgba(20, 24, 32, 0.94)",
  color: "#fff",
  fontFamily: FONT,
  fontSize: 14,
  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.4)",
};
const BTN: React.CSSProperties = {
  minHeight: 40,
  padding: "0 14px",
  border: "none",
  borderRadius: 10,
  fontFamily: FONT,
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  touchAction: "manipulation",
};
const PHASE: Record<RedeemPhase, string> = {
  sign: "Sign to unlock your key…",
  confirm: "Confirm in MetaMask…",
  verifying: "Chainlink CRE is checking ownership…",
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

export default function Collection({ wallet }: { wallet: string }) {
  const player = wallet as Address;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Owned[] | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<{ id: bigint; phase: RedeemPhase } | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      // Bought creatures aren't in getPlayerCatches; their Arkiv entities (after a sync) point us at them.
      const extra = await entitiesOwnedBy(player).then((es) => es.map((e) => e.creatureId)).catch(() => []);
      setItems(await ownedCreatures(player, extra));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [player]);

  const onRedeem = async (c: Owned) => {
    setNote("");
    setError("");
    try {
      const code = await redeem(player, c.creatureId, (phase) => setWorking({ id: c.creatureId, phase }));
      setCodes((m) => ({ ...m, [c.creatureId.toString()]: code }));
      setWorking(null);
      void refresh();
      // Display mirror on Arkiv; needs tGLM on Rabdi and the entity settled to this wallet.
      markRedeemed(player, c.creatureId)
        .then((patched) => patched && setNote("Arkiv updated: redeemed = true"))
        .catch((e) => setNote(`Code revealed; Arkiv not updated (${errMsg(e)})`));
    } catch (e) {
      setWorking(null);
      setError(errMsg(e));
    }
  };

  const onSync = async () => {
    setNote("");
    setError("");
    try {
      const n = await syncSold(player, (done, total) => setNote(`Syncing sold creatures ${done}/${total}…`));
      setNote(n ? `Moved ${n} sold creature${n > 1 ? "s" : ""} to their buyers on Arkiv` : "Nothing to sync");
    } catch (e) {
      setError(`Sync failed (click again to finish): ${errMsg(e)}`);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (chainConfigured) void refresh();
        }}
        style={{ ...BTN, position: "fixed", top: "calc(16px + env(safe-area-inset-top))", right: "calc(16px + env(safe-area-inset-right))", minHeight: 48, borderRadius: 24, background: "rgba(20, 24, 32, 0.85)", color: "#fff", boxShadow: "0 2px 10px rgba(0,0,0,0.35)" }}
      >
        🎒 My creatures
      </button>
    );
  }

  return (
    <div style={PANEL} role="dialog" aria-label="My creatures">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 17 }}>My creatures</strong>
        <button type="button" onClick={() => setOpen(false)} style={{ ...BTN, background: "transparent", color: "#fff" }} aria-label="Close">
          ✕
        </button>
      </div>
      {!chainConfigured && <div>Set NEXT_PUBLIC_CATCH_MANAGER to load your creatures.</div>}
      {items === null && chainConfigured && !error && <div style={{ opacity: 0.7 }}>Loading…</div>}
      {items?.length === 0 && <div style={{ opacity: 0.7 }}>No creatures yet. Go catch one!</div>}
      {items?.map((c) => {
        const id = c.creatureId.toString();
        const code = codes[id];
        const busyHere = working?.id === c.creatureId;
        return (
          <div key={id} style={{ padding: "10px 0", borderTop: "1px solid #ffffff1f" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{RARITIES[c.rarity] ?? "?"}</strong>
              <span style={{ opacity: 0.7 }}>
                campaign {(c.creatureId >> BigInt(32)).toString()} · #{(c.creatureId & BigInt(0xffffffff)).toString()}
              </span>
            </div>
            <div style={{ opacity: 0.75, marginTop: 2 }}>float {c.float.toFixed(6)}</div>
            {code ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                <code style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>{code}</code>
                <button type="button" style={{ ...BTN, background: "#fff", color: "#111" }} onClick={() => void navigator.clipboard?.writeText(code).catch(() => null)}>
                  Copy
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!!working}
                onClick={() => void onRedeem(c)}
                style={{ ...BTN, marginTop: 8, background: c.redeemed ? "#3a3f4a" : "#16a34a", color: "#fff", opacity: working && !busyHere ? 0.5 : 1 }}
              >
                {busyHere ? PHASE[working.phase] : c.redeemed ? "Show code" : "Redeem code"}
              </button>
            )}
          </div>
        );
      })}
      <button type="button" onClick={() => void onSync()} style={{ ...BTN, width: "100%", marginTop: 12, background: "transparent", color: "#fff", border: "1px solid #fff5" }}>
        Sync sold creatures
      </button>
      {note && <div style={{ marginTop: 8, opacity: 0.85 }}>{note}</div>}
      {error && <div style={{ marginTop: 8, color: "#fca5a5" }}>{error}</div>}
    </div>
  );
}
