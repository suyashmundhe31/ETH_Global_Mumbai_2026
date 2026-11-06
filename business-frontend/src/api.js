import { API_URL } from "./config.js";

async function call(path, init) {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), { status: res.status });
  return body;
}

const post = (path, body) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  assets: () => call("/api/assets"),
  assetUrl: (name) => `${API_URL}/api/assets/${encodeURIComponent(name)}`,
  swarmUrl: (ref) => `${API_URL}/api/swarm/bzz/${ref}`,
  uploadToSwarm: (asset) =>
    call("/api/swarm/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset }) }),
  campaign: (id) => call(`/api/campaigns/${id}`),
  // Arkiv: plan = creatures still missing (409 while Swarm assets are being prepared),
  // submissions = keys returned by a business transaction, verify = check Arkiv itself.
  arkivPlan: (id) => post(`/api/campaigns/${id}/arkiv/plan`),
  arkivSubmissions: (id, body) => post(`/api/campaigns/${id}/arkiv/submissions`, body),
  arkivVerify: (id) => post(`/api/campaigns/${id}/arkiv/verify`),
  // Discount codes: the worker holds the key. encrypt -> before createCampaign; reveal -> signed request.
  encryptCodes: (body) => post("/api/discount-codes/encrypt", body),
  revealCodes: (id, body) => post(`/api/campaigns/${id}/discount-codes/reveal`, body),
};
