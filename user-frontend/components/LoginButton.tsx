"use client";
import { useState } from "react";
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit";

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

export default function LoginButton() {
  const [open, setOpen] = useState(false);
  const [rp, setRp] = useState<RpContext | null>(null);
  const [wallet, setWallet] = useState("");
  const [proof, setProof] = useState({ message: "", message_tag: "", signature: "" });
  const [msg, setMsg] = useState("");
  // No injected wallet (e.g. Safari on iPhone): link that reopens this page inside the MetaMask app's browser.
  const [openInMetaMask, setOpenInMetaMask] = useState("");

  async function start() {
    setMsg("");
    try {
      const eth = (window as unknown as { ethereum?: Eth }).ethereum;
      if (!eth) {
        setOpenInMetaMask(`https://metamask.app.link/dapp/${location.host}${location.pathname}`);
        return setMsg("MetaMask not found in this browser. On a phone, open the game inside the MetaMask app:");
      }

      // 1. Connect MetaMask
      const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];

      // 2. Server challenge, then the wallet signs it (proves ownership)
      const s = await fetch("/api/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      }).then((r) => r.json());
      const signature = (await eth.request({ method: "personal_sign", params: [s.message, address] })) as string;

      // 3. Already verified wallet? Skip World ID and go to the logged-in page.
      const w = await fetch("/api/wallet-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, message: s.message, message_tag: s.message_tag, signature }),
      }).then((r) => r.json());
      if (w.registered) return void (location.href = "/");
      if (w.error) return setMsg(w.error);

      // 4. New wallet: World ID check, bound to this wallet
      setWallet(address.toLowerCase());
      setProof({ message: s.message, message_tag: s.message_tag, signature });
      setRp({ rp_id: process.env.NEXT_PUBLIC_WORLD_RP_ID!, nonce: s.nonce, created_at: s.created_at, expires_at: s.expires_at, signature: s.sig });
      setOpen(true);
    } catch (e) {
      console.error(e);
      const err = e as { code?: number; message?: string };
      setMsg(err.code === 4001 ? "Wallet request rejected" : `Error: ${err.message ?? e}`);
    }
  }

  return (
    <>
      <button onClick={start}>Connect wallet &amp; verify with World ID</button>
      <p>{msg}</p>
      {openInMetaMask && (
        <p>
          <a href={openInMetaMask}>🦊 Open in MetaMask</a>
        </p>
      )}
      {rp && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`}
          action="game-login"
          rp_context={rp}
          allow_legacy_proofs={true}
          environment={(process.env.NEXT_PUBLIC_WORLD_ENV ?? "production") as "production" | "staging"}
          preset={proofOfHuman({ signal: wallet })}
          handleVerify={async (result) => {
            const r = await fetch("/api/verify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ idkitResponse: result, address: wallet, ...proof }),
            });
            if (!r.ok) {
              setMsg((await r.json()).error);
              throw new Error("Backend verification failed");
            }
          }}
          onSuccess={() => location.reload()}
          onError={(code) => setMsg((m) => m || `Login failed: ${code}`)}
        />
      )}
    </>
  );
}