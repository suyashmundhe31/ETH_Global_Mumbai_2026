"use client";

// The player's profile and collection in one place: every creature this wallet holds (Arkiv entities they own,
// cross-checked on CreatureMarket), plus their listings and claims still on their way (lib/creatures.ts).
//   Ready     Redeem: CreatureMarket.redeem (final; blocks selling) -> the worker reveals the code to the owner
//             -> Arkiv redeemed = true.   Sell: Arkiv escrow (listed = true, price, ownership -> settler) ->
//             settler attestation -> CreatureMarket.list
//   Redeemed  Show code (sign only, no transaction)
//   For sale  Unlist: CreatureMarket.unlist -> the settler hands the entity back automatically
//   Escrow    Finish listing (attestation + CreatureMarket.list at the escrowed price)

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { escrowForSale, explorerUrl, markRedeemed, modelUrl } from "@/lib/arkiv";
import { postJson, revealCode } from "@/lib/codes";
import { loadConfig, type AppConfig } from "@/lib/config";
import { loadProfile, type ProfileItem } from "@/lib/creatures";
import { list, redeem, unlist } from "@/lib/market";
import { errorText } from "@/lib/metamask";
import Avatar, { shortAddr } from "@/components/Avatar";
import CreatureCard, { RARITY_ORDER } from "@/components/CreatureCard";
import { IconAlert, IconCheck, IconClose, IconCopy, IconGift, IconMap, IconPaw, IconShield, IconTag } from "@/components/icons";

const MAX_PRICE = (BigInt(1) << BigInt(64)) - BigInt(1); // CreatureMarket.MAX_PRICE (Arkiv u64 column)
const POLL_MS = 15_000; // while something is in flight (approval, settler transfer, escrow)

function parsePrice(text: string): bigint {
  let wei: bigint;
  try {
    wei = parseEther(text.trim());
  } catch {
    throw new Error("Enter a price in ETH, e.g. 0.01");
  }
  if (wei <= BigInt(0)) throw new Error("The price must be above 0");
  if (wei > MAX_PRICE) throw new Error(`The maximum price is ${formatEther(MAX_PRICE)} ETH`);
  return wei;
}

const STATUS: Record<ProfileItem["status"], string> = {
  owned: "",
  listed: "For sale",
  escrow: "Listing…",
  "awaiting-approval": "Awaiting approval",
  transferring: "Arriving",
};

type Filter = "all" | "ready" | "redeemed" | "listed" | "arriving";
const isReady = (i: ProfileItem) => i.status === "owned" && !i.holding.redeemed;
const FILTERS: { id: Filter; label: string; test: (i: ProfileItem) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "ready", label: "Ready to redeem", test: isReady },
  { id: "redeemed", label: "Redeemed", test: (i) => i.holding.redeemed },
  { id: "listed", label: "For sale", test: (i) => i.status === "listed" || i.status === "escrow" },
  { id: "arriving", label: "Arriving", test: (i) => i.status === "awaiting-approval" || i.status === "transferring" },
];

