"use client";

// Spawns from Arkiv (one per campaign within 1 km that canSpawnFor allows): map markers + 3D models at the
// exact spot the business placed them, the encounter card, the AR camera and the on-chain catch flow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import mapboxgl from "mapbox-gl";
import type { Address } from "viem";
import { fetchCreaturesNear, type Creature } from "@/lib/arkiv";
import { CATCH_RADIUS, VISIBLE_RADIUS, visibleCampaigns, type Campaign } from "@/lib/campaigns";
import { RARITIES, catchCreature, chainConfigured, spawnableCampaigns, type CatchPhase, type Caught } from "@/lib/chain";
import { createCampaignModels } from "@/lib/campaignModels";
import type { Player } from "@/lib/player";
import type { Occlusion } from "@/lib/occlusion";
import type { ARCatchOutcome } from "@/components/ARView";
import CatchProgress from "@/components/CatchProgress";
import CatchReveal, { type Reveal } from "@/components/CatchReveal";
import { IconCamera, IconChevronSwap, IconPaw } from "@/components/icons";

// Camera AR. Browser only.
const ARView = dynamic(() => import("@/components/ARView"), { ssr: false });

const REFETCH_MOVE = 300; // m — refetch when the player is this far from the last fetch centre
const REFETCH_EVERY = 60_000; // ms
const RETRY_AFTER = 15_000; // ms — back-off after a failed load (rate limits)
const FETCH_RADIUS = VISIBLE_RADIUS + REFETCH_MOVE; // covers the 1 km circle until the next refetch
const MARKER_LIFT = -72; // px — the label floats above the hovering 3D model

const BUSY: CatchPhase[] = ["clearing", "confirm", "verifying", "rolling"];

export const fmtDist = (m: number) => (m < 1000 ? `${Math.max(0, Math.round(m))} m` : `${(m / 1000).toFixed(1)} km`);

const PAW_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12.5c-2.6 0-5 2.9-5 5 0 1.4 1 2 2.3 2 1 0 1.7-.6 2.7-.6s1.7.6 2.7.6c1.3 0 2.3-.6 2.3-2 0-2.1-2.4-5-5-5Z"/><ellipse cx="7" cy="9.5" rx="1.6" ry="2.1"/><ellipse cx="10.2" cy="6" rx="1.6" ry="2.1"/><ellipse cx="13.8" cy="6" rx="1.6" ry="2.1"/><ellipse cx="17" cy="9.5" rx="1.6" ry="2.1"/></svg>';

