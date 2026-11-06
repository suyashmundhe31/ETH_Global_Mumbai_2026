"use client";

// Campaign markers (one per campaign within 1 km that canSpawnFor allows) + the on-chain catch panel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import mapboxgl from "mapbox-gl";
import { fetchCreaturesNear, type Creature } from "@/lib/arkiv";
import { CATCH_RADIUS, VISIBLE_RADIUS, visibleCampaigns, type Campaign } from "@/lib/campaigns";
import type { ARCatchOutcome } from "@/components/ARView";
import { RARITIES, catchCreature, chainConfigured, spawnableCampaigns, type CatchPhase, type Caught } from "@/lib/chain";
import type { Address } from "viem";
import { createCampaignModels } from "@/lib/campaignModels";
import ModelViewer from "@/components/ModelViewer";

// Tilt-driven AR camera (split screen when the phone is upright). Browser only.
const ARView = dynamic(() => import("@/components/ARView"), { ssr: false });

const REFETCH_MOVE = 300; // m — refetch when the player is this far from the last fetch centre
const REFETCH_EVERY = 60_000; // ms
const RETRY_AFTER = 15_000; // ms — back-off after a failed load (rate limits)
const FETCH_RADIUS = VISIBLE_RADIUS + REFETCH_MOVE; // covers the 1 km circle until the next refetch

const RARITY_COLOR: Record<string, string> = {
  COMMON: "#9aa4b2",
  RARE: "#3b82f6",
  EPIC: "#a855f7",
  LEGENDARY: "#f59e0b",
};

const FONT = "system-ui, sans-serif";

const CARD: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  transform: "translateX(-50%)",
  bottom: "calc(88px + env(safe-area-inset-bottom))",
  width: "min(360px, calc(100% - 32px))",
  boxSizing: "border-box",
  padding: 16,
  borderRadius: 16,
  background: "rgba(20, 24, 32, 0.92)",
  color: "#fff",
  fontFamily: FONT,
  fontSize: 15,
  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.4)",
};

const ACTION: React.CSSProperties = {
  width: "100%",
  minHeight: 48,
  marginTop: 12,
  border: "none",
  borderRadius: 12,
  fontFamily: FONT,
  fontSize: 16,
  fontWeight: 700,
  touchAction: "manipulation",
};

const PHASE_LABEL: Record<CatchPhase, string> = {
  clearing: "Expiring your timed-out attempt: confirm in MetaMask…",
  confirm: "Confirm in MetaMask…",
  verifying: "Verifying distance (Chainlink CRE)…",
  rolling: "Verified ✓ Rolling (Chainlink VRF)…",
  caught: "Caught!",
  missed: "It got away. Try again in a minute.",
  rejected: `CRE rejected the catch: get within ${CATCH_RADIUS} m.`,
  expired: "The attempt expired. Try again.",
};

const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

