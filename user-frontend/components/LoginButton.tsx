"use client";

// World ID login (IDKit v4). Only a verified human gets a session:
//   1. connect MetaMask and sign a server challenge (proves the wallet),
//   2. a wallet already linked to a verified human logs straight in,
//   3. otherwise World ID's proof-of-human request, bound to this wallet (signal = wallet), verified on the
//      server against World's API. Anything that fails shows the "Unverified" pop-up.

import { reloadTo } from "@/lib/nav";
import { useState } from "react";
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit";
import Modal from "@/components/Modal";

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

// IDKit error codes that mean "not a verified human" (vs. a technical failure).
const UNVERIFIED_CODES = new Set([
  "verification_rejected",
  "credential_unavailable",
  "max_verifications_reached",
  "failed_by_host_app",
  "nullifier_replayed",
  "user_presence_failed",
  "identity_attributes_not_matched",
]);

export default function LoginButton() {
  const [open, setOpen] = useState(false);
  const [rp, setRp] = useState<RpContext | null>(null);
  const [wallet, setWallet] = useState("");
  const [proof, setProof] = useState({ message: "", message_tag: "", signature: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState<string | null>(null);

  async function start() {
    setMsg("");
    setBusy(true);
    try {
      const eth = (window as unknown as { ethereum?: Eth }).ethereum;
      if (!eth) return setMsg("MetaMask not found. Install it to play.");

      // 1. Connect MetaMask
      const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];

      // 2. Server challenge, then the wallet signs it (proves ownership)
      const s = await fetch("/api/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      }).then((r) => r.json());
      if (s.error) return setMsg(s.error);
      const signature = (await eth.request({ method: "personal_sign", params: [s.message, address] })) as string;

      // 3. Already verified wallet? Straight in.
      const w = await fetch("/api/wallet-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, message: s.message, message_tag: s.message_tag, signature }),
      }).then((r) => r.json());
      if (w.registered) return void reloadTo("/");
      if (w.error) return setMsg(w.error);

      // 4. New wallet: World ID proof of human, bound to this wallet
      setWallet(address.toLowerCase());
      setProof({ message: s.message, message_tag: s.message_tag, signature });
      setRp({ rp_id: process.env.NEXT_PUBLIC_WORLD_RP_ID!, nonce: s.nonce, created_at: s.created_at, expires_at: s.expires_at, signature: s.sig });
      setOpen(true);
    } catch (e) {
      console.warn(e);
      const err = e as { code?: number; message?: string };
      setMsg(err.code === 4001 ? "Wallet request rejected" : `Error: ${err.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn green wide" onClick={start} disabled={busy}>
        {busy ? "Waiting for MetaMask…" : "Connect wallet & verify with World ID"}
      </button>
      {msg && <p className="error">{msg}</p>}
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
              const body = await r.json().catch(() => ({}));
              if (body.unverified) setUnverified(body.error || "World ID could not verify you.");
              else setMsg(body.error || "Verification failed");
              throw new Error("Backend verification failed");
            }
          }}
          onSuccess={() => {
            reloadTo("/");
          }}
          onError={(code) => {
            if (UNVERIFIED_CODES.has(code)) setUnverified((u) => u ?? "World ID could not verify you as a unique human.");
            else if (code !== "user_rejected") setMsg((m) => m || `Login failed: ${code}`);
          }}
        />
      )}
      {unverified && (
        <Modal title="Unverified" onClose={() => setUnverified(null)}>
          <p>Only World ID verified humans can play.</p>
          <p className="muted">{unverified}</p>
          <button type="button" className="btn wide" onClick={() => setUnverified(null)}>
            OK
          </button>
        </Modal>
      )}
    </>
  );
}
