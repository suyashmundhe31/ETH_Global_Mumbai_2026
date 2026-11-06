"use client";

import dynamic from "next/dynamic";
import { useWalletGuard } from "@/lib/useWalletGuard";

const GameMap = dynamic(() => import("@/components/GameMap"), { ssr: false });

// The game only starts once MetaMask is confirmed to be on the session's wallet (see useWalletGuard).
export default function MapClient({ wallet }: { wallet: string }) {
  const ok = useWalletGuard(wallet);
  return ok ? <GameMap wallet={wallet} /> : null;
}
