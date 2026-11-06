import { defineConfig } from "vite";

export default defineConfig({
  // fs.allow: the Arkiv creature schema lives in ../shared (one definition for worker + frontend).
  server: { port: 5173, strictPort: true, fs: { allow: [".", "../shared"] } },
  build: { chunkSizeWarningLimit: 2000 },
});
