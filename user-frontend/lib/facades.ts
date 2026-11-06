// Procedural building facades for fill-extrusion-pattern.
//
// Mapbox maps wall patterns in screen pixels at the current integer zoom, so a fixed image
// would halve in real size every zoom level. Each image is redrawn per integer zoom with 2^(20-z)
// window bays per side, so one bay always spans the same real-world floor height.

export type FacadeType = "plain" | "low" | "mid" | "high";
export type LightPreset = "dawn" | "day" | "dusk" | "night";
type Lighting = "day" | "dusk" | "night";

const SIZE = 256;

const STYLES: Record<
  FacadeType,
  { floor: number; wall: string; brick: boolean; frame: string; glass: string; w: number; h: number }
> = {
  // Small sheds/walls (< 4 m): brick, too short for windows → no cut-outs.
  plain: { floor: 3.5, wall: "#cbbfae", brick: true, frame: "", glass: "", w: 0, h: 0 },
  // Small buildings (4–15 m): brick with painted frames, small windows, wide wall gaps.
  low: { floor: 3.2, wall: "#cbbfae", brick: true, frame: "#e6dfd2", glass: "#6d8594", w: 0.34, h: 0.42 },
  // Offices (15–60 m): concrete, medium windows.
  mid: { floor: 3.6, wall: "#bab9b3", brick: false, frame: "#6e6f70", glass: "#5a7285", w: 0.48, h: 0.46 },
  // Towers (60 m+): dark steel, large glass panels.
  high: { floor: 4.0, wall: "#4e5a66", brick: false, frame: "#2f3740", glass: "#8cadc6", w: 0.7, h: 0.6 },
};

const BRICKS = ["#9c4a32", "#a8553a", "#8f4330", "#b05f43", "#96503a"];
const LIT = ["#ffd88a", "#ffe6b0", "#ffc96b", "#fff1cf"];
const UNLIT = "#1a222c";
const SILL = "#d9d3c7";

/** Wall brightness and share of lit windows per lighting. Walls are pre-darkened because the
 *  building layer is emissive at dusk/night (ignores scene light) so lit windows glow. */
const LIGHT = {
  day: { wall: 1, lit: 0 },
  dusk: { wall: 0.5, lit: 40 },
  night: { wall: 0.2, lit: 65 },
};

export const facadeLighting = (p: LightPreset): Lighting => (p === "night" ? "night" : p === "dusk" ? "dusk" : "day");

/** pixelRatio that makes 2 bays = 2 floors at zoom 19 (pattern px per metre vertically = 2^z / 65536).
 *  Above zoom 19 the image keeps 2 bays and the ratio halves per zoom so floors keep their real height. */
export const facadePixelRatio = (type: FacadeType, zoom: number) =>
  16 / STYLES[type].floor / 2 ** Math.max(0, Math.floor(zoom) - 19);

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.min(255, Math.round(v * k));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

const hash = (a: number, b: number) => ((a * 73856093) ^ (b * 19349663)) >>> 0;

export function drawFacade(type: FacadeType, zoom: number, lighting: Lighting): ImageData {
  const s = STYLES[type];
  const L = LIGHT[lighting];
  const ctx = Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE }).getContext("2d")!;
  const n = 2 ** (20 - Math.min(19, Math.max(15, Math.floor(zoom))));
  const bay = SIZE / n;

  // Wall
  ctx.fillStyle = shade(s.wall, L.wall);
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Bricks: 16 courses and 4 bricks per bay, alternate rows offset by half a brick. Mortar = wall colour.
  const course = bay / 16;
  const brickLen = bay / 4;
  if (s.brick) {
    const mortar = course >= 4 ? 1 : 0;
    for (let r = 0; r < SIZE / Math.max(course, 1); r++) {
      const off = r % 2 ? brickLen / 2 : 0;
      for (let b = -1; b < SIZE / brickLen; b++) {
        ctx.fillStyle = shade(BRICKS[hash(b, r) % BRICKS.length], L.wall);
        ctx.fillRect(b * brickLen + off, r * course, brickLen - mortar, Math.max(course, 1) - mortar);
      }
    }
  }

  if (s.w === 0) return ctx.getImageData(0, 0, SIZE, SIZE);

  const ww = Math.max(1, Math.round(bay * s.w));
  const wh = Math.max(1, Math.round(bay * s.h));
  const detail = bay >= 16; // enough pixels for frame, recess, sill
  const near = bay >= 32; // zoom 17+: full-strength lit windows and halo (far away they'd sparkle)
  const f = detail ? Math.max(1, Math.round(bay / 40)) : 0; // frame thickness

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = Math.round(i * bay + (bay - ww) / 2);
      const y = Math.round(j * bay + (bay - wh) / 2);
      const h = hash(i, j);
      const lit = h % 100 < L.lit;

      // Warm light spilling onto the wall around lit windows.
      if (lit && near) {
        const g = Math.max(2, Math.round(bay * 0.06));
        ctx.fillStyle = "rgba(255, 196, 110, 0.22)";
        ctx.fillRect(x - g, y - g, ww + 2 * g, wh + 2 * g);
      }

      if (detail) {
        // Sill below, frame around.
        ctx.fillStyle = shade(SILL, L.wall);
        ctx.fillRect(x - 2 * f, y + wh + f, ww + 4 * f, Math.max(1, f + 1));
        ctx.fillStyle = shade(s.frame, L.wall);
        ctx.fillRect(x - f, y - f, ww + 2 * f, wh + 2 * f);
      }

      // Glass
      ctx.fillStyle = lit ? LIT[h % LIT.length] : lighting === "day" ? s.glass : lighting === "dusk" ? shade(s.glass, 0.45) : UNLIT;
      ctx.fillRect(x, y, ww, wh);
      // Zoomed out: tone lit windows down towards the wall so tiny bright pixels don't dominate.
      if (lit && !near) {
        ctx.fillStyle = shade(s.wall, L.wall).replace("rgb", "rgba").replace(")", ", 0.45)");
        ctx.fillRect(x, y, ww, wh);
      }

      // Depth: recess shadow cast by the top and left of the opening.
      if (wh >= 3) {
        ctx.fillStyle = lit ? "rgba(120, 60, 0, 0.35)" : "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(x, y, ww, Math.max(1, Math.round(wh * 0.18)));
        ctx.fillStyle = lit ? "rgba(120, 60, 0, 0.2)" : "rgba(0, 0, 0, 0.2)";
        ctx.fillRect(x, y, Math.max(1, Math.round(ww * 0.1)), wh);
      }
      // Daytime sky reflection streak on the glass.
      if (detail && lighting === "day") {
        ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
        ctx.fillRect(x + Math.round(ww * 0.6), y + Math.round(wh * 0.25), Math.max(1, Math.round(ww * 0.12)), Math.round(wh * 0.7));
      }
    }
  }
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

export function lightPresetFor(date = new Date()): LightPreset {
  const h = date.getHours();
  return h < 5 || h >= 19 ? "night" : h < 7 ? "dawn" : h < 17 ? "day" : "dusk";
}
