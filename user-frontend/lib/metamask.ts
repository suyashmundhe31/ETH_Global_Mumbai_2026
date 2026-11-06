"use client";

// MetaMask (EIP-1193) helpers shared by the campaign chain and Arkiv writes.

import { BaseError, ContractFunctionRevertedError, numberToHex, type Address, type Chain, type EIP1193Provider } from "viem";

export function provider(): EIP1193Provider {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("MetaMask not found. Install it to play.");
  return eth;
}

/**
 * Makes sure MetaMask is on `chain` (adding it if unknown) and that `expected` is the active account.
 * MetaMask grants accounts per site; ask again after switching so sends are authorized.
 */
export async function ensureWallet(chain: Chain, expected: Address): Promise<Address> {
  const eth = provider();
  const current = Number(await eth.request({ method: "eth_chainId" }));
  if (current !== chain.id) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: numberToHex(chain.id),
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
          },
        ],
      });
    }
    if (Number(await eth.request({ method: "eth_chainId" })) !== chain.id) throw new Error(`Switch MetaMask to ${chain.name}`);
  }
  const [account] = await eth.request({ method: "eth_requestAccounts" });
  if (!account || account.toLowerCase() !== expected.toLowerCase()) throw new Error(`Switch MetaMask to your verified wallet ${expected}`);
  return account;
}

// Custom errors of CreatureMarket, in player language.
const CONTRACT_ERRORS: Record<string, string> = {
  TooFar: "You are too far away: get within 50 m of the creature.",
  NotNextCreature: "Someone just claimed this creature. The map is refreshing.",
  AlreadyClaimedInCampaign: "You already have a creature from this campaign.",
  CampaignDepleted: "Every creature of this campaign has been claimed.",
  CampaignExpired: "This campaign has ended.",
  CampaignNotActive: "This campaign is not active yet.",
  InvalidTicket: "Your human-verification ticket was not accepted. Log in again.",
  TicketExpired: "Your claim ticket expired. Try again.",
  NotOwner: "You don't own this creature.",
  AlreadyRedeemed: "This creature was already redeemed.",
  IsListed: "Unlist the creature first.",
  NotListed: "This creature is no longer for sale.",
  InvalidPrice: "Enter a valid price.",
  OwnListing: "You can't buy your own creature.",
  WrongPayment: "The price changed. Refresh and try again.",
  PaymentFailed: "The seller could not be paid; the sale was cancelled.",
};

const WALLET_HINTS: Record<number, string> = {
  4001: "You rejected the request in MetaMask.",
  4100: "Allow this site to use your account in MetaMask, then try again.",
  [-32002]: "A MetaMask request is already open: approve or reject it in MetaMask.",
};

/** A readable message for wallet, contract and SDK errors. */
export function errorText(e: unknown): string {
  console.warn(e);
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName;
    if (name && CONTRACT_ERRORS[name]) return CONTRACT_ERRORS[name];
    if (name) return `Transaction refused: ${name}`;
  }
  for (let x = e as { code?: number; cause?: unknown; shortMessage?: string; message?: string } | undefined; x && typeof x === "object"; x = x.cause as typeof x) {
    if (x.code !== undefined && WALLET_HINTS[x.code]) return WALLET_HINTS[x.code];
    if ((x as { name?: string }).name === "UserRejectedRequestError") return WALLET_HINTS[4001];
  }
  const err = e as { shortMessage?: string; message?: string };
  return (err?.shortMessage || err?.message || String(e)).split("\n")[0];
}
