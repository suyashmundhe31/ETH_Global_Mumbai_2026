// Street lamps along roads: pole on the kerb, arm reaching back over the road, lamp head
// above the lane. Positions are anchored to a world grid along each road segment so they
// stay put when panning (tiles clip roads differently, the crossings don't change).

import type { Feature, FeatureCollection, Position } from "geojson";

const LAMP_HEIGHT = 11; // m, pole height
const SPACING = 50; // m between consecutive lamps (alternating sides → 100 m per side)
const MIN_GAP = 25; // m, no two lamps closer than this (junctions, parallel roads)
const ARM = 3; // m, arm reach over the road
const M_PER_DEG_LAT = 110_540;

/** Kerb offset from road centreline in metres, by Mapbox Streets road class. */
export const ROAD_OFFSETS: Record<string, number> = { trunk: 11, primary: 9, secondary: 8, tertiary: 7, street: 5.5 };

type Rings = Position[][];

function inside([x, y]: Position, rings: Rings) {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

const polygons = (f: Feature): Rings[] =>
  f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [];

const lines = (f: Feature): Position[][] =>
  f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];

export function buildStreetlights(roads: Feature[], buildings: Feature[], refLat: number): FeatureCollection {
  const mx = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  const toM = ([lng, lat]: Position) => [lng * mx, lat * M_PER_DEG_LAT];
  const toLL = ([x, y]: number[]): Position => [x / mx, y / M_PER_DEG_LAT];

  // Buildings bucketed into 50 m cells for quick "is this point inside a building" tests.
  const CELL = 50;
  const cell = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const bIndex = new Map<string, Rings[]>();
  for (const f of buildings) {
    for (const rings of polygons(f)) {
      const pts = rings[0].map(toM);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(...ys) / CELL); cy <= Math.floor(Math.max(...ys) / CELL); cy++) {
          const k = `${cx},${cy}`;
          if (!bIndex.has(k)) bIndex.set(k, []);
          bIndex.get(k)!.push(rings);
        }
      }
    }
  }
  const inBuilding = (m: number[]) => (bIndex.get(cell(m[0], m[1])) ?? []).some((r) => inside(toLL(m), r));

  // Placed lamps bucketed for the MIN_GAP check.
  const placed = new Map<string, number[][]>();
  const tooClose = ([x, y]: number[]) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const near = placed.get(`${Math.floor(x / MIN_GAP) + dx},${Math.floor(y / MIN_GAP) + dy}`) ?? [];
        if (near.some(([px, py]) => Math.hypot(px - x, py - y) < MIN_GAP)) return true;
      }
    }
    return false;
  };

  // Rectangle centred at c, long side along unit vector u.
  const box = (c: number[], u: number[], len: number, wid: number): Position[] => {
    const [ax, ay] = [(u[0] * len) / 2, (u[1] * len) / 2];
    const [bx, by] = [(-u[1] * wid) / 2, (u[0] * wid) / 2];
    const ring = [
      [c[0] - ax - bx, c[1] - ay - by],
      [c[0] + ax - bx, c[1] + ay - by],
      [c[0] + ax + bx, c[1] + ay + by],
      [c[0] - ax + bx, c[1] - ay + by],
    ].map(toLL);
    return [...ring, ring[0]];
  };

  const features: Feature[] = [];
  const H = LAMP_HEIGHT;
  const poly = (part: string, ring: Position[], base: number, height: number): Feature => ({
    type: "Feature",
    properties: { part, base, height },
    geometry: { type: "Polygon", coordinates: [ring] },
  });

  for (const road of roads) {
    const offset = ROAD_OFFSETS[road.properties?.class as string] ?? 6;
    for (const line of lines(road)) {
      for (let i = 1; i < line.length; i++) {
        const a = toM(line[i - 1]);
        const b = toM(line[i]);
        const d = [b[0] - a[0], b[1] - a[1]];
        const len = Math.hypot(d[0], d[1]);
        if (len < 1) continue;
        const dir = [d[0] / len, d[1] / len];
        const normal = [-dir[1], dir[0]];

        // Lamp wherever the segment crosses a world-grid line on its dominant axis.
        const axis = Math.abs(d[0]) >= Math.abs(d[1]) ? 0 : 1;
        const [lo, hi] = [Math.min(a[axis], b[axis]), Math.max(a[axis], b[axis])];
        for (let k = Math.ceil(lo / SPACING); k * SPACING < hi; k++) {
          const t = (k * SPACING - a[axis]) / d[axis];
          const centre = [a[0] + d[0] * t, a[1] + d[1] * t];
          const side = k % 2 === 0 ? 1 : -1; // alternate sides of the road
          const toRoad = [-normal[0] * side, -normal[1] * side];
          const pole = [centre[0] + normal[0] * side * offset, centre[1] + normal[1] * side * offset];
          const head = [pole[0] + toRoad[0] * ARM, pole[1] + toRoad[1] * ARM];

          if (tooClose(pole) || inBuilding(pole) || inBuilding(head)) continue;
          const ck = `${Math.floor(pole[0] / MIN_GAP)},${Math.floor(pole[1] / MIN_GAP)}`;
          if (!placed.has(ck)) placed.set(ck, []);
          placed.get(ck)!.push(pole);

          const armMid = [pole[0] + (toRoad[0] * ARM) / 2, pole[1] + (toRoad[1] * ARM) / 2];
          features.push(
            poly("pole", box(pole, toRoad, 0.4, 0.4), 0, H),
            poly("pole", box(armMid, toRoad, ARM, 0.25), H - 0.5, H - 0.25),
            poly("head", box(head, toRoad, 1.2, 0.6), H - 0.8, H - 0.4),
            { type: "Feature", properties: { part: "glow" }, geometry: { type: "Point", coordinates: toLL(head) } },
          );
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}
