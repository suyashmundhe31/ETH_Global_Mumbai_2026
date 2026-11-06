// Copies contract ABIs from the Foundry build output into the worker and frontend.
// Run after `forge build` whenever the contract interface changes:
//   node scripts/sync-abi.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "contracts", "out");

const read = (file, name) => JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8")).abi;

const manager = read("CreatureCampaignManager.sol", "CreatureCampaignManager");
// Only the pieces the local-network VRF simulator needs from Chainlink's official mock.
const mock = read("VRFCoordinatorV2_5Mock.sol", "VRFCoordinatorV2_5Mock").filter(
  (e) =>
    (e.type === "event" && ["RandomWordsRequested", "RandomWordsFulfilled"].includes(e.name)) ||
    (e.type === "function" && e.name === "fulfillRandomWords"),
);

for (const target of [join(root, "worker", "src", "abi"), join(root, "frontend", "src", "abi")]) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "CreatureCampaignManager.json"), JSON.stringify(manager, null, 2) + "\n");
  writeFileSync(join(target, "VRFCoordinatorV2_5Mock.json"), JSON.stringify(mock, null, 2) + "\n");
  console.log("ABIs written to", target);
}
