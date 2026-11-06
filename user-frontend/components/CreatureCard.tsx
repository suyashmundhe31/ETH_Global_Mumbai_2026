"use client";

// One creature tile, shared by the collection and the marketplace.

import { useEffect, useState } from "react";
import { thumbnail } from "@/lib/thumbnails";
import { IconPaw } from "@/components/icons";

export const RARITY_ORDER = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function CreatureThumb({ url }: { url?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    thumbnail(url).then(
      (s) => alive && setSrc(s),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  if (src) return <img src={src} alt="" />;
  return (
    <span className="creature-thumb-fallback" style={{ opacity: failed || !url ? 1 : 0.5 }}>
      <IconPaw />
    </span>
  );
}

export default function CreatureCard({
  rarity,
  title,
  offer,
  modelUrl,
  status,
  facts,
  children,
}: {
  rarity: string;
  title: string;
  offer?: string;
  modelUrl?: string;
  status?: React.ReactNode;
  facts: [string, React.ReactNode][];
  children?: React.ReactNode;
}) {
  const r = RARITY_ORDER.includes(rarity) ? rarity : "COMMON";
  return (
    <article className="creature-card" data-rarity={r}>
      <div className="creature-thumb">
        <CreatureThumb url={modelUrl} />
        <span className="rarity">{r}</span>
        {status}
      </div>
      <div className="creature-body">
        <div>
          <h3>{title}</h3>
          {offer && <p className="creature-offer">{offer}</p>}
        </div>
        <dl className="creature-facts">
          {facts.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {children}
      </div>
    </article>
  );
}
