// Retired: the collection now reads Arkiv + CreatureMarket in the browser (lib/creatures.ts loadProfile), so
// ownership is always cross-checked on chain. Nothing in the app calls this route any more; safe to delete.
export function GET() {
  return Response.json({ error: "Gone: the collection reads Arkiv and CreatureMarket directly (lib/creatures.ts)" }, { status: 410 });
}
