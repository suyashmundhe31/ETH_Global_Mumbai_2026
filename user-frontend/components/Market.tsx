"use client";

// Marketplace: listed creatures of every other player. A listing only counts while its seller still
// owns the creature on chain and it isn't redeemed, so stale or fake listings never show.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { isAddressEqual, type Address } from "viem";
import { creatureRows, listedSellers } from "@/lib/arkiv";
import { RARITIES, ownersOf } from "@/lib/chain";
import Avatar, { shortAddr } from "@/components/Avatar";
import CreatureCard, { RARITY_ORDER, titleCase } from "@/components/CreatureCard";
import { IconAlert, IconCollection, IconMarket } from "@/components/icons";

async function fetchMarket(self: Address) {
  const sellers = await listedSellers();
  const ids = [...sellers.keys()].map(BigInt);
  const [owners, rows] = await Promise.all([ownersOf(ids, true), creatureRows(ids)]);
  return ids.flatMap((id, i) => {
    const seller = sellers.get(id.toString())!;
    const o = owners[i];
    return isAddressEqual(o.owner, seller) && !o.redeemed && !isAddressEqual(seller, self)
      ? [{ id, seller, float: o.float, rarity: rows.get(id.toString())?.rarity ?? RARITIES[o.rarity], row: rows.get(id.toString()) }]
      : [];
  });
}

export default function Market({ wallet }: { wallet: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchMarket>> | null>(null);
  const [error, setError] = useState("");
  const [rarity, setRarity] = useState("ALL");
  useEffect(() => {
    fetchMarket(wallet as Address).then(setItems, (e) => setError(e instanceof Error ? e.message.split("\n")[0] : String(e)));
  }, [wallet]);

  const shown = useMemo(
    () =>
      (items ?? [])
        .filter((i) => rarity === "ALL" || i.rarity === rarity)
        .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.float - a.float),
    [items, rarity],
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Creatures other hunters have put up for trade. Every listing is checked against on-chain ownership.</p>
        </div>
        <Link href="/profile" className="btn btn-secondary">
          <IconCollection />
          List from your collection
        </Link>
      </header>

      <div className="toolbar">
        <div className="filters" role="group" aria-label="Filter by rarity">
          {["ALL", ...RARITY_ORDER].map((r) => (
            <button key={r} type="button" aria-pressed={rarity === r} onClick={() => setRarity(r)}>
              {r === "ALL" ? "All" : titleCase(r)}
              <span className="count">{items ? (r === "ALL" ? items.length : items.filter((i) => i.rarity === r).length) : ""}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          <IconAlert />
          <span>Couldn&apos;t load the marketplace: {error}</span>
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
          <p>{items.length ? "Try another rarity filter." : "When hunters list creatures for trade, they show up here. You can list your own from your collection."}</p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid">
          {shown.map(({ id, seller, float, rarity: r, row }) => (
            <CreatureCard
              key={id.toString()}
              rarity={r}
              title={row?.businessName ?? `${titleCase(r)} creature`}
              offer={row?.description}
              modelUrl={row?.modelUrl}
              facts={[
                ["Float", <span key="f" className="mono">{float.toFixed(6)}</span>],
                ["Creature", `#${(id & BigInt(0xffffffff)).toString()}`],
                ["Campaign", (id >> BigInt(32)).toString()],
              ]}
            >
              <div className="seller" style={{ marginTop: "auto" }}>
                <Avatar address={seller} size={22} />
                Listed by <span className="num">{shortAddr(seller)}</span>
              </div>
            </CreatureCard>
          ))}
        </div>
      )}
    </>
  );
}
