"use client";

// Spawns (lib/creatures.ts loadSpawns): Arkiv creature entities near the player, each verified on chain and
// shown as its campaign's NEXT creature on CreatureMarket, one per business within 500 m. Map markers + 3D
// models at the campaign's spawn point, the encounter card, the AR camera and the claim flow:
//   claim ticket (this app's server, World ID) -> CreatureMarket.claim (MetaMask) -> Arkiv entity -> player.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import mapboxgl from "mapbox-gl";
import type { Address, Hex } from "viem";
import { CATCH_RADIUS, VISIBLE_RADIUS, toCampaign, type Campaign } from "@/lib/campaigns";
import { postJson } from "@/lib/codes";
import { loadConfig, type AppConfig } from "@/lib/config";
import { loadSpawns, waitForArkivOwner, type MapSpawn } from "@/lib/creatures";
import { distanceM, toE6, withinClaimRadius } from "@/lib/geo";
import { claim } from "@/lib/market";
import { errorText } from "@/lib/metamask";
import { createCampaignModels } from "@/lib/campaignModels";
import type { Player } from "@/lib/player";
import type { Occlusion } from "@/lib/occlusion";
import type { ARCatchOutcome } from "@/components/ARView";
import CatchProgress, { type CatchPhase } from "@/components/CatchProgress";
import CatchReveal, { type Reveal } from "@/components/CatchReveal";
import { IconCamera, IconChevronSwap, IconPaw } from "@/components/icons";

// Camera AR. Browser only.
const ARView = dynamic(() => import("@/components/ARView"), { ssr: false });

const REFETCH_MOVE = 75; // m — refetch when the player is this far from the last fetch centre
const REFETCH_EVERY = 30_000; // ms — someone else may have claimed the next creature
const RETRY_AFTER = 15_000; // ms — back-off after a failed load (rate limits)
const MARKER_LIFT = -72; // px — the label floats above the hovering 3D model

const BUSY: CatchPhase[] = ["ticket", "confirm", "mining"];

