import "@google/model-viewer";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { api } from "./api.js";
import { loadConfig } from "./config.js";
import "./style.css";
import { RARITIES, validateCampaign } from "./validation.js";
import { connectWallet, createCampaign, readCampaign, retryRandomness } from "./wallet.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 10) => (s && s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-6)}` : s ?? "—");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let cfg;
let conn = null;
let busy = false;

// ---------------------------------------------------------------- status steps
const STEP_DEFS = [
  ["validate", "Validate campaign"],
  ["wallet", "Connect MetaMask & check network"],
  ["swarm", "Upload .glb to Swarm"],
  ["tx", "Submit createCampaign transaction"],
  ["vrf", "Chainlink VRF fulfilment + on-chain Fisher–Yates allocation"],
  ["arkiv", "Persist one Arkiv entity per creature"],
];
function resetSteps() {
  $("steps").innerHTML = STEP_DEFS.map(([k, t]) => `<li id="step-${k}" class="pending"><b>${t}</b><span></span></li>`).join("");
  $("summary").innerHTML = "";
}
function step(k, state, detail = "") {
  const el = $(`step-${k}`);
  if (!el) return;
  el.className = state;
  el.querySelector("span").innerHTML = detail;
}

// ---------------------------------------------------------------- form building
function buildForm() {
  $("rewardRows").innerHTML = RARITIES.map(
    (r) => `<tr><td class="r-${r}">${r}</td>
      <td><input id="code-${r}" maxlength="64" placeholder="${r.slice(0, 3)}10" /></td>
      <td><input id="desc-${r}" maxlength="128" placeholder="Reward for ${r.toLowerCase()} creatures" /></td></tr>`,
  ).join("");
  const defaults = { COMMON: 6, RARE: 2, EPIC: 1, LEGENDARY: 1 };
  $("countInputs").innerHTML = RARITIES.map(
    (r) => `<label class="r-${r}">${r} <input id="count-${r}" type="number" min="0" step="1" value="${defaults[r]}" /></label>`,
  ).join("");
  const updateSum = () => {
    const sum = RARITIES.reduce((a, r) => a + (Number($(`count-${r}`).value) || 0), 0);
    const total = Number($("totalCreatures").value) || 0;
    $("sumHint").textContent = `Sum of rarities: ${sum} / Total: ${total}${sum === total ? " ✓" : " ✗ must match"}`;
    $("sumHint").className = sum === total ? "hint ok" : "hint bad";
  };
  [...RARITIES.map((r) => `count-${r}`), "totalCreatures"].forEach((id) => $(id).addEventListener("input", updateSum));
  updateSum();
}

function readForm() {
  return {
    businessName: $("businessName").value,
    totalCreatures: $("totalCreatures").value,
    counts: Object.fromEntries(RARITIES.map((r) => [r, $(`count-${r}`).value])),
    rewards: Object.fromEntries(RARITIES.map((r) => [r, { code: $(`code-${r}`).value, description: $(`desc-${r}`).value }])),
    latitude: $("latitude").value,
    longitude: $("longitude").value,
    expiration: $("expiration").value ? new Date($("expiration").value).toISOString() : "",
    asset: $("asset").value,
  };
}