export default function Campaigns({
  map,
  player,
  occlusion,
  wallet,
  devMode,
  arOpen,
  setArOpen,
}: {
  map: mapboxgl.Map;
  player: Player;
  occlusion: Occlusion;
  wallet: string;
  devMode: boolean;
  arOpen: boolean;
  setArOpen: (open: boolean) => void;
}) {
  const getPlayerPos = player.getPosition;
  const [pos, setPos] = useState(getPlayerPos);
  const [creatures, setCreatures] = useState<Creature[]>([]);
  const [spawnable, setSpawnable] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<CatchPhase | null>(null);
  const [catchError, setCatchError] = useState("");
  const [catchTarget, setCatchTarget] = useState<string>("");
  const [result, setResult] = useState<Reveal | null>(null);
  const busy = phase !== null && BUSY.includes(phase);

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
  const load = useCallback(
    async (at: mapboxgl.LngLat) => {
      if (loading.current || Date.now() < retryAt.current) return;
      loading.current = true;
      fetchedAt.current = at;
      try {
        if (!chainConfigured) throw new Error("NEXT_PUBLIC_CATCH_MANAGER is not set");
        const list = await fetchCreaturesNear(at.lat, at.lng, FETCH_RADIUS);
        setSpawnable(await spawnableCampaigns(wallet as Address, [...new Set(list.map((c) => c.campaignId))]));
        setCreatures(list);
        setLoadError("");
        setLoaded(true);
      } catch (err) {
        console.warn("Arkiv fetch failed", err);
        setLoadError("Couldn't reach the creature network. Retrying shortly…");
        fetchedAt.current = null; // retry on the first tick after the back-off
        retryAt.current = Date.now() + RETRY_AFTER;
      } finally {
        loading.current = false;
      }
    },
    [wallet],
  );

  useEffect(() => {
    if (!fetchedAt.current || fetchedAt.current.distanceTo(pos) > REFETCH_MOVE) void load(pos);
  }, [pos, load]);

  useEffect(() => {
    const t = setInterval(() => void load(getPlayerPos()), REFETCH_EVERY);
    return () => clearInterval(t);
  }, [load, getPlayerPos]);

  const campaigns = useMemo(() => visibleCampaigns(creatures, spawnable, pos), [creatures, spawnable, pos]);
  const dist = useCallback((c: { lngLat: mapboxgl.LngLat }) => c.lngLat.distanceTo(pos), [pos]);
  const sorted = useMemo(() => [...campaigns].sort((a, b) => dist(a) - dist(b)), [campaigns, dist]);
  // Tapped marker if it's still on the map, otherwise the nearest campaign.
  const selected = campaigns.find((c) => c.id === selectedId) ?? sorted[0] ?? null;

  // --- 3D creature models from Swarm, one per spawn point at its exact Arkiv location (under the player) ---
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
    models.current?.set(campaigns.map((c) => ({ id: c.id, lngLat: c.lngLat, url: c.modelUrl })));
    // A creature placed inside a venue: flatten the building(s) at its spot so it stands there visibly.
    occlusion.setAnchors(campaigns.map((c) => c.lngLat));
  }, [campaigns, occlusion]);

  // --- Markers: one per spawn point, synced by spawn id ---
  type M = { marker: mapboxgl.Marker; el: HTMLDivElement; name: HTMLSpanElement };
  const markers = useRef(new Map<string, M>());
  useEffect(() => {
    const live = new Set(campaigns.map((c) => c.id));
    for (const [id, m] of markers.current) {
      if (!live.has(id)) {
        m.marker.remove();
        markers.current.delete(id);
      }
    }
    for (const c of campaigns) {
      let m = markers.current.get(c.id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "cm-marker";
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.innerHTML = `<div class="cm-marker-label">${PAW_SVG}<span class="cm-marker-name"></span></div><div class="cm-marker-dot"></div>`;
        const pick = (e: Event) => {
          e.stopPropagation();
          setSelectedId(c.id);
        };
        el.addEventListener("click", pick);
        el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && pick(e));
        const marker = new mapboxgl.Marker({ element: el, anchor: "bottom", offset: [0, MARKER_LIFT] }).setLngLat(c.lngLat).addTo(map);
        m = { marker, el, name: el.querySelector(".cm-marker-name")! };
        markers.current.set(c.id, m);
      }
      m.marker.setLngLat(c.lngLat);
            m.name.textContent = c.businessName;
      m.el.setAttribute("aria-label", `${c.businessName} creature, ${fmtDist(dist(c))} away`);
      m.el.dataset.inRange = String(dist(c) <= CATCH_RADIUS);
      m.el.dataset.selected = String(selected?.id === c.id);
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
    setCatchTarget(target.businessName);
    setSelectedId(target.id);
    const at = player.getFix(); // CRE checks the real position against the campaign's on-chain spawn point
    try {
      const caught: Caught | null = await catchCreature(wallet as Address, target.campaignId, at.lat, at.lng, setPhase);
      if (!caught) return "missed";
      const own = target.creatures.find((c) => c.creatureId === caught.creatureId.toString());
      navigator.vibrate?.([60, 40, 120]);
      setResult({
        creatureId: caught.creatureId,
        rarity: RARITIES[caught.rarity] ?? "COMMON",
        float: caught.float,
        businessName: target.businessName,
        description: target.discountDescription,
        modelUrl: own?.modelUrl ?? target.modelUrl,
      });
      setPhase(null);
      setSelectedId(null);
      void load(getPlayerPos()); // canSpawnFor is now false for this campaign
      return "caught";
    } catch (err) {
      setPhase(null);
      setCatchError(err instanceof Error ? err.message.split("\n")[0] : "Catch failed.");
      return "failed";
    }
  };

  const cycle = () => {
    if (sorted.length < 2 || !selected) return;
    const i = sorted.findIndex((c) => c.id === selected.id);
    const next = sorted[(i + 1) % sorted.length];
    setSelectedId(next.id);
  };

  const showProgress = busy || catchError !== "" || (phase !== null && phase !== "caught");
  const dismissProgress = () => {
    setPhase(null);
    setCatchError("");
  };

  return (
    <>
      {!arOpen && !showProgress && !result && (
        <div className="hud hud-bottom">
          {selected ? (
            <Encounter
              campaign={selected}
              distance={dist(selected)}
              count={sorted.length}
              onCycle={cycle}
              onCatch={() => void catchAt(selected)}
              onAR={devMode ? undefined : () => setArOpen(true)}
            />
          ) : (
            <div className="scan panel" aria-live="polite">
              <span className="scan-radar" aria-hidden="true" />
              <span>
                <strong>{loadError ? "Connection trouble" : loaded ? "No creatures nearby" : "Scanning the area…"}</strong>
                {loadError || (loaded ? `Nothing within ${VISIBLE_RADIUS / 1000} km yet. Keep exploring: new spawns appear as you move.` : "Looking for creatures within 1 km.")}
              </span>
            </div>
          )}
        </div>
      )}

      <ARView
        map={map}
        player={player}
        open={arOpen}
        setOpen={setArOpen}
        disabled={devMode}
        campaigns={sorted}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        busy={busy}
        onCatch={catchAt}
      />

      {showProgress && <CatchProgress phase={phase} error={catchError} target={catchTarget} onClose={dismissProgress} />}
      {result && <CatchReveal reveal={result} onClose={() => setResult(null)} />}
    </>
  );
}

