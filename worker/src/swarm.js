// Swarm storage for creature .glb models, using the official bee-js SDK (v13 API:
// bee.file.upload / bee.file.download / bee.stamp.get).
import { Bee, NULL_STAMP } from "@ethersphere/bee-js";
import { parseGlb, sha256 } from "./glb.js";
import { createLogger, withRetry } from "./util.js";

export const GLB_CONTENT_TYPE = "model/gltf-binary";

export class SwarmService {
  /**
   * @param {object} opts
   * @param {string} opts.beeUrl          Bee node API URL (own node) or a Swarm gateway URL.
   * @param {string} [opts.postageBatchId] Usable postage batch on that node. Empty = NULL_STAMP,
   *                                      which only a gateway that stamps uploads itself accepts.
   */
  constructor({ beeUrl, postageBatchId = "", verifyDownload = true, pin = false, maxGlbBytes, logger, bee }) {
    this.beeUrl = beeUrl.replace(/\/+$/, "");
    this.bee = bee || new Bee(this.beeUrl);
    this.batchId = postageBatchId || NULL_STAMP;
    this.usesNullStamp = !postageBatchId;
    this.verifyDownload = verifyDownload;
    this.pin = pin;
    this.maxGlbBytes = maxGlbBytes;
    this.log = logger || createLogger("swarm");
    this._stampChecked = false;
  }

  /** Confirms the postage batch is usable before any upload (Swarm rejects unstamped data). */
  async ensureUsableStamp() {
    if (this._stampChecked) return;
    if (this.usesNullStamp) {
      this.log.warn(
        "No SWARM_POSTAGE_BATCH_ID configured: using NULL_STAMP, which only works against a public gateway " +
          "that stamps uploads with its own (short-lived) batch. Use your own Bee node + batch for durable storage.",
      );
    } else {
      const batch = await this.bee.stamp.get(this.batchId);
      if (!batch.usable) throw new Error(`Postage batch ${this.batchId} is not usable yet (or has expired)`);
      this.log.info(`postage batch ok: depth=${batch.depth} utilization=${batch.utilization} ttl=${batch.duration?.toSeconds?.()}s`);
    }
    this._stampChecked = true;
  }

  /** Validates, uploads and (optionally) verifies retrieval of a .glb. Returns the Swarm reference. */
  async uploadGlb(buffer, filename) {
    parseGlb(buffer, { maxBytes: this.maxGlbBytes });
    await this.ensureUsableStamp();
    const digest = sha256(buffer);

    const result = await withRetry(
      () => this.bee.file.upload(this.batchId, buffer, filename, { contentType: GLB_CONTENT_TYPE, pin: this.pin }),
      { attempts: 3, baseDelayMs: 1500, onError: (e, i) => this.log.warn(`upload attempt ${i + 1} failed: ${e.message}`) },
    );
    const reference = result.reference.toHex();

    if (this.verifyDownload) {
      const back = await this.download(reference);
      if (sha256(back.data) !== digest) throw new Error(`Swarm verification failed for ${reference}: content mismatch`);
    }
    return { reference, sha256: digest, size: buffer.length, filename, url: this.bzzUrl(reference) };
  }

  async download(reference) {
    const file = await withRetry(() => this.bee.file.download(reference), { attempts: 3, baseDelayMs: 1000 });
    return { data: Buffer.from(file.data.toUint8Array()), name: file.name, contentType: file.contentType };
  }

  bzzUrl(reference) {
    return `${this.beeUrl}/bzz/${reference}/`;
  }
}
