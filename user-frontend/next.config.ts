import path from "node:path";
import type { NextConfig } from "next";

// The repository root: the app imports ../shared (the Arkiv creature schema, gas policy and discount-code
// message shared with the worker and the business app). Those modules have no imports of their own.
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Let a phone load the dev server through an ngrok HTTPS tunnel (dev only; ignored by `next build`).
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app"],
};

export default nextConfig;
