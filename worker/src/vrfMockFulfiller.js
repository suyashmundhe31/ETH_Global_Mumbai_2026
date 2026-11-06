// LOCAL NETWORK ONLY. On Anvil there is no Chainlink node, so this plays its role against
// Chainlink's official VRFCoordinatorV2_5Mock, exactly as the "test locally" guide does by hand:
// it watches RandomWordsRequested and calls mock.fulfillRandomWords(requestId, consumer).
// The consumer contract never trusts this process: it only accepts callbacks from the configured
// coordinator. On testnets this module is disabled and the real Chainlink VRF service fulfils.
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import mockAbi from "./abi/VRFCoordinatorV2_5Mock.json" with { type: "json" };
import { createLogger, errMessage, sleep } from "./util.js";

export class LocalVrfFulfiller {
  constructor({ chain, coordinator, privateKey, delayMs = 2000, pollIntervalMs = 1500, logger }) {
    this.chain = chain; // CampaignChain (public client + consumer address)
    this.coordinator = coordinator;
    this.delayMs = delayMs;
    this.pollIntervalMs = pollIntervalMs;
    this.log = logger || createLogger("vrf-mock");
    this.wallet = createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: chain.chain,
      transport: http(chain.chain.rpcUrls.default.http[0]),
    });
    this.next = undefined;
    this.done = new Set();
    this.stopped = false;
  }

  async pollOnce() {
    const client = this.chain.client;
    const head = await client.getBlockNumber();
    const from = this.next ?? this.chain.startBlock;
    if (from > head) return;
    const events = await client.getContractEvents({
      address: this.coordinator,
      abi: mockAbi,
      eventName: "RandomWordsRequested",
      args: { sender: this.chain.address },
      fromBlock: from,
      toBlock: head,
    });
    for (const ev of events) {
      const requestId = ev.args.requestId;
      if (this.done.has(requestId)) continue;
      await sleep(this.delayMs); // simulate the asynchronous oracle round-trip
      try {
        const hash = await this.wallet.writeContract({
          address: this.coordinator,
          abi: mockAbi,
          functionName: "fulfillRandomWords",
          args: [requestId, this.chain.address],
          // The mock forwards `callbackGasLimit` to the consumer and swallows a failed callback, so
          // gas estimation could under-provision it. Give it the full limit plus overhead explicitly.
          gas: BigInt(ev.args.callbackGasLimit) + 1_000_000n,
        });
        const receipt = await client.waitForTransactionReceipt({ hash });
        const [fulfilled] = await client.getContractEvents({
          address: this.coordinator,
          abi: mockAbi,
          eventName: "RandomWordsFulfilled",
          args: { requestId },
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        });
        if (fulfilled && !fulfilled.args.success) this.log.error(`consumer callback FAILED for request ${requestId}`);
        else this.log.info(`fulfilled VRF request ${requestId} (tx ${hash})`);
      } catch (err) {
        // InvalidRequest = already fulfilled (e.g. after a restart) -> nothing to do.
        this.log.warn(`request ${requestId}: ${errMessage(err)}`);
      }
      this.done.add(requestId);
    }
    this.next = head + 1n;
  }

  async run() {
    this.log.warn("LOCAL VRF SIMULATOR ACTIVE (VRF_MODE=mock). Never use on a public network.");
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.log.warn(`poll failed: ${errMessage(err)}`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  stop() {
    this.stopped = true;
  }
}
