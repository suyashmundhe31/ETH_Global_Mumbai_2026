import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents / partialPrefetching are off: on Cloudflare Workers they hang every page render
  // ("cannot guarantee that Cache Components will run as expected due to the runtime's setTimeout()").
  // Nothing here uses "use cache"; every page reads the session cookie, so all pages are dynamic anyway.
  // Let a phone load the dev server through an ngrok or Cloudflare HTTPS tunnel (dev only; ignored by `next build`).
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.trycloudflare.com"],
};

export default nextConfig;

// Gives `next dev` the wrangler.jsonc bindings (PLAYERS KV, emulated locally in .wrangler/).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
