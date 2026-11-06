"use client";

// One creature in range: everything about it (the discount code stays encrypted), its 3D model, and
// "Claim it": a human-verification ticket from this app's server, then CreatureMarket.claim in MetaMask.
// The contract re-checks the 50 m radius, that this is the campaign's next creature and one per campaign.
// Afterwards Arkiv follows: Auto settle -> the settler transfers it to you; Approval -> the business approves.

import { useState } from "react";
import type mapboxgl from "mapbox-gl";
import type { Address, Hex } from "viem";
import Modal from "@/components/Modal";
import ModelViewer from "@/components/ModelViewer";
import { modelUrl } from "@/lib/arkiv";
import { postJson } from "@/lib/codes";
import type { AppConfig } from "@/lib/config";
import { waitForArkivOwner, type MapSpawn } from "@/lib/creatures";
import { CLAIM_RADIUS_M, distanceM, toE6, withinClaimRadius } from "@/lib/geo";
import { claim } from "@/lib/market";
import { errorText } from "@/lib/metamask";

type Phase = "idle" | "ticket" | "confirm" | "mining" | "transferring" | "done-auto" | "done-approval" | "done-pending";

const LABEL: Record<Phase, string> = {
  idle: "Claim it",
  ticket: "Checking you're a verified human…",
  confirm: "Confirm in MetaMask…",
  mining: "Claiming on chain…",
  transferring: "Claimed ✓ Transferring it to you on Arkiv…",
  "done-auto": "It's yours!",
  "done-approval": "Claimed ✓",
  "done-pending": "Claimed ✓",
};

export default function ClaimModal({
  cfg,
  spawn,
  wallet,
  getPlayerPos,
  onClose,
  onChanged,
}: {
  cfg: AppConfig;
  spawn: MapSpawn;
  wallet: Address;
  getPlayerPos: () => mapboxgl.LngLat;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [tx, setTx] = useState<Hex | null>(null);
  const busy = phase === "ticket" || phase === "confirm" || phase === "mining" || phase === "transferring";
  const done = phase.startsWith("done");

  const here = getPlayerPos();
  const lat = toE6(here.lat);
  const lon = toE6(here.lng);
  const d = distanceM(lat, lon, spawn.latitudeE6, spawn.longitudeE6);
  const near = withinClaimRadius(lat, lon, spawn.latitudeE6, spawn.longitudeE6);

  const onClaim = async () => {
    setError("");
    const at = getPlayerPos(); // the contract checks this position against the campaign's spawn point
    try {
      setPhase("ticket");
      const ticket = await postJson<{ deadline: string; signature: Hex }>("/api/claim-ticket", { creatureId: spawn.nextCreatureId });
      setPhase("confirm");
      await claim(
        cfg,
        wallet,
        { creatureId: BigInt(spawn.nextCreatureId), latE6: toE6(at.lat), lonE6: toE6(at.lng), deadline: BigInt(ticket.deadline), signature: ticket.signature },
        (hash) => {
          setTx(hash);
          setPhase("mining");
        },
      );
      onChanged(); // this campaign disappears from your map
      if (spawn.mode === "approval") return setPhase("done-approval");
      setPhase("transferring");
      const moved = await waitForArkivOwner(cfg, spawn.nextCreatureId, wallet);
      setPhase(moved ? "done-auto" : "done-pending");
    } catch (e) {
      setPhase("idle");
      const msg = errorText(e);
      setError(msg);
      if (/claimed this creature|already have|been claimed|ended/.test(msg)) onChanged();
    }
  };

  const exp = spawn.expiresAt ? new Date(spawn.expiresAt * 1000).toLocaleDateString() : "never";
  return (
    <Modal title={spawn.businessName} onClose={busy ? () => {} : onClose}>
      <ModelViewer url={modelUrl(spawn.entity.swarmReference)} height={200} />
      <div className={`r-${spawn.rarity}`} style={{ fontSize: 22, fontWeight: 800, margin: "4px 0" }}>
        {spawn.rarity}
      </div>
      <dl className="facts">
        <dt>Reward</dt>
        <dd>{spawn.description}</dd>
        <dt>Discount code</dt>
        <dd>🔒 Encrypted until you redeem it</dd>
        <dt>Distance</dt>
        <dd>{Math.round(d)} m</dd>
        <dt>Campaign ends</dt>
        <dd>{exp}</dd>
        <dt>Creature</dt>
        <dd>
          <code>{spawn.nextCreatureId}</code>
        </dd>
      </dl>

      {phase === "done-auto" && <p className="notice">It&apos;s in your Profile. Redeem the code there, or sell it on the marketplace.</p>}
      {phase === "done-approval" && <p className="notice">Claimed on chain. {spawn.businessName} approves the transfer; it then appears in your Profile.</p>}
      {phase === "done-pending" && <p className="notice">Claimed on chain. The transfer on Arkiv is still running; it will appear in your Profile shortly.</p>}

      {!done && (
        <button type="button" className={`btn wide ${near ? "green" : ""}`} disabled={!near || busy} onClick={() => void onClaim()}>
          {near || busy ? LABEL[phase] : `Get within ${CLAIM_RADIUS_M} m to claim (${Math.ceil(d - CLAIM_RADIUS_M)} m more)`}
        </button>
      )}
      {done && (
        <button type="button" className="btn wide" onClick={onClose}>
          Done
        </button>
      )}
      {tx && (
        <p className="muted" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
          Transaction <code>{tx}</code>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