export default function MyCreatures({ wallet }: { wallet: string }) {
  const player = wallet as Address;
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [items, setItems] = useState<ProfileItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(""); // "<creatureId>:<action>"
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const [selling, setSelling] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});

  const refresh = useCallback(
    async (c: AppConfig) => {
      try {
        setItems(await loadProfile(c, player));
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

  // Transfers done by the settler / the business show up without a reload.
  useEffect(() => {
    if (!cfg || !items?.some((i) => i.status !== "owned" && i.status !== "listed")) return;
    const t = setInterval(() => void refresh(cfg), POLL_MS);
    return () => clearInterval(t);
  }, [cfg, items, refresh]);

  const run = async (id: string, action: string, fn: (c: AppConfig) => Promise<void>) => {
    if (!cfg || busy) return;
    setError("");
    setNote("");
    setBusy(`${id}:${action}`);
    try {
      await fn(cfg);
    } catch (e) {
      setNote("");
      setError(errorText(e));
    } finally {
      setBusy("");
      void refresh(cfg);
    }
  };

  const doRedeem = (it: ProfileItem) =>
    run(it.creatureId, "redeem", async (c) => {
      if (!confirm("Redeem this creature? Its discount code is revealed, and a redeemed creature can never be sold.")) return;
      if (!it.holding.redeemed) {
        setNote("Confirm the redemption in MetaMask…");
        await redeem(c, player, BigInt(it.creatureId), () => setNote("Redeeming on chain…"));
      }
      setNote("Sign the reveal request (free, no transaction)…");
      const code = await revealCode(c, player, it.creatureId);
      setCodes((m) => ({ ...m, [it.creatureId]: code }));
      setNote("Redeemed ✓ Mirroring it on Arkiv (redeemed = true): confirm in MetaMask…");
      await markRedeemed(c, player, it.entity.key);
      setNote("Redeemed ✓ Arkiv updated.");
    });

  const showCode = (it: ProfileItem) =>
    run(it.creatureId, "code", async (c) => {
      setNote("Sign the reveal request (free, no transaction)…");
      const code = await revealCode(c, player, it.creatureId);
      setCodes((m) => ({ ...m, [it.creatureId]: code }));
      setNote("");
    });

  const syncRedeemed = (it: ProfileItem) =>
    run(it.creatureId, "sync", async (c) => {
      setNote("Mirror the redemption on Arkiv: confirm in MetaMask…");
      await markRedeemed(c, player, it.entity.key);
      setNote("Arkiv updated: redeemed = true.");
    });

  /** Attestation from the settler (ownership, not redeemed, untampered data), then the on-chain listing. */
  const finishListing = async (c: AppConfig, creatureId: string, price: bigint) => {
    setNote("Checking the creature (ownership, redemption, untampered data)…");
    const att = await postJson<{ deadline: string; signature: Hex }>("/api/market/attest", { creatureId, price: price.toString() });
    setNote("Confirm the listing in MetaMask…");
    await list(c, player, { creatureId: BigInt(creatureId), price, deadline: BigInt(att.deadline), signature: att.signature }, () => setNote("Listing on chain…"));
    setNote(`Listed for ${formatEther(price)} ETH ✓ It's on the marketplace.`);
    setSelling(null);
  };

  const doSell = (it: ProfileItem) =>
    run(it.creatureId, "sell", async (c) => {
      const price = parsePrice(prices[it.creatureId] ?? "");
      if (it.holding.redeemed) throw new Error("A redeemed creature cannot be sold.");
      setNote("Move it to the marketplace escrow on Arkiv: confirm in MetaMask…");
      await escrowForSale(c, player, it.entity.key, price);
      await finishListing(c, it.creatureId, price);
    });

  const doFinish = (it: ProfileItem) =>
    run(it.creatureId, "finish", async (c) => {
      if (it.entity.price === null) throw new Error("The escrow has no price; wait for it to return, then sell again.");
      await finishListing(c, it.creatureId, it.entity.price);
    });

  const doUnlist = (it: ProfileItem) =>
    run(it.creatureId, "unlist", async (c) => {
      setNote("Confirm in MetaMask…");
      await unlist(c, player, BigInt(it.creatureId), () => setNote("Unlisting on chain…"));
      setNote("Unlisted ✓ The creature returns to you on Arkiv in a moment.");
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
  const shown = useMemo(
    () =>
      (items ?? [])
        .filter(FILTERS.find((f) => f.id === filter)!.test)
        .sort((a, b) => RARITY_ORDER.indexOf(b.entity.rarity) - RARITY_ORDER.indexOf(a.entity.rarity) || Number(b.holding.claimedAt - a.holding.claimedAt)),
    [items, filter],
  );

  const spin = (id: string, action: string) => busy === `${id}:${action}`;

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
          {FILTERS.filter((f) => f.id !== "arriving" || counts.arriving > 0).map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              <span className="count">{items ? counts[f.id] : ""}</span>
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
          <span>{error}</span>
        </div>
      )}

      {!items && !error && (
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
              ? "Head out on the map, walk within 50 m of a spawn and catch your first creature. Every catch carries a real reward."
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
          {shown.map((it) => {
            const id = it.creatureId;
            const e = it.entity;
            const code = codes[id];
            const redeemed = it.holding.redeemed;
            const label = STATUS[it.status];
            return (
              <CreatureCard
                key={id}
                rarity={e.rarity}
                title={e.businessName}
                offer={e.discountDescription}
                modelUrl={modelUrl(e.swarmReference || e.campaignSwarmReference)}
                status={
                  redeemed ? (
                    <span className="status status-ok">
                      <IconCheck />
                      Redeemed
                    </span>
                  ) : label ? (
                    <span className="status">
                      {it.status === "listed" ? <IconTag /> : <span className="spinner" aria-hidden="true" />}
                      {label}
                    </span>
                  ) : undefined
                }
                facts={[
                  ["Creature", `#${e.index}`],
                  ["Campaign", e.campaignId],
                  ["Claimed", it.holding.claimedAt > BigInt(0) ? new Date(Number(it.holding.claimedAt) * 1000).toLocaleDateString() : "—"],
                  ...(it.status === "listed" ? [["Price", <span key="p" className="creature-price">{formatEther(it.listing.price)} ETH</span>] as [string, React.ReactNode]] : []),
                  [
                    "Arkiv",
                    <a key="a" href={explorerUrl(e.key)} target="_blank" rel="noreferrer" className="mono">
                      {shortAddr(e.key)}
                    </a>,
                  ],
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

                {it.status === "owned" && redeemed && !code && (
                  <div className="creature-actions">
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void showCode(it)}>
                      {spin(id, "code") ? <span className="spinner" /> : <IconGift />}
                      {spin(id, "code") ? "Sign…" : "Show code"}
                    </button>
                    {!e.redeemed && (
                      <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void syncRedeemed(it)}>
                        {spin(id, "sync") ? <span className="spinner" /> : <IconCheck />}
                        {spin(id, "sync") ? "Updating…" : "Sync Arkiv"}
                      </button>
                    )}
                  </div>
                )}

                {it.status === "owned" && !redeemed && selling !== id && (
                  <div className="creature-actions">
                    <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void doRedeem(it)}>
                      {spin(id, "redeem") ? <span className="spinner" /> : <IconGift />}
                      {spin(id, "redeem") ? "Redeeming…" : "Redeem"}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setSelling(id)}>
                      <IconTag />
                      Sell
                    </button>
                  </div>
                )}

                {it.status === "owned" && !redeemed && selling === id && (
                  <div className="sell-form">
                    <input
                      className="price-input"
                      inputMode="decimal"
                      placeholder="Price in ETH, e.g. 0.01"
                      value={prices[id] ?? ""}
                      onChange={(ev) => setPrices((p) => ({ ...p, [id]: ev.target.value }))}
                      aria-label="Price in ETH"
                      autoFocus
                    />
                    <div className="creature-actions">
                      <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setSelling(null)} aria-label="Cancel">
                        <IconClose />
                      </button>
                      <button type="button" className="btn btn-primary" disabled={!!busy || !(prices[id] ?? "").trim()} onClick={() => void doSell(it)}>
                        {spin(id, "sell") ? <span className="spinner" /> : <IconTag />}
                        {spin(id, "sell") ? "Listing…" : "List it"}
                      </button>
                    </div>
                  </div>
                )}

                {it.status === "listed" && (
                  <div className="creature-actions">
                    <Link href="/marketplace" className="btn btn-secondary">
                      <IconTag />
                      Market
                    </Link>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void doUnlist(it)}>
                      {spin(id, "unlist") ? <span className="spinner" /> : <IconClose />}
                      {spin(id, "unlist") ? "Unlisting…" : "Unlist"}
                    </button>
                  </div>
                )}

                {it.status === "escrow" && (
                  <>
                    <p className="creature-note">In the marketplace escrow but not listed on chain yet. Finish the listing, or it returns to you automatically.</p>
                    <div className="creature-actions">
                      <button type="button" className="btn btn-primary" disabled={!!busy || e.price === null} onClick={() => void doFinish(it)}>
                        {spin(id, "finish") ? <span className="spinner" /> : <IconTag />}
                        {spin(id, "finish") ? "Listing…" : `Finish${e.price !== null ? ` · ${formatEther(e.price)} ETH` : ""}`}
                      </button>
                    </div>
                  </>
                )}

                {it.status === "awaiting-approval" && <p className="creature-note">Claimed on chain ✓ {e.businessName} approves the Arkiv transfer; then you can redeem or sell it.</p>}
                {it.status === "transferring" && <p className="creature-note">Claimed on chain ✓ Moving it to you on Arkiv…</p>}
              </CreatureCard>
            );
          })}
        </div>
      )}
    </>
  );
}
