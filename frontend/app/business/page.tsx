"use client";

// Business: "Settle catches" moves each caught creature's Arkiv entity (owned by this business wallet)
// to its on-chain owner and sets catched = true, in executeBatch chunks of 20. Safe to click again.

import { useState } from "react";
import type { Address } from "viem";
import { settleCatches } from "@/lib/arkiv";
import { caughtFromBusiness, chainConfigured } from "@/lib/chain";

export default function BusinessPage() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const say = (line: string) => setLog((l) => [...l, line]);

  const settle = async () => {
    setBusy(true);
    setLog([]);
    try {
      const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
      if (!eth) throw new Error("MetaMask not found");
      const [business] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      say(`Business wallet ${business}`);
      const caught = await caughtFromBusiness(business);
      say(`${caught.length} creature${caught.length === 1 ? "" : "s"} caught on chain`);
      const moved = await settleCatches(business, caught, (done, total) => say(`Settled ${done}/${total}`));
      say(moved ? `Done: ${moved} moved to their catchers on Arkiv` : "Nothing to settle: Arkiv is up to date");
    } catch (e) {
      say(`Failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}. Click again to finish.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "40px 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Business</h1>
      <p>Move caught creatures on Arkiv from your wallet to the players who caught them.</p>
      {!chainConfigured && <p style={{ color: "#b91c1c" }}>Set NEXT_PUBLIC_CATCH_MANAGER first.</p>}
      <button type="button" onClick={() => void settle()} disabled={busy || !chainConfigured} style={{ minHeight: 48, padding: "0 20px", fontSize: 16, fontWeight: 700 }}>
        {busy ? "Settling…" : "Settle catches"}
      </button>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </main>
  );
}
