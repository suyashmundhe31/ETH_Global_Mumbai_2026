import { currentPlayer } from "@/lib/currentPlayer";
import { errorResponse, workerPost } from "@/lib/worker";

// Listing attestation for CreatureMarket.list, issued by the worker's settler after it checked the chain
// (ownership, not redeemed) and the Arkiv escrow (listed = true at this price, data untampered).
// The seller is always the logged-in player's wallet.
export async function POST(req: Request) {
  const player = await currentPlayer();
  if (!player) return Response.json({ error: "Not logged in" }, { status: 401 });
  const { creatureId, price } = (await req.json().catch(() => ({}))) as { creatureId?: string; price?: string };
  try {
    return Response.json(await workerPost("/api/market/attest", { creatureId, price, seller: player.wallet }));
  } catch (e) {
    return errorResponse(e);
  }
}
