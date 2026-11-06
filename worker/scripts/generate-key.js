// Prints a new signing key and its address. Keep keys secret and back them up.
//   npm run gen-key -- SETTLER       -> SETTLER_PRIVATE_KEY for worker/.env (fund the address with tGLM on
//                                       Arkiv: https://hub.arkiv.network/faucet). Deploy CreatureMarket with
//                                       SETTLER_ADDRESS = this address.
//   npm run gen-key -- HUMAN_SIGNER  -> HUMAN_SIGNER_PRIVATE_KEY for user-frontend/.env.local (needs no funds).
//                                       Deploy CreatureMarket with HUMAN_SIGNER_ADDRESS = this address.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const name = (process.argv[2] || "SETTLER").toUpperCase();
if (!["SETTLER", "HUMAN_SIGNER"].includes(name)) {
  console.error("Usage: npm run gen-key -- SETTLER | HUMAN_SIGNER");
  process.exit(1);
}
const key = generatePrivateKey();
console.log(`${name}_PRIVATE_KEY=${key}`);
console.log(`${name}_ADDRESS=${privateKeyToAccount(key).address}`);
