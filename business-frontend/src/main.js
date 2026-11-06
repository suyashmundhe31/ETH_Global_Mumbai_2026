import "@google/model-viewer";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { api } from "./api.js";
import { custom } from "viem";
import { approveCatches, arkivChainFor, ensureArkivNetwork, entityKeyPredictor, isUserRejection, metaMaskArkivWallet, rabdiBatchTxParams, writeCreatureBatches } from "./arkivWrite.js";
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
  ["arkiv", "Business signs one Arkiv entity per creature ($creator = business; $owner = business, or the settler with Auto settle)"],
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

/** "auto" only when chosen AND the worker runs a settler; otherwise the current approval flow. */
function settlementChoice() {
  return $("settlementAuto").checked && cfg.settlerAddress ? "auto" : "approval";
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
  if (plan.payloads.length === 0) return verifyArkiv(campaignId, plan.pending);

  if (!conn) await doConnect();
  if (conn.address.toLowerCase() !== plan.business.toLowerCase()) {
    throw new Error(`Switch MetaMask to the business wallet of this campaign (${plan.business}); it must sign the creatures.`);
  }
  // The wallet uses its own RPC for Arkiv: no operator access key is shipped in this page.
  const chain = arkivChainFor({ network: cfg.arkivNetwork, rpcUrl: cfg.arkivRpcUrl });
  step("arkiv", "active", `switch MetaMask to Arkiv ${esc(chain.name)}…`);
  await ensureArkivNetwork(window.ethereum, chain);
  const balance = BigInt(await window.ethereum.request({ method: "eth_getBalance", params: [conn.address, "latest"] }));
  if (balance === 0n) {
    throw new Error(`The business wallet has no ${chain.nativeCurrency.symbol} on Arkiv ${chain.name}. Get some at https://hub.arkiv.network/faucet, then retry.`);
  }

  // Settlement mode: a campaign that already has creatures on Arkiv keeps the mode they were written with
  // (the worker infers it from their $owner); otherwise the business's choice in section F.
  const mode = plan.settlement?.mode ?? settlementChoice();
  const settler = plan.settlement?.settler;
  if (mode === "auto" && !settler) throw new Error("Auto settle needs the worker's settler (SETTLER_PRIVATE_KEY); choose Approval or configure it.");

  const batches = Math.ceil(plan.payloads.length / plan.batchSize);
  let signed = 0;
  step("arkiv", "active", `${plan.stored}/${plan.total} on Arkiv · ${mode === "auto" ? `auto settle via <code>${short(settler, 6)}</code> · ` : ""}confirm ${batches} transaction(s) in MetaMask…`);
  const wallet = metaMaskArkivWallet(window.ethereum, conn.address, chain);
  const request = (args) => window.ethereum.request(args);
  const result = await writeCreatureBatches({
    walletClient: wallet,
    plan,
    schemaName: cfg.arkivSchema,
    // Auto settle: the same atomic batch hands each new creature to the settler ($creator stays the business).
    settleTo: mode === "auto" ? settler : undefined,
    predictKeys: mode === "auto" ? entityKeyPredictor(custom(window.ethereum), chain, conn.address) : undefined,
    // arkiv-app-integration: re-check the account and chain before every signature.
    beforeBatch: async () => {
      const [account] = await request({ method: "eth_accounts" });
      if (!account || account.toLowerCase() !== plan.business.toLowerCase()) throw new Error("MetaMask account changed; switch back to the business wallet and retry.");
      if (Number(await request({ method: "eth_chainId" })) !== chain.id) throw new Error(`MetaMask left Arkiv ${chain.name}; switch back and retry.`);
    },
    // arkiv-write-safety: explicit gas from an unsigned estimate, bounded by the block gas limit.
    txParamsFor: (batch) => rabdiBatchTxParams({ request, account: conn.address, chain, batch }),
    onBatch: async (r) => {
      signed++;
      if (r.ok) await api.arkivSubmissions(campaignId, { txHash: r.txHash, entries: r.entries }).catch(() => {});
      else if (r.sent && r.txHash) await api.arkivSubmissions(campaignId, { txHash: r.txHash, pending: r.creatureIds }).catch(() => {});
      const why = r.ok ? "" : esc(isUserRejection(r.error) ? "rejected in MetaMask" : r.error.shortMessage || r.error.message);
      step("arkiv", "active", `batch ${signed}/${batches} ${r.ok ? "written" : "stopped"} · ${why}`);
    },
  });
  if (result.rejected) step("arkiv", "active", "signature rejected in MetaMask · verifying what was written…");
  else if (result.uncertain) step("arkiv", "active", "a transaction's outcome is uncertain · verifying (it is held back from retries until Arkiv shows it)…");
  const after = await api.arkivPlan(campaignId).catch(() => ({ pending: [] }));
  const report = await verifyArkiv(campaignId, after.pending);
  watchSettlements(campaignId);
  return report;
}

