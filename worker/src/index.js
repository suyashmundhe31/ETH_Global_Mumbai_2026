// Worker entrypoint: HTTP API + RarityAllocated listener + (local only) VRF mock fulfiller.
// The worker holds no Arkiv key: the business signs its creature entities in MetaMask.
import { ArkivCreatureStore, expirationFor } from "./arkiv.js";
import { CampaignArkivService } from "./campaignArkiv.js";
import { CampaignChain } from "./chain.js";
import { assertRuntimeConfig, buildConfig, loadEnvFile } from "./config.js";
import { CodeCipher, DiscountCodeService } from "./discountCodes.js";
import { AllocationListener } from "./listener.js";
import { createApi } from "./server.js";
import { JsonStateStore } from "./state.js";
import { SwarmService } from "./swarm.js";
import { createLogger } from "./util.js";
import { LocalVrfFulfiller } from "./vrfMockFulfiller.js";

loadEnvFile();
const log = createLogger("worker");
const config = buildConfig();
const problems = assertRuntimeConfig(config);
if (problems.length) {
  for (const p of problems) log.error(p);
  process.exit(1);
}
if (process.env.ARKIV_PRIVATE_KEY) {
  log.warn("ARKIV_PRIVATE_KEY is set but no longer used (the business signs Arkiv entities). Remove it from worker/.env.");
}

const state = new JsonStateStore(config.stateFile);
const chain = new CampaignChain(config.chain);
const swarm = new SwarmService({ ...config.swarm, maxGlbBytes: config.maxGlbBytes });
const arkiv = new ArkivCreatureStore(config.arkiv);
const service = new CampaignArkivService({ chain, swarm, arkiv, state, expirationFor, batchSize: config.arkiv.batchSize });

const codes = new DiscountCodeService({ chain, arkiv, cipher: new CodeCipher(config.codeEncryptionKey) });

const listener = new AllocationListener({ chain, state, service, ...config.chain });
const api = createApi({ config, chain, swarm, state, service, codes });

api.listen(config.port, () => {
  log.info(`API on http://localhost:${config.port}`);
  log.info(`chain ${config.chain.chainId} via ${config.chain.rpcUrl}, CreatureCampaignManager ${chain.address}`);
  log.info(`Swarm ${config.swarm.beeUrl} | Arkiv ${config.arkiv.network} schema ${config.arkiv.schemaName} (entities signed by each business) | VRF ${config.vrf.mode}`);
});
listener.run();

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
  api.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
