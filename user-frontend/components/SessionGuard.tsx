"use client";

import { reloadTo } from "@/lib/nav";
import { useEffect, useState } from "react";

type Eth = {
  request: (a: { method: string }) => Promise<unknown>;
  on?: (e: string, cb: (accounts: string[]) => void) => void;
  removeListener?: (e: string, cb: (accounts: string[]) => void) => void;
};

/**
 * The session belongs to one verified wallet. If MetaMask is on any other account (or locked / missing), the
 * session ends and the player goes back to the World ID login.
 */
export default function SessionGuard({ wallet, children }: { wallet: string; children: React.ReactNode }) {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const eth = (window as unknown as { ethereum?: Eth }).ethereum;
    let done = false;
    const logout = async () => {
      if (done) return;
      done = true;
      setOk(false);
      await fetch("/api/logout", { method: "POST" }).catch(() => null);
      reloadTo("/");
    };
    const check = (accounts: string[]) => (accounts[0]?.toLowerCase() === wallet.toLowerCase() ? setOk(true) : void logout());
    if (!eth) {
      void logout();
      return;
    }
    eth.request({ method: "eth_accounts" }).then((a) => check(a as string[])).catch(logout);
    eth.on?.("accountsChanged", check);
    return () => eth.removeListener?.("accountsChanged", check);
  }, [wallet]);

  return ok ? <>{children}</> : null;
}
