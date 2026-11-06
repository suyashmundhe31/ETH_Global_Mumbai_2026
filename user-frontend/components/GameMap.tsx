"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { createPlayer } from "@/lib/player";
import Spawns from "@/components/Spawns";
import { ROAD_OFFSETS, buildStreetlights } from "@/lib/streetlights";
import { drawFacade, facadeLighting, facadePixelRatio, lightPresetFor, type FacadeType, type LightPreset } from "@/lib/facades";

type LightMode = "auto" | LightPreset;
const GREEN: mapboxgl.FilterSpecification = [
  "match", ["get", "class"], ["park", "wood", "scrub", "grass", "agriculture", "pitch", "cemetery"], true, false,
];
const MODES: LightMode[] = ["auto", "dawn", "day", "dusk", "night"];
const LABELS: Record<LightMode, string> = { auto: "🕒 Auto", dawn: "🌅 Dawn", day: "☀️ Day", dusk: "🌇 Dusk", night: "🌙 Night" };

const BUTTON: React.CSSProperties = {
  position: "fixed",
  bottom: "calc(24px + env(safe-area-inset-bottom))",
  minHeight: 48,
  padding: "0 18px",
  border: "none",
  borderRadius: 24,
  background: "rgba(20, 24, 32, 0.85)",
  color: "#fff",
  font: "600 15px system-ui, sans-serif",
  boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
  touchAction: "manipulation",
};

export default function GameMap({ wallet }: { wallet: `0x${string}` }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<LightMode>("auto");
  const modeRef = useRef<LightMode>("auto");
  const applyPresetRef = useRef<((p: LightPreset) => void) | null>(null);
  // Dev mode (click map to walk) is on by default in `npm run dev`, off in production builds.
  const [devMode, setDevMode] = useState(process.env.NODE_ENV !== "production");
  const devModeRef = useRef(devMode);
  const playerRef = useRef<ReturnType<typeof createPlayer> | null>(null);
  const [world, setWorld] = useState<{ map: mapboxgl.Map; getPlayerPos: () => mapboxgl.LngLat } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: process.env.NEXT_PUBLIC_MAPBOX_STYLE!,
      center: [72.8636, 19.0656], // Jio World Convention Centre, BKC, Mumbai
      zoom: 17,
      minZoom: 15,
      maxZoom: 22,
      pitch: 55,
      maxPitch: 65,
      antialias: true,
    });

    let alive = true;
    let clock: ReturnType<typeof setInterval> | undefined;

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
          "fill-extrusion-height": height,
          "fill-extrusion-base": ["to-number", ["get", "min_height"], 0],
          "fill-extrusion-emissive-strength": facadeLighting(preset) === "day" ? 0 : glow,
        },
      });
      // Terrace: thin plain grey concrete slab on top of the walls (hides the pattern on the roof).
      map.addLayer({
        ...building,
        id: "building-terrace",
        type: "fill-extrusion",
        paint: {
          "fill-extrusion-color": "#a4a4a0",
          "fill-extrusion-base": height,
          "fill-extrusion-height": ["+", height, 0.2],
        },
      });
      // Terrace border: 1 m parapet wall around the roof edge.
      map.addLayer({
        ...building,
        id: "building-parapet",
        type: "fill-extrusion",
        paint: {
          "fill-extrusion-color": "#8c8c88",
          "fill-extrusion-line-width": 0.4,
          "fill-extrusion-base": height,
          "fill-extrusion-height": ["+", height, 1],
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
      const player = createPlayer(map, devModeRef.current);
      playerRef.current = player;
      map.addLayer(player.layer);
      setWorld({ map, getPlayerPos: player.getPosition });
    });

    return () => {
      alive = false;
      applyPresetRef.current = null;
      clearInterval(clock);
      playerRef.current?.destroy();
      playerRef.current = null;
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
    playerRef.current?.setDevMode(devMode);
  }, [devMode]);

  return (
    <>
      <div ref={containerRef} style={{ position: "fixed", inset: 0 }} />
      {world && <Spawns map={world.map} getPlayerPos={world.getPlayerPos} wallet={wallet} />}
      <button
        type="button"
        aria-label="Switch time of day"
        onClick={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])}
        style={{ ...BUTTON, right: "calc(16px + env(safe-area-inset-right))" }}
      >
        {LABELS[mode]}
      </button>
      <button
        type="button"
        aria-label="Toggle dev mode"
        aria-pressed={devMode}
        onClick={() => setDevMode((d) => !d)}
        style={{ ...BUTTON, left: "calc(16px + env(safe-area-inset-left))" }}
      >
        {devMode ? "🛠 Dev: tap to walk" : "📍 GPS"}
      </button>
    </>
  );
}
