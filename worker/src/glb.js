// Minimal, spec-based GLB (glTF 2.0 binary) validation and metadata stamping.
// Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
import { createHash } from "node:crypto";

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export class GlbValidationError extends Error {}

/** Validates a GLB buffer and returns its parsed JSON chunk and raw BIN chunk. */
export function parseGlb(buf, { maxBytes = Infinity } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length > maxBytes) throw new GlbValidationError(`GLB is ${buf.length} bytes, limit is ${maxBytes}`);
  if (buf.length < 20) throw new GlbValidationError("File too small to be a GLB");
  if (buf.readUInt32LE(0) !== MAGIC) throw new GlbValidationError("Missing glTF magic header (not a .glb file)");
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new GlbValidationError(`Unsupported GLB container version ${version} (need 2)`);
  if (buf.readUInt32LE(8) !== buf.length) throw new GlbValidationError("GLB header length does not match file size");

  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== CHUNK_JSON) throw new GlbValidationError("First chunk is not JSON");
  if (20 + jsonLen > buf.length) throw new GlbValidationError("JSON chunk overruns file");
  let json;
  try {
    json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  } catch {
    throw new GlbValidationError("JSON chunk is not valid JSON");
  }
  if (!json?.asset?.version?.startsWith("2")) throw new GlbValidationError("asset.version must be 2.x");

  let bin = null;
  const binStart = 20 + jsonLen;
  if (binStart < buf.length) {
    const binLen = buf.readUInt32LE(binStart);
    if (buf.readUInt32LE(binStart + 4) !== CHUNK_BIN) throw new GlbValidationError("Second chunk is not BIN");
    bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
  }
  return { json, bin };
}

/** Re-encodes a GLB from a JSON object and optional BIN chunk. */
export function encodeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const parts = [];
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  parts.push(jsonHeader, jsonBuf);
  if (bin) {
    const padded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(padded.length, 0);
    binHeader.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binHeader, padded);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/**
 * Produces a per-creature copy of the model with creature metadata in `asset.extras`
 * (glTF's sanctioned place for application data). Geometry is unchanged, but the bytes differ,
 * so every creature gets its own content-addressed Swarm reference. The output is deterministic,
 * which makes re-uploading idempotent (same bytes -> same reference).
 */
export function stampCreatureMetadata(baseGlb, extras) {
  const { json, bin } = parseGlb(baseGlb);
  const next = structuredClone(json);
  next.asset = { ...next.asset, extras: { ...(next.asset.extras || {}), creature: extras } };
  return encodeGlb(next, bin);
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
