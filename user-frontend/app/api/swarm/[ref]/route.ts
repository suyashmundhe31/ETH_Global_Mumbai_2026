import { currentPlayer } from "@/lib/currentPlayer";
import { errorResponse, workerFetch } from "@/lib/worker";

// A creature's 3D model (GLB) from Swarm, fetched through the worker (works with any Bee node or gateway
// the worker is configured with, and keeps the browser on this origin).
export async function GET(_req: Request, ctx: { params: Promise<{ ref: string }> }) {
  if (!(await currentPlayer())) return Response.json({ error: "Not logged in" }, { status: 401 });
  const { ref } = await ctx.params;
  if (!/^[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/.test(ref)) return Response.json({ error: "Invalid Swarm reference" }, { status: 400 });
  try {
    const res = await workerFetch(`/api/swarm/bzz/${ref}`);
    if (!res.ok) return Response.json({ error: `Swarm download failed (${res.status})` }, { status: 502 });
    return new Response(await res.arrayBuffer(), {
      headers: {
        "content-type": res.headers.get("content-type") || "model/gltf-binary",
        // Swarm content is immutable (content addressed).
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
