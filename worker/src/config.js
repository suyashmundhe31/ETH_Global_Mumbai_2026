import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCHEMA_NAME } from "../../shared/creatureEntity.js";

export const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(WORKER_ROOT, "..");

/** Loads worker/.env if present (Node >= 20.12 built-in, no dotenv dependency). */
export function loadEnvFile(file = join(WORKER_ROOT, ".env")) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const fromWorker = (p) => (isAbsolute(p) ? p : resolve(WORKER_ROOT, p));

function bool(v, dflt) {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export function isLocalUrl(url) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function int(v, dflt) {
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer, got "${v}"`);
  return n;
}

/** Reads contracts/deployments/<chainId>.json written by the Foundry deploy scripts. */
export function readDeployment(chainId) {
  const file = join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function buildConfig(env = process.env) {
  const chainId = int(env.CHAIN_ID, 31337);
  const deployment = readDeployment(chainId);

  const campaignManager = env.CAMPAIGN_MANAGER_ADDRESS || deployment?.campaignManager;
  const vrfMode = env.VRF_MODE || deployment?.vrfMode || "chainlink";

  return {
    port: int(env.PORT, 8787),
    corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    assetsDir: fromWorker(env.ASSETS_DIR || "../assets/creatures"),
    maxGlbBytes: int(env.MAX_GLB_BYTES, 10 * 1024 * 1024),
    stateFile: fromWorker(env.STATE_FILE || "./data/state.json"),

    chain: {
      chainId,
      rpcUrl: env.CHAIN_RPC_URL || "http://127.0.0.1:8545",
      // Sent to the browser via /api/config (MetaMask "add network"). CHAIN_RPC_URL often embeds a
      // provider API key, so it is only reused when it points at a local node.
      publicRpcUrl: env.PUBLIC_RPC_URL || (isLocalUrl(env.CHAIN_RPC_URL || "http://127.0.0.1:8545") ? env.CHAIN_RPC_URL || "http://127.0.0.1:8545" : ""),
      campaignManager,
      startBlock: BigInt(env.START_BLOCK || deployment?.deployBlock || 0),
      confirmations: BigInt(int(env.CONFIRMATIONS, 0)),
      pollIntervalMs: int(env.POLL_INTERVAL_MS, 3000),
      logRange: BigInt(int(env.LOG_RANGE, 2000)),
    },

    vrf: {
      mode: vrfMode, // "mock" (local Anvil only) | "chainlink"
      coordinator: env.VRF_COORDINATOR_ADDRESS || deployment?.vrfCoordinator,
      localFulfillerKey: env.LOCAL_VRF_FULFILLER_PRIVATE_KEY || "",
      localFulfillDelayMs: int(env.LOCAL_VRF_FULFILL_DELAY_MS, 2000),
    },

    swarm: {
      beeUrl: env.SWARM_BEE_URL || "https://api.gateway.ethswarm.org",
      postageBatchId: env.SWARM_POSTAGE_BATCH_ID || "",
      verifyDownload: bool(env.SWARM_VERIFY_DOWNLOAD, true),
      pin: bool(env.SWARM_PIN, false),
      publicGatewayUrl: env.SWARM_PUBLIC_GATEWAY_URL || env.SWARM_BEE_URL || "https://api.gateway.ethswarm.org",
    },

    // AES-256-GCM key for discount codes (base64, 32 bytes). Server-side only: never sent to the browser.
    codeEncryptionKey: env.CODE_ENCRYPTION_KEY || "",

    arkiv: {
      network: env.ARKIV_NETWORK || "rabdi", // "rabdi" | "localhost"
      accessKey: env.ARKIV_ACCESS_KEY ?? "",
      rpcUrl: env.ARKIV_RPC_URL || "",
      // No private key: the business signs the creature entities in MetaMask (it becomes $creator/$owner).
      schemaName: env.ARKIV_SCHEMA_NAME || DEFAULT_SCHEMA_NAME,
      batchSize: int(env.ARKIV_BATCH_SIZE, 10), // creatures per business-signed Arkiv transaction
      explorerUrl: env.ARKIV_EXPLORER_URL || "https://rabdi.explorer.arkiv.network",
    },
  };
}

export function assertRuntimeConfig(config) {
  const problems = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.chain.campaignManager || "")) {
    problems.push(
      "CAMPAIGN_MANAGER_ADDRESS is not set and no contracts/deployments/<CHAIN_ID>.json was found. Deploy the contracts first.",
    );
  }
  if (Buffer.from(config.codeEncryptionKey, "base64").length !== 32) {
    problems.push("CODE_ENCRYPTION_KEY must be set to 32 random bytes, base64 encoded. Generate one with: npm --prefix worker run gen-code-key");
  }
  if (config.arkiv.batchSize < 1 || config.arkiv.batchSize > 100) {
    problems.push("ARKIV_BATCH_SIZE must be between 1 and 100.");
  }
  if (config.vrf.mode === "mock" && config.chain.chainId !== 31337) {
    problems.push("VRF_MODE=mock is only allowed on the local Anvil chain (CHAIN_ID=31337).");
  }
  return problems;
}
