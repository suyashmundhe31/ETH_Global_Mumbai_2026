import { currentPlayer } from "@/lib/currentPlayer";
import { appConfig, errorResponse } from "@/lib/worker";

// Deployment addresses and networks for the browser (public values, verified players only).
export async function GET() {
  if (!(await currentPlayer())) return Response.json({ error: "Not logged in" }, { status: 401 });
  try {
    return Response.json(await appConfig());
  } catch (e) {
    return errorResponse(e);
  }
}