export default function Campaigns({
  map,
  getPlayerPos,
  wallet,
}: {
  map: mapboxgl.Map;
  getPlayerPos: () => mapboxgl.LngLat;
  wallet: string;
}) {
  const [pos, setPos] = useState(getPlayerPos);
  const [creatures, setCreatures] = useState<Creature[]>([]);
  const [spawnable, setSpawnable] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<CatchPhase | null>(null);
  const [catchError, setCatchError] = useState("");
  const [result, setResult] = useState<(Caught & { businessName: string; description: string; modelUrl: string }) | null>(null);
  const busy = phase === "clearing" || phase === "confirm" || phase === "verifying" || phase === "rolling";

  // Follow the player (GPS or dev-mode walking) without re-rendering on every frame.
  useEffect(() => {
    const t = setInterval(() => {
      const p = getPlayerPos();
      setPos((old) => (old.distanceTo(p) > 1 ? p : old));
    }, 500);
    return () => clearInterval(t);
  }, [getPlayerPos]);

  // Load creatures around the player; refetch after moving far or every minute.
  const fetchedAt = useRef<mapboxgl.LngLat | null>(null);
  // One load at a time, and after a failure wait RETRY_AFTER: the position ticks every 500 ms, and retrying
  // on each tick floods the public RPCs, which answer with 429s (that also break an in-flight catch).
  const loading = useRef(false);
  const retryAt = useRef(0);
  const load = useCallback(async (at: mapboxgl.LngLat) => {
    if (loading.current || Date.now() < retryAt.current) return;
    loading.current = true;
    fetchedAt.current = at;
    try {
      if (!chainConfigured) throw new Error("NEXT_PUBLIC_CATCH_MANAGER is not set");
      const list = await fetchCreaturesNear(at.lat, at.lng, FETCH_RADIUS);
      setSpawnable(await spawnableCampaigns(wallet as Address, [...new Set(list.map((c) => c.campaignId))]));
      setCreatures(list);
      setLoadError("");
    } catch (err) {
      console.error("Arkiv fetch failed", err);
      setLoadError("Couldn't load creatures. Retrying…");
      fetchedAt.current = null; // retry on the first tick after the back-off
      retryAt.current = Date.now() + RETRY_AFTER;
    } finally {
      loading.current = false;
    }
  }, [wallet]);

  useEffect(() => {
    if (!fetchedAt.current || fetchedAt.current.distanceTo(pos) > REFETCH_MOVE) void load(pos);
  }, [pos, load]);

  useEffect(() => {
    const t = setInterval(() => void load(getPlayerPos()), REFETCH_EVERY);
    return () => clearInterval(t);
  }, [load, getPlayerPos]);

  const campaigns = useMemo(() => visibleCampaigns(creatures, spawnable, pos), [creatures, spawnable, pos]);
  const dist = useCallback((c: { lngLat: mapboxgl.LngLat }) => c.lngLat.distanceTo(pos), [pos]);
  const nearest = useMemo(
    () => campaigns.reduce<(typeof campaigns)[number] | null>((a, c) => (!a || dist(c) < dist(a) ? c : a), null),
    [campaigns, dist],
  );
  // Tapped marker if it's still on the map, otherwise the nearest campaign.
  const selected = campaigns.find((c) => c.campaignId === selectedId) ?? nearest;

  // --- 3D creature models from Swarm, one per visible campaign (under the player layer) ---
  const models = useRef<ReturnType<typeof createCampaignModels> | null>(null);
  useEffect(() => {
    const m = createCampaignModels(map);
    map.addLayer(m.layer, map.getLayer("player") ? "player" : undefined);
    models.current = m;
    return () => {
      m.destroy();
      models.current = null;
      // GameMap may already have called map.remove() (its cleanup runs first on unmount), after which
      // getLayer() throws; the layer went with the map, so there's nothing left to remove.
      try {
        if (map.getLayer(m.layer.id)) map.removeLayer(m.layer.id);
      } catch {}
    };
  }, [map]);
  useEffect(() => {
    models.current?.set(campaigns.map((c) => ({ id: c.campaignId, lngLat: c.lngLat, url: c.modelUrl })));
  }, [campaigns]);

  // --- Markers: one per visible campaign, synced by campaignId ---
  const markers = useRef(new Map<string, { marker: mapboxgl.Marker; el: HTMLDivElement }>());
  useEffect(() => {
    const live = new Set(campaigns.map((c) => c.campaignId));
    for (const [id, m] of markers.current) {
      if (!live.has(id)) {
        m.marker.remove();
        markers.current.delete(id);
      }
    }
    for (const c of campaigns) {
      let m = markers.current.get(c.campaignId);
      if (!m) {
        const el = document.createElement("div");
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", `${c.businessName} campaign`);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          setSelectedId(c.campaignId);
        });
        m = { marker: new mapboxgl.Marker({ element: el, anchor: "bottom", offset: [0, -70] /* label floats above the model */ }).setLngLat(c.lngLat).addTo(map), el };
        markers.current.set(c.campaignId, m);
      }
      const inRange = dist(c) <= CATCH_RADIUS;
      const isSel = selected?.campaignId === c.campaignId;
      m.marker.setLngLat(c.lngLat);
      m.el.innerHTML = "";
      const pin = document.createElement("div");
      pin.textContent = `🐾 ${c.businessName} · ${c.remaining}`;
      Object.assign(pin.style, {
        padding: "6px 10px",
        borderRadius: "14px",
        background: inRange ? "#16a34a" : "rgba(20, 24, 32, 0.9)",
        color: "#fff",
        fontFamily: FONT,
        fontSize: "13px",
        fontWeight: "600",
        whiteSpace: "nowrap",
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        outline: isSel ? "2px solid #fff" : "none",
      });
      m.el.appendChild(pin);
    }
  }, [campaigns, selected, dist, map]);

  useEffect(() => {
    const all = markers.current;
    return () => {
      for (const m of all.values()) m.marker.remove();
      all.clear();
    };
  }, []);

  /** The on-chain catch. Shared by the map's Catch button and a tap on a creature in the AR camera. */
  const catchAt = async (target: Campaign): Promise<ARCatchOutcome> => {
    if (busy) return "failed";
    setCatchError("");
    const at = getPlayerPos(); // CRE checks this against the campaign's on-chain spawn point
    try {
      const caught = await catchCreature(wallet as Address, target.campaignId, at.lat, at.lng, setPhase);
      if (!caught) return "missed";
      const own = target.creatures.find((c) => c.creatureId === caught.creatureId.toString());
      setResult({ ...caught, businessName: target.businessName, description: target.discountDescription, modelUrl: own?.modelUrl ?? target.modelUrl });
      setSelectedId(null);
      void load(getPlayerPos()); // canSpawnFor is now false for this campaign
      return "caught";
    } catch (err) {
      setPhase(null);
      setCatchError(err instanceof Error ? err.message.split("\n")[0] : "Catch failed.");
      return "failed";
    }
  };
  const onCatch = () => {
    if (selected) void catchAt(selected);
  };

  const status = busy && phase ? PHASE_LABEL[phase] : catchError || (phase && phase !== "caught" ? PHASE_LABEL[phase] : "");
  return (
    <>
      {renderPanel()}
      <ARView
        map={map}
        campaign={selected}
        canCatch={!!selected && dist(selected) <= CATCH_RADIUS}
        distanceLabel={selected ? fmtDist(dist(selected)) : ""}
        status={status}
        onCatch={() => (selected ? catchAt(selected) : Promise.resolve("failed"))}
      />
    </>
  );

  // The map's bottom card: catch result, the selected campaign with its Catch button, or "nothing nearby".
  function renderPanel() {
  if (result) {
    const rarity = RARITIES[result.rarity] ?? "COMMON";
    const color = RARITY_COLOR[rarity];
    return (
      <div style={CARD} role="dialog" aria-label="Creature caught">
        <ModelViewer url={result.modelUrl} />
        <div style={{ fontSize: 13, opacity: 0.7 }}>Caught at {result.businessName}</div>
        <div style={{ margin: "6px 0 10px", fontSize: 24, fontWeight: 800, color }}>{rarity}</div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", alignItems: "baseline" }}>
          <span style={{ opacity: 0.7 }}>Float</span>
          <code style={{ fontSize: 15 }}>{result.float.toFixed(10)}</code>
          <span style={{ opacity: 0.7 }}>Code</span>
          <span>🔒 Redeem it from My creatures</span>
          <span style={{ opacity: 0.7 }}>Offer</span>
          <span>{result.description}</span>
        </div>
        <button
          type="button"
          style={{ ...ACTION, background: "transparent", color: "#fff", border: "1px solid #fff5" }}
          onClick={() => {
            setResult(null);
            setPhase(null);
          }}
        >
          Done
        </button>
      </div>
    );
  }

  if (!selected) {
    return (
      <div style={{ ...CARD, padding: "10px 16px", fontSize: 14, textAlign: "center", opacity: 0.9 }} aria-live="polite">
        {loadError || "No creatures within 1 km. Keep exploring!"}
      </div>
    );
  }

  const d = dist(selected);
  const canCatch = d <= CATCH_RADIUS;
  return (
    <div style={CARD} aria-live="polite">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <strong style={{ fontSize: 18 }}>{selected.businessName}</strong>
        <span style={{ opacity: 0.8 }}>{fmtDist(d)}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 14, opacity: 0.75 }}>
        {selected.discountDescription} · {selected.remaining} left
      </div>
      <button
        type="button"
        disabled={!canCatch || busy}
        onClick={onCatch}
        style={{
          ...ACTION,
          background: canCatch ? "#16a34a" : "#3a3f4a",
          color: canCatch ? "#fff" : "#aab",
          cursor: canCatch ? "pointer" : "not-allowed",
        }}
      >
        {busy && phase ? PHASE_LABEL[phase] : canCatch ? "Catch!" : `Get within ${CATCH_RADIUS} m (${fmtDist(d - CATCH_RADIUS)} more)`}
      </button>
      {!busy && phase && phase !== "caught" && <div style={{ marginTop: 8, fontSize: 14 }}>{PHASE_LABEL[phase]}</div>}
      {catchError && <div style={{ marginTop: 8, color: "#fca5a5", fontSize: 14 }}>{catchError}</div>}
    </div>
  );
  }
}
