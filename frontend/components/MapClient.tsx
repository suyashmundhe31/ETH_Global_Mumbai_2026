"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const GameMap = dynamic(() => import("@/components/GameMap"), { ssr: false });

type Eth = {
  request: (a: { method: string }) => Promise<unknown>;
  on?: (e: string, cb: (accounts: string[]) => void) => void;
  removeListener?: (e: string, cb: (accounts: string[]) => void) => void;
};

// The session belongs to one wallet. If MetaMask is on any other account
// (or locked / missing), end the session and send the player back to login.
export default function MapClient({ wallet }: { wallet: string }) {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const eth = (window as unknown as { ethereum?: Eth }).ethereum;
    let done = false;
    const logout = async () => {
      if (done) return;
      done = true;
      setOk(false);
      await fetch("/api/logout", { method: "POST" }).catch(() => null);
      location.reload();
    };
    const check = (accounts: string[]) =>
      accounts[0]?.toLowerCase() === wallet ? setOk(true) : logout();

    if (!eth) {
      logout();
      return;
    }
    eth.request({ method: "eth_accounts" }).then((a) => check(a as string[])).catch(logout);
    eth.on?.("accountsChanged", check);
    return () => eth.removeListener?.("accountsChanged", check);
  }, [wallet]);

  return ok ? <GameMap wallet={wallet} /> : null;
}
