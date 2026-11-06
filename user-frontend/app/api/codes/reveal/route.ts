import { currentPlayer } from "@/lib/currentPlayer";
import { errorResponse, workerPost } from "@/lib/worker";

// Reveals a creature's discount code. The worker decrypts only for a wallet that signed the reveal message
// (EIP-191) and owns the creature on CreatureMarket, after it was redeemed there.
export async function POST(req: Request) {
  const player = await currentPlayer();
  if (!player) return Response.json({ error: "Not logged in" }, { status: 401 });
  const { creatureId, issuedAt, signature } = (await req.json().catch(() => ({}))) as { creatureId?: string; issuedAt?: string; signature?: string };
  if (!/^\d{1,78}$/.test(String(creatureId ?? ""))) return Response.json({ error: "creatureId must be a decimal integer" }, { status: 400 });
  const campaignId = (BigInt(String(creatureId)) >> BigInt(32)).toString();
  try {
    return Response.json(
      await workerPost(`/api/campaigns/${campaignId}/discount-codes/reveal`, { creatureId, address: player.wallet, issuedAt, signature }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
