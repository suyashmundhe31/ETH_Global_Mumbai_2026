// End-to-end integration test of the whole pipeline on a throwaway local chain:
//   Anvil -> forge DeployLocal (real contract + Chainlink VRFCoordinatorV2_5Mock)
//   -> worker HTTP API: Swarm upload of the .glb (real Swarm via SWARM_BEE_URL)
//   -> business wallet sends createCampaign (what MetaMask does in the UI)
//   -> local VRF simulator fulfils -> on-chain Fisher–Yates allocation
//   -> listener prepares per-creature Swarm assets -> API plan
//   -> the BUSINESS signs one Arkiv entity per creature (business-frontend/src/arkivWrite.js, the page's code)
//   -> verification against the chain, Swarm and Arkiv ($creator = $owner = business); re-plan is empty.
//   -> CreatureMarket (claim / redeem / marketplace) + the worker's settler:
//        Auto settle: a valid claim moves the creature to the player automatically; an invalid one moves nothing
//        Approval: the business approves the claim (business-frontend approveCatches)
//        Redeem: on chain, then the owner (only) gets the plaintext code; Arkiv redeemed = true
//        Marketplace: escrow -> settler attestation -> list -> buy -> settler moves it to the buyer; unlist returns it
//
// Run:  npm run e2e            (from worker/, needs anvil + forge on PATH, and business-frontend deps installed)
// Arkiv: real Rabdi testnet by default. The business key must hold tGLM on Rabdi:
//          E2E_BUSINESS_PRIVATE_KEY=<0x key funded at https://hub.arkiv.network/faucet>
//        E2E_ARKIV=memory swaps in an in-memory Arkiv double (then Arkiv is NOT really tested) and
//        additionally injects a partial failure (3 of 10 creatures) to exercise the retry.
//        E2E_SWARM=memory swaps in an in-memory Swarm double (when the public gateway is down).
//        Real Arkiv also needs E2E_SETTLER_PRIVATE_KEY (funded with tGLM); player-signed Arkiv writes
//        (redeemed flag, marketplace escrow) only run with E2E_ARKIV=memory (dev keys hold no tGLM).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { approveCatches, arkivChainFor, entityKeyPredictor, localAccountArkivWallet, rabdiBatchTxParams, writeCreatureBatches } from "../../business-frontend/src/arkivWrite.js";
import managerAbi from "../src/abi/CreatureCampaignManager.json" with { type: "json" };
import { ArkivCreatureStore, creatureSchema, expirationFor } from "../src/arkiv.js";
import { CampaignArkivService } from "../src/campaignArkiv.js";
import { CampaignChain, RARITY } from "../src/chain.js";
import { buildConfig, loadEnvFile, REPO_ROOT } from "../src/config.js";
import { CodeCipher, DiscountCodeService, isEncryptedCode } from "../src/discountCodes.js";
import { revealMessage } from "../../shared/discountCodes.js";
import { u64 } from "@arkiv-network/sdk";
import { randomBytes } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";
import { parseGlb } from "../src/glb.js";
import { AllocationListener } from "../src/listener.js";
import { createSettler } from "../src/settlerSetup.js";
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

  // CreatureMarket (compiled by the forge run above): humanSigner = the user app's claim-ticket key,
  // settler = the worker's settler key.
  const SETTLER_KEY = MEMORY ? keyOf(5) : process.env.E2E_SETTLER_PRIVATE_KEY || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(SETTLER_KEY)) throw new Error("Real Arkiv needs E2E_SETTLER_PRIVATE_KEY (a test key funded with tGLM), or run with E2E_ARKIV=memory");
  const settlerAccount = privateKeyToAccount(SETTLER_KEY);
  const humanSigner = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
  const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const MARKET = JSON.parse(readFileSync(join(REPO_ROOT, "contracts", "out", "CreatureMarket.sol", "CreatureMarket.json"), "utf8"));
  const deployerWallet = createWalletClient({ account: deployer, transport: http(RPC), chain: { id: CHAIN_ID, name: "e2e", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } });
  const marketTx = await deployerWallet.deployContract({ abi: MARKET.abi, bytecode: MARKET.bytecode.object, args: [deployment.campaignManager, humanSigner.address, settlerAccount.address, deployer.address] });
  const marketReceipt = await probe.waitForTransactionReceipt({ hash: marketTx });
  const marketAddress = marketReceipt.contractAddress;
  log("CreatureMarket", marketAddress, "| human signer", humanSigner.address, "| settler", settlerAccount.address);

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
    // Anvil here mines only on transactions, so waiting for confirmation blocks would wait forever.
    settlement: { ...base.settlement, privateKey: SETTLER_KEY, creatureMarket: marketAddress, startBlock: marketReceipt.blockNumber, retryDelayMs: 500, sweepIntervalMs: 1000, escrowGraceMs: 3000 },
  };
  config.chain.confirmations = 0n;
  const stateDir = mkdtempSync(join(tmpdir(), "creature-e2e-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const state = new JsonStateStore(join(stateDir, "state.json"));
  const chain = new CampaignChain(config.chain);
  // E2E_SWARM=memory: in-memory Swarm double (for when the public gateway is down); Swarm is then NOT tested.
  const swarm = process.env.E2E_SWARM === "memory" ? new (await import("../test/fakes.js")).FakeSwarm() : new SwarmService({ ...config.swarm, maxGlbBytes: config.maxGlbBytes });
  if (process.env.E2E_SWARM === "memory") log("WARNING: E2E_SWARM=memory -> Swarm replaced by an in-memory double");

  let arkiv;
  let arkivWallet;
  let arkivTxParamsFor;
  if (MEMORY) {
    const { MemoryArkiv } = await import("../test/fakes.js");
    arkiv = new MemoryArkiv();
    arkivWallet = arkiv.walletFor(business.address);
    log("WARNING: E2E_ARKIV=memory -> Arkiv replaced by an in-memory double");
  } else {
    arkiv = new ArkivCreatureStore(config.arkiv);
    const arkivChain = arkivChainFor({ network: config.arkiv.network, accessKey: config.arkiv.accessKey, rpcUrl: config.arkiv.rpcUrl || null });
    arkivWallet = localAccountArkivWallet(business, arkivChain);
    const arkivRpc = createPublicClient({ chain: arkivChain, transport: http() });
    arkivTxParamsFor = (batch) => rabdiBatchTxParams({ request: (args) => arkivRpc.request(args), account: business, chain: arkivChain, batch });
    const bal = await arkiv.publicClient.getBalance({ address: business.address });
    log(`Arkiv ${config.arkiv.network}: business ${business.address} balance ${bal} wei`);
    if (bal === 0n) throw new Error(`Business ${business.address} has no tGLM. Fund it at https://hub.arkiv.network/faucet`);
  }

  const settlerAddress = settlerAccount.address;
  const { settler, market } = createSettler({ config, chain, arkiv, state, wallet: MEMORY ? arkiv.walletFor(settlerAddress) : undefined, gasPolicy: !MEMORY, pollIntervalMs: 300 });
  settler.run();
  cleanup.push(() => settler.stop());
  const service = new CampaignArkivService({ chain, swarm, arkiv, state, expirationFor, batchSize: config.arkiv.batchSize, settler: settlerAddress });
  const listener = new AllocationListener({ chain, state, service, pollIntervalMs: 500 });
  const fulfiller = new LocalVrfFulfiller({ chain, coordinator: deployment.vrfCoordinator, privateKey: keyOf(1), delayMs: 500, pollIntervalMs: 500 });
  listener.run();
  fulfiller.run();
  cleanup.push(() => listener.stop(), () => fulfiller.stop());

  const codes = new DiscountCodeService({ chain, market, cipher: new CodeCipher(config.codeEncryptionKey) });
  const server = createApi({ config, chain, swarm, state, service, codes, arkiv, market, settler, settlerAddress });
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
      // Real Arkiv: the same explicit gas policy as the page (memory mode has no node to estimate on).
      txParamsFor: arkivTxParamsFor,
      onBatch: async (r) => {
        if (r.ok) await call(`/api/campaigns/${campaignId}/arkiv/submissions`, { txHash: r.txHash, entries: r.entries });
        else if (r.sent && r.txHash) await call(`/api/campaigns/${campaignId}/arkiv/submissions`, { txHash: r.txHash, pending: r.creatureIds });
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
    // Partial failure: batch 8 fails, so the run stops (arkiv-write-safety): 7 land, 3 are left.
    const failing = plan.payloads.slice(7).map((p) => p.creatureId);
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

  // ------------------------------------------------------------------ 9. CreatureMarket: claims, settlement, redeem, marketplace
  const asWallet = (account) => createWalletClient({ account, chain: chain.chain, transport: http(RPC) });
  const mined = async (hashPromise) => {
    const receipt = await chain.client.waitForTransactionReceipt({ hash: await hashPromise });
    assert.equal(receipt.status, "success");
    return receipt;
  };
  const marketCall = async (account, functionName, args, value) => {
    const { request: rq } = await chain.client.simulateContract({ address: marketAddress, abi: MARKET.abi, functionName, args, account, value });
    return mined(asWallet(account).writeContract(rq));
  };
  const revertName = async (promise) => {
    try {
      await promise;
    } catch (err) {
      for (let e = err; e; e = e.cause) if (e.data?.errorName) return e.data.errorName;
      throw err;
    }
    throw new Error("expected a revert");
  };
  const player = async (i) => {
    const a = mnemonicToAccount(MNEMONIC, { addressIndex: i });
    await probe.request({ method: "anvil_setBalance", params: [a.address, "0x56BC75E2D63100000"] });
    return a;
  };
  const domain = { name: "CreatureMarket", version: "1", chainId: CHAIN_ID, verifyingContract: marketAddress };
  // What the user app's /api/claim-ticket does for a World ID verified player.
  const ticketFor = async (playerAddress, creatureId) => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const signature = await humanSigner.signTypedData({
      domain,
      types: { Claim: [{ name: "player", type: "address" }, { name: "creatureId", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Claim",
      message: { player: playerAddress, creatureId, deadline },
    });
    return { deadline, signature };
  };
  const claimNext = async (account, id, { latE6 = 19076090, lonE6 = 72877426 } = {}) => {
    const [creatureId] = await chain.client.readContract({ address: marketAddress, abi: MARKET.abi, functionName: "nextCreature", args: [id] });
    const t = await ticketFor(account.address, creatureId);
    await marketCall(account, "claim", [creatureId, latE6, lonE6, t.deadline, t.signature]);
    return creatureId;
  };
  const entityOf = async (id, creatureId) =>
    (await arkiv.findCampaignEntities({ creator: business.address, chainId: CHAIN_ID, contract: deployment.campaignManager, campaignId: id })).get(String(creatureId))?.[0];
  const fullEntity = async (creatureId) => (await arkiv.findCreatureEntities({ creator: business.address, chainId: CHAIN_ID, contract: deployment.campaignManager, creatureId }))[0];
  const until = async (fn, what) => {
    for (let i = 0; i < 80; i++) {
      if (await fn()) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };
  const schema = arkiv.schema ?? creatureSchema(config.arkiv.schemaName);

  // ---- Auto settle campaign: launch, the same batches hand every creature to the settler.
  const autoInput = { ...input, businessName: "E2E Auto Cafe", totalCreatures: 4, rarityCounts: [2, 1, 1, 0] };
  const { request: req2, result: autoId } = await chain.client.simulateContract({ address: deployment.campaignManager, abi: managerAbi, functionName: "createCampaign", args: [autoInput], account: business });
  await mined(wallet.writeContract(req2));
  await until(async () => (await chain.getCampaign(autoId)).statusName === "ALLOCATED", "auto campaign allocation");
  let autoPlan;
  await until(async () => (autoPlan = await call(`/api/campaigns/${autoId}/arkiv/plan`, {}).catch(() => null)), "auto campaign plan");
  assert.equal(autoPlan.settlement.mode, null, "no entities yet: the business chooses");
  assert.equal(autoPlan.settlement.settler, settlerAddress);
  const predictKeys = MEMORY ? (count) => arkiv.predictEntityKeys({ owner: business.address, count }) : entityKeyPredictor(http(), arkivChainFor({ network: config.arkiv.network, accessKey: config.arkiv.accessKey }), business.address);
  const autoRun = await writeCreatureBatches({
    walletClient: arkivWallet,
    plan: autoPlan,
    schemaName: config.arkiv.schemaName,
    txParamsFor: arkivTxParamsFor,
    settleTo: settlerAddress,
    predictKeys,
    onBatch: async (r) => r.ok && (await call(`/api/campaigns/${autoId}/arkiv/submissions`, { txHash: r.txHash, entries: r.entries })),
  });
  assert.equal(autoRun.written, 4);
  await until(async () => (await call(`/api/campaigns/${autoId}/arkiv/verify`, {})).status === "COMPLETE", "auto campaign COMPLETE");
  const autoEntities = await arkiv.findCampaignEntities({ creator: business.address, chainId: CHAIN_ID, contract: deployment.campaignManager, campaignId: autoId });
  assert.ok([...autoEntities.values()].flat().every((e) => e.owner === settlerAddress), "auto settle: $owner = settler, $creator = business");
  log(`auto-settle campaign #${autoId}: 4 creatures created by the business, held by settler ${settlerAddress}`);

  // Valid claim (within 50 m, the campaign's next creature) -> the player gets it on Arkiv automatically.
  const alice = await player(6);
  const aliceId = await claimNext(alice, autoId, { latE6: 19076090 + 300 }); // ~33 m north of the spawn
  await until(async () => (await entityOf(autoId, aliceId))?.owner === alice.address, "automatic transfer to the player");
  assert.equal((await fullEntity(aliceId)).values.catched, true, "catched = true");
  const autoView = await call(`/api/campaigns/${autoId}`);
  assert.equal(autoView.settlement.mode, "auto");
  assert.deepEqual(autoView.settlement.autoSettled.map((x) => [x.creatureId, x.player]), [[String(aliceId), alice.address]], "business notification feed");
  log(`valid claim: creature ${aliceId} transferred to ${alice.address} automatically (business notified)`);

  // Invalid claims are refused on chain and move nothing.
  const bob = await player(7);
  const [nextId] = await chain.client.readContract({ address: marketAddress, abi: MARKET.abi, functionName: "nextCreature", args: [autoId] });
  const far = await ticketFor(bob.address, nextId);
  assert.equal(await revertName(marketCall(bob, "claim", [nextId, 19076090 + 600, 72877426, far.deadline, far.signature])), "TooFar", "67 m away");
  assert.equal(await revertName(claimNext(alice, autoId)), "AlreadyClaimedInCampaign", "one creature per campaign");
  const forged = await ticketFor(bob.address, nextId);
  assert.equal(await revertName(marketCall(alice, "claim", [nextId, 19076090, 72877426, forged.deadline, forged.signature])), "InvalidTicket", "a ticket is bound to its player");
  await sleep(1500);
  const afterInvalid = await arkiv.findCampaignEntities({ creator: business.address, chainId: CHAIN_ID, contract: deployment.campaignManager, campaignId: autoId });
  assert.equal([...afterInvalid.values()].flat().filter((e) => e.owner === settlerAddress).length, 3, "invalid claims: nothing transferred");
  log("invalid claims (too far, second claim, foreign ticket): refused on chain, no ownership transfer");

  // ---- Approval campaign (#1): the claim waits for the business, which approves it.
  const carol = await player(8);
  const carolId = await claimNext(carol, campaignId);
  let approvals;
  await until(async () => (approvals = (await call(`/api/campaigns/${campaignId}`)).settlement.approvals).length === 1, "claim listed for approval");
  assert.equal(approvals[0].creatureId, String(carolId));
  assert.equal(approvals[0].player, carol.address);
  assert.equal((await entityOf(campaignId, carolId)).owner, business.address, "approval: the settler never moves it");
  const approved = await approveCatches({ walletClient: arkivWallet, approvals, schemaName: config.arkiv.schemaName, txParamsFor: arkivTxParamsFor });
  assert.equal(approved.approved, 1);
  await until(async () => (await entityOf(campaignId, carolId))?.owner === carol.address, "approved transfer");
  assert.equal((await fullEntity(carolId)).values.catched, true);
  const apView = await call(`/api/campaigns/${campaignId}`);
  assert.equal(apView.settlement.approvals.length, 0);
  assert.equal(apView.settlement.autoSettled.length, 0, "an approval is never reported as automatic");
  log(`approval campaign #${campaignId}: claim ${carolId} approved by the business -> ${carol.address}`);

  // ---- Redeem: the code is revealed only to the owner, only after redeeming on chain.
  const playerReveal = async (account, creatureId) => {
    const issuedAt = new Date().toISOString();
    const message = revealMessage({ chainId: CHAIN_ID, contract: deployment.campaignManager, campaignId: BigInt(creatureId) >> 32n, creatureId, address: account.address, issuedAt });
    return call(`/api/campaigns/${BigInt(creatureId) >> 32n}/discount-codes/reveal`, { address: account.address, issuedAt, creatureId: String(creatureId), signature: await account.signMessage({ message }) });
  };
  await assert.rejects(playerReveal(carol, carolId), (e) => e.status === 403, "no code before redeeming");
  await marketCall(carol, "redeem", [carolId]);
  const carolRarity = Number((await chain.getCreature(carolId)).rarity);
  assert.equal((await playerReveal(carol, carolId)).code, PLAIN_CODES[carolRarity], "the owner gets the plaintext code");
  await assert.rejects(playerReveal(bob, carolId), (e) => e.status === 403, "nobody else");
  if (MEMORY) {
    const key = (await entityOf(campaignId, carolId)).key;
    await arkiv.walletFor(carol.address).executeBatch({ patches: [{ schema, entityKey: key, set: { redeemed: true } }] });
    assert.equal((await fullEntity(carolId)).values.redeemed, true);
  }
  log(`redeem: creature ${carolId} redeemed on chain; code revealed to its owner only`);

  // ---- Marketplace (player-signed Arkiv writes: memory mode only).
  if (!MEMORY) {
    log("marketplace checks SKIPPED on real Arkiv (player dev keys hold no tGLM); run with E2E_ARKIV=memory");
  } else {
    const price = 10n ** 15n; // 0.001 ETH
    const aliceKey = (await entityOf(autoId, aliceId)).key;
    const escrow = (who, key, p) =>
      arkiv.walletFor(who.address).executeBatch({ patches: [{ schema, entityKey: key, set: { listed: true, price: u64(p) } }], ownershipChanges: [{ entityKey: key, newOwner: settlerAddress }] });

    // A redeemed creature can never be sold.
    await assert.rejects(call("/api/market/attest", { creatureId: String(carolId), seller: carol.address, price: price.toString() }), (e) => e.status === 409);

    await escrow(alice, aliceKey, price);
    const att = await call("/api/market/attest", { creatureId: String(aliceId), seller: alice.address, price: price.toString() });
    await marketCall(alice, "list", [aliceId, price, BigInt(att.deadline), att.signature]);
    await sleep(1500);
    assert.equal((await entityOf(autoId, aliceId)).owner, settlerAddress, "listed: stays in escrow");
    log(`listed: creature ${aliceId} for ${price} wei (settler attestation accepted on chain)`);

    const before = await chain.client.getBalance({ address: alice.address });
    await marketCall(bob, "buy", [aliceId], price);
    assert.equal(await chain.client.getBalance({ address: alice.address }), before + price, "the seller is paid");
    await until(async () => (await entityOf(autoId, aliceId))?.owner === bob.address, "sale mirrored on Arkiv");
    const sold = await fullEntity(aliceId);
    assert.equal(sold.values.listed, false);
    assert.equal(sold.values.price, undefined, "price unset");
    assert.deepEqual((await call(`/api/campaigns/${autoId}`)).settlement.sales.map((x) => [x.creatureId, x.buyer]), [[String(aliceId), bob.address]]);
    log(`bought: ${bob.address} paid ${price} wei to the seller; the settler moved the creature to the buyer`);

    // The buyer lists it again, then unlists: it comes back.
    await escrow(bob, aliceKey, 2n * price);
    const att2 = await call("/api/market/attest", { creatureId: String(aliceId), seller: bob.address, price: (2n * price).toString() });
    await marketCall(bob, "list", [aliceId, 2n * price, BigInt(att2.deadline), att2.signature]);
    await marketCall(bob, "unlist", [aliceId]);
    await until(async () => (await entityOf(autoId, aliceId))?.owner === bob.address, "unlist returns it");
    assert.equal((await fullEntity(aliceId)).values.listed, false);
    log("unlisted: the settler handed the creature back to its owner");

    // An escrow that is never listed on chain goes back after the grace period.
    await escrow(bob, aliceKey, price);
    await until(async () => (await entityOf(autoId, aliceId))?.owner === bob.address, "abandoned escrow returned");
    log("abandoned escrow: returned to its owner automatically");
  }

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
