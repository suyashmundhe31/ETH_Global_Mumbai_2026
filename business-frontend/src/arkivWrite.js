// The business writes its creature entities to Arkiv, signing in its own wallet, so Arkiv records
// the business wallet as each entity's $creator and $owner (nothing is hard-coded).
// Uses the official @arkiv-network/sdk wallet client: with a browser wallet it sends through
// viem's writeContract -> eth_sendTransaction, i.e. MetaMask asks the business to confirm.
import * as sdk from "@arkiv-network/sdk";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { localhost, rabdi } from "@arkiv-network/sdk/chains";
import { custom, http, numberToHex } from "viem";
import { BatchTooLargeError, GAS_FLOOR, GAS_PER_EXTRA_OP, rabdiBatchTxParams as sharedTxParams } from "../../shared/arkivGas.js";
import { creatureCreates, creatureExpiration, defineCreatureSchema } from "../../shared/creatureEntity.js";

/** Arkiv chain for the wallet. accessKey is optional (public Rabdi endpoint when empty). */
export function arkivChainFor({ network = "rabdi", accessKey = "", rpcUrl = null } = {}) {
  if (network === "rabdi") return rabdi({ accessKey });
  if (network === "localhost") return rpcUrl ? { ...localhost, rpcUrls: { default: { http: [rpcUrl] } } } : localhost;
  throw new Error(`Unsupported Arkiv network "${network}"`);
}

