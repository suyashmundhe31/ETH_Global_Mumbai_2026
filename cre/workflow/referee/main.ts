// Creature referee: the CRE workflow that decides catches and redemptions, so nobody can catch from far
// away and nobody can rig a redemption.
//
//   CatchRequested  -> haversine(player, spawn) <= catchRadiusMeters -> report 1 (CATCH)
//   RedeemRequested -> read owner / redeemed / encrypted code on chain, decrypt (AES-256-GCM, CRE secret),
//                      seal the code to the player's nacl.box key -> report 2 (REDEEM)
//
// Report: abi.encode(uint64 chainSelector, uint8 reportType, bytes payload), decoded by CatchReceiver.
// Consensus: every node must take the same path, so the inputs are the trigger log, EVM reads (consensus
// by the EVM capability) and secrets; the only "randomness" (the box nonce) is derived from the creature id.
// The runtime is QuickJS/WASM: no node:crypto or crypto.subtle, hence @noble/ciphers and tweetnacl.
import {
  bytesToHex,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  LATEST_BLOCK_NUMBER,
  logTriggerConfig,
  Runner,
  TxStatus,
  type EVMLog,
  type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  isAddressEqual,
  parseAbi,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base64ToBytes, codeAad, decryptCode, encodeReport, haversineMeters, sealCode } from "./referee";

type Config = {
  /** CRE chain selector name, e.g. "ethereum-testnet-sepolia-base-1". */
  chainSelectorName: string;
  /** EVM chain id, part of the discount-code AAD (84532). */
  chainId: number;
  catchManager: Address;
  campaignManager: Address;
  /** Report receiver (CatchReceiver). */
  catchReceiver: Address;
  catchRadiusMeters: number;
  /** Gas limit for the report tx (forwarder -> receiver -> CatchManager [-> VRF request]). */
  gasLimit: string;
};

const REPORT_CATCH = 1;
const REPORT_REDEEM = 2;
const SECRET_CODE_KEY = "CODE_ENCRYPTION_KEY"; // base64, 32 bytes (AES-256)
const SECRET_BOX_SK = "WORKFLOW_BOX_SK"; // hex, 32 bytes (X25519 secret key)

const catchAbi = parseAbi([
  "event CatchRequested(uint256 indexed attemptId, uint256 indexed campaignId, address indexed player, int32 playerLatE6, int32 playerLonE6, int32 spawnLatE6, int32 spawnLonE6, bytes worldIdProof)",
  "event RedeemRequested(uint256 indexed creatureId, address indexed owner, bytes32 playerPubKey)",
  "function getCaught(uint256 creatureId) view returns ((address owner, uint64 floatE18, uint64 caughtAt, uint8 rarity, uint256 attemptId))",
  "function redeemed(uint256 creatureId) view returns (bool)",
]);
const campaignAbi = parseAbi([
  "function getCreature(uint256 creatureId) view returns ((uint256 creatureId, uint256 campaignId, uint32 index, address business, string businessName, uint8 rarity, string discountCode, string discountDescription, int32 latitudeE6, int32 longitudeE6, uint64 expiresAt, string swarmReference, uint64 createdAt))",
]);

// ---------------------------------------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------------------------------------

function network(config: Config) {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!net) throw new Error(`Unknown chain ${config.chainSelectorName}`);
  return net;
}

const topicsOf = (log: EVMLog) => log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]];

/** eth_call at the latest block (finalized lags minutes on Base Sepolia). */
function read<T>(runtime: Runtime<Config>, evm: EVMClient, to: Address, abi: readonly unknown[], fn: string, args: readonly unknown[]): T {
  const data = encodeFunctionData({ abi, functionName: fn, args } as never);
  const reply = evm
    .callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: LATEST_BLOCK_NUMBER })
    .result();
  return decodeFunctionResult({ abi, functionName: fn, data: bytesToHex(reply.data) } as never) as T;
}

