// Rabdi gas policy for Arkiv writes (arkiv-write-safety / arkiv-entity-lifecycle recipes), shared by the
// business page (MetaMask) and the worker's settler (server key). No imports: the caller passes the
// @arkiv-network/sdk `createWalletClient` and viem `custom`, so each package uses its own SDK copy.

/** Raised before anything is signed: the batch must be split. */
export class BatchTooLargeError extends Error {}

export const GAS_FLOOR = 1_000_000n; // one operation
export const GAS_PER_EXTRA_OP = 400_000n; // each further operation in the same batch

// Only reads are allowed while estimating: anything that could sign or send is blocked.
const ESTIMATE_READS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
]);

/** Number of native operations in an executeBatch input. */
export const batchOps = (batch) =>
  ["creates", "patches", "deletes", "extensions", "ownershipChanges"].reduce((n, k) => n + (batch[k]?.length ?? 0), 0);

/**
 * Explicit { gas, gasPrice } for one batch:
 * gas = max(1,000,000 + 400,000 × (ops − 1), 2 × estimate), and at most half the latest block gas limit
 * (otherwise BatchTooLargeError: split it). The estimate is the SDK's own exact unsigned eth_estimateGas
 * for this batch, captured through a guarded transport that refuses every non-read method, so nothing
 * can be signed or broadcast here. Nonce is left to the wallet / signer.
 *
 * @param deps { createWalletClient, custom }
 * @param p.request EIP-1193 `request` of the node the transaction will be sent to
 * @param p.batch the exact executeBatch input ({ creates?, patches?, ownershipChanges?, ... })
 */
export async function rabdiBatchTxParams({ createWalletClient, custom }, { request, account, chain, batch }) {
  let estimate;
  const captured = new Error("unsigned estimate captured");
  const guarded = createWalletClient({
    chain,
    account,
    transport: custom(
      {
        async request(args) {
          if (!ESTIMATE_READS.has(args.method)) throw new Error(`${args.method} blocked during unsigned estimate`);
          if (args.method !== "eth_estimateGas") return request(args);
          const result = await request({ method: "eth_estimateGas", params: [args.params?.[0], "latest"] });
          estimate = BigInt(result);
          throw captured; // stop the SDK right after estimating: it never reaches signing
        },
      },
      { retryCount: 0 },
    ),
  });
  try {
    await guarded.executeBatch(batch);
  } catch (err) {
    if (estimate === undefined) throw new Error(`Unsigned gas estimate failed: ${err.shortMessage || err.message}`, { cause: err });
  }
  if (!(estimate > 0n)) throw new Error("Unsigned gas estimate failed: no positive estimate");
  const ops = batchOps(batch);
  const floor = GAS_FLOOR + GAS_PER_EXTRA_OP * BigInt(Math.max(ops, 1) - 1);
  const gas = 2n * estimate > floor ? 2n * estimate : floor;
  const block = await request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  const blockGasLimit = BigInt(block?.gasLimit ?? 0);
  if (blockGasLimit <= 0n) throw new Error("Latest block gas limit unavailable");
  if (gas > blockGasLimit / 2n) {
    throw new BatchTooLargeError(`A batch of ${ops} operations needs ${gas} gas, over half the block gas limit (${blockGasLimit}); lower ARKIV_BATCH_SIZE`);
  }
  const gasPrice = BigInt(await request({ method: "eth_gasPrice" }));
  return { gas, gasPrice, estimate };
}
