import "@google/model-viewer";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { api } from "./api.js";
import { arkivChainFor, ensureArkivNetwork, isUserRejection, metaMaskArkivWallet, writeCreatureBatches } from "./arkivWrite.js";
import { loadConfig } from "./config.js";
import "./style.css";
import { revealMessage } from "../../shared/discountCodes.js";
import { LIMITS, RARITIES, validateCampaign } from "./validation.js";
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
  ["encrypt", "Encrypt discount codes (worker key; only ciphertext goes on-chain and to Arkiv)"],
  ["swarm", "Upload .glb to Swarm"],
  ["tx", "Submit createCampaign transaction"],
  ["vrf", "Chainlink VRF fulfilment + on-chain Fisher–Yates allocation"],
  ["arkiv", "Business signs one Arkiv entity per creature ($creator = $owner = business wallet)"],
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
      <td><input id="code-${r}" maxlength="${LIMITS.code}" placeholder="${r.slice(0, 3)}10" /></td>
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

    // 3. Encrypt the discount codes with the worker's key (bound to this business + rarity).
    step("encrypt", "active");
    const { codes: encryptedCodes } = await api.encryptCodes({
      business: conn.address,
      codes: RARITIES.map((r) => form.rewards[r].code.trim()),
    });
    step("encrypt", "done", `${encryptedCodes.filter(Boolean).length} code(s) encrypted · plaintext never leaves the worker`);

    // 3. Swarm upload (must succeed before anything goes on-chain)
    step("swarm", "active", `uploading ${esc(form.asset)}…`);
    const up = await api.uploadToSwarm(form.asset);
    step("swarm", "done", `reference <code>${short(up.reference, 8)}</code> (download verified)`);
    showSwarmModel(up.reference);

    // 4. Contract transaction (with the encrypted codes)
    const { input } = validateCampaign({ ...form, swarmReference: up.reference });
    input.rewards = input.rewards.map((r, i) => ({ ...r, code: encryptedCodes[i] }));
    step("tx", "active", "confirm in MetaMask…");
    const tx = await createCampaign(conn, cfg.campaignManager, input);
    step("tx", "done", `campaign #${tx.campaignId} · tx ${txLink(tx.hash)}`);

    // 5. Wait for VRF callback + allocation
    await waitForAllocation(tx.campaignId, tx.requestId);

    // 6. Arkiv: the worker prepares the payloads, the business signs them in MetaMask
    await createArkivEntities(tx.campaignId);
  } catch (err) {
    const active = document.querySelector("#steps li.active");
    const msg = isUserRejection(err) ? "rejected in MetaMask" : err.shortMessage || err.message;
    if (active) step(active.id.replace("step-", ""), "error", esc(msg));
    else $("formErrors").innerHTML = `<li>${esc(msg)}</li>`;
    if (active?.id === "step-arkiv") $("arkivSignBtn").hidden = false; // the campaign exists; only Arkiv is left
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

/** Waits until the worker has the per-creature Swarm assets, then returns what is left to sign. */
async function waitForPlan(campaignId) {
  for (;;) {
    try {
      return await api.arkivPlan(campaignId);
    } catch (err) {
      if (err.status !== 409) throw err;
      step("arkiv", "active", `preparing per-creature Swarm models · ${esc(err.message)}`);
      await sleep(3000);
    }
  }
}

/**
 * The business creates its creatures on Arkiv. Only creatures without a valid entity are in the
 * plan, so running this again after any failure (the "Retry" button) never creates duplicates.
 */
async function createArkivEntities(campaignId) {
  currentCampaignId = campaignId;
  $("arkivSignBtn").hidden = true;
  step("arkiv", "active", "preparing per-creature Swarm models…");
  const plan = await waitForPlan(campaignId);
  renderCampaign(await api.campaign(campaignId));
  if (plan.payloads.length === 0) return verifyArkiv(campaignId);

  if (!conn) await doConnect();
  if (conn.address.toLowerCase() !== plan.business.toLowerCase()) {
    throw new Error(`Switch MetaMask to the business wallet of this campaign (${plan.business}); it must sign the creatures.`);
  }
  const chain = arkivChainFor({ network: cfg.arkivNetwork, accessKey: cfg.arkivAccessKey, rpcUrl: cfg.arkivRpcUrl });
  step("arkiv", "active", `switch MetaMask to Arkiv ${esc(chain.name)}…`);
  await ensureArkivNetwork(window.ethereum, chain);
  const balance = BigInt(await window.ethereum.request({ method: "eth_getBalance", params: [conn.address, "latest"] }));
  if (balance === 0n) {
    throw new Error(`The business wallet has no ${chain.nativeCurrency.symbol} on Arkiv ${chain.name}. Get some at https://hub.arkiv.network/faucet, then retry.`);
  }

  const batches = Math.ceil(plan.payloads.length / plan.batchSize);
  let signed = 0;
  step("arkiv", "active", `${plan.stored}/${plan.total} on Arkiv · confirm ${batches} transaction(s) in MetaMask…`);
  const wallet = metaMaskArkivWallet(window.ethereum, conn.address, chain);
  const result = await writeCreatureBatches({
    walletClient: wallet,
    plan,
    schemaName: cfg.arkivSchema,
    onBatch: async (r) => {
      signed++;
      if (r.ok) await api.arkivSubmissions(campaignId, { txHash: r.txHash, entries: r.entries }).catch(() => {});
      step("arkiv", "active", `batch ${signed}/${batches} ${r.ok ? "written" : "failed"} · ${r.ok ? "" : esc(r.error.shortMessage || r.error.message)}`);
    },
  });
  if (result.rejected) step("arkiv", "active", "signature rejected in MetaMask · verifying what was written…");
  return verifyArkiv(campaignId);
}

/** Verification is done by the worker against Arkiv itself ($creator must be the business). */
async function verifyArkiv(campaignId) {
  step("arkiv", "active", "verifying on Arkiv…");
  let report;
  for (let i = 0; i < 5; i++) {
    report = await api.arkivVerify(campaignId);
    if (report.status === "COMPLETE") break;
    await sleep(2000); // the query index can trail the latest block slightly
  }
  renderCampaign(await api.campaign(campaignId));
  if (report.status === "COMPLETE") {
    step("arkiv", "done", `${report.stored}/${report.expected} entities · $creator = $owner = <code>${short(report.creator, 6)}</code>`);
  } else {
    step("arkiv", "error", `${report.stored}/${report.expected} on Arkiv · ${report.missing.length} missing`);
    $("arkivSignBtn").hidden = false;
  }
  return report;
}

/** Deep link / reload: show the state; signing needs a click (it opens MetaMask). */
async function showExistingCampaign(campaignId) {
  currentCampaignId = campaignId;
  // Re-check Arkiv itself (read-only) so the page never shows a stale result.
  await api.arkivVerify(campaignId).catch(() => {});
  const view = await api.campaign(campaignId);
  renderCampaign(view);
  const a = view.arkiv;
  if (view.onChain.status !== "ALLOCATED") return step("arkiv", "pending", "waiting for VRF allocation");
  if (a.status === "COMPLETE") return step("arkiv", "done", `${a.stored}/${view.onChain.totalCreatures} entities · $creator = $owner = <code>${short(a.creator, 6)}</code>`);
  step("arkiv", "error", `${a.stored}/${view.onChain.totalCreatures} on Arkiv · the business wallet must sign the rest`);
  $("arkivSignBtn").hidden = false;
}

function txLink(hash) {
  if (!hash) return "—";
  return cfg.explorerUrl ? `<a href="${cfg.explorerUrl}/tx/${hash}" target="_blank" rel="noreferrer"><code>${short(hash, 8)}</code></a>` : `<code>${short(hash, 8)}</code>`;
}

// Plaintext codes revealed in this page session (never persisted): { campaignId, byRarity }
let revealed = null;
let lastView = null;

function codeCell(campaignId, c) {
  if (!c.discountCodeEncrypted) return `<code>${esc(c.discountCode)}</code> <small title="Created before encryption">(public)</small>`;
  const plain = revealed?.campaignId === String(campaignId) ? revealed.byRarity[c.rarity] : undefined;
  return plain !== undefined ? `<code>${esc(plain)}</code>` : `<span title="${esc(c.discountCode)}">🔒 encrypted</span>`;
}

/** The business signs a message (no gas, no transaction); the worker verifies it and decrypts. */
async function revealCodes() {
  if (currentCampaignId === null) return;
  if (!conn) await doConnect();
  const issuedAt = new Date().toISOString();
  const message = revealMessage({ chainId: cfg.chainId, contract: cfg.campaignManager, campaignId: currentCampaignId, address: conn.address, issuedAt });
  const signature = await conn.wallet.signMessage({ account: conn.address, message });
  const res = await api.revealCodes(currentCampaignId, { address: conn.address, issuedAt, signature });
  revealed = { campaignId: String(currentCampaignId), byRarity: Object.fromEntries(res.codes.map((c) => [c.rarity, c.code])) };
  if (lastView) renderCampaign(lastView);
}

function renderCampaign(v) {
  lastView = v;
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
      <dt>Arkiv</dt><dd>${esc(v.arkiv.status)} · ${v.arkiv.stored}/${oc.totalCreatures} · $creator = $owner = <code>${short(v.arkiv.creator, 6)}</code> · schema <code>${esc(v.arkiv.schema)}</code> · expiry: ${esc(v.arkiv.expirationMode || "—")}</dd>
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
          <td>${codeCell(v.campaignId, c)}</td>
          <td>${c.arkivEntityKey ? `<code title="${esc(c.arkivEntityKey)}">${short(c.arkivEntityKey, 8)}</code>` : `<em>${esc(c.arkivStatus)}</em>`}</td>
          <td>${c.arkivOwner ? `<code title="${esc(c.arkivOwner)}">${short(c.arkivOwner, 6)}</code>` : "—"}</td>
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
  $("revealCodesBtn").addEventListener("click", () =>
    revealCodes().catch((e) => alert(isUserRejection(e) ? "Signature rejected in MetaMask" : e.shortMessage || e.message)),
  );
  $("arkivSignBtn").addEventListener("click", async () => {
    if (currentCampaignId === null || busy) return;
    busy = true;
    try {
      await createArkivEntities(currentCampaignId);
    } catch (err) {
      step("arkiv", "error", esc(isUserRejection(err) ? "signature rejected in MetaMask" : err.shortMessage || err.message));
      $("arkivSignBtn").hidden = false;
    } finally {
      busy = false;
    }
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
  if (id && /^\d+$/.test(id)) showExistingCampaign(BigInt(id)).catch((e) => step("arkiv", "error", esc(e.message)));
}

boot();