function Encounter({
  campaign,
  distance,
  count,
  onCycle,
  onCatch,
  onAR,
}: {
  campaign: Campaign;
  distance: number;
  count: number;
  onCycle: () => void;
  onCatch: () => void;
  onAR?: () => void;
}) {
  const inRange = distance <= CATCH_RADIUS;
  // 0 at the edge of the visible circle, 1 inside the catch radius.
  const closeness = Math.min(1, Math.max(0.06, 1 - (distance - CATCH_RADIUS) / (VISIBLE_RADIUS - CATCH_RADIUS)));
  return (
    <section className="encounter panel" data-in-range={inRange} aria-live="polite" aria-label="Nearest creature">
      <div className="encounter-head">
        <span className="encounter-badge">
          <IconPaw />
        </span>
        <div className="encounter-title">
          <strong>{campaign.businessName}</strong>
          <span>{campaign.discountDescription}</span>
        </div>
      </div>
      <div className="encounter-label">{inRange ? "Creature in range!" : "Get closer to catch:"}</div>
      <div className="encounter-progress" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(closeness * 100)} aria-label="Distance to the creature">
        <span style={{ width: `${closeness * 100}%` }} />
        <b className="num">{inRange ? `${fmtDist(distance)} away` : `${fmtDist(distance - CATCH_RADIUS)} to go`}</b>
      </div>
      <div className="encounter-switch">
        {count > 1 && (
          <button type="button" className="icon-btn icon-btn-stone" aria-label="Next creature" onClick={onCycle}>
            <IconChevronSwap />
          </button>
        )}
        <button type="button" className="btn btn-primary btn-lg" disabled={!inRange} onClick={onCatch}>
          {inRange ? "Catch!" : "Too far"}
        </button>
        {onAR && (
          <button type="button" className="icon-btn" aria-label="Find it in AR" onClick={onAR}>
            <IconCamera />
          </button>
        )}
      </div>
    </section>
  );
}
