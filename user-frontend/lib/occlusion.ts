// Buildings flatten to their footprint where something must stay visible:
//   - around the player: within HIDE_WITHIN metres (rising again past SHOW_BEYOND, so standing on the
//     boundary doesn't make a building flicker), so the avatar never clips into a wall;
//   - at creature spawns: any building containing a spawn point or within SPAWN_CLEAR metres of it, so a
//     creature placed inside a venue stands visibly at its exact Arkiv location instead of inside the walls.
//
// Fast path: feature-state `near` on the Mapbox Streets building features (a paint-only change, no tile
// re-layout). Fallback when the tiles carry no feature ids: a `distance` filter on the extrusion layers plus
// a flat footprint layer.

import mapboxgl from "mapbox-gl";

export const HIDE_WITHIN = 18; // m — building goes flat
export const SHOW_BEYOND = 26; // m — building stands up again
export const SPAWN_CLEAR = 12; // m — around each creature spawn
const CHECK_EVERY = 200; // ms
const MOVE_EPS = 0.75; // m — re-check after moving this far (or when new tiles arrive)

type Expr = mapboxgl.ExpressionSpecification;
const NEAR: Expr = ["boolean", ["feature-state", "near"], false];

/** Paint values for the building layers: flat when the feature is `near`. */
export function occludedPaint(height: Expr) {
  const minHeight: Expr = ["to-number", ["get", "min_height"], 0];
  return {
    walls: {
      "fill-extrusion-height": ["case", NEAR, 0, height] as Expr,
      "fill-extrusion-base": ["case", NEAR, 0, minHeight] as Expr,
    },
    terrace: {
      "fill-extrusion-base": ["case", NEAR, 0, height] as Expr,
      "fill-extrusion-height": ["case", NEAR, 0.12, ["+", height, 0.2]] as Expr,
      "fill-extrusion-color": ["case", NEAR, "#b9bab4", "#a4a4a0"] as Expr,
    },
    parapet: {
      "fill-extrusion-base": ["case", NEAR, 0, height] as Expr,
      "fill-extrusion-height": ["case", NEAR, 0, ["+", height, 1]] as Expr,
    },
  };
}

const LAYERS = ["building-walls", "building-terrace", "building-parapet"];
const M_PER_DEG = 111_320;

/** Metres from `p` to a (multi)polygon: 0 inside, else the distance to the nearest edge. */
function distanceToPolygon(p: mapboxgl.LngLat, geom: GeoJSON.Geometry): number {
  const kx = M_PER_DEG * Math.cos((p.lat * Math.PI) / 180);
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  let best = Infinity;
  for (const rings of polys) {
    let inside = false;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = (ring[j][0] - p.lng) * kx, ay = (ring[j][1] - p.lat) * M_PER_DEG;
        const bx = (ring[i][0] - p.lng) * kx, by = (ring[i][1] - p.lat) * M_PER_DEG;
        // Even-odd crossing test (holes toggle it back).
        if (ay > 0 !== by > 0 && 0 < ((bx - ax) * -ay) / (by - ay) + ax) inside = !inside;
        // Distance from the origin to segment a-b.
        const dx = bx - ax, dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
    if (inside) return 0;
  }
  return best;
}

