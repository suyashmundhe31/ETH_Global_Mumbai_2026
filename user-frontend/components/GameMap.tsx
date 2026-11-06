"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { createPlayer, type GpsStatus, type Player } from "@/lib/player";
import { createOcclusion, occludedPaint, type Occlusion } from "@/lib/occlusion";
import Campaigns from "@/components/Campaigns";
import { ROAD_OFFSETS, buildStreetlights } from "@/lib/streetlights";
import { drawFacade, facadeLighting, facadePixelRatio, lightPresetFor, type FacadeType, type LightPreset } from "@/lib/facades";
import Avatar from "@/components/Avatar";
import { ArtGear, IconAlert, IconCamera, IconClock, IconClose, IconLocate, IconMoon, IconSettings, IconSun, IconSunrise, IconSunset } from "@/components/icons";

type LightMode = "auto" | LightPreset;
const GREEN: mapboxgl.FilterSpecification = [
  "match", ["get", "class"], ["park", "wood", "scrub", "grass", "agriculture", "pitch", "cemetery"], true, false,
];
const MODES: { id: LightMode; label: string; Icon: typeof IconSun }[] = [
  { id: "auto", label: "Auto", Icon: IconClock },
  { id: "dawn", label: "Dawn", Icon: IconSunrise },
  { id: "day", label: "Day", Icon: IconSun },
  { id: "dusk", label: "Dusk", Icon: IconSunset },
  { id: "night", label: "Night", Icon: IconMoon },
];
const DEFAULT_PITCH = 60; // third-person view behind the character