/** Distance with CreatureMarket's own formula (lib/geo.ts), so "in range" means the contract will accept it. */
const contractDist = (a: mapboxgl.LngLat, s: MapSpawn) => distanceM(toE6(a.lat), toE6(a.lng), s.latitudeE6, s.longitudeE6);

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
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [spawns, setSpawns] = useState<MapSpawn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<CatchPhase | null>(null);
  const [catchError, setCatchError] = useState("");
  const [catchTarget, setCatchTarget] = useState<string>("");
  const [result, setResult] = useState<Reveal | null>(null);
  const busy = phase !== null && BUSY.includes(phase);

  // Deployment config (contract addresses, Arkiv network) from this app's server.
  useEffect(() => {
    loadConfig().then(setCfg, (e) => setLoadError(errorText(e)));
  }, []);

  // Follow the player (GPS or dev-mode walking) without re-rendering on every frame.
  useEffect(() => {
    const t = setInterval(() => {
      const p = getPlayerPos();
      setPos((old) => (old.distanceTo(p) > 1 ? p : old));
    }, 500);
    return () => clearInterval(t);
  }, [getPlayerPos]);

  // Load creatures around the player; refetch after moving, and periodically (the next creature changes
  // whenever someone claims one).
  const fetchedAt = useRef<mapboxgl.LngLat | null>(null);
  // One load at a time, and after a failure wait RETRY_AFTER: the position ticks every 500 ms, and retrying
  // on each tick floods the public RPCs, which answer with 429s (that also break an in-flight catch).
  const loading = useRef(false);
  const retryAt = useRef(0);
  const load = useCallback(
    async (at: mapboxgl.LngLat, force = false) => {
      if (!cfg || loading.current || (!force && Date.now() < retryAt.current)) return;
      loading.current = true;
      fetchedAt.current = at;
      try {
        setSpawns(await loadSpawns(cfg, wallet as Address, at.lat, at.lng));
        setLoadError("");
        setLoaded(true);
      } catch (err) {
        console.warn("Loading creatures failed", err);
        setLoadError("Couldn't reach the creature network. Retrying shortly…");
        fetchedAt.current = null; // retry on the first tick after the back-off
        retryAt.current = Date.now() + RETRY_AFTER;
      } finally {
        loading.current = false;
      }
    },
    [cfg, wallet],
  );

  useEffect(() => {
    if (!fetchedAt.current || fetchedAt.current.distanceTo(pos) > REFETCH_MOVE) void load(pos);
  }, [pos, load]);

  useEffect(() => {
    const t = setInterval(() => void load(getPlayerPos()), REFETCH_EVERY);
    return () => clearInterval(t);
  }, [load, getPlayerPos]);

  // Spawns were picked around the last fetch point; keep only those still within reach of where we are now.
  const allCampaigns = useMemo(() => spawns.map(toCampaign), [spawns]);
  const campaigns = useMemo(() => allCampaigns.filter((c) => contractDist(pos, c.spawn) <= VISIBLE_RADIUS), [allCampaigns, pos]);
  const dist = useCallback((c: Campaign) => contractDist(pos, c.spawn), [pos]);
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

  /**
   * The claim. Shared by the map's Catch button and a tap on a creature in the AR camera.
   * CreatureMarket.claim re-checks everything (ticket, 50 m, next creature, one per campaign, expiry); the
   * transaction is simulated first, so a revert reason shows before MetaMask opens.
   */
  const catchAt = async (target: Campaign): Promise<ARCatchOutcome> => {
    if (busy || !cfg) return "failed";
    const s = target.spawn;
    setCatchError("");
    setCatchTarget(target.businessName);
    setSelectedId(target.id);
    const at = player.getFix(); // the contract checks this real position against the campaign's spawn point
    const latE6 = toE6(at.lat);
    const lonE6 = toE6(at.lng);
    try {
      if (!withinClaimRadius(latE6, lonE6, s.latitudeE6, s.longitudeE6)) {
        throw new Error(`You are ${Math.round(contractDist(at, s))} m away: get within ${CATCH_RADIUS} m of the creature.`);
      }
      setPhase("ticket");
      const ticket = await postJson<{ deadline: string; signature: Hex }>("/api/claim-ticket", { creatureId: s.nextCreatureId });
      setPhase("confirm");
      await claim(
        cfg,
        wallet as Address,
        { creatureId: BigInt(s.nextCreatureId), latE6, lonE6, deadline: BigInt(ticket.deadline), signature: ticket.signature },
        () => setPhase("mining"),
      );
      navigator.vibrate?.([60, 40, 120]);
      setResult({
        creatureId: BigInt(s.nextCreatureId),
        rarity: s.rarity,
        businessName: target.businessName,
        description: target.discountDescription,
        modelUrl: target.modelUrl,
        arkiv: s.mode === "approval" ? "approval" : "transferring",
        entityKey: s.entity.key,
      });
      setPhase(null);
      setSelectedId(null);
      void load(getPlayerPos(), true); // this campaign leaves the map (one creature per player per campaign)
      if (s.mode === "auto") {
        // The settler moves the Arkiv entity to the player once it sees the claim.
        void waitForArkivOwner(cfg, s.nextCreatureId, wallet as Address).then((moved) =>
          setResult((r) => (r && r.creatureId === BigInt(s.nextCreatureId) ? { ...r, arkiv: moved ? "arrived" : "pending" } : r)),
        );
      }
      return "caught";
    } catch (err) {
      setPhase(null);
      const msg = errorText(err);
      setCatchError(msg);
      // Someone else claimed it / the campaign changed: refresh what the map shows.
      if (/claimed this creature|already have|been claimed|ended|not active/.test(msg)) void load(getPlayerPos(), true);
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
              <strong>{loadError ? "Connection trouble…" : loaded ? "No creatures nearby" : "Scanning…"}</strong>
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
      <span className="encounter-badge" aria-hidden="true">
        <IconPaw />
      </span>
      <div className="encounter-title">
        <strong>{campaign.businessName}</strong>
        <span className="num">{inRange ? "In range · tap Catch" : `${fmtDist(distance)} away`}</span>
        <span className="encounter-progress" aria-hidden="true">
          <span style={{ width: `${closeness * 100}%` }} />
        </span>
      </div>
      {count > 1 && (
        <button type="button" className="icon-btn icon-btn-stone encounter-mini" aria-label="Next creature" onClick={onCycle}>
          <IconChevronSwap />
        </button>
      )}
      {onAR && (
        <button type="button" className="icon-btn encounter-mini" aria-label="Find it in AR" onClick={onAR}>
          <IconCamera />
        </button>
      )}
      <button type="button" className="btn btn-primary encounter-catch" disabled={!inRange} onClick={onCatch} title={campaign.discountDescription}>
        {inRange ? "Catch!" : "Far"}
      </button>
    </section>
  );
}
