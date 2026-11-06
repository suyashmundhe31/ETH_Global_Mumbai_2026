"use client";

// Marketplace: creatures players listed. A listing shows only when the settler holds its Arkiv entity in escrow
// (listed = true) AND CreatureMarket lists it at the same price, and it is not redeemed (lib/creatures.ts
// loadMarket), so stale or fake listings never show.
// Buy = CreatureMarket.buy (the seller is paid in the same transaction); the settler then transfers the Arkiv
// entity to the buyer automatically.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatEther, type Address } from "viem";
import { explorerUrl, modelUrl } from "@/lib/arkiv";
import { loadConfig, type AppConfig } from "@/lib/config";
import { loadMarket, waitForArkivOwner, type MarketItem } from "@/lib/creatures";
import { buy } from "@/lib/market";
import { errorText } from "@/lib/metamask";
import Avatar, { shortAddr } from "@/components/Avatar";
import CreatureCard, { RARITY_ORDER, titleCase } from "@/components/CreatureCard";
import { IconAlert, IconCheck, IconCollection, IconMarket, IconTag } from "@/components/icons";

export default function Market({ wallet }: { wallet: string }) {
  const player = wallet as Address;
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [items, setItems] = useState<MarketItem[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [rarity, setRarity] = useState("ALL");

  const refresh = useCallback(
    async (c: AppConfig) => {
      try {
        setItems(await loadMarket(c, player));
        setError("");
      } catch (e) {
        setError(errorText(e));
      }
    },
    [player],
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
    if (!cfg || busy) return;
    if (!confirm(`Buy this ${titleCase(it.entity.rarity)} ${it.entity.businessName} creature for ${formatEther(it.price)} ETH?`)) return;
    setError("");
    setBusy(it.creatureId);
    try {
      setNote("Confirm the purchase in MetaMask…");
      await buy(cfg, player, BigInt(it.creatureId), it.price, () => setNote("Buying on chain…"));
      setNote("Bought ✓ The seller has been paid. Transferring the creature to you on Arkiv…");
      const moved = await waitForArkivOwner(cfg, it.creatureId, player);
      setNote(moved ? "It's yours! Find it in your collection." : "Bought ✓ The Arkiv transfer is still running; it will appear in your collection shortly.");
    } catch (e) {
      setNote("");
      setError(errorText(e));
    } finally {
      setBusy(null);
      void refresh(cfg);
    }
  };

  const shown = useMemo(
    () =>
      (items ?? [])
        .filter((i) => rarity === "ALL" || i.entity.rarity === rarity)
        .sort((a, b) => Number(a.mine) - Number(b.mine) || RARITY_ORDER.indexOf(b.entity.rarity) - RARITY_ORDER.indexOf(a.entity.rarity) || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)),
    [items, rarity],
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Creatures other hunters have put up for sale. Every listing is checked against CreatureMarket and its Arkiv escrow.</p>
        </div>
        <Link href="/profile" className="btn btn-secondary">
          <IconCollection />
          Sell from your collection
        </Link>
      </header>

      <div className="toolbar">
        <div className="filters" role="group" aria-label="Filter by rarity">
          {["ALL", ...RARITY_ORDER].map((r) => (
            <button key={r} type="button" aria-pressed={rarity === r} onClick={() => setRarity(r)}>
              {r === "ALL" ? "All" : titleCase(r)}
              <span className="count">{items ? (r === "ALL" ? items.length : items.filter((i) => i.entity.rarity === r).length) : ""}</span>
            </button>
          ))}
        </div>
      </div>

      {note && (
        <div className="notice" style={{ marginBottom: 16 }} role="status" aria-live="polite">
          {busy ? <span className="spinner" aria-hidden="true" /> : <IconCheck />}
          <span>{note}</span>
        </div>
      )}
      {error && (
        <div className="notice notice-error" style={{ marginBottom: 16 }} role="alert">
          <IconAlert />
          <span>{items ? error : `Couldn't load the marketplace: ${error}`}</span>
        </div>
      )}

      {!items && !error && (
        <div className="grid" aria-busy="true" aria-label="Loading listings">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      )}

      {items && shown.length === 0 && (
        <div className="empty">
          <span className="empty-icon">
            <IconMarket />
          </span>
          <h3>{items.length ? "No listings at this rarity" : "Nothing listed right now"}</h3>
          <p>{items.length ? "Try another rarity filter." : "When hunters list creatures for sale, they show up here. You can sell your own from your collection."}</p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid">
          {shown.map((it) => {
            const e = it.entity;
            return (
              <CreatureCard
                key={it.creatureId}
                rarity={e.rarity}
                title={e.businessName}
                offer={e.discountDescription}
                modelUrl={modelUrl(e.swarmReference || e.campaignSwarmReference)}
                status={
                  it.mine ? (
                    <span className="status">
                      <IconTag />
                      Yours
                    </span>
                  ) : undefined
                }
                facts={[
                  ["Price", <span key="p" className="creature-price">{formatEther(it.price)} ETH</span>],
                  ["Creature", `#${e.index}`],
                  ["Campaign", e.campaignId],
                  [
                    "Arkiv",
                    <a key="a" href={explorerUrl(e.key)} target="_blank" rel="noreferrer" className="mono">
                      {shortAddr(e.key)}
                    </a>,
                  ],
                ]}
              >
                <div className="seller">
                  <Avatar address={it.seller} size={22} />
                  Listed by <span className="num">{it.mine ? "you" : shortAddr(it.seller)}</span>
                </div>
                {it.mine ? (
                  <div className="creature-actions">
                    <Link href="/profile" className="btn btn-secondary">
                      Manage in collection
                    </Link>
                  </div>
                ) : (
                  <div className="creature-actions">
                    <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void onBuy(it)}>
                      {busy === it.creatureId ? <span className="spinner" /> : <IconTag />}
                      {busy === it.creatureId ? "Buying…" : `Buy · ${formatEther(it.price)} ETH`}
                    </button>
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
