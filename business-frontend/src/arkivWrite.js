// The business writes its creature entities to Arkiv, signing in its own wallet, so Arkiv records
// the business wallet as each entity's $creator and $owner (nothing is hard-coded).
// Uses the official @arkiv-network/sdk wallet client: with a browser wallet it sends through
// viem's writeContract -> eth_sendTransaction, i.e. MetaMask asks the business to confirm.
import * as sdk from "@arkiv-network/sdk";
import { createWalletClient } from "@arkiv-network/sdk";
import { localhost, rabdi } from "@arkiv-network/sdk/chains";
import { custom, http, numberToHex } from "viem";
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

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Signs the plan's creatures in independent batches (each batch is one atomic Arkiv transaction).
 * A failed batch does not stop the others; a rejected signature stops the run. Whatever is not
 * written shows up as missing in the next plan, which is how retries work.
 *
 * @param {object} p
 * @param {{executeBatch: Function}} p.walletClient Arkiv wallet client of the business
 * @param {{payloads: object[], batchSize: number, expiresAtUnix: string}} p.plan from POST /arkiv/plan
 * @param {string} p.schemaName
 * @param {(r: {ok: boolean, txHash?: string, entries?: object[], creatureIds: string[], error?: Error}) => any} [p.onBatch]
 */
export async function writeCreatureBatches({ walletClient, plan, schemaName, onBatch, nowMs = Date.now() }) {
  const schema = defineCreatureSchema(sdk, schemaName);
  const { expiration } = creatureExpiration(sdk, plan.expiresAtUnix, nowMs);
  let written = 0;
  const failed = [];
  let rejected = false;
  for (const group of chunk(plan.payloads, Math.max(1, plan.batchSize || 10))) {
    const creatureIds = group.map((p) => p.creatureId);
    try {
      const res = await walletClient.executeBatch({ creates: creatureCreates(sdk, schema, group, expiration) });
      const entries = group.map((p, i) => ({ creatureId: p.creatureId, entityKey: res.createdEntities[i] }));
      written += entries.length;
      await onBatch?.({ ok: true, txHash: res.txHash, entries, creatureIds });
    } catch (error) {
      failed.push(...creatureIds);
      await onBatch?.({ ok: false, error, creatureIds });
      if (isUserRejection(error)) {
        rejected = true;
        break;
      }
    }
  }
  return { written, failed, rejected };
}
