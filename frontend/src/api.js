import { API_URL } from "./config.js";

async function call(path, init) {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  assets: () => call("/api/assets"),
  assetUrl: (name) => `${API_URL}/api/assets/${encodeURIComponent(name)}`,
  swarmUrl: (ref) => `${API_URL}/api/swarm/bzz/${ref}`,
  uploadToSwarm: (asset) =>
    call("/api/swarm/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset }) }),
  campaign: (id) => call(`/api/campaigns/${id}`),
  persist: (id) => call(`/api/campaigns/${id}/persist`, { method: "POST" }),
};
