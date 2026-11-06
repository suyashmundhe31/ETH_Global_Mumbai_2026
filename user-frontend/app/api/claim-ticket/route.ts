import { privateKeyToAccount } from "viem/accounts";
import { currentPlayer } from "@/lib/currentPlayer";
import { appConfig, errorResponse } from "@/lib/worker";

// A claim ticket proves to CreatureMarket that the claimer is a World ID verified human: this server signs
// it (EIP-712, HUMAN_SIGNER_PRIVATE_KEY = CreatureMarket.humanSigner) only for the logged-in player's own
// wallet. The contract checks everything else (distance, next creature, one per campaign, expiry).
const TICKET_SECONDS = 10 * 60; // <= CreatureMarket.MAX_TICKET_TTL

export async function POST(req: Request) {
  const player = await currentPlayer();
  if (!player) return Response.json({ error: "Not logged in" }, { status: 401 });
  const { creatureId } = (await req.json().catch(() => ({}))) as { creatureId?: string };
  if (!/^\d{1,78}$/.test(String(creatureId ?? ""))) return Response.json({ error: "creatureId must be a decimal integer" }, { status: 400 });
  const key = process.env.HUMAN_SIGNER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return Response.json({ error: "HUMAN_SIGNER_PRIVATE_KEY is not set" }, { status: 500 });
  try {
    const cfg = await appConfig();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + TICKET_SECONDS);
    const signature = await privateKeyToAccount(key as `0x${string}`).signTypedData({
      domain: { name: "CreatureMarket", version: "1", chainId: cfg.chainId, verifyingContract: cfg.creatureMarket },
      types: {
        Claim: [
          { name: "player", type: "address" },
          { name: "creatureId", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Claim",
      message: { player: player.wallet, creatureId: BigInt(String(creatureId)), deadline },
    });
    return Response.json({ creatureId: String(creatureId), player: player.wallet, deadline: deadline.toString(), signature });
  } catch (e) {
    return errorResponse(e);
  }
}
