// Minimal HTTP API (node:http, no framework) used by the Launch Campaign page.
// It never holds or accepts private keys: the business signs the campaign transaction AND the Arkiv
// creature entities in MetaMask. The worker prepares payloads and verifies the result.
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { NotAllocatedError, NotReadyError } from "./campaignArkiv.js";
import { CodeAccessError, isEncryptedCode } from "./discountCodes.js";
import { GlbValidationError, parseGlb } from "./glb.js";
import { campaignKey } from "./state.js";
import { createLogger, errMessage, toJson } from "./util.js";

const ASSET_NAME = /^[A-Za-z0-9._-]+\.glb$/;
const SWARM_REF = /^[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApi({ config, chain, swarm, state, service, codes, logger }) {
  const log = logger || createLogger("api");

  async function assetPath(name) {
    if (!ASSET_NAME.test(name)) throw new HttpError(400, "Invalid asset name");
    const base = resolve(config.assetsDir);
    const full = resolve(base, name);
    if (!full.startsWith(base + sep)) throw new HttpError(400, "Invalid asset path");
    try {
      await stat(full);
    } catch {
      throw new HttpError(404, `Asset ${name} not found`);
    }
    return full;
  }

  async function campaignView(id) {
    let onChain;
    try {
      onChain = await chain.getCampaign(id);
    } catch (err) {
      throw new HttpError(404, `Campaign ${id} not found on-chain: ${errMessage(err)}`);
    }
    const rewards = await chain.getRewards(id);
    const key = campaignKey(chain.chainId, chain.address, BigInt(id));
    const recorded = state.getCampaign(key) || { creatures: {} };
    // Arkiv results recorded under another schema version (e.g. v1, worker-owned) are not shown as
    // current; the page re-verifies against Arkiv.
    const current = recorded.arkivSchema === config.arkiv.schemaName;
    const st = current
      ? recorded
      : { ...recorded, status: undefined, stored: 0, missing: [], duplicates: [], mismatched: [], verifiedAt: null, prepared: false,
          creatures: Object.fromEntries(Object.entries(recorded.creatures || {}).map(([id, c]) => [id, { swarmReference: c.swarmReference }])) };
    let creatures = [];
    if (onChain.statusName === "ALLOCATED") {
      creatures = (await chain.getAllCreatures(id, Number(onChain.totalCreatures))).map((c) => {
        const s = st.creatures?.[c.creatureId.toString()] || {};
        return {
          creatureId: c.creatureId.toString(),
          index: c.index,
          rarity: c.rarityName,
          discountCode: c.discountCode, // ciphertext unless the campaign predates encryption
          discountCodeEncrypted: isEncryptedCode(c.discountCode),
          discountDescription: c.discountDescription,
          swarmReference: s.swarmReference || null,
          arkivEntityKey: s.arkivEntityKey || null,
          arkivOwner: s.arkivOwner || null,
          arkivStatus: s.arkivStatus || "PENDING",
          lastError: s.lastError || null,
        };
      });
    }
    const txs = st.creationTxHash ? st : await chain.getCampaignTxHashes(id).catch(() => ({}));
    return {
      campaignId: String(id),
      chainId: chain.chainId,
      contract: chain.address,
      onChain: {
        status: onChain.statusName,
        business: onChain.business,
        businessName: onChain.businessName,
        totalCreatures: onChain.totalCreatures,
        rarityCounts: onChain.rarityCounts,
        rewards,
        swarmReference: onChain.swarmReference,
        latitudeE6: onChain.latitudeE6,
        longitudeE6: onChain.longitudeE6,
        expiresAt: onChain.expiresAt,
        createdAt: onChain.createdAt,
        allocatedAt: onChain.allocatedAt,
        vrfRequestId: onChain.vrfRequestId,
        randomWord: onChain.randomWord,
      },
      txs: { creationTxHash: txs.creationTxHash ?? null, allocationTxHash: txs.allocationTxHash ?? null },
      arkiv: {
        status: st.status || (onChain.statusName === "ALLOCATED" ? "PREPARING" : "WAITING_FOR_VRF"),
        prepared: Boolean(st.prepared),
        stored: st.stored ?? 0,
        missing: st.missing ?? [],
        duplicates: st.duplicates ?? [],
        mismatched: st.mismatched ?? [],
        lastError: st.lastError ?? null,
        verifiedAt: st.verifiedAt ?? null,
        expirationMode: st.expirationMode ?? null,
        creator: onChain.business, // $creator and $owner of every entity = the business wallet
        schema: config.arkiv.schemaName,
        explorer: config.arkiv.explorerUrl,
      },
      creatures,
    };
  }

  const routes = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, chainId: chain.chainId, contract: chain.address, vrfMode: config.vrf.mode, arkivNetwork: config.arkiv.network })],
    [
      "GET",
      /^\/api\/config$/,
      async () => ({
        chainId: chain.chainId,
        rpcUrl: config.chain.publicRpcUrl,
        campaignManager: chain.address,
        vrfMode: config.vrf.mode,
        swarmGateway: config.swarm.publicGatewayUrl,
        arkivExplorer: config.arkiv.explorerUrl,
        arkivNetwork: config.arkiv.network,
        arkivSchema: config.arkiv.schemaName,
        arkivBatchSize: config.arkiv.batchSize,
        // Only for ARKIV_NETWORK=localhost; on Rabdi the browser uses the SDK's chain definition.
        arkivRpcUrl: config.arkiv.network === "localhost" ? config.arkiv.rpcUrl || null : null,
      }),
    ],
    [
      "GET",
      /^\/api\/assets$/,
      async () => {
        const files = (await readdir(config.assetsDir)).filter((f) => ASSET_NAME.test(f));
        return Promise.all(files.map(async (name) => ({ name, size: (await stat(join(config.assetsDir, name))).size })));
      },
    ],
    [
      "GET",
      /^\/api\/assets\/([^/]+)$/,
      async (_req, m) => ({ __file: await readFile(await assetPath(decodeURIComponent(m[1]))), contentType: "model/gltf-binary" }),
    ],
    [
      "POST",
      /^\/api\/swarm\/upload$/,
      async (_req, _m, body) => {
        const name = body?.asset;
        const buf = await readFile(await assetPath(String(name || "")));
        try {
          parseGlb(buf, { maxBytes: config.maxGlbBytes });
        } catch (err) {
          throw new HttpError(422, err.message);
        }
        log.info(`uploading ${name} (${buf.length} bytes) to Swarm`);
        return swarm.uploadGlb(buf, name);
      },
    ],
    [
      "GET",
      /^\/api\/swarm\/bzz\/([0-9a-fA-F]+)$/,
      async (_req, m) => {
        if (!SWARM_REF.test(m[1])) throw new HttpError(400, "Invalid Swarm reference");
        const file = await swarm.download(m[1]);
        return { __file: file.data, contentType: file.contentType || "application/octet-stream" };
      },
    ],
    ["GET", /^\/api\/campaigns\/(\d+)$/, async (_req, m) => campaignView(BigInt(m[1]))],
    // What the business still has to sign (only creatures without a valid entity). Calling it again
    // after any failure IS the retry: it re-reads Arkiv first.
    ["POST", /^\/api\/campaigns\/(\d+)\/arkiv\/plan$/, async (_req, m) => arkivCall(() => service.plan(BigInt(m[1])))],
    // Entity keys returned by a business transaction (re-read from Arkiv, never trusted as-is).
    [
      "POST",
      /^\/api\/campaigns\/(\d+)\/arkiv\/submissions$/,
      async (_req, m, body) => arkivCall(() => service.recordSubmission(BigInt(m[1]), { txHash: body?.txHash, entries: body?.entries })),
    ],
    ["POST", /^\/api\/campaigns\/(\d+)\/arkiv\/verify$/, async (_req, m) => arkivCall(() => service.verify(BigInt(m[1])))],
    // Discount codes: encrypted with the worker's key BEFORE createCampaign, so the chain, the
    // transaction and Arkiv only ever hold ciphertext.
    [
      "POST",
      /^\/api\/discount-codes\/encrypt$/,
      async (_req, _m, body) => arkivCall(() => ({ codes: codes.encryptRewardCodes({ business: body?.business, codes: body?.codes }) })),
    ],
    // Decrypt for a wallet that proves (signature) it is the business, or the creature's Arkiv owner.
    [
      "POST",
      /^\/api\/campaigns\/(\d+)\/discount-codes\/reveal$/,
      async (_req, m, body) =>
        arkivCall(() =>
          codes.reveal({
            campaignId: BigInt(m[1]),
            creatureId: body?.creatureId ?? null,
            address: body?.address,
            issuedAt: body?.issuedAt,
            signature: body?.signature,
          }),
        ),
    ],
  ];

  async function arkivCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotAllocatedError || err instanceof NotReadyError) throw new HttpError(409, err.message);
      if (err instanceof CodeAccessError) throw new HttpError(err.status, err.message);
      if (err instanceof TypeError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new HttpError(413, "Body too large");
      chunks.push(c);
    }
    if (!chunks.length) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const url = new URL(req.url, "http://localhost");
    try {
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const body = method === "POST" ? await readBody(req) : null;
        const out = await handler(req, m, body);
        if (out?.__file) {
          res.writeHead(200, { "Content-Type": out.contentType, "Content-Length": out.__file.length });
          return res.end(out.__file);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(toJson(out));
      }
      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof GlbValidationError ? 422 : 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${errMessage(err)}`);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(toJson({ error: errMessage(err) }));
    }
  });
}
