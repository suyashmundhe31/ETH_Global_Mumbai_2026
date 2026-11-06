"use client";

// Profile: the player's wallet and every creature they hold (Arkiv entities they own, cross-checked on chain),
// plus their marketplace listings and claims still on their way to them.
//   Redeem   CreatureMarket.redeem (final; blocks selling) -> the worker reveals the code -> Arkiv redeemed = true
//   Sell     Arkiv escrow (listed = true, price, ownership -> settler) -> settler attestation (ownership,
//            not redeemed, data untampered) -> CreatureMarket.list
//   Unlist   CreatureMarket.unlist -> the settler hands the entity back automatically

import { reloadTo } from "@/lib/nav";
import { useCallback, useEffect, useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import ModelViewer from "@/components/ModelViewer";
import { escrowForSale, markRedeemed, modelUrl } from "@/lib/arkiv";
import { postJson, revealCode } from "@/lib/codes";
import { loadConfig, type AppConfig } from "@/lib/config";
import { loadProfile, type ProfileItem } from "@/lib/creatures";
import { list, redeem, unlist } from "@/lib/market";
import { errorText } from "@/lib/metamask";

const MAX_PRICE = (BigInt(1) << BigInt(64)) - BigInt(1); // CreatureMarket.MAX_PRICE (Arkiv u64 column)

const STATUS: Record<ProfileItem["status"], string> = {
  owned: "",
  listed: "For sale",
  escrow: "Listing in progress",
  "awaiting-approval": "Awaiting business approval",
  transferring: "Arriving on Arkiv…",
};

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

export default function Profile({ wallet }: { wallet: Address }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [items, setItems] = useState<ProfileItem[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(""); // "<creatureId>:<action>"
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [selling, setSelling] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const refresh = useCallback(async (c: AppConfig) => {
    try {
      setItems(await loadProfile(c, wallet));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [wallet]);

  useEffect(() => {
    loadConfig().then((c) => {
      setCfg(c);
      void refresh(c);
    }, (e) => setError(errorText(e)));
  }, [refresh]);

  // Transfers done by the settler / the business show up without a reload.
  useEffect(() => {
    if (!cfg || !items?.some((i) => i.status !== "owned" && i.status !== "listed")) return;
    const t = setInterval(() => void refresh(cfg), 15_000);
    return () => clearInterval(t);
  }, [cfg, items, refresh]);

  const run = async (id: string, action: string, fn: () => Promise<void>) => {
    if (!cfg) return;
    setError("");
    setNote("");
    setBusy(`${id}:${action}`);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
      void refresh(cfg);
    }
  };

  const doRedeem = (it: ProfileItem) =>
    run(it.creatureId, "redeem", async () => {
      if (!confirm("Redeem this creature? Its discount code is revealed, and a redeemed creature can never be sold.")) return;
      if (!it.holding.redeemed) {
        setNote("Confirm the redemption in MetaMask…");
        await redeem(cfg!, wallet, BigInt(it.creatureId));
      }
      setNote("Sign the reveal request (free, no transaction)…");
      const code = await revealCode(cfg!, wallet, it.creatureId);
      setCodes((m) => ({ ...m, [it.creatureId]: code }));
      setNote("Redeemed ✓ Updating Arkiv (redeemed = true): confirm in MetaMask…");
      await markRedeemed(cfg!, wallet, it.entity.key);
      setNote("Redeemed ✓ Arkiv updated.");
    });

  const showCode = (it: ProfileItem) =>
    run(it.creatureId, "code", async () => {
      const code = await revealCode(cfg!, wallet, it.creatureId);
      setCodes((m) => ({ ...m, [it.creatureId]: code }));
    });

  const syncRedeemed = (it: ProfileItem) =>
    run(it.creatureId, "sync", async () => {
      await markRedeemed(cfg!, wallet, it.entity.key);
      setNote("Arkiv updated: redeemed = true.");
    });

  /** Attestation from the settler, then the on-chain listing. */
  const finishListing = async (creatureId: string, price: bigint) => {
    setNote("Checking the creature (ownership, redemption, untampered data)…");
    const att = await postJson<{ deadline: string; signature: Hex }>("/api/market/attest", { creatureId, price: price.toString() });
    setNote("Confirm the listing in MetaMask…");
    await list(cfg!, wallet, { creatureId: BigInt(creatureId), price, deadline: BigInt(att.deadline), signature: att.signature });
    setNote(`Listed for ${formatEther(price)} ETH ✓ It's on the marketplace.`);
    setSelling(null);
  };

  const doSell = (it: ProfileItem) =>
    run(it.creatureId, "sell", async () => {
      const price = parsePrice(prices[it.creatureId] ?? "");
      if (it.holding.redeemed) throw new Error("A redeemed creature cannot be sold.");
      setNote("Move it to the marketplace escrow on Arkiv: confirm in MetaMask…");
      await escrowForSale(cfg!, wallet, it.entity.key, price);
      await finishListing(it.creatureId, price);
    });

  const doFinish = (it: ProfileItem) =>
    run(it.creatureId, "finish", async () => {
      if (it.entity.price === null) throw new Error("The escrow has no price; wait for it to return, then sell again.");
      await finishListing(it.creatureId, it.entity.price);
    });

  const doUnlist = (it: ProfileItem) =>
    run(it.creatureId, "unlist", async () => {
      setNote("Confirm in MetaMask…");
      await unlist(cfg!, wallet, BigInt(it.creatureId));
      setNote("Unlisted ✓ The creature returns to you on Arkiv in a moment.");
    });

  return (
    <>
      <h1>Profile</h1>
      <dl className="facts">
        <dt>Wallet</dt>
        <dd>
          <code>{wallet}</code>
        </dd>
        <dt>Status</dt>
        <dd>✅ World ID verified human</dd>
      </dl>
      <button
        type="button"
        className="btn ghost"
        onClick={() => fetch("/api/logout", { method: "POST" }).finally(() => reloadTo("/"))}
      >
        Log out
      </button>

      <h2>My creatures</h2>
      {note && <p className="notice">{note}</p>}
      {error && <p className="error">{error}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">No creatures yet. Find one on the map!</p>}
      <div className="grid">
        {items?.map((it) => {
          const id = it.creatureId;
          const e = it.entity;
          const busyHere = busy.startsWith(`${id}:`);
          const code = codes[id];
          return (
            <div className="card" key={id}>
              <div className="row">
                <strong className={`r-${e.rarity}`}>{e.rarity}</strong>
                {STATUS[it.status] && <span className="badge">{STATUS[it.status]}</span>}
              </div>
              <div>
                <b>{e.businessName}</b>
              </div>
              <div className="muted">{e.discountDescription}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Creature <code>{id}</code>
              </div>
              {viewing === id ? <ModelViewer url={modelUrl(e.swarmReference)} height={180} /> : null}
              <button type="button" className="btn ghost" onClick={() => setViewing(viewing === id ? null : id)}>
                {viewing === id ? "Hide 3D" : "View 3D"}
              </button>

              {code && (
                <div>
                  Code: <span className="code">{code}</span>{" "}
                  <button type="button" className="btn ghost" onClick={() => void navigator.clipboard?.writeText(code).catch(() => null)}>
                    Copy
                  </button>
                </div>
              )}

              {it.status === "owned" && it.holding.redeemed && (
                <div className="actions">
                  <span className="badge">Redeemed</span>
                  {!code && (
                    <button type="button" className="btn" disabled={!!busy} onClick={() => void showCode(it)}>
                      {busy === `${id}:code` ? "Sign in MetaMask…" : "Show code"}
                    </button>
                  )}
                  {!e.redeemed && (
                    <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void syncRedeemed(it)}>
                      {busy === `${id}:sync` ? "Updating…" : "Update Arkiv (redeemed)"}
                    </button>
                  )}
                </div>
              )}

              {it.status === "owned" && !it.holding.redeemed && (
                <>
                  <div className="actions">
                    <button type="button" className="btn green" disabled={!!busy} onClick={() => void doRedeem(it)}>
                      {busy === `${id}:redeem` ? "Redeeming…" : "Redeem code"}
                    </button>
                    <button type="button" className="btn blue" disabled={!!busy} onClick={() => setSelling(selling === id ? null : id)}>
                      Sell
                    </button>
                  </div>
                  {selling === id && (
                    <div className="actions">
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="Price in ETH, e.g. 0.01"
                        value={prices[id] ?? ""}
                        onChange={(ev) => setPrices((p) => ({ ...p, [id]: ev.target.value }))}
                        aria-label="Price in ETH"
                      />
                      <button type="button" className="btn blue wide" disabled={!!busy || !(prices[id] ?? "").trim()} onClick={() => void doSell(it)}>
                        {busy === `${id}:sell` ? "Listing…" : "List on marketplace"}
                      </button>
                    </div>
                  )}
                </>
              )}

              {it.status === "listed" && (
                <div className="actions">
                  <span>
                    Price: <b>{formatEther(it.listing.price)} ETH</b>
                  </span>
                  <button type="button" className="btn" disabled={!!busy} onClick={() => void doUnlist(it)}>
                    {busy === `${id}:unlist` ? "Unlisting…" : "Unlist"}
                  </button>
                </div>
              )}

              {it.status === "escrow" && (
                <div className="actions">
                  <span className="muted" style={{ fontSize: 13 }}>
                    In the marketplace escrow but not listed on chain yet. Finish the listing, or it returns to you automatically.
                  </span>
                  <button type="button" className="btn blue" disabled={!!busy || e.price === null} onClick={() => void doFinish(it)}>
                    {busy === `${id}:finish` ? "Listing…" : `Finish listing${e.price !== null ? ` (${formatEther(e.price)} ETH)` : ""}`}
                  </button>
                </div>
              )}

              {busyHere && <span className="muted">Working…</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}