export default function GameMap({ wallet }: { wallet: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<LightMode>("auto");
  const modeRef = useRef<LightMode>("auto");
  const applyPresetRef = useRef<((p: LightPreset) => void) | null>(null);
  // The game always starts on real GPS. Dev mode (free roam, no AR) is an explicit opt-in from Settings.
  const [devMode, setDevMode] = useState(false);
  const devModeRef = useRef(devMode);
  const [gps, setGps] = useState<GpsStatus>({ kind: "locating" });
  const [bearing, setBearing] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [arOpen, setArOpen] = useState(false);
  const [world, setWorld] = useState<{ map: mapboxgl.Map; player: Player; occlusion: Occlusion } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: process.env.NEXT_PUBLIC_MAPBOX_STYLE!,
      center: [72.8636, 19.0656], // Jio World Convention Centre, BKC, Mumbai (until the first GPS fix)
      zoom: 18.3,
      minZoom: 16,
      maxZoom: 21,
      pitch: DEFAULT_PITCH,
      maxPitch: 65,
      antialias: true,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");

    let alive = true;
    let clock: ReturnType<typeof setInterval> | undefined;
    let occlusion: ReturnType<typeof createOcclusion> | null = null;
    let player: Player | null = null;

    let bearingRaf = 0;
    map.on("rotate", () => {
      cancelAnimationFrame(bearingRaf);
      bearingRaf = requestAnimationFrame(() => setBearing(map.getBearing()));
    });

    const loadImage = (name: string, url: string) =>
      new Promise<void>((resolve, reject) =>
        map.loadImage(url, (err, img) => {
          if (err || !img) return reject(err);
          if (!map.hasImage(name)) map.addImage(name, img);
          resolve();
        })
      );

    const setBasemap = (key: string, value: string | boolean) => {
      try {
        map.setConfigProperty("basemap", key, value);
      } catch {
        // Custom styles without a "basemap" import don't support config properties.
      }
    };

    map.on("style.load", async () => {
      setBasemap("show3dObjects", true);
      // Our own textured buildings replace Standard's (landmark models would overlap them).
      setBasemap("show3dBuildings", false);
      setBasemap("show3dLandmarks", false);
      setBasemap("show3dTrees", true);
      setBasemap("showPointOfInterestLabels", false);

      let preset: LightPreset = modeRef.current === "auto" ? lightPresetFor() : modeRef.current;
      setBasemap("lightPreset", preset);

      try {
        await Promise.all([
          loadImage("grass", "/sprities/grass.png"),
          loadImage("water", "/sprities/water.png"),
        ]);
      } catch {
        return; // map removed or image missing
      }
      if (!alive) return;

      // "bottom" slot: above Standard's land/water, below roads and buildings.
      map.addLayer({
        id: "grass-texture",
        type: "background",
        slot: "bottom",
        paint: { "background-pattern": "grass" },
      });

      map.addSource("streets", { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" });

      // Areas Mapbox Standard already paints green keep its greenspace colours (no grass texture).
      map.addLayer({
        id: "greenspace",
        type: "fill",
        source: "streets",
        "source-layer": "landuse",
        slot: "bottom",
        filter: GREEN,
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "park", "hsl(115, 60%, 80%)",
            "wood", "hsl(115, 60%, 74%)",
            "pitch", "hsl(103, 70%, 86%)",
            "cemetery", "hsl(115, 50%, 84%)",
            "hsl(115, 60%, 87%)", // grass, scrub, agriculture
          ],
        },
      });

      // Beaches (and other sand) as beige land instead of grass.
      map.addLayer({
        id: "beach",
        type: "fill",
        source: "streets",
        "source-layer": "landuse",
        slot: "bottom",
        filter: ["==", ["get", "class"], "sand"],
        paint: { "fill-color": "#e9dcb8" },
      });

      map.addLayer({
        id: "water-texture",
        type: "fill",
        source: "streets",
        "source-layer": "water",
        slot: "bottom",
        paint: { "fill-pattern": "water" },
      });

      // --- 3D buildings ---
      // Dusk/night glow fades out as you zoom out (zoom 15 → 40%, zoom 17+ → full).
      const glow: mapboxgl.ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 15, 0.4, 17, 1];
      const height: mapboxgl.ExpressionSpecification = ["to-number", ["get", "height"], 0];
      // Buildings right next to the player go flat (see lib/occlusion.ts), so the avatar never clips into a wall.
      const occluded = occludedPaint(height);
      let tileZoom = Math.floor(map.getZoom());

      // One image per (type, zoom, lighting), created on first use. map.updateImage() can't be used:
      // already-loaded tiles miss the update, so switching the pattern name is what forces a redraw.
      const facadePattern = (): mapboxgl.ExpressionSpecification => {
        const lighting = facadeLighting(preset);
        const id = (type: FacadeType) => {
          const name = `facade-${type}-${tileZoom}-${lighting}`;
          if (!map.hasImage(name)) {
            map.addImage(name, drawFacade(type, tileZoom, lighting), { pixelRatio: facadePixelRatio(type, tileZoom) });
          }
          return name;
        };
        return ["step", height, id("plain"), 4, id("low"), 15, id("mid"), 60, id("high")];
      };

      const building = {
        source: "streets",
        "source-layer": "building",
        slot: "middle",
        minzoom: 15,
        filter: ["all", ["==", ["get", "extrude"], "true"], ["!=", ["get", "underground"], "true"]],
      } satisfies Partial<mapboxgl.FillExtrusionLayerSpecification>;

      map.addLayer({
        ...building,
        id: "building-walls",
        type: "fill-extrusion",
        paint: {
          "fill-extrusion-pattern": facadePattern(),
          ...occluded.walls,
          "fill-extrusion-emissive-strength": facadeLighting(preset) === "day" ? 0 : glow,
        },
      });
      // Terrace: thin plain grey concrete slab on top of the walls (hides the pattern on the roof).
      // Flattened buildings keep only this slab at ground level: a clean footprint on the map.
      map.addLayer({
        ...building,
        id: "building-terrace",
        type: "fill-extrusion",
        paint: occluded.terrace,
      });
      // Terrace border: 1 m parapet wall around the roof edge.
      map.addLayer({
        ...building,
        id: "building-parapet",
        type: "fill-extrusion",
        paint: {
          "fill-extrusion-color": "#8c8c88",
          "fill-extrusion-line-width": 0.4,
          ...occluded.parapet,
        },
      });

      // --- Street lamps ---
      const refLat = map.getCenter().lat;
      const pxPerMetre15 = (512 * 2 ** 15) / (40_075_016.686 * Math.cos((refLat * Math.PI) / 180));
      const lampsOn = () => facadeLighting(preset) !== "day";
      const part = (p: string): mapboxgl.FilterSpecification => ["==", ["get", "part"], p];

      map.addSource("streetlights", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "lamp-poles",
        type: "fill-extrusion",
        source: "streetlights",
        slot: "middle",
        minzoom: 15,
        filter: part("pole"),
        paint: {
          "fill-extrusion-color": "#5d6166",
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-height": ["get", "height"],
        },
      });
      map.addLayer({
        id: "lamp-heads",
        type: "fill-extrusion",
        source: "streetlights",
        slot: "middle",
        minzoom: 15,
        filter: part("head"),
        paint: {
          "fill-extrusion-color": "#fff1c9",
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-emissive-strength": lampsOn() ? 1 : 0,
        },
      });
      // Pool of warm light on the road under each lamp head (dusk/night only).
      map.addLayer({
        id: "lamp-glow",
        type: "circle",
        source: "streetlights",
        slot: "middle",
        minzoom: 15,
        filter: part("glow"),
        layout: { visibility: lampsOn() ? "visible" : "none" },
        paint: {
          // ~10 m radius on the ground at every zoom.
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 15, 10 * pxPerMetre15, 22, 10 * pxPerMetre15 * 128],
          "circle-color": "#ffcf7a",
          "circle-opacity": 0.55,
          "circle-blur": 1,
          "circle-pitch-alignment": "map",
          "circle-emissive-strength": 1,
        },
      });

      let lampTimer: ReturnType<typeof setTimeout> | undefined;
      const updateLamps = () => {
        clearTimeout(lampTimer);
        lampTimer = setTimeout(() => {
          if (!alive) return;
          const roads = map.querySourceFeatures("streets", {
            sourceLayer: "road",
            filter: ["all", ["match", ["get", "class"], Object.keys(ROAD_OFFSETS), true, false], ["==", ["get", "structure"], "none"]],
          });
          const buildings = map.querySourceFeatures("streets", { sourceLayer: "building" });
          (map.getSource("streetlights") as mapboxgl.GeoJSONSource).setData(buildStreetlights(roads, buildings, refLat));
        }, 300);
      };
      map.on("moveend", updateLamps);
      map.on("sourcedata", (e) => {
        if (e.sourceId === "streets" && e.isSourceLoaded) updateLamps();
      });

      // Switch facades when the integer zoom or the time of day changes.
      const refresh = () => {
        map.setPaintProperty("lamp-heads", "fill-extrusion-emissive-strength", lampsOn() ? 1 : 0);
        map.setLayoutProperty("lamp-glow", "visibility", lampsOn() ? "visible" : "none");
        map.setPaintProperty("building-walls", "fill-extrusion-pattern", facadePattern());
        // At dusk/night walls are pre-darkened and windows lit; emissive makes them ignore scene lighting → glow.
        map.setPaintProperty("building-walls", "fill-extrusion-emissive-strength", facadeLighting(preset) === "day" ? 0 : glow);
      };

      map.on("zoom", () => {
        const z = Math.floor(map.getZoom());
        if (z !== tileZoom) {
          tileZoom = z;
          refresh();
        }
      });

      applyPresetRef.current = (next) => {
        if (next === preset) return;
        preset = next;
        setBasemap("lightPreset", preset);
        refresh();
      };

      // In auto mode follow the device clock.
      clock = setInterval(() => {
        if (modeRef.current === "auto") applyPresetRef.current?.(lightPresetFor());
      }, 60_000);

      // --- Player avatar (three.js custom layer, drawn on top) ---
      player = createPlayer(map, { devMode: devModeRef.current, onStatus: setGps });
      map.addLayer(player.layer);
      occlusion = createOcclusion(map, player.getPosition);
      setWorld({ map, player, occlusion });
    });

    return () => {
      alive = false;
      applyPresetRef.current = null;
      clearInterval(clock);
      cancelAnimationFrame(bearingRaf);
      occlusion?.destroy();
      player?.destroy();
      setWorld(null);
      map.remove();
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
    applyPresetRef.current?.(mode === "auto" ? lightPresetFor() : mode);
  }, [mode]);

  useEffect(() => {
    devModeRef.current = devMode;
    world?.player.setDevMode(devMode);
  }, [devMode, world]);

  const changeDevMode = (on: boolean) => {
    setDevMode(on);
    if (on) setArOpen(false); // AR needs real GPS and a real camera: dev mode turns it off
  };

  const resetView = () => {
    if (!world) return;
    world.player.recenter();
    world.map.easeTo({ bearing: 0, pitch: DEFAULT_PITCH, duration: 450 });
  };

  const showLocating = !devMode && world && gps.kind !== "live" && gps.kind !== "dev";

  return (
    <>
      <div ref={containerRef} className="map-stage" />
      {world && (
        <Campaigns map={world.map} player={world.player} occlusion={world.occlusion} wallet={wallet} devMode={devMode} arOpen={arOpen} setArOpen={setArOpen} />
      )}

      <div className="hud hud-status" aria-live="polite">
        <span className="player-badge" aria-hidden="true">
          <Avatar address={wallet} size={40} />
        </span>
        <StatusChip gps={gps} />
      </div>

      <div className="hud hud-rail">
        <button type="button" className="gear-btn" aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>
          <ArtGear />
        </button>
        <button type="button" className="icon-btn icon-btn-stone" aria-label="Reset view to north" onClick={resetView} title="Reset view">
          <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)`, filter: "none" }}>
            <path d="M12 2.5 16 12H8l4-9.5Z" fill="#ff5d5d" stroke="#0b1630" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 21.5 8 12h8l-4 9.5Z" fill="#fff" stroke="#0b1630" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </button>
        {!devMode && (
          <button type="button" className="icon-btn icon-btn-yellow" aria-label="Open AR camera" onClick={() => setArOpen(true)} title="AR camera">
            <IconCamera />
          </button>
        )}
      </div>

      {showLocating && <Locating gps={gps} onDev={() => changeDevMode(true)} />}

      {settingsOpen && (
        <Settings
          mode={mode}
          setMode={setMode}
          devMode={devMode}
          setDevMode={changeDevMode}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}

function StatusChip({ gps }: { gps: GpsStatus }) {
  switch (gps.kind) {
    case "live":
      return (
        <span className="chip chip-live">
          <span className="chip-dot">
            <IconLocate />
          </span>
          GPS <span className="num">±{gps.accuracy} m</span>
        </span>
      );
    case "dev":
      return (
        <span className="chip chip-dev">
          <span className="chip-dot">
            <IconSettings />
          </span>
          Dev mode
        </span>
      );
    case "locating":
      return (
        <span className="chip chip-warn">
          <span className="chip-dot">
            <span className="spinner" />
          </span>
          Locating…
        </span>
      );
    default:
      return (
        <span className="chip chip-danger">
          <span className="chip-dot">
            <IconAlert />
          </span>
          Location off
        </span>
      );
  }
}

function Locating({ gps, onDev }: { gps: GpsStatus; onDev: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, []);
  const failed = gps.kind === "denied" || gps.kind === "unavailable";
  return (
    <div className="locating" role="status">
      <div className="locating-card panel">
        <div className="locating-pulse">
          <IconLocate />
        </div>
        {gps.kind === "denied" ? (
          <>
            <h2>Location access is off</h2>
            <p>Creatures spawn at real places, so the game needs your location. Allow location for this site in your browser settings, then reload.</p>
          </>
        ) : gps.kind === "unavailable" ? (
          <>
            <h2>No location fix</h2>
            <p>{gps.message} Move to an open area or check that location services are on.</p>
          </>
        ) : (
          <>
            <h2>Finding your location</h2>
            <p>{slow ? "Still searching. Step outside or near a window for a faster GPS fix." : "Hold on while we get a GPS fix."}</p>
          </>
        )}
        {failed && (
          <button type="button" className="btn btn-primary btn-block" onClick={() => location.reload()}>
            Try again
          </button>
        )}
        {(failed || slow) && (
          <button type="button" className="btn btn-secondary btn-block" onClick={onDev} style={{ marginTop: failed ? 12 : 16 }}>
            Explore in dev mode
          </button>
        )}
      </div>
    </div>
  );
}

function Settings({
  mode,
  setMode,
  devMode,
  setDevMode,
  onClose,
}: {
  mode: LightMode;
  setMode: (m: LightMode) => void;
  devMode: boolean;
  setDevMode: (on: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet panel" role="dialog" aria-label="Settings">
        <div className="sheet-title">
          <h2>Settings</h2>
          <button type="button" className="icon-btn icon-btn-stone" aria-label="Close settings" onClick={onClose} autoFocus>
            <IconClose />
          </button>
        </div>
        <div className="sheet-section">
          <span className="sheet-label">Time of day</span>
          <div className="segmented">
            {MODES.map(({ id, label, Icon }) => (
              <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="sheet-section">
          <label className="switch-row">
            <span>
              <strong>Dev mode</strong>
              <p>Roam freely without GPS. The AR camera is turned off while dev mode is on.</p>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
          </label>
          {devMode && (
            <div className="dev-keys">
              Tap or click the map to walk · <kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> move · <kbd>Shift</kbd> run · right-click to teleport
            </div>
          )}
        </div>
      </div>
    </>
  );
}
