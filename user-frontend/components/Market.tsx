"use client";

// Marketplace: listed creatures of every other player. A listing only counts while its seller still
// owns the creature on chain and it isn't redeemed, so stale or fake listings never show.

import { useEffect, useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { creatureRows, listedSellers } from "@/lib/arkiv";
import { RARITIES, ownersOf } from "@/lib/chain";

async function fetchMarket(self: Address) {
  const sellers = await listedSellers();
  const ids = [...sellers.keys()].map(BigInt);
  const [owners, rows] = await Promise.all([ownersOf(ids, true), creatureRows(ids)]);
  return ids.flatMap((id, i) => {
    const seller = sellers.get(id.toString())!;
    const o = owners[i];
    return isAddressEqual(o.owner, seller) && !o.redeemed && !isAddressEqual(seller, self)
      ? [{ id: id.toString(), seller, rarity: rows.get(id.toString())?.rarity ?? RARITIES[o.rarity], row: rows.get(id.toString()) }]
      : [];
  });
}

export default function Market({ wallet }: { wallet: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchMarket>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchMarket(wallet as Address).then(setItems, (e) => setError(String(e)));
  }, [wallet]);

  if (error) return <p>{error}</p>;
  if (!items) return <p>Loading…</p>;
  if (!items.length) return <p>Nothing listed right now.</p>;
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
      {items.map(({ id, seller, rarity, row }) => (
        <div key={id} style={{ padding: 12, borderRadius: 12, border: "1px solid #ffffff2a" }}>
          <strong>{rarity}</strong> · {row?.businessName ?? "?"}
          <div>ID {id} · campaign {(BigInt(id) >> BigInt(32)).toString()}</div>
          <div style={{ opacity: 0.75 }}>{row?.description}</div>
          <div style={{ opacity: 0.75 }}>seller {seller.slice(0, 6)}…{seller.slice(-4)}</div>
        </div>
      ))}
    </div>
  );
}