/** Switches MetaMask to the Arkiv chain, adding it first if MetaMask does not know it. */
export async function ensureArkivNetwork(ethereum, chain) {
  const chainIdHex = numberToHex(chain.id);
  if (Number(await ethereum.request({ method: "eth_chainId" })) === chain.id) return;
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (err) {
    if (err?.code !== 4902) throw new Error(`Please switch your wallet to ${chain.name} (chain ${chain.id}).`);
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: `Arkiv ${chain.name}`,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
  const now = Number(await ethereum.request({ method: "eth_chainId" }));
  if (now !== chain.id) throw new Error(`Wrong network: expected Arkiv chain ${chain.id}, wallet is on ${now}.`);
}

/** Arkiv wallet client that signs through MetaMask as `account` (the business address). */
export function metaMaskArkivWallet(ethereum, account, chain) {
  return createWalletClient({ chain, transport: custom(ethereum), account });
}

/**
 * predictKeys for writeCreatureBatches: the keys `owner`'s next creates will get (SDK predictEntityKeys,
 * an eth_call of the owner's entity nonce), read through the SAME node the wallet sends to.
 */
export function entityKeyPredictor(transport, chain, owner) {
  const reader = createPublicClient({ chain, transport, cacheTime: 0 });
  return (count) => reader.predictEntityKeys({ owner, count });
}

/** Same client for a local viem account (scripts / end-to-end tests only; never in the browser). */
export function localAccountArkivWallet(account, chain) {
  return createWalletClient({ chain, transport: http(), account });
}

export function isUserRejection(err) {
  for (let e = err; e; e = e.cause) {
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
  }
  return false;
}

/** Transaction hash carried by an SDK/viem error (e.g. EntityMutationError.txHash), if any. */
export function txHashOf(err) {
  for (let e = err; e; e = e.cause) {
    if (typeof e.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(e.txHash)) return e.txHash;
  }
  return undefined;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---------------------------------------------------------------- Rabdi gas policy (arkiv-write-safety)
// Shared with the worker's settler (shared/arkivGas.js); this page passes its own SDK copy.
export { BatchTooLargeError, GAS_FLOOR, GAS_PER_EXTRA_OP };

/**
 * Explicit { gas, gasPrice } for one batch (see shared/arkivGas.js). `batch` is the exact executeBatch
 * input; `creates` alone is accepted for a create-only batch.
 * @param p.request EIP-1193 `request` of the node the wallet sends to (window.ethereum.request in the page)
 */
export function rabdiBatchTxParams({ request, account, chain, creates, batch }) {
  return sharedTxParams({ createWalletClient, custom }, { request, account, chain, batch: batch ?? { creates } });
}

/**
 * Signs the plan's creatures in batches (each batch is one atomic Arkiv transaction).
 *
 * arkiv-write-safety: a JavaScript error does not prove the chain rejected a write, so the run
 * STOPS at the first failed batch instead of sending more. If the failed batch has a transaction
 * hash it is reported (onBatch `txHash`), so the worker holds those creatures back until Arkiv
 * shows the outcome; everything else not written shows up as missing in the next plan.
 *
 * @param {object} p
 * @param {{executeBatch: Function}} p.walletClient Arkiv wallet client of the business
 * @param {{payloads: object[], batchSize: number, expiresAtUnix: string}} p.plan from POST /arkiv/plan
 * @param {string} p.schemaName
 * @param {() => Promise<void>} [p.beforeBatch] re-check account/chain before every signature; throw to stop
 * @param {(batch: object) => Promise<object>} [p.txParamsFor] explicit TxParams per batch (rabdiBatchTxParams)
 * @param {string} [p.settleTo] AUTO SETTLE: hand every created creature to this settler address in the
 *   SAME atomic batch ($creator stays the business, $owner becomes the settler)
 * @param {(count: number) => Promise<{key: string, salt: bigint}[]>} [p.predictKeys] required with settleTo:
 *   the keys this signer's next creates will get (SDK predictEntityKeys)
 * @param {(r: {ok: boolean, sent?: boolean, txHash?: string, entries?: object[], creatureIds: string[], error?: Error}) => any} [p.onBatch]
 */
export async function writeCreatureBatches({ walletClient, plan, schemaName, beforeBatch, txParamsFor, settleTo, predictKeys, onBatch, nowMs = Date.now() }) {
  if (settleTo && !predictKeys) throw new TypeError("settleTo needs predictKeys");
  const schema = defineCreatureSchema(sdk, schemaName);
  const { expiration } = creatureExpiration(sdk, plan.expiresAtUnix, nowMs);
  let written = 0;
  const failed = [];
  let rejected = false;
  let uncertain = false;
  const queue = chunk(plan.payloads, Math.max(1, plan.batchSize || 8));
  while (queue.length) {
    const group = queue.shift();
    const creatureIds = group.map((p) => p.creatureId);
    const creates = creatureCreates(sdk, schema, group, expiration);
    let sent = false;
    let batch = { creates };
    let predicted;
    try {
      await beforeBatch?.();
      if (settleTo) {
        // Same transaction: creates first, then ownership changes (SDK order), so the batch is atomic.
        // A stale prediction makes the unsigned estimate fail, i.e. before anything is signed.
        predicted = await predictKeys(group.length);
        if (predicted.length !== group.length) throw new Error("Entity key prediction returned the wrong count");
        creates.forEach((c, i) => (c.salt = predicted[i].salt));
        batch = { creates, ownershipChanges: predicted.map((p) => ({ entityKey: p.key, newOwner: settleTo })) };
      }
      let txParams;
      try {
        txParams = txParamsFor ? await txParamsFor(batch) : undefined;
      } catch (err) {
        // Nothing signed yet ("unprepared work"): split an oversized batch and estimate the halves.
        if (err instanceof BatchTooLargeError && group.length > 1) {
          const half = Math.ceil(group.length / 2);
          queue.unshift(group.slice(0, half), group.slice(half));
          continue;
        }
        throw err;
      }
      sent = true; // from here the wallet may broadcast: an error no longer proves nothing was sent
      const res = await walletClient.executeBatch(batch, txParams);
      if (predicted && res.createdEntities.some((k, i) => k.toLowerCase() !== predicted[i].key.toLowerCase())) {
        // Cannot happen for a successful atomic batch (the transfers name these keys); stop loudly if it does.
        throw Object.assign(new Error("Created keys differ from the predicted keys"), { txHash: res.txHash });
      }
      const entries = group.map((p, i) => ({ creatureId: p.creatureId, entityKey: res.createdEntities[i] }));
      written += entries.length;
      await onBatch?.({ ok: true, sent, txHash: res.txHash, entries, creatureIds });
    } catch (error) {
      failed.push(...creatureIds);
      rejected = isUserRejection(error);
      uncertain = sent && !rejected;
      await onBatch?.({ ok: false, sent, rejected, txHash: txHashOf(error), error, creatureIds });
      break;
    }
  }
  return { written, failed, rejected, uncertain };
}

/**
 * APPROVAL campaigns: the business approves claims recorded on CreatureMarket. One atomic batch per group:
 * patch catched = true (and redeemed as on chain), then ownership -> the player (SDK order: patches first).
 * Stops at the first failure (arkiv-write-safety); the worker's next view lists whatever is still pending,
 * so approving again finishes the job without double transfers (only entities the business holds are listed).
 *
 * @param p.approvals [{ creatureId, entityKey, player, redeemed }] from the worker's campaign view
 * @param p.txParamsFor explicit TxParams per batch (rabdiBatchTxParams); BatchTooLargeError splits the group
 */
export async function approveCatches({ walletClient, approvals, schemaName, batchSize = 8, beforeBatch, txParamsFor, onBatch }) {
  const schema = defineCreatureSchema(sdk, schemaName);
  const queue = chunk(approvals, Math.max(1, batchSize));
  let approved = 0;
  while (queue.length) {
    const group = queue.shift();
    const creatureIds = group.map((a) => a.creatureId);
    const batch = {
      patches: group.map((a) => ({ schema, entityKey: a.entityKey, set: { catched: true, redeemed: Boolean(a.redeemed) } })),
      ownershipChanges: group.map((a) => ({ entityKey: a.entityKey, newOwner: a.player })),
    };
    let sent = false;
    try {
      await beforeBatch?.();
      let txParams;
      try {
        txParams = txParamsFor ? await txParamsFor(batch) : undefined;
      } catch (err) {
        if (err instanceof BatchTooLargeError && group.length > 1) {
          const half = Math.ceil(group.length / 2);
          queue.unshift(group.slice(0, half), group.slice(half));
          continue;
        }
        throw err;
      }
      sent = true;
      const res = await walletClient.executeBatch(batch, txParams);
      approved += group.length;
      await onBatch?.({ ok: true, txHash: res.txHash, creatureIds });
    } catch (error) {
      const rejected = isUserRejection(error);
      await onBatch?.({ ok: false, sent, rejected, txHash: txHashOf(error), error, creatureIds });
      return { approved, failed: creatureIds, rejected, uncertain: sent && !rejected };
    }
  }
  return { approved, failed: [], rejected: false, uncertain: false };
}
