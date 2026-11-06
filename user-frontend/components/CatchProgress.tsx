"use client";

// The catch in flight: wallet confirmation, then Chainlink CRE verifies the distance, then Chainlink VRF
// rolls the rarity. Ends with the reveal (CatchReveal) or one of the misses below.

import type { CatchPhase } from "@/lib/chain";
import { CATCH_RADIUS } from "@/lib/campaigns";
import { IconAlert, IconCheck } from "@/components/icons";

const STEPS = [
  { title: "Confirm in your wallet", detail: "Sign the catch request" },
  { title: "Verifying your location", detail: `Chainlink CRE checks you are within ${CATCH_RADIUS} m` },
  { title: "Rolling rarity", detail: "Chainlink VRF picks your creature" },
];

const stepOf = (p: CatchPhase | null) => (p === "clearing" || p === "confirm" ? 0 : p === "verifying" ? 1 : p === "rolling" ? 2 : p === "caught" ? 3 : 0);

const OUTCOME: Partial<Record<CatchPhase, { title: string; text: string }>> = {
  missed: { title: "It got away", text: "The creature slipped out at the last second. Try again in a minute." },
  rejected: { title: "Too far to catch", text: `The location check failed. Get within ${CATCH_RADIUS} m of the spawn and try again.` },
  expired: { title: "Attempt expired", text: "The catch took too long to settle. Try again." },
};

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
  const outcome = phase ? OUTCOME[phase] : undefined;
  const failed = !!error || !!outcome;
  const current = stepOf(phase);

  if (failed) {
    return (
      <section className="catch-progress panel" role="alertdialog" aria-label="Catch result" data-outcome={error ? "failed" : "missed"}>
        <div className="catch-progress-head">
          <span className="catch-orb" aria-hidden="true" />
          <div>
            <strong>{error ? "Catch failed" : outcome!.title}</strong>
            <span>{target}</span>
          </div>
        </div>
        <div className={error ? "notice notice-error" : "notice"}>
          <IconAlert />
          <span>{error ? humanError(error) : outcome!.text}</span>
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
                {i === 0 && phase === "clearing" ? "Clearing your timed-out attempt" : s.title}
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
  if (/user rejected|denied|4001/i.test(msg)) return "You rejected the request in your wallet. Nothing was sent.";
  if (/insufficient funds/i.test(msg)) return "Your wallet doesn't have enough Base Sepolia ETH for gas.";
  return msg;
}
