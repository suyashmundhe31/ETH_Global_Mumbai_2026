"use client";

// Marketplace: creatures other players listed. A listing shows only when the settler holds its Arkiv entity
// in escrow (listed = true) AND CreatureMarket lists it at the same price, and it is not redeemed.
// Buy = CreatureMarket.buy (the seller is paid in the same transaction); the settler then transfers the
// Arkiv entity to the buyer automatically.

import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import ModelViewer from "@/components/ModelViewer";
import { modelUrl } from "@/lib/arkiv";
import { loadConfig, shortAddr, type AppConfig } from "@/lib/config";
import { loadMarket, waitForArkivOwner, type MarketItem } from "@/lib/creatures";
import { buy } from "@/lib/market";
import { errorText } from "@/lib/metamask";

export default function Market({ wallet }: { wallet: Address }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [items, setItems] = useState<MarketItem[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const refresh = useCallback(
    async (c: AppConfig) => {
      try {
        setItems(await loadMarket(c, wallet));
        setError("");
      } catch (e) {
        setError(errorText(e));
      }
    },
    [wallet],
  );

  useEffect(() => {
    loadConfig().then(
      (c) => {
        setCfg(c);
        void refresh(c);
      },
      (e) => setError(errorText(e)),
    );
  }, [refresh]);

  const onBuy = async (it: MarketItem) => {
    if (!cfg) return;
    if (!confirm(`Buy this ${it.entity.rarity} creature for ${formatEther(it.price)} ETH?`)) return;
    setError("");
    setBusy(it.creatureId);
    try {
      setNote("Confirm the purchase in MetaMask…");
      await buy(cfg, wallet, BigInt(it.creatureId), it.price, () => setNote("Buying on chain…"));
      setNote("Bought ✓ The seller has been paid. Transferring the creature to you on Arkiv…");
      const moved = await waitForArkivOwner(cfg, it.creatureId, wallet);
      setNote(moved ? "It's yours! Find it in your Profile." : "Bought ✓ The Arkiv transfer is still running; it will appear in your Profile shortly.");
    } catch (e) {
      setNote("");
      setError(errorText(e));
    } finally {
      setBusy(null);
      void refresh(cfg);
    }
  };

  return (
    <>
      {note && <p className="notice">{note}</p>}
      {error && <p className="error">{error}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">Nothing is listed right now.</p>}
      <div className="grid">
        {items?.map((it) => (
          <div className="card" key={it.creatureId}>
            <div className="row">
              <strong className={`r-${it.entity.rarity}`}>{it.entity.rarity}</strong>
              <b>{formatEther(it.price)} ETH</b>
            </div>
            <div>
              <b>{it.entity.businessName}</b>
            </div>
            <div className="muted">{it.entity.discountDescription}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Seller <code>{shortAddr(it.seller)}</code> · creature <code>{it.creatureId}</code>
            </div>
            {viewing === it.creatureId ? <ModelViewer url={modelUrl(it.entity.swarmReference)} height={180} /> : null}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setViewing(viewing === it.creatureId ? null : it.creatureId)}>
                {viewing === it.creatureId ? "Hide 3D" : "View 3D"}
              </button>
              {it.mine ? (
                <span className="badge">Your listing (unlist it in your Profile)</span>
              ) : (
                <button type="button" className="btn green" disabled={busy !== null} onClick={() => void onBuy(it)}>
                  {busy === it.creatureId ? "Buying…" : "Buy"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