/** Verification is done by the worker against Arkiv itself ($creator must be the business). */
async function verifyArkiv(campaignId, pending = []) {
  step("arkiv", "active", "verifying on Arkiv…");
  let report;
  for (let i = 0; i < 5; i++) {
    report = await api.arkivVerify(campaignId);
    if (report.status === "COMPLETE") break;
    await sleep(2000); // the query index can trail the latest block slightly
  }
  renderCampaign(await api.campaign(campaignId));
  if (report.status === "COMPLETE") {
    step("arkiv", "done", `${report.stored}/${report.expected} entities · $creator = <code>${short(report.creator, 6)}</code>`);
  } else if (pending?.length) {
    // Never offer to re-sign creatures whose earlier transaction may still land (duplicates).
    const held = pending.reduce((n, p) => n + p.creatureIds.length, 0);
    step("arkiv", "error", `${report.stored}/${report.expected} on Arkiv · ${held} waiting for an earlier transaction (${pending.map((p) => `<code>${short(p.txHash, 8)}</code> ${esc(p.status)}`).join(", ")}) · reload to re-check`);
    $("arkivSignBtn").hidden = report.missing.length <= held;
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
  watchSettlements(campaignId);
  const a = view.arkiv;
  if (view.onChain.status !== "ALLOCATED") return step("arkiv", "pending", "waiting for VRF allocation");
  if (a.status === "COMPLETE") return step("arkiv", "done", `${a.stored}/${view.onChain.totalCreatures} entities · $creator = <code>${short(a.creator, 6)}</code>`);
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

// ---------------------------------------------------------------- settlement (Approval / Auto settle)
function settlementSummary(s) {
  if (!s || !s.mode) return "not decided yet (chosen when you sign the creatures on Arkiv)";
  const claimed = `${s.claimed ?? 0} claimed by players`;
  if (s.mode === "approval") return `<b>Approval</b> · you approve each claim below (signed in MetaMask) · ${claimed}`;
  return `<b>Auto settle</b> · settler <code>${short(s.settler, 6)}</code> holds uncaught creatures and transfers each valid claim · ${claimed}`;
}

function feedTable(rows, head) {
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function formatWei(wei) {
  if (wei === null || wei === undefined) return "—";
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ETH`;
}

function settlementPanel(s) {
  if (!s?.mode) return "";
  let html = "";
  if (s.mode === "approval") {
    const rows = (s.approvals || [])
      .map(
        (a) => `<tr><td><code>${esc(a.creatureId)}</code></td><td class="r-${esc(a.rarity)}">${esc(a.rarity)}</td>
          <td><code title="${esc(a.player)}">${short(a.player, 6)}</code></td><td>${a.redeemed ? "yes" : "no"}</td></tr>`,
      )
      .join("");
    html += `<h3>Claims awaiting your approval</h3>${
      rows
        ? `${feedTable(rows, ["Creature", "Rarity", "Player (new $owner)", "Redeemed"])}
           <button type="button" id="approveBtn" class="primary">Approve ${s.approvals.length} claim(s) on Arkiv</button>
           <p class="hint" id="approveStatus">Each approval sets catched = true and transfers the creature to its player, in atomic batches you confirm in MetaMask.</p>`
        : `<p class="hint">No claims waiting. When a player claims a creature within 50 m, it appears here for approval.</p>`
    }`;
  } else {
    const rows = (s.autoSettled || [])
      .map(
        (e) => `<tr><td>${new Date(e.settledAt).toLocaleString()}</td><td><code>${esc(e.creatureId)}</code></td>
          <td class="r-${esc(e.rarity)}">${esc(e.rarity)}</td><td><code title="${esc(e.player)}">${short(e.player, 6)}</code></td>
          <td><code title="${esc(e.arkivTxHash)}">${short(e.arkivTxHash, 8)}</code></td></tr>`,
      )
      .join("");
    const waiting = (s.pending || []).length ? `<p class="hint">${s.pending.length} creature(s) being synced to Arkiv…</p>` : "";
    html += `<h3>Auto-settled claims</h3>${waiting}${
      rows
        ? feedTable(rows, ["When", "Creature", "Rarity", "Player (new $owner)", "Arkiv tx"])
        : `<p class="hint">No claims yet. When a player claims a creature, it moves to them automatically and appears here.</p>`
    }`;
  }
  const sales = (s.sales || [])
    .map(
      (e) => `<tr><td>${new Date(e.at).toLocaleString()}</td><td><code>${esc(e.creatureId)}</code></td><td class="r-${esc(e.rarity)}">${esc(e.rarity ?? "")}</td>
        <td><code title="${esc(e.buyer)}">${short(e.buyer, 6)}</code></td><td>${esc(formatWei(e.price))}</td></tr>`,
    )
    .join("");
  if (sales) html += `<h3>Marketplace resales</h3>${feedTable(sales, ["When", "Creature", "Rarity", "Buyer (new $owner)", "Price"])}`;
  return html;
}

// Notify the business of claims and transfers since the page last looked (polling while open).
const seenEvents = new Set();
let eventsPrimed = false;
function notifyNewSettlements(v) {
  const s = v.settlement || {};
  const events = [
    ...(s.autoSettled || []).map((e) => [`auto:${e.creatureId}`, `🎉 A player claimed <b>${esc(e.rarity)}</b> creature <code>${esc(e.creatureId)}</code>; ownership transferred to <code>${short(e.player, 6)}</code>.`]),
    ...(s.approvals || []).map((a) => [`claim:${a.creatureId}`, `🔔 <code>${short(a.player, 6)}</code> claimed <b>${esc(a.rarity)}</b> creature <code>${esc(a.creatureId)}</code>: approve it below.`]),
    ...(s.sales || []).map((e) => [`sale:${e.creatureId}:${e.at}`, `💱 Creature <code>${esc(e.creatureId)}</code> was resold to <code>${short(e.buyer, 6)}</code> for ${esc(formatWei(e.price))}.`]),
  ];
  const fresh = events.filter(([k]) => !seenEvents.has(k));
  fresh.forEach(([k]) => seenEvents.add(k));
  if (eventsPrimed && fresh.length) {
    $("notice").hidden = false;
    $("notice").innerHTML = fresh.map(([, html]) => html).join("<br />");
  }
  eventsPrimed = true;
}

let settlementPoll = null;
function watchSettlements(campaignId) {
  clearInterval(settlementPoll);
  settlementPoll = setInterval(async () => {
    if (busy || String(currentCampaignId) !== String(campaignId)) return;
    const v = await api.campaign(campaignId).catch(() => null);
    if (v) renderCampaign(v);
  }, 15000);
}

/** Approval campaigns: the business signs catched = true + ownership -> player for every pending claim. */
async function approvePending() {
  if (currentCampaignId === null || busy) return;
  busy = true;
  const status = (html) => {
    const el = $("approveStatus");
    if (el) el.innerHTML = html;
  };
  try {
    const v = await api.campaign(currentCampaignId); // fresh list: never approve from a stale view
    const approvals = v.settlement?.approvals || [];
    if (!approvals.length) return renderCampaign(v);
    if (!conn) await doConnect();
    if (conn.address.toLowerCase() !== v.onChain.business.toLowerCase()) throw new Error(`Switch MetaMask to the campaign's business wallet (${v.onChain.business}).`);
    const chain = arkivChainFor({ network: cfg.arkivNetwork, rpcUrl: cfg.arkivRpcUrl });
    status("switch MetaMask to Arkiv and confirm the transaction(s)…");
    await ensureArkivNetwork(window.ethereum, chain);
    const request = (args) => window.ethereum.request(args);
    const res = await approveCatches({
      walletClient: metaMaskArkivWallet(window.ethereum, conn.address, chain),
      approvals,
      schemaName: cfg.arkivSchema,
      batchSize: cfg.arkivBatchSize,
      beforeBatch: async () => {
        const [account] = await request({ method: "eth_accounts" });
        if (!account || account.toLowerCase() !== v.onChain.business.toLowerCase()) throw new Error("MetaMask account changed; switch back to the business wallet.");
        if (Number(await request({ method: "eth_chainId" })) !== chain.id) throw new Error(`MetaMask left Arkiv ${chain.name}; switch back.`);
      },
      txParamsFor: (batch) => rabdiBatchTxParams({ request, account: conn.address, chain, batch }),
      onBatch: (r) => status(r.ok ? `approved ${r.creatureIds.length} · tx <code>${short(r.txHash, 8)}</code>` : esc(r.rejected ? "rejected in MetaMask" : r.error.shortMessage || r.error.message)),
    });
    await sleep(2000); // the query index can trail the latest block slightly
    renderCampaign(await api.campaign(currentCampaignId));
    if (res.failed.length) status(`${res.approved} approved · ${res.failed.length} not approved${res.uncertain ? " (a transaction may still land; reload in a moment)" : ""} · click Approve again to finish`);
  } catch (err) {
    status(esc(isUserRejection(err) ? "rejected in MetaMask" : err.shortMessage || err.message));
  } finally {
    busy = false;
  }
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
      <dt>Arkiv</dt><dd>${esc(v.arkiv.status)} · ${v.arkiv.stored}/${oc.totalCreatures} · $creator = <code>${short(v.arkiv.creator, 6)}</code> · schema <code>${esc(v.arkiv.schema)}</code> · expiry: ${esc(v.arkiv.expirationMode || "—")}</dd>
      <dt>Settlement</dt><dd>${settlementSummary(v.settlement)}</dd>
      <dt>Campaign Swarm ref</dt><dd><a href="#" data-swarm="${esc(oc.swarmReference)}"><code>${short(oc.swarmReference, 8)}</code></a></dd>
      <dt>Expires</dt><dd>${exp}</dd>
    </dl>${settlementPanel(v.settlement)}`;
  notifyNewSettlements(v);
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
  $("settlerAddress").textContent = cfg.settlerAddress || "(worker not reachable)";
  if (!cfg.settlerAddress) $("settlementAuto").disabled = true;
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
    if (e.target.closest("#approveBtn")) return void approvePending();
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
