// LOCAL DEMO helper: does what the Launch Campaign page does, without MetaMask, on the local Anvil chain.
// Uploads a .glb through the worker API and sends createCampaign from Anvil's dev account #2.
//   npm run demo -- [asset.glb] [common rare epic legendary]
// Then open http://localhost:5173/?campaign=<id> to watch VRF + Arkiv progress.
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import managerAbi from "../src/abi/CreatureCampaignManager.json" with { type: "json" };
import { CampaignChain } from "../src/chain.js";
import { buildConfig, loadEnvFile } from "../src/config.js";

loadEnvFile();
const config = buildConfig();
if (config.chain.chainId !== 31337) throw new Error("demo-campaign.js only runs against the local Anvil chain (CHAIN_ID=31337)");

const [assetArg, ...countArgs] = process.argv.slice(2);
const counts = countArgs.length === 4 ? countArgs.map(Number) : [6, 2, 1, 1];
const api = `http://localhost:${config.port}`;
const postJson = (path, body) =>
  fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const b = await r.json();
    if (!r.ok) throw new Error(b.error);
    return b;
  });

// Default: the smallest .glb in the assets folder (whatever models you put there).
const asset =
  assetArg ??
  (await fetch(`${api}/api/assets`)
    .then((r) => r.json())
    .then((list) => list.sort((a, b) => a.size - b.size)[0]?.name));
if (!asset) throw new Error("No .glb in the assets folder");
console.log("Asset:", asset);

const up = await postJson("/api/swarm/upload", { asset });
console.log("Swarm reference:", up.reference);

const chain = new CampaignChain(config.chain);
// Anvil's publicly known dev mnemonic, account #2 acts as the business.
const business = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 2 });
const wallet = createWalletClient({ account: business, chain: chain.chain, transport: http(config.chain.rpcUrl) });
const input = {
  businessName: "Demo Chai Point",
  swarmReference: up.reference,
  latitudeE6: 19076090,
  longitudeE6: 72877426,
  expiresAt: 0n,
  totalCreatures: counts.reduce((a, b) => a + b, 0),
  rarityCounts: counts,
  rewards: [
    { code: "COMMON10", description: "10% off any drink" },
    { code: "RARE25", description: "25% off any drink" },
    { code: "EPIC50", description: "50% off your order" },
    { code: "LEGEND100", description: "Free meal for two" },
  ],
};
// Same as the page: codes are encrypted by the worker before they go on-chain.
const { codes: encrypted } = await postJson("/api/discount-codes/encrypt", { business: business.address, codes: input.rewards.map((r) => r.code) });
input.rewards = input.rewards.map((r, i) => ({ ...r, code: encrypted[i] }));
const { request, result } = await chain.client.simulateContract({
  address: chain.address,
  abi: managerAbi,
  functionName: "createCampaign",
  args: [input],
  account: business,
});
const hash = await wallet.writeContract(request);
await chain.client.waitForTransactionReceipt({ hash });
console.log(`Campaign #${result} created by ${business.address} (tx ${hash})`);
console.log(`Open http://localhost:5173/?campaign=${result}`);
