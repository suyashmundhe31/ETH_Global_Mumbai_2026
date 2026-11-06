// End-to-end integration test of the whole pipeline on a throwaway local chain:
//   Anvil -> forge DeployLocal (real contract + Chainlink VRFCoordinatorV2_5Mock)
//   -> worker HTTP API: Swarm upload of the .glb (real Swarm via SWARM_BEE_URL)
//   -> business wallet sends createCampaign (what MetaMask does in the UI)
//   -> local VRF simulator fulfils -> on-chain Fisher–Yates allocation
//   -> listener prepares per-creature Swarm assets -> API plan
//   -> the BUSINESS signs one Arkiv entity per creature (business-frontend/src/arkivWrite.js, the page's code)
//   -> verification against the chain, Swarm and Arkiv ($creator = $owner = business); re-plan is empty.
//
// Run:  npm run e2e            (from worker/, needs anvil + forge on PATH, and business-frontend deps installed)
// Arkiv: real Rabdi testnet by default. The business key must hold tGLM on Rabdi:
//          E2E_BUSINESS_PRIVATE_KEY=<0x key funded at https://hub.arkiv.network/faucet>
//        E2E_ARKIV=memory swaps in an in-memory Arkiv double (then Arkiv is NOT really tested) and
//        additionally injects a partial failure (3 of 10 creatures) to exercise the retry.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { arkivChainFor, localAccountArkivWallet, writeCreatureBatches } from "../../business-frontend/src/arkivWrite.js";
import managerAbi from "../src/abi/CreatureCampaignManager.json" with { type: "json" };
import { ArkivCreatureStore, expirationFor } from "../src/arkiv.js";
import { CampaignArkivService } from "../src/campaignArkiv.js";
import { CampaignChain, RARITY } from "../src/chain.js";
import { buildConfig, loadEnvFile, REPO_ROOT } from "../src/config.js";
import { CodeCipher, DiscountCodeService, isEncryptedCode } from "../src/discountCodes.js";
import { revealMessage } from "../../shared/discountCodes.js";
import { randomBytes } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";
import { parseGlb } from "../src/glb.js";
import { AllocationListener } from "../src/listener.js";
import { createApi } from "../src/server.js";
import { JsonStateStore } from "../src/state.js";
import { SwarmService } from "../src/swarm.js";
import { sleep } from "../src/util.js";
import { LocalVrfFulfiller } from "../src/vrfMockFulfiller.js";

loadEnvFile();
const CHAIN_ID = 31338; // separate from the dev chain so contracts/deployments/31337.json is untouched
const PORT = Number(process.env.E2E_ANVIL_PORT || 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const MEMORY = process.env.E2E_ARKIV === "memory";
// Anvil's default, publicly known development mnemonic. Local throwaway chain only.
const MNEMONIC = "test test test test test test test test test test test junk";
const keyOf = (i) => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey);
const log = (...a) => console.log("[e2e]", ...a);

