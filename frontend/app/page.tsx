"use client";

import dynamic from "next/dynamic";

const GameMap = dynamic(() => import("@/components/GameMap"), { ssr: false });

export default function Home() {
  return <GameMap />;
}
