// Builds the settler from config (worker + end-to-end test use the same wiring).
import { createWalletClient } from "@arkiv-network/sdk";
import { custom, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rabdiBatchTxParams } from "../../shared/arkivGas.js";
import { MarketChain } from "./marketChain.js";
import { MarketSettler } from "./settler.js";

/** Address of the settler wallet. */
export function settlerAddressOf(config) {
  return privateKeyToAccount(config.settlement.privateKey).address;
}

/**
 * @param o.wallet optional wallet override (tests: in-memory Arkiv); default = SDK wallet client on Arkiv
 * @param o.gasPolicy false to skip the explicit Rabdi gas policy (tests without an Arkiv node)
 */
export function createSettler({ config, chain, arkiv, state, wallet, gasPolicy = true, pollIntervalMs, sweepIntervalMs, logger }) {
  const account = privateKeyToAccount(config.settlement.privateKey);
  const settlerWallet = wallet ?? createWalletClient({ chain: arkiv.chain, transport: http(), account });
  const txParamsFor = gasPolicy
    ? (batch) => rabdiBatchTxParams({ createWalletClient, custom }, { request: (args) => arkiv.publicClient.request(args), account, chain: arkiv.chain, batch })
    : undefined;
  const market = new MarketChain({ chain, address: config.settlement.creatureMarket });
  const settler = new MarketSettler({
    chain,
    market,
    arkiv,
    wallet: settlerWallet,
    account,
    schema: arkiv.schema,
    state,
    txParamsFor,
    startBlock: config.settlement.startBlock,
    confirmations: config.chain.confirmations,
    pollIntervalMs: pollIntervalMs ?? config.chain.pollIntervalMs,
    sweepIntervalMs: sweepIntervalMs ?? config.settlement.sweepIntervalMs,
    escrowGraceMs: config.settlement.escrowGraceMs,
    logRange: config.chain.logRange,
    retryDelayMs: config.settlement.retryDelayMs,
    logger,
  });
  return { settler, market, address: account.address };
}

/** Startup check: the deployed CreatureMarket must trust this settler and read this campaign manager. */
export async function checkMarketWiring({ market, settlerAddress, campaignManager }) {
  const [onChainSettler, manager] = await Promise.all([market.read("settler"), market.read("campaignManager")]);
  const problems = [];
  if (onChainSettler.toLowerCase() !== settlerAddress.toLowerCase()) {
    problems.push(`CreatureMarket.settler() is ${onChainSettler}, but SETTLER_PRIVATE_KEY is ${settlerAddress}. Redeploy with SETTLER_ADDRESS=${settlerAddress} or call setSettler.`);
  }
  if (manager.toLowerCase() !== campaignManager.toLowerCase()) {
    problems.push(`CreatureMarket.campaignManager() is ${manager}, not CAMPAIGN_MANAGER_ADDRESS ${campaignManager}.`);
  }
  return problems;
}
