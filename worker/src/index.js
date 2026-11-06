// Worker entrypoint: HTTP API + RarityAllocated listener + settler (CreatureMarket -> Arkiv) +
// (local only) VRF mock fulfiller. The business signs its creature entities in MetaMask; the worker's only
// Arkiv key is the settler's (Auto-settle creatures and marketplace escrows).
import { ArkivCreatureStore, expirationFor } from "./arkiv.js";
import { CampaignArkivService } from "./campaignArkiv.js";
import { CampaignChain } from "./chain.js";
import { assertRuntimeConfig, buildConfig, loadEnvFile } from "./config.js";
import { CodeCipher, DiscountCodeService } from "./discountCodes.js";
import { AllocationListener } from "./listener.js";
import { createApi } from "./server.js";
import { JsonStateStore } from "./state.js";
import { SwarmService } from "./swarm.js";
import { checkMarketWiring, createSettler } from "./settlerSetup.js";
import { createLogger, errMessage, urlHost } from "./util.js";
import { LocalVrfFulfiller } from "./vrfMockFulfiller.js";

loadEnvFile();
const log = createLogger("worker");
const config = buildConfig();
const problems = assertRuntimeConfig(config);
if (problems.length) {
  for (const p of problems) log.error(p);
  process.exit(1);
}
for (const old of ["ARKIV_PRIVATE_KEY", "CATCH_MANAGER_ADDRESS", "CATCH_START_BLOCK"]) {
  if (process.env[old]) log.warn(`${old} is set but no longer used. Remove it from worker/.env.`);
}

const state = new JsonStateStore(config.stateFile);
const chain = new CampaignChain(config.chain);
const swarm = new SwarmService({ ...config.swarm, maxGlbBytes: config.maxGlbBytes });
const arkiv = new ArkivCreatureStore(config.arkiv);
const { settler, market, address: settlerAddress } = createSettler({ config, chain, arkiv, state });
const service = new CampaignArkivService({ chain, swarm, arkiv, state, expirationFor, batchSize: config.arkiv.batchSize, settler: settlerAddress });

const codes = new DiscountCodeService({ chain, market, cipher: new CodeCipher(config.codeEncryptionKey) });

const listener = new AllocationListener({ chain, state, service, ...config.chain });
const api = createApi({ config, chain, swarm, state, service, codes, arkiv, market, settler, settlerAddress });

const wiring = await checkMarketWiring({ market, settlerAddress, campaignManager: chain.address }).catch((err) => [`Cannot read CreatureMarket at ${market.address}: ${errMessage(err)}`]);
if (wiring.length) {
  for (const p of wiring) log.error(p);
  process.exit(1);
}

api.listen(config.port, () => {
  log.info(`API on http://localhost:${config.port}`);
  log.info(`chain ${config.chain.chainId} via ${urlHost(config.chain.rpcUrl)}, CreatureCampaignManager ${chain.address}`);
  log.info(`Swarm ${config.swarm.beeUrl} | Arkiv ${config.arkiv.network} schema ${config.arkiv.schemaName} (entities signed by each business) | VRF ${config.vrf.mode}`);
});
listener.run();

log.info(`settler ${settlerAddress} follows CreatureMarket ${market.address} (Auto-settle claims, marketplace escrow, sales)`);
arkiv.publicClient
  .getBalance({ address: settlerAddress })
  .then((b) => {
    if (b === 0n) log.warn(`Settler ${settlerAddress} has 0 tGLM on Arkiv: its transfers will fail. Fund it at https://hub.arkiv.network/faucet`);
  })
  .catch((err) => log.warn(`Could not read the settler balance: ${errMessage(err)}`));
settler.run();

if (config.vrf.mode === "mock") {
  if (!config.vrf.localFulfillerKey || !config.vrf.coordinator) {
    log.error("VRF_MODE=mock needs LOCAL_VRF_FULFILLER_PRIVATE_KEY and the mock coordinator address (deployment file).");
  } else {
    new LocalVrfFulfiller({
      chain,
      coordinator: config.vrf.coordinator,
      privateKey: config.vrf.localFulfillerKey,
      delayMs: config.vrf.localFulfillDelayMs,
    }).run();
  }
}

const shutdown = () => {
  listener.stop();
  settler.stop();
  api.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
