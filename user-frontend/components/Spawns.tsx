"use client";

// Creatures on the map: one per business within 500 m (lib/creatures.ts loadSpawns), each its campaign's
// next creature. Tap one within 50 m to open the claim modal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import type { Address } from "viem";
import ClaimModal from "@/components/ClaimModal";
import { modelUrl } from "@/lib/arkiv";
import { createCampaignModels } from "@/lib/campaignModels";
import { loadConfig, type AppConfig } from "@/lib/config";
import { loadSpawns, type MapSpawn } from "@/lib/creatures";
import { CLAIM_RADIUS_M, distanceM, toE6, withinClaimRadius } from "@/lib/geo";
import { errorText } from "@/lib/metamask";

const REFETCH_MOVE_M = 50; // refetch after the player moved this far
const REFETCH_EVERY_MS = 30_000;
const RETRY_AFTER_MS = 15_000; // back-off after a failed load (public RPC rate limits)

const CARD: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  transform: "translateX(-50%)",
  bottom: "calc(88px + env(safe-area-inset-bottom))",
  width: "min(360px, calc(100% - 32px))",
  boxSizing: "border-box",
  padding: "12px 16px",
  borderRadius: 16,
  background: "rgba(20, 24, 32, 0.92)",
  color: "#fff",
  font: "15px system-ui, sans-serif",
  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.4)",
  textAlign: "center",
};

const fmt = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

export default function Spawns({ map, getPlayerPos, wallet }: { map: mapboxgl.Map; getPlayerPos: () => mapboxgl.LngLat; wallet: Address }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [pos, setPos] = useState(getPlayerPos);
  const [spawns, setSpawns] = useState<MapSpawn[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tooFar, setTooFar] = useState<string | null>(null);

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

  const fetchedAt = useRef<mapboxgl.LngLat | null>(null);
  const loading = useRef(false);
  const retryAt = useRef(0);
  const load = useCallback(
    async (at: mapboxgl.LngLat, force = false) => {
      if (!cfg || loading.current || (!force && Date.now() < retryAt.current)) return;
      loading.current = true;
      fetchedAt.current = at;
      try {
        setSpawns(await loadSpawns(cfg, wallet, at.lat, at.lng));
        setLoadError("");
        setLoaded(true);
      } catch (e) {
        console.warn("Loading creatures failed", e);
        setLoadError("Couldn't load creatures. Retrying…");
        fetchedAt.current = null;
        retryAt.current = Date.now() + RETRY_AFTER_MS;
      } finally {
        loading.current = false;
      }
    },
    [cfg, wallet],
  );

  useEffect(() => {
    if (!fetchedAt.current || fetchedAt.current.distanceTo(pos) > REFETCH_MOVE_M) void load(pos);
  }, [pos, load]);

  useEffect(() => {
    const t = setInterval(() => void load(getPlayerPos()), REFETCH_EVERY_MS);
    return () => clearInterval(t);
  }, [load, getPlayerPos]);

  const playerE6 = useMemo(() => ({ lat: toE6(pos.lat), lon: toE6(pos.lng) }), [pos]);
  const dist = useCallback((s: MapSpawn) => distanceM(playerE6.lat, playerE6.lon, s.latitudeE6, s.longitudeE6), [playerE6]);
  const inRange = useCallback((s: MapSpawn) => withinClaimRadius(playerE6.lat, playerE6.lon, s.latitudeE6, s.longitudeE6), [playerE6]);
  const selected = spawns.find((s) => s.campaignId === selectedId) ?? null;

  // --- 3D models from Swarm, one per spawn (under the player layer) ---
  const models = useRef<ReturnType<typeof createCampaignModels> | null>(null);
  useEffect(() => {
    const m = createCampaignModels(map);
    map.addLayer(m.layer, map.getLayer("player") ? "player" : undefined);
    models.current = m;
    return () => {
      m.destroy();
      models.current = null;
      try {
        if (map.getLayer(m.layer.id)) map.removeLayer(m.layer.id);
      } catch {} // the map may already be removed (GameMap cleanup runs first)
    };
  }, [map]);
  useEffect(() => {
    models.current?.set(
      spawns.map((s) => ({ id: s.campaignId, lngLat: new mapboxgl.LngLat(s.longitudeE6 / 1e6, s.latitudeE6 / 1e6), url: modelUrl(s.entity.swarmReference) })),
    );
  }, [spawns]);

  // --- Markers: business name only (never how many creatures a campaign has) ---
  const onTap = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    onTap.current = (id) => {
      const s = spawns.find((x) => x.campaignId === id);
      if (!s) return;
      if (inRange(s)) {
        setTooFar(null);
        setSelectedId(id);
      } else setTooFar(id);
    };
  }, [spawns, inRange]);
  const markers = useRef(new Map<string, { marker: mapboxgl.Marker; el: HTMLDivElement }>());
  useEffect(() => {
    const live = new Set(spawns.map((s) => s.campaignId));
    for (const [id, m] of markers.current) {
      if (!live.has(id)) {
        m.marker.remove();
        markers.current.delete(id);
      }
    }
    for (const s of spawns) {
      let m = markers.current.get(s.campaignId);
      const lngLat = new mapboxgl.LngLat(s.longitudeE6 / 1e6, s.latitudeE6 / 1e6);
      if (!m) {
        const el = document.createElement("div");
        el.setAttribute("role", "button");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onTap.current(s.campaignId);
        });
        m = { marker: new mapboxgl.Marker({ element: el, anchor: "bottom", offset: [0, -70] }).setLngLat(lngLat).addTo(map), el };
        markers.current.set(s.campaignId, m);
      }
      const near = inRange(s);
      m.marker.setLngLat(lngLat);
      m.el.setAttribute("aria-label", `${s.businessName} creature, ${near ? "in range" : "out of range"}`);
      m.el.textContent = `🐾 ${s.businessName}`;
      Object.assign(m.el.style, {
        padding: "6px 10px",
        borderRadius: "14px",
        background: near ? "#16a34a" : "rgba(20, 24, 32, 0.9)",
        color: "#fff",
        font: "600 13px system-ui, sans-serif",
        whiteSpace: "nowrap",
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      });
    }
  }, [spawns, inRange, map]);

  useEffect(() => {
    const all = markers.current;
    return () => {
      for (const m of all.values()) m.marker.remove();
      all.clear();
    };
  }, []);

  const far = spawns.find((s) => s.campaignId === tooFar);
  const nearest = spawns.reduce<MapSpawn | null>((a, s) => (!a || dist(s) < dist(a) ? s : a), null);

  return (
    <>
      {selected && cfg && (
        <ClaimModal
          cfg={cfg}
          spawn={selected}
          wallet={wallet}
          getPlayerPos={getPlayerPos}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load(getPlayerPos(), true)}
        />
      )}
      {!selected && (
        <div style={CARD} aria-live="polite">
          {loadError ? (
            loadError
          ) : far ? (
            <>
              <b>{far.businessName}</b> is {fmt(dist(far))} away. Get within {CLAIM_RADIUS_M} m to claim it.
            </>
          ) : !loaded ? (
            "Looking for creatures nearby…"
          ) : nearest ? (
            inRange(nearest) ? (
              <>
                <b>{nearest.businessName}</b> is right here: tap it to claim!
              </>
            ) : (
              <>
                Nearest: <b>{nearest.businessName}</b> · {fmt(dist(nearest))}
              </>
            )
          ) : (
            "No creatures within 500 m. Keep exploring!"
          )}
        </div>
      )}
    </>
  );
}
