import { isAddress, verifyMessage } from "viem";
import { tagOk } from "./session";

// True only if the wallet signed a fresh challenge that THIS server issued.
export async function ownsWallet(b: { address?: string; message?: string; message_tag?: string; signature?: string }) {
  if (!b.address || !isAddress(b.address) || typeof b.message !== "string") return false;
  const wallet = b.address.toLowerCase();
  const expires = Number(/Expires: (\d+)$/.exec(b.message)?.[1]);
  return (
    expires > Date.now() / 1000 &&
    b.message.includes(`Wallet: ${wallet}\n`) &&
    tagOk(b.message, b.message_tag ?? "") &&
    (await verifyMessage({ address: b.address, message: b.message, signature: b.signature as `0x${string}` }).catch(() => false))
  );
}