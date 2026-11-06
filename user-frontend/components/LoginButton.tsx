"use client";

// Login = the game's trust moment. Creatures are scarce, real-world rewards: one human must not farm them with
// many wallets. So every session needs:
//   1. the wallet: it signs a one-time server challenge (proves ownership of the address);
//   2. World ID Proof of Human (IDKit), with the wallet address as the signal, verified on the server
//      (/api/verify -> developer.world.org). Proof of Human is the minimum sufficient credential: we only need
//      "a unique real person", not their name, age or nationality, so nothing personal is shared.
//   3. one human <-> one wallet: the World ID nullifier is linked to the first wallet that used it. Another
//      wallet with the same World ID, or this wallet with another World ID, is declined.
// Alternative paths handled on screen: no wallet, wallet request rejected, World ID cancelled, no World ID
// credential, proof rejected, World ID / wallet already linked elsewhere, session ended by a wallet switch.

import { useEffect, useRef, useState } from "react";
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit";
import { IconAlert, IconCheck, IconShield, IconWallet } from "@/components/icons";

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
type Step = "idle" | "connect" | "sign" | "verify" | "done";
type Msg = { tone: "error" | "info"; text: string } | null;

const ENDED: Record<string, string> = {
  "wallet-changed": "You switched to a different wallet, so your session ended. Sign in again with the wallet linked to your World ID.",
  "wallet-locked": "Your wallet was locked or disconnected, so your session ended. Unlock it and sign in again.",
  "no-wallet": "No wallet was found in this browser, so your session ended.",
};

/** What the player sees for an IDKit error code (docs.world.org/world-id/idkit/error-codes). */
function idkitMessage(code: string): Msg {
  switch (code) {
    case "user_rejected":
    case "verification_rejected":
    case "cancelled":
      return { tone: "info", text: "Verification cancelled. World ID is required to play: it keeps rewards fair, one per real person." };
    case "credential_unavailable":
    case "world_id_4_not_available":
    case "world_id_3_not_available":
      return { tone: "error", text: "Your World ID doesn't have a Proof of Human yet. Get verified in World App, then come back." };
    case "max_verifications_reached":
    case "nullifier_replayed":
      return { tone: "error", text: "This World ID has reached its verification limit for this game." };
    case "invalid_network":
      return { tone: "error", text: "World App is on a different network (staging vs production) than this game." };
    case "timeout":
    case "connection_failed":
    case "inclusion_proof_pending":
      return { tone: "error", text: "World ID took too long to answer. Check your connection and try again." };
    case "failed_by_host_app":
      return null; // our server already explained why (set in handleVerify)
    default:
      return { tone: "error", text: `World ID verification failed (${code}). Please try again.` };
  }
}

