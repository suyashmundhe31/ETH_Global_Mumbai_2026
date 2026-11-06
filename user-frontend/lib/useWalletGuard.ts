"use client";

// A session belongs to exactly one wallet: the one whose human passed World ID at login. On every logged-in
// page, if MetaMask switches to another account, locks, or isn't there, the session ends at once and the
// player is sent back to the login with the reason. Checked on load, on every account change, and whenever
// the tab comes back to the foreground (MetaMask mobile can switch accounts while the game is in the background).

import { useEffect, useState } from "react";

type Eth = {
  request: (a: { method: string }) => Promise<unknown>;
  on?: (e: string, cb: (accounts: string[]) => void) => void;
  removeListener?: (e: string, cb: (accounts: string[]) => void) => void;
};

export type EndReason = "wallet-changed" | "wallet-locked" | "no-wallet";

/** True once the connected wallet is confirmed to be the session's wallet. */
export function useWalletGuard(wallet: string | undefined) {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    const expected = wallet.toLowerCase();
    const eth = (window as unknown as { ethereum?: Eth }).ethereum;
    let ended = false;

    const end = async (reason: EndReason) => {
      if (ended) return;
      ended = true;
      setOk(false);
      await fetch("/api/logout", { method: "POST" }).catch(() => null);
      location.replace(`/?reason=${reason}`);
    };
    const check = (accounts: string[]) => {
      const current = accounts[0]?.toLowerCase();
      if (!current) return void end("wallet-locked");
      if (current !== expected) return void end("wallet-changed");
      setOk(true);
    };
    const recheck = () => {
      if (document.visibilityState !== "visible" || !eth) return;
      eth.request({ method: "eth_accounts" }).then((a) => check(a as string[]), () => end("wallet-locked"));
    };

    if (!eth) {
      void end("no-wallet");
      return;
    }
    recheck();
    eth.on?.("accountsChanged", check);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      eth.removeListener?.("accountsChanged", check);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [wallet]);

  return ok;
}
