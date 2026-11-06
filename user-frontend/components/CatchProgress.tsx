"use client";

// The claim in flight: a human-verification ticket from this app's server (World ID), the wallet confirmation,
// CreatureMarket.claim on chain (it re-checks the 50 m radius, the campaign's next creature, one per campaign).
// Ends with the reveal (CatchReveal, which then follows the Arkiv transfer) or an error.

import { CATCH_RADIUS } from "@/lib/campaigns";
import { IconAlert, IconCheck } from "@/components/icons";

export type CatchPhase = "ticket" | "confirm" | "mining" | "caught";

const STEPS = [
  { title: "Checking you're human", detail: "World ID verified ticket for this creature" },
  { title: "Confirm in your wallet", detail: "Sign the claim on Base Sepolia" },
  { title: "Claiming on chain", detail: `CreatureMarket checks you are within ${CATCH_RADIUS} m` },
];

const STEP: Record<CatchPhase, number> = { ticket: 0, confirm: 1, mining: 2, caught: 3 };

export default function CatchProgress({
  phase,
  error,
  target,
  onClose,
}: {
  phase: CatchPhase | null;
  error: string;
  target: string;
  onClose: () => void;
}) {
  const current = phase ? STEP[phase] : 0;

  if (error) {
    return (
      <section className="catch-progress panel" role="alertdialog" aria-label="Catch result" data-outcome="failed">
        <div className="catch-progress-head">
          <span className="catch-orb" aria-hidden="true" />
          <div>
            <strong>Catch failed</strong>
            <span>{target}</span>
          </div>
        </div>
        <div className="notice notice-error">
          <IconAlert />
          <span>{humanError(error)}</span>
        </div>
        <div className="catch-result-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="catch-progress panel" role="status" aria-live="polite" aria-label="Catching">
      <div className="catch-progress-head">
        <span className="catch-orb" aria-hidden="true" />
        <div>
          <strong>Catching…</strong>
          <span>{target}</span>
        </div>
      </div>
      <ol className="steps">
        {STEPS.map((s, i) => {
          const state = i < current ? "done" : i === current ? "active" : "todo";
          return (
            <li key={s.title} className="step" data-state={state}>
              <span className="step-mark">{state === "done" ? <IconCheck /> : state === "active" ? <span className="spinner" /> : i + 1}</span>
              <span>
                {s.title}
                <small>{s.detail}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function humanError(msg: string) {
  if (/insufficient funds/i.test(msg)) return "Your wallet doesn't have enough Base Sepolia ETH for gas.";
  return msg;
}