export function createOcclusion(map: mapboxgl.Map, getPos: () => mapboxgl.LngLat) {
  let hidden = new Map<string | number, true>();
  let anchors: mapboxgl.LngLat[] = []; // creature spawn points
  let mode: "state" | "filter" | null = null;
  let lastPos: mapboxgl.LngLat | null = null;
  let dirty = true;
  let filterPos: mapboxgl.LngLat | null = null;
  const baseFilters = new Map<string, mapboxgl.FilterSpecification | undefined>();

  const onData = (e: mapboxgl.MapSourceDataEvent) => {
    if (e.sourceId === "streets" && e.isSourceLoaded) dirty = true;
  };
  map.on("sourcedata", onData);

  const setNear = (id: string | number, near: boolean) => {
    try {
      map.setFeatureState({ source: "streets", sourceLayer: "building", id }, { near });
    } catch {}
  };

  // Fallback: no feature ids, so hide by distance filter and draw flat footprints instead.
  const applyDistanceFilters = (p: mapboxgl.LngLat) => {
    const pt: GeoJSON.MultiPoint = { type: "MultiPoint", coordinates: [p, ...anchors].map((q) => [q.lng, q.lat]) };
    const far: mapboxgl.FilterSpecification = [">=", ["distance", pt], HIDE_WITHIN];
    for (const id of LAYERS) {
      if (!map.getLayer(id)) continue;
      if (!baseFilters.has(id)) baseFilters.set(id, map.getFilter(id) ?? undefined);
      const base = baseFilters.get(id);
      map.setFilter(id, base ? ["all", base, far] : far);
    }
    if (!map.getLayer("building-footprint-near")) {
      map.addLayer(
        {
          id: "building-footprint-near",
          type: "fill",
          source: "streets",
          "source-layer": "building",
          slot: "middle",
          minzoom: 15,
          paint: { "fill-color": "#b9bab4", "fill-outline-color": "#8c8c88" },
          filter: ["<", ["distance", pt], HIDE_WITHIN],
        },
        "building-walls",
      );
    } else {
      map.setFilter("building-footprint-near", ["<", ["distance", pt], HIDE_WITHIN]);
    }
    filterPos = p;
  };

  const check = () => {
    if (!map.isStyleLoaded() || !map.getLayer("building-walls")) return;
    const p = getPos();
    if (!dirty && lastPos && lastPos.distanceTo(p) < MOVE_EPS) return;
    lastPos = p;
    dirty = false;

    if (mode === "filter") {
      // Filters re-layout tiles, so only refresh them after a real move.
      if (!filterPos || filterPos.distanceTo(p) > 3) applyDistanceFilters(p);
      return;
    }

    const features = map.querySourceFeatures("streets", { sourceLayer: "building" });
    const next = new Map<string | number, true>();
    for (const f of features) {
      if (f.id === undefined || f.id === null) {
        if (mode === null) {
          mode = "filter";
          for (const id of hidden.keys()) setNear(id, false);
          hidden.clear();
          applyDistanceFilters(p);
          return;
        }
        continue;
      }
      if (next.has(f.id)) continue;
      const g = f.geometry;
      const first = g.type === "Polygon" ? g.coordinates[0]?.[0] : g.type === "MultiPolygon" ? g.coordinates[0]?.[0]?.[0] : null;
      if (!first) continue;
      // Cheap reject: a building more than ~300 m from a point can't be within any clearing radius.
      const near = (q: mapboxgl.LngLat) => Math.abs(first[1] - q.lat) * M_PER_DEG < 300 && Math.abs(first[0] - q.lng) * M_PER_DEG < 330;
      const limit = hidden.has(f.id) ? SHOW_BEYOND : HIDE_WITHIN;
      if (near(p) && distanceToPolygon(p, g) < limit) next.set(f.id, true);
      else if (anchors.some((a) => near(a) && distanceToPolygon(a, g) < SPAWN_CLEAR)) next.set(f.id, true);
    }
    if (features.length) mode = "state";
    for (const id of hidden.keys()) if (!next.has(id)) setNear(id, false);
    for (const id of next.keys()) if (!hidden.has(id)) setNear(id, true);
    hidden = next;
  };

  const timer = setInterval(check, CHECK_EVERY);

  return {
    /** Creature spawn points: buildings at and around them go flat. */
    setAnchors(points: mapboxgl.LngLat[]) {
      const same = points.length === anchors.length && points.every((q, i) => q.lng === anchors[i].lng && q.lat === anchors[i].lat);
      if (same) return;
      anchors = points;
      dirty = true;
      filterPos = null;
    },
    /** Re-check now (e.g. after a teleport). */
    refresh() {
      dirty = true;
      check();
    },
    destroy() {
      clearInterval(timer);
      map.off("sourcedata", onData);
    },
  };
}

export type Occlusion = ReturnType<typeof createOcclusion>;
