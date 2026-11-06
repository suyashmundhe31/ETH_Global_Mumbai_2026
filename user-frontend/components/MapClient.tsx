"use client";

import dynamic from "next/dynamic";

// Mapbox and three.js need the browser.
const GameMap = dynamic(() => import("@/components/GameMap"), { ssr: false });

export default function MapClient({ wallet }: { wallet: `0x${string}` }) {
  return <GameMap wallet={wallet} />;
}