function submit(runtime: Runtime<Config>, evm: EVMClient, selector: bigint, reportType: number, payload: Hex): string {
  const report = runtime
    .report({
      encodedPayload: hexToBase64(encodeReport(selector, reportType, payload)),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const write = evm
    .writeReport(runtime, { receiver: runtime.config.catchReceiver, report, gasConfig: { gasLimit: runtime.config.gasLimit } })
    .result();
  const tx = write.txHash && write.txHash.length > 0 ? bytesToHex(write.txHash) : "0x";
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`report tx ${TxStatus[write.txStatus]}: ${write.errorMessage ?? ""}`);
  if (write.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
    throw new Error(`CatchReceiver.onReport reverted: ${write.errorMessage ?? ""}`);
  }
  return tx;
}

const onCatchRequested = (runtime: Runtime<Config>, log: EVMLog): string => {
  const { args } = decodeEventLog({ abi: catchAbi, eventName: "CatchRequested", topics: topicsOf(log), data: bytesToHex(log.data) });
  // Spawn coordinates come from the campaign contract (emitted by CatchManager), player coordinates from the player.
  const distance = haversineMeters(args.playerLatE6, args.playerLonE6, args.spawnLatE6, args.spawnLonE6);
  const approved = distance <= runtime.config.catchRadiusMeters;
  const net = network(runtime.config);
  const evm = new EVMClient(net.chainSelector.selector);
  // nullifier 0: World ID is not checked by this workflow (CatchManager skips the human binding for 0).
  const payload = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }], [args.attemptId, approved, 0n]);
  const tx = submit(runtime, evm, net.chainSelector.selector, REPORT_CATCH, payload);
  const msg = `catch attempt=${args.attemptId} distance=${Math.round(distance)}m approved=${approved} tx=${tx}`;
  runtime.log(msg);
  return msg;
};

const onRedeemRequested = (runtime: Runtime<Config>, log: EVMLog): string => {
  const config = runtime.config;
  const { args } = decodeEventLog({ abi: catchAbi, eventName: "RedeemRequested", topics: topicsOf(log), data: bytesToHex(log.data) });
  const { creatureId, owner, playerPubKey } = args;
  const net = network(config);
  const evm = new EVMClient(net.chainSelector.selector);

  // Issue, then await, in a fixed order (deterministic across nodes).
  const caught = read<{ owner: Address }>(runtime, evm, config.catchManager, catchAbi, "getCaught", [creatureId]);
  const isRedeemed = read<boolean>(runtime, evm, config.catchManager, catchAbi, "redeemed", [creatureId]);
  const approved = isAddressEqual(caught.owner, owner) && !isRedeemed;

  let sealed: Hex = "0x";
  if (approved) {
    const creature = read<{ business: Address; rarity: number; discountCode: string }>(
      runtime, evm, config.campaignManager, campaignAbi, "getCreature", [creatureId],
    );
    const key = base64ToBytes(runtime.getSecret({ id: SECRET_CODE_KEY }).result().value);
    const boxSk = hexToBytes(runtime.getSecret({ id: SECRET_BOX_SK }).result().value as Hex);
    if (key.length !== 32 || boxSk.length !== 32) throw new Error("CODE_ENCRYPTION_KEY / WORKFLOW_BOX_SK must be 32 bytes");
    // A failed decrypt is an operator problem (wrong key), not the player's: fail the execution so the pending
    // redeem can be retried after the timeout, instead of reporting a rejection.
    const code = decryptCode(creature.discountCode, key, codeAad(config.chainId, config.campaignManager, creature.business, creature.rarity));
    sealed = sealCode(code, creatureId, playerPubKey, boxSk);
  }

  const payload = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "bytes" }], [creatureId, approved, sealed]);
  const tx = submit(runtime, evm, net.chainSelector.selector, REPORT_REDEEM, payload);
  const msg = `redeem creature=${creatureId} owner=${owner} approved=${approved} tx=${tx}`;
  runtime.log(msg);
  return msg;
};

const initWorkflow = (config: Config) => {
  const evm = new EVMClient(network(config).chainSelector.selector);
  const on = (event: "CatchRequested" | "RedeemRequested") =>
    evm.logTrigger(
      logTriggerConfig({
        addresses: [config.catchManager],
        topics: [[toEventSelector(catchAbi.find((x) => x.type === "event" && x.name === event)!)]],
        confidence: "LATEST", // the receiver ignores stale verdicts, so reorg risk is a wasted report at worst
      }),
    );
  return [handler(on("CatchRequested"), onCatchRequested), handler(on("RedeemRequested"), onRedeemRequested)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
