// Prints a new CODE_ENCRYPTION_KEY (32 random bytes, base64) for worker/.env.
// Keep it secret and back it up: codes encrypted with it cannot be decrypted without it.
import { randomBytes } from "node:crypto";

console.log(`CODE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
