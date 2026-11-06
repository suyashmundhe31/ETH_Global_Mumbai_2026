// Generates small, valid glTF 2.0 binary (.glb) creature models into assets/creatures/.
// Pure Node.js (no dependencies) so it runs identically on Windows, Linux and macOS.
//   node scripts/generate-creature-glb.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets", "creatures");

function sphere(cx, cy, cz, rx, ry, rz, seg = 24, rings = 16) {
  const pos = [], nrm = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, phi = v * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const u = s / seg, th = u * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(th);
      pos.push(cx + x * rx, cy + y * ry, cz + z * rz);
      const n = [x / rx, y / ry, z / rz], l = Math.hypot(...n) || 1;
      nrm.push(n[0] / l, n[1] / l, n[2] / l);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  return { pos, nrm, idx };
}

function cone(cx, cy, cz, radius, height, seg = 16) {
  const pos = [cx, cy + height, cz], nrm = [0, 1, 0], idx = [];
  for (let s = 0; s <= seg; s++) {
    const th = (s / seg) * Math.PI * 2, x = Math.cos(th), z = Math.sin(th);
    pos.push(cx + x * radius, cy, cz + z * radius);
    const n = [x, radius / height, z], l = Math.hypot(...n);
    nrm.push(n[0] / l, n[1] / l, n[2] / l);
  }
  for (let s = 1; s <= seg; s++) idx.push(0, s + 1, s);
  return { pos, nrm, idx };
}

function merge(...parts) {
  const out = { pos: [], nrm: [], idx: [] };
  for (const p of parts) {
    const base = out.pos.length / 3;
    out.pos.push(...p.pos);
    out.nrm.push(...p.nrm);
    out.idx.push(...p.idx.map((i) => i + base));
  }
  return out;
}

function buildGlb(name, primitives) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [], accessors = [], meshPrims = [], materials = [];
  const pushView = (typed, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    chunks.push(buf, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    offset += buf.length + pad;
    return bufferViews.length - 1;
  };
  for (const { geo, color, metallic = 0, roughness = 0.6 } of primitives) {
    const pos = new Float32Array(geo.pos), nrm = new Float32Array(geo.nrm), idx = new Uint16Array(geo.idx);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3)
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const pv = pushView(pos, 34962), nv = pushView(nrm, 34962), iv = pushView(idx, 34963);
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    const pa = accessors.length - 1;
    accessors.push({ bufferView: nv, componentType: 5126, count: nrm.length / 3, type: "VEC3" });
    const na = accessors.length - 1;
    accessors.push({ bufferView: iv, componentType: 5123, count: idx.length, type: "SCALAR" });
    const ia = accessors.length - 1;
    materials.push({ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: metallic, roughnessFactor: roughness } });
    meshPrims.push({ attributes: { POSITION: pa, NORMAL: na }, indices: ia, material: materials.length - 1 });
  }
  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: "2.0", generator: "creature-campaign generate-creature-glb" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: meshPrims }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); // JSON
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4); // BIN
  return Buffer.concat([header, jh, json, bh, bin]);
}

const eyes = (y, z, spread) => [
  { geo: merge(sphere(-spread, y, z, 0.13, 0.13, 0.08), sphere(spread, y, z, 0.13, 0.13, 0.08)), color: [1, 1, 1, 1], roughness: 0.2 },
  { geo: merge(sphere(-spread, y, z + 0.07, 0.06, 0.06, 0.04), sphere(spread, y, z + 0.07, 0.06, 0.06, 0.04)), color: [0.05, 0.05, 0.08, 1], roughness: 0.1 },
];

const models = {
  "ember-fox.glb": [
    { geo: sphere(0, 0.55, 0, 0.5, 0.55, 0.45), color: [0.95, 0.42, 0.12, 1] },
    { geo: merge(cone(-0.25, 0.95, 0, 0.13, 0.4), cone(0.25, 0.95, 0, 0.13, 0.4)), color: [0.75, 0.25, 0.05, 1] },
    { geo: sphere(0, 0.42, 0.33, 0.22, 0.15, 0.15), color: [1, 0.9, 0.8, 1] },
    ...eyes(0.7, 0.36, 0.17),
  ],
  "aqua-blob.glb": [
    { geo: sphere(0, 0.45, 0, 0.6, 0.45, 0.55), color: [0.2, 0.6, 0.95, 1], roughness: 0.15, metallic: 0.1 },
    { geo: cone(0, 0.85, 0, 0.08, 0.35), color: [0.1, 0.35, 0.8, 1] },
    ...eyes(0.55, 0.46, 0.2),
  ],
};

mkdirSync(outDir, { recursive: true });
for (const [file, prims] of Object.entries(models)) {
  const glb = buildGlb(file.replace(".glb", ""), prims);
  writeFileSync(join(outDir, file), glb);
  console.log(`wrote ${join("assets", "creatures", file)} (${glb.length} bytes)`);
}
