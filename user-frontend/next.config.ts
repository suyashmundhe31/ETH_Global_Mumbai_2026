import path from "node:path";
import type { NextConfig } from "next";

// The repository root: the app imports ../shared (the Arkiv creature schema, gas policy and discount-code
// message shared with the worker and the business app). Those modules have no imports of their own.
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // cacheComponents / partialPrefetching are off: on Cloudflare Workers they hang every page render
  // ("cannot guarantee that Cache Components will run as expected due to the runtime's setTimeout()").
  // Nothing here uses "use cache"; every page reads the session cookie, so all pages are dynamic anyway.
  // Let a phone load the dev server through an ngrok or Cloudflare HTTPS tunnel (dev only; ignored by `next build`).
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.trycloudflare.com"],
  // Browser hardening for a wallet app. No CSP script/connect rules: Mapbox (blob workers), World ID, Swarm,
  // Arkiv and the RPCs load from many origins; these headers are the ones that can't break anything.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Clickjacking: no other site may frame the app and trick taps onto wallet prompts.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Only what the game uses (camera for AR, location for GPS, motion sensors), and only for this origin.
          {
            key: "Permissions-Policy",
            value: "camera=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), microphone=(), payment=(), usb=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;

// Gives `next dev` the wrangler.jsonc bindings (PLAYERS KV, emulated locally in .wrangler/).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