export default function LoginButton() {
  const [open, setOpen] = useState(false);
  const [rp, setRp] = useState<RpContext | null>(null);
  const [wallet, setWallet] = useState("");
  const [proof, setProof] = useState({ message: "", message_tag: "", signature: "" });
  const [msg, setMsg] = useState<Msg>(null);
  const [step, setStep] = useState<Step>("idle");
  const [known, setKnown] = useState(false);
  // No injected wallet (e.g. Safari on iPhone): link that reopens this page inside the MetaMask app's browser.
  const [openInMetaMask, setOpenInMetaMask] = useState("");
  const verified = useRef(false);
  const errored = useRef(false);

  // Why the last session ended (sent by useWalletGuard), shown once, then removed from the address bar.
  useEffect(() => {
    const reason = new URLSearchParams(location.search).get("reason");
    if (!reason || !ENDED[reason]) return;
    history.replaceState(null, "", location.pathname);
    const t = setTimeout(() => setMsg({ tone: "info", text: ENDED[reason] }), 0);
    return () => clearTimeout(t);
  }, []);

  async function start() {
    setMsg(null);
    verified.current = false;
    errored.current = false;
    try {
      const eth = (window as unknown as { ethereum?: Eth }).ethereum;
      if (!eth) {
        setOpenInMetaMask(`https://metamask.app.link/dapp/${location.host}${location.pathname}`);
        return setMsg({ tone: "error", text: "No wallet found in this browser. On a phone, open the game inside the MetaMask app." });
      }

      // 1. Connect the wallet.
      setStep("connect");
      const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!address) throw new Error("No account selected");

      // 2. Sign the server's one-time challenge (proves the wallet is yours).
      setStep("sign");
      const s = await fetch("/api/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      }).then((r) => r.json());
      if (s.error) throw new Error(s.error);
      const signature = (await eth.request({ method: "personal_sign", params: [s.message, address] })) as string;

      const w = await fetch("/api/wallet-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, message: s.message, message_tag: s.message_tag, signature }),
      }).then((r) => r.json());
      if (w.error) throw new Error(w.error);
      if (w.registered) return void (location.href = "/"); // testing mode only (SKIP_WORLD_ID)

      // 3. World ID Proof of Human, bound to this wallet (signal = address), every session.
      setKnown(!!w.known);
      setWallet(address.toLowerCase());
      setProof({ message: s.message, message_tag: s.message_tag, signature });
      setRp({ rp_id: process.env.NEXT_PUBLIC_WORLD_RP_ID!, nonce: s.nonce, created_at: s.created_at, expires_at: s.expires_at, signature: s.sig });
      setStep("verify");
      setOpen(true);
    } catch (e) {
      console.warn(e);
      const err = e as { code?: number; message?: string };
      setStep("idle");
      setMsg({
        tone: err.code === 4001 ? "info" : "error",
        text: err.code === 4001 ? "You declined the wallet request. Nothing was shared; try again when you're ready." : err.message?.split("\n")[0] || "Couldn't connect your wallet.",
      });
    }
  }

  // Widget closed without a verified proof and without an error code: the player closed it.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next || verified.current) return;
    setStep("idle");
    if (!errored.current) setMsg((m) => m ?? idkitMessage("cancelled"));
  };

  const busy = step !== "idle";
  const label =
    step === "connect" ? "Connect your wallet…" : step === "sign" ? "Sign in your wallet…" : step === "verify" ? "Verify with World ID…" : step === "done" ? "Starting the game…" : "Connect wallet & verify";
  const order: Step[] = ["connect", "sign", "verify", "done"];
  const at = order.indexOf(step);

  return (
    <>
      <ol className="login-progress" aria-label="Sign-in steps">
        {(["connect", "sign", "verify"] as const).map((s, i) => {
          const state = step === "idle" ? "todo" : i < at ? "done" : i === at ? "active" : "todo";
          return (
            <li key={s} data-state={state}>
              <span className="login-progress-mark">{state === "done" ? <IconCheck /> : i + 1}</span>
              {s === "connect" ? "Wallet" : s === "sign" ? "Sign" : "World ID"}
            </li>
          );
        })}
      </ol>

      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={start} disabled={busy}>
        {busy ? <span className="spinner" /> : <IconWallet />}
        {label}
      </button>
      <p className="login-fineprint">
        <IconShield />
        <span>
          {known && step === "verify"
            ? "Welcome back. Confirm it's still you: this wallet only opens for the human it's linked to."
            : "One human, one wallet. World ID proves you're a unique person without sharing who you are."}
        </span>
      </p>

      {msg && (
        <div className={msg.tone === "error" ? "notice notice-error login-msg" : "notice login-msg"} role={msg.tone === "error" ? "alert" : "status"}>
          <IconAlert />
          <span>{msg.text}</span>
        </div>
      )}
      {openInMetaMask && (
        <a href={openInMetaMask} className="btn btn-secondary btn-block" style={{ marginTop: 10 }}>
          Open in the MetaMask app
        </a>
      )}
      {rp && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={onOpenChange}
          app_id={process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`}
          action="game-login"
          rp_context={rp}
          allow_legacy_proofs={true}
          environment={(process.env.NEXT_PUBLIC_WORLD_ENV ?? "production") as "production" | "staging"}
          preset={proofOfHuman({ signal: wallet })}
          handleVerify={async (result) => {
            // The server re-checks the wallet signature, the signal binding, the proof (with World) and the
            // one-human-one-wallet link. Never trust the client result alone.
            const r = await fetch("/api/verify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ idkitResponse: result, address: wallet, ...proof }),
            });
            if (!r.ok) {
              const body = await r.json().catch(() => ({}));
              errored.current = true;
              setMsg({ tone: "error", text: body.error || "Verification failed. Please try again." });
              throw new Error("Backend verification failed");
            }
          }}
          onSuccess={() => {
            verified.current = true;
            setStep("done");
            location.href = "/";
          }}
          onError={(code) => {
            errored.current = true;
            setStep("idle");
            const m = idkitMessage(String(code));
            if (m) setMsg(m);
          }}
        />
      )}
    </>
  );
}