// ---------------------------------------------------------------- map
let map, marker;
function setLocation(lat, lon, pan = true) {
  $("latitude").value = lat.toFixed(6);
  $("longitude").value = lon.toFixed(6);
  marker.setLatLng([lat, lon]);
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 15));
}
function initMap() {
  // Explicit icon: Leaflet's Default icon prepends its own image path to bundler URLs.
  const icon = L.icon({
    iconUrl: markerIcon,
    iconRetinaUrl: markerIcon2x,
    shadowUrl: markerShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    shadowSize: [41, 41],
  });
  map = L.map("map").setView([19.07609, 72.877426], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  marker = L.marker([19.07609, 72.877426], { draggable: true, icon }).addTo(map);
  marker.on("dragend", () => {
    const p = marker.getLatLng();
    setLocation(p.lat, p.lng, false);
  });
  map.on("click", (e) => setLocation(e.latlng.lat, e.latlng.lng, false));
  ["latitude", "longitude"].forEach((id) =>
    $(id).addEventListener("change", () => {
      const lat = Number($("latitude").value), lon = Number($("longitude").value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) setLocation(lat, lon);
    }),
  );
  $("locateBtn").addEventListener("click", useCurrentLocation);
  useCurrentLocation();
}
function useCurrentLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude),
    () => {
      if (!$("latitude").value) setLocation(19.07609, 72.877426); // fallback: Mumbai
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

// ---------------------------------------------------------------- assets & preview
async function loadAssets() {
  try {
    const assets = await api.assets();
    $("asset").innerHTML = assets.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} (${(a.size / 1024).toFixed(1)} KB)</option>`).join("");
    if (!assets.length) $("asset").innerHTML = `<option value="">No .glb files in assets/creatures</option>`;
    showLocalModel();
  } catch (err) {
    $("asset").innerHTML = `<option value="">Worker API unreachable: ${esc(err.message)}</option>`;
  }
}
function showLocalModel() {
  const name = $("asset").value;
  if (!name) return;
  $("viewer").src = api.assetUrl(name);
  $("viewerSource").textContent = `Source: local assets folder (${name})`;
}
function showSwarmModel(ref, label = "Swarm") {
  $("viewer").src = api.swarmUrl(ref);
  $("viewerSource").innerHTML = `Source: retrieved from ${label} <code>${short(ref, 8)}</code>`;
}

// ---------------------------------------------------------------- wallet
async function doConnect() {
  conn = await connectWallet(cfg);
  $("wallet").value = conn.address;
  $("connectBtn").textContent = short(conn.address, 6);
  return conn;
}

// ---------------------------------------------------------------- launch flow
async function launch(ev) {
  ev.preventDefault();
  if (busy) return;
  busy = true;
  $("launchBtn").disabled = true;
  $("formErrors").innerHTML = "";
  $("results").hidden = true;
  resetSteps();
  try {
    // 1. Validate
    step("validate", "active");
    const form = readForm();
    const { errors } = validateCampaign(form);
    if (errors.length) {
      $("formErrors").innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join("");
      step("validate", "error", `${errors.length} problem(s)`);
      return;
    }
    if (!cfg.campaignManager) throw new Error("No contract address configured (VITE_CAMPAIGN_MANAGER_ADDRESS or worker deployment).");
    step("validate", "done");

    // 2. Wallet
    step("wallet", "active");
    await doConnect();
    step("wallet", "done", `${short(conn.address, 6)} on ${cfg.chainName}`);

    // 3. Swarm upload (must succeed before anything goes on-chain)
    step("swarm", "active", `uploading ${esc(form.asset)}…`);
    const up = await api.uploadToSwarm(form.asset);
    step("swarm", "done", `reference <code>${short(up.reference, 8)}</code> (download verified)`);
    showSwarmModel(up.reference);

    // 4. Contract transaction
    const { input } = validateCampaign({ ...form, swarmReference: up.reference });
    step("tx", "active", "confirm in MetaMask…");
    const tx = await createCampaign(conn, cfg.campaignManager, input);
    step("tx", "done", `campaign #${tx.campaignId} · tx ${txLink(tx.hash)}`);

    // 5. Wait for VRF callback + allocation
    await waitForAllocation(tx.campaignId, tx.requestId);

    // 6. Arkiv persistence (the worker also picks this up from the RarityAllocated event)
    await waitForPersistence(tx.campaignId, true);
  } catch (err) {
    const active = document.querySelector("#steps li.active");
    if (active) step(active.id.replace("step-", ""), "error", esc(err.shortMessage || err.message));
    else $("formErrors").innerHTML = `<li>${esc(err.shortMessage || err.message)}</li>`;
  } finally {
    busy = false;
    $("launchBtn").disabled = false;
  }
}

let currentCampaignId = null;

async function waitForAllocation(campaignId, requestId) {
  currentCampaignId = campaignId;
  step("vrf", "active", `VRF request ${requestId ?? ""} pending…`);
  const started = Date.now();
  for (;;) {
    const c = await readCampaign(conn, cfg.campaignManager, campaignId);
    if (c.statusName === "ALLOCATED") {
      step("vrf", "done", `fulfilled · random word <code>${short(c.randomWord.toString(16), 8)}</code>`);
      return c;
    }
    if (c.statusName === "CANCELLED") throw new Error("Campaign was cancelled");
    const mins = Math.floor((Date.now() - started) / 60000);
    // The contract allows the business to re-request after RETRY_TIMEOUT (1 hour), e.g. if the
    // VRF subscription was underfunded. The stale request is invalidated on-chain.
    const canRetry = Date.now() / 1000 >= Number(c.requestedAt) + 3600;
    step(
      "vrf",
      "active",
      `waiting for Chainlink VRF (request ${c.vrfRequestId}) · ${mins} min` +
        (canRetry ? ` · <button id="vrfRetry" type="button">Re-request randomness</button>` : ""),
    );
    if (canRetry) $("vrfRetry").onclick = () => retryRandomness(conn, cfg.campaignManager, campaignId).catch((e) => alert(e.message));
    await sleep(4000);
  }
}