const cleanup = [];
async function main() {
  // The business signs on BOTH chains (campaign on Anvil, creatures on Arkiv) with one key.
  let business;
  if (MEMORY) business = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
  else {
    const k = process.env.E2E_BUSINESS_PRIVATE_KEY;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k || "")) {
      throw new Error("Set E2E_BUSINESS_PRIVATE_KEY (a test key funded with tGLM on Arkiv Rabdi), or run with E2E_ARKIV=memory");
    }
    business = privateKeyToAccount(k);
  }

  // ------------------------------------------------------------------ chain + contracts
  log(`starting anvil on ${RPC} (chain ${CHAIN_ID})`);
  const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  cleanup.push(() => anvil.kill());
  const probe = createPublicClient({ transport: http(RPC) });
  for (let i = 0; ; i++) {
    try {
      await probe.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error("anvil did not start");
      await sleep(200);
    }
  }

  // Chainlink's VRF mock derives subscription IDs from blockhash(block.number - 1): needs block >= 1.
  await probe.request({ method: "anvil_mine", params: ["0x2"] });
  // Local test ETH for the business so it can send createCampaign on Anvil.
  await probe.request({ method: "anvil_setBalance", params: [business.address, "0x56BC75E2D63100000"] });

  log("deploying contracts with forge script DeployLocal");
  const forge = spawnSync("forge", ["script", "script/DeployLocal.s.sol:DeployLocal", "--rpc-url", RPC, "--broadcast"], {
    cwd: join(REPO_ROOT, "contracts"),
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: keyOf(0), LOCAL_RPC_URL: RPC, SEPOLIA_RPC_URL: RPC, ETHERSCAN_API_KEY: "" },
    encoding: "utf8",
  });
  if (forge.status !== 0) throw new Error(`forge script failed:\n${forge.stdout}\n${forge.stderr}`);
  const deployment = JSON.parse(readFileSync(join(REPO_ROOT, "contracts", "deployments", `${CHAIN_ID}.json`), "utf8"));
  log("CreatureCampaignManager", deployment.campaignManager, "| VRF mock", deployment.vrfCoordinator);

  // ------------------------------------------------------------------ worker components (in-process)
  const base = buildConfig();
  const config = {
    ...base,
    port: 0,
    chain: { ...base.chain, chainId: CHAIN_ID, rpcUrl: RPC, campaignManager: deployment.campaignManager, startBlock: 0n, pollIntervalMs: 500 },
    vrf: { mode: "mock", coordinator: deployment.vrfCoordinator },
    arkiv: { ...base.arkiv, batchSize: MEMORY ? 1 : 10 },
    // A throwaway key for this run unless worker/.env provides one.
    codeEncryptionKey: base.codeEncryptionKey || randomBytes(32).toString("base64"),
    // The test's own model, so the run does not depend on what is in assets/creatures.
    assetsDir: join(REPO_ROOT, "worker", "test", "fixtures"),
  };
  const stateDir = mkdtempSync(join(tmpdir(), "creature-e2e-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const state = new JsonStateStore(join(stateDir, "state.json"));
  const chain = new CampaignChain(config.chain);
  const swarm = new SwarmService({ ...config.swarm, maxGlbBytes: config.maxGlbBytes });

  let arkiv;
  let arkivWallet;
  if (MEMORY) {
    const { MemoryArkiv } = await import("../test/fakes.js");
    arkiv = new MemoryArkiv();
    arkivWallet = arkiv.walletFor(business.address);
    log("WARNING: E2E_ARKIV=memory -> Arkiv replaced by an in-memory double");
  } else {
    arkiv = new ArkivCreatureStore(config.arkiv);
    const arkivChain = arkivChainFor({ network: config.arkiv.network, accessKey: config.arkiv.accessKey, rpcUrl: config.arkiv.rpcUrl || null });
    arkivWallet = localAccountArkivWallet(business, arkivChain);
    const bal = await arkiv.publicClient.getBalance({ address: business.address });
    log(`Arkiv ${config.arkiv.network}: business ${business.address} balance ${bal} wei`);
    if (bal === 0n) throw new Error(`Business ${business.address} has no tGLM. Fund it at https://hub.arkiv.network/faucet`);
  }

  const service = new CampaignArkivService({ chain, swarm, arkiv, state, expirationFor, batchSize: config.arkiv.batchSize });
  const listener = new AllocationListener({ chain, state, service, pollIntervalMs: 500 });
  const fulfiller = new LocalVrfFulfiller({ chain, coordinator: deployment.vrfCoordinator, privateKey: keyOf(1), delayMs: 500, pollIntervalMs: 500 });
  listener.run();
  fulfiller.run();
  cleanup.push(() => listener.stop(), () => fulfiller.stop());

  const codes = new DiscountCodeService({ chain, arkiv, cipher: new CodeCipher(config.codeEncryptionKey) });
  const server = createApi({ config, chain, swarm, state, service, codes });
  await new Promise((r) => server.listen(0, r));
  cleanup.push(() => server.close());
  const API = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const init = body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(API + path, init);
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${path}: ${json.error}`), { status: res.status });
    return json;
  };

  // ------------------------------------------------------------------ 1. Swarm upload via the API
  const assets = await call("/api/assets");
  assert.ok(assets.some((a) => a.name === "ember-fox.glb"), "asset folder must contain ember-fox.glb");
  log(`uploading ember-fox.glb to Swarm (${config.swarm.beeUrl})`);
  const upload = await call("/api/swarm/upload", { asset: "ember-fox.glb" });
  assert.match(upload.reference, /^[0-9a-f]{64}$/);
  log("campaign Swarm reference", upload.reference);

  // ------------------------------------------------------------------ 2. business creates the campaign
  const wallet = createWalletClient({ account: business, chain: chain.chain, transport: http(RPC) });
  const counts = [6, 2, 1, 1];
  const now = Math.floor(Date.now() / 1000);
  const input = {
    businessName: "E2E Chai Point",
    swarmReference: upload.reference,
    latitudeE6: 19076090,
    longitudeE6: 72877426,
    expiresAt: BigInt(now + 7 * 86400),
    totalCreatures: 10,
    rarityCounts: counts,
    rewards: [
      { code: "COMMON10", description: "10% off any drink" },
      { code: "RARE25", description: "25% off any drink" },
      { code: "EPIC50", description: "50% off your order" },
      { code: "LEGEND100", description: "Free meal for two" },
    ],
  };
  // Encrypt the codes with the worker's key first (what the page does): only ciphertext goes on-chain.
  const PLAIN_CODES = input.rewards.map((r) => r.code);
  const { codes: encrypted } = await call("/api/discount-codes/encrypt", { business: business.address, codes: PLAIN_CODES });
  input.rewards = input.rewards.map((r, i) => ({ ...r, code: encrypted[i] }));
  assert.ok(encrypted.every(isEncryptedCode));
  const { request, result: campaignId } = await chain.client.simulateContract({
    address: deployment.campaignManager,
    abi: managerAbi,
    functionName: "createCampaign",
    args: [input],
    account: business,
  });
  const txHash = await wallet.writeContract(request);
  await chain.client.waitForTransactionReceipt({ hash: txHash });
  log(`campaign #${campaignId} created by ${business.address}, tx ${txHash}`);

  // ------------------------------------------------------------------ 3. VRF + allocation
  let campaign;
  for (let i = 0; i < 120; i++) {
    campaign = await chain.getCampaign(campaignId);
    if (campaign.statusName === "ALLOCATED") break;
    await sleep(500);
  }
  assert.equal(campaign.statusName, "ALLOCATED", "VRF fulfilment / allocation did not happen");
  const rarities = await chain.read("getRarities", [campaignId]);
  const tally = [0, 0, 0, 0];
  rarities.forEach((r) => tally[r]++);
  assert.deepEqual(tally, counts, "on-chain distribution must be preserved exactly");
  log("allocated:", rarities.map((r) => RARITY[r][0]).join(""), "word", campaign.randomWord.toString(16).slice(0, 12) + "…");

  // ------------------------------------------------------------------ 4. plan (listener prepares the Swarm assets)
  const waitForPlan = async () => {
    for (let i = 0; i < 300; i++) {
      try {
        return await call(`/api/campaigns/${campaignId}/arkiv/plan`, {});
      } catch (err) {
        if (err.status !== 409) throw err;
        await sleep(1000);
      }
    }
    throw new Error("campaign was never prepared");
  };
  const plan = await waitForPlan();
  assert.equal(plan.payloads.length, 10);
  assert.equal(plan.business.toLowerCase(), business.address.toLowerCase());
  log(`plan: ${plan.payloads.length} creatures to sign in batches of ${plan.batchSize}`);

  // ------------------------------------------------------------------ 5. the business signs (page code)
  const signAll = (p) =>
    writeCreatureBatches({
      walletClient: arkivWallet,
      plan: p,
      schemaName: config.arkiv.schemaName,
      onBatch: async (r) => {
        if (r.ok) await call(`/api/campaigns/${campaignId}/arkiv/submissions`, { txHash: r.txHash, entries: r.entries });
      },
    });
  const verifyUntil = async (want) => {
    let report;
    for (let i = 0; i < 15; i++) {
      report = await call(`/api/campaigns/${campaignId}/arkiv/verify`, {});
      if (report.status === want) break;
      await sleep(2000);
    }
    return report;
  };

  if (MEMORY) {
    // Partial failure: 3 creatures fail, the other 7 land.
    const failing = plan.payloads.slice(0, 3).map((p) => p.creatureId);
    failing.forEach((id) => arkiv.failCreatureIds.add(id));
    const first = await signAll(plan);
    assert.equal(first.written, 7);
    const partial = await verifyUntil("PARTIAL");
    assert.equal(partial.status, "PARTIAL");
    assert.deepEqual([...partial.missing].sort(), [...failing].sort());
    arkiv.failCreatureIds.clear();
    const retry = await waitForPlan();
    assert.deepEqual(retry.payloads.map((p) => p.creatureId).sort(), [...failing].sort(), "retry asks only for the 3 missing creatures");
    log("partial failure 7/10 -> retry plan has exactly the 3 missing creatures");
    await signAll(retry);
  } else {
    const r = await signAll(plan);
    log(`signed: ${r.written} written, ${r.failed.length} failed`);
  }
  const report = await verifyUntil("COMPLETE");
  log("arkiv:", report.status, `${report.stored}/10`, "creator", report.creator);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.creator.toLowerCase(), business.address.toLowerCase());

  // ------------------------------------------------------------------ 6. verification
  const view = await call(`/api/campaigns/${campaignId}`);
  const rewards = await chain.getRewards(campaignId);
  assert.equal(view.creatures.length, 10);
  assert.equal(new Set(view.creatures.map((c) => c.creatureId)).size, 10, "unique creature IDs");
  assert.equal(new Set(view.creatures.map((c) => c.arkivEntityKey)).size, 10, "one Arkiv entity per creature");
  assert.equal(new Set(view.creatures.map((c) => c.swarmReference)).size, 10, "distinct Swarm reference per creature");
  assert.ok(rewards.every((r, i) => isEncryptedCode(r.code) && !r.code.includes(PLAIN_CODES[i])), "on-chain codes are ciphertext");
  for (const c of view.creatures) {
    assert.equal(c.discountCode, rewards[RARITY.indexOf(c.rarity)].code);
    assert.equal(c.discountCodeEncrypted, true);
    assert.equal(c.arkivOwner.toLowerCase(), business.address.toLowerCase(), "$owner is the business");
  }

  const inArkiv = await arkiv.findCampaignEntities({ creator: business.address, chainId: CHAIN_ID, contract: deployment.campaignManager, campaignId });
  assert.equal(inArkiv.size, 10, "Arkiv holds exactly 10 creature entities created by the business");
  assert.ok([...inArkiv.values()].every((e) => e.length === 1), "no duplicate entities");

  const sample = view.creatures.find((c) => c.rarity === "LEGENDARY");
  if (MEMORY) {
    const e = arkiv.entities.get(sample.arkivEntityKey);
    assert.equal(e.creator, business.address);
    assert.equal(e.values.discountCode, rewards[3].code, "Arkiv holds the ciphertext, not the code");
    assert.equal(e.values.listed, false);
    assert.equal(e.values.catched, false);
    assert.equal(e.values.redeemed, false);
    assert.equal("price" in e.values, false);
  } else {
    const e = await arkiv.publicClient.getEntity(sample.arkivEntityKey, arkiv.schema);
    assert.equal(e.$creator.toLowerCase(), business.address.toLowerCase(), "$creator is the business");
    assert.equal(e.$owner.toLowerCase(), business.address.toLowerCase(), "$owner is the business");
    assert.equal(e.creatureId.value, sample.creatureId);
    assert.equal(e.rarity.value, "LEGENDARY");
    assert.equal(e.discountCode.value, rewards[3].code, "Arkiv holds the ciphertext, not the code");
    assert.equal(e.swarmReference.value, sample.swarmReference);
    assert.equal(e.campaignTxHash.value, txHash);
    assert.equal(e.listed.value, false);
    assert.equal(e.catched.value, false);
    assert.equal(e.redeemed.value, false);
    assert.equal(e.price, undefined, "price is not set (null)");
    log("Arkiv entity", sample.arkivEntityKey, "$creator = $owner =", e.$owner);
  }

  const glb = await swarm.download(sample.swarmReference);
  const parsed = parseGlb(glb.data);
  assert.equal(parsed.json.asset.extras.creature.creatureId, sample.creatureId, "Swarm asset is the creature's own model");
  log("Swarm asset for creature", sample.creatureId, "retrieved and valid,", glb.data.length, "bytes");

  // ------------------------------------------------------------------ 7. discount code reveal (signed)
  const signedReveal = async (account, creatureId = null) => {
    const issuedAt = new Date().toISOString();
    const message = revealMessage({ chainId: CHAIN_ID, contract: deployment.campaignManager, campaignId, creatureId, address: account.address, issuedAt });
    return { address: account.address, issuedAt, creatureId, signature: await account.signMessage({ message }) };
  };
  const revealed = await call(`/api/campaigns/${campaignId}/discount-codes/reveal`, await signedReveal(business));
  assert.deepEqual(revealed.codes.map((c) => c.code), PLAIN_CODES, "the business gets its plaintext codes back");
  const one = await call(`/api/campaigns/${campaignId}/discount-codes/reveal`, await signedReveal(business, sample.creatureId));
  assert.equal(one.code, "LEGEND100");
  const stranger = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(call(`/api/campaigns/${campaignId}/discount-codes/reveal`, await signedReveal(stranger)), (e) => e.status === 403);
  log("discount codes: ciphertext on-chain + on Arkiv; business reveal OK; stranger refused (403)");

  // ------------------------------------------------------------------ 8. idempotency
  const again = await waitForPlan();
  assert.equal(again.payloads.length, 0, "nothing left to sign: a re-run cannot create duplicates");
  assert.equal((await call(`/api/campaigns/${campaignId}/arkiv/verify`, {})).status, "COMPLETE");

  log("ALL END-TO-END CHECKS PASSED");
}

main()
  .then(() => (process.exitCode = 0))
  .catch((err) => {
    console.error("[e2e] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {}
    }
    setTimeout(() => process.exit(process.exitCode), 200);
  });
