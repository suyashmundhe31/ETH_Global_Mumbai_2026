import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Let a phone load the dev server through an ngrok or Cloudflare HTTPS tunnel (dev only; ignored by `next build`).
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.trycloudflare.com"],
};

export default nextConfig;