async function waitForPersistence(campaignId, trigger) {
  currentCampaignId = campaignId;
  step("arkiv", "active", "starting…");
  if (trigger) await api.persist(campaignId).catch(() => {});
  for (;;) {
    const view = await api.campaign(campaignId);
    renderCampaign(view);
    const p = view.persistence;
    if (p.status === "COMPLETE") {
      step("arkiv", "done", `${p.stored}/${view.onChain.totalCreatures} entities verified in Arkiv`);
      return view;
    }
    if (p.status === "PARTIAL") {
      step("arkiv", "error", `${p.stored}/${view.onChain.totalCreatures} stored · ${p.missing.length} missing · ${esc(p.lastError || "")}`);
      $("retryPersistBtn").hidden = false;
      return view;
    }
    step("arkiv", "active", `${p.status.toLowerCase()} · ${p.stored ?? 0}/${view.onChain.totalCreatures}`);
    await sleep(3000);
  }
}

function txLink(hash) {
  if (!hash) return "—";
  return cfg.explorerUrl ? `<a href="${cfg.explorerUrl}/tx/${hash}" target="_blank" rel="noreferrer"><code>${short(hash, 8)}</code></a>` : `<code>${short(hash, 8)}</code>`;
}

function renderCampaign(v) {
  const oc = v.onChain;
  const counts = oc.rarityCounts.map((n, i) => `${RARITIES[i]}: ${n}`).join(" · ");
  const exp = Number(oc.expiresAt) ? new Date(Number(oc.expiresAt) * 1000).toLocaleString() : "none";
  $("summary").innerHTML = `
    <dl class="summary">
      <dt>Campaign ID</dt><dd>${esc(v.campaignId)}</dd>
      <dt>Business wallet</dt><dd><code>${esc(oc.business)}</code></dd>
      <dt>Total creatures</dt><dd>${esc(oc.totalCreatures)}</dd>
      <dt>Rarity distribution</dt><dd>${counts}</dd>
      <dt>Creation tx</dt><dd>${txLink(v.txs.creationTxHash)}</dd>
      <dt>VRF</dt><dd>${esc(oc.status)} · request ${esc(oc.vrfRequestId)} · fulfilment tx ${txLink(v.txs.allocationTxHash)}</dd>
      <dt>Arkiv</dt><dd>${esc(v.persistence.status)} · ${v.persistence.stored}/${oc.totalCreatures} · owner <code>${short(v.persistence.arkivOwner, 6)}</code> · expiry: ${esc(v.persistence.expirationMode || "—")}</dd>
      <dt>Campaign Swarm ref</dt><dd><a href="#" data-swarm="${esc(oc.swarmReference)}"><code>${short(oc.swarmReference, 8)}</code></a></dd>
      <dt>Expires</dt><dd>${exp}</dd>
    </dl>`;
  if (v.creatures.length) {
    $("results").hidden = false;
    $("creatureRows").innerHTML = v.creatures
      .map(
        (c) => `<tr>
          <td>${c.index}</td>
          <td><code>${esc(c.creatureId)}</code></td>
          <td class="r-${c.rarity}">${c.rarity}</td>
          <td><code>${esc(c.discountCode)}</code></td>
          <td>${c.arkivEntityKey ? `<code title="${esc(c.arkivEntityKey)}">${short(c.arkivEntityKey, 8)}</code>` : `<em>${esc(c.arkivStatus)}</em>`}</td>
          <td>${c.swarmReference ? `<a href="#" data-swarm="${esc(c.swarmReference)}"><code>${short(c.swarmReference, 8)}</code></a>` : "—"}</td>
        </tr>`,
      )
      .join("");
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  buildForm();
  resetSteps();
  cfg = await loadConfig();
  $("netInfo").innerHTML = `${esc(cfg.chainName)} · contract <code>${short(cfg.campaignManager || "not set", 6)}</code> · VRF: ${esc(cfg.vrfMode)}`;
  initMap();
  await loadAssets();
  $("asset").addEventListener("change", showLocalModel);
  $("connectBtn").addEventListener("click", () => doConnect().catch((e) => alert(e.message)));
  $("campaignForm").addEventListener("submit", launch);
  $("retryPersistBtn").addEventListener("click", async () => {
    $("retryPersistBtn").hidden = true;
    if (currentCampaignId !== null) await waitForPersistence(currentCampaignId, true);
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-swarm]");
    if (!a) return;
    e.preventDefault();
    showSwarmModel(a.dataset.swarm);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  // Deep link: ?campaign=<id> re-opens the status view of an existing campaign.
  const id = new URLSearchParams(location.search).get("campaign");
  if (id && /^\d+$/.test(id)) waitForPersistence(BigInt(id), false).catch((e) => step("arkiv", "error", esc(e.message)));
}

boot();
