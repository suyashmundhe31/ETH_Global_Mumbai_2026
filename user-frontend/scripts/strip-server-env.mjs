// Runs after `opennextjs-cloudflare build`. OpenNext copies every key from .env* into the worker bundle
// (.open-next/cloudflare/next-env.mjs and server-functions/**/.env*). Server-only values such as
// RP_SIGNING_KEY must come from `wrangler secret put` instead, so keep only NEXT_PUBLIC_* (already
// public: inlined into the browser JS) and fail if a secret value is still anywhere in .open-next.
import fs from "node:fs";
import path from "node:path";
import * as built from "../.open-next/cloudflare/next-env.mjs";

const out = ".open-next";
const isPublic = (k) => k.startsWith("NEXT_PUBLIC_");
const secrets = new Set();
const lines = Object.entries(built).map(([mode, vars]) => {
  const kept = {};
  for (const [k, v] of Object.entries(vars)) (isPublic(k) ? (kept[k] = v) : v && secrets.add(v));
  return `export const ${mode} = ${JSON.stringify(kept)};\n`;
});
fs.writeFileSync(path.join(out, "cloudflare/next-env.mjs"), lines.join(""));

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
for (const f of walk(out)) if (/^\.env/.test(path.basename(f))) fs.rmSync(f);

const leaks = walk(out).filter((f) => {
  const text = fs.readFileSync(f, "latin1");
  return [...secrets].some((s) => s.length >= 8 && text.includes(s));
});
if (leaks.length) {
  console.error("Server-only env values still present in the build:\n  " + leaks.join("\n  "));
  process.exit(1);
}
console.log(`Stripped ${secrets.size} server-only env value(s) from the bundle; set them with wrangler secret put.`);
