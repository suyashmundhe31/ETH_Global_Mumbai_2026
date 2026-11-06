import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import Market from "@/components/Market";
import NavBar from "@/components/NavBar";
import SessionGuard from "@/components/SessionGuard";

async function Gate() {
  const player = await currentPlayer();
  if (!player) redirect("/");
  return (
    <SessionGuard wallet={player.wallet}>
      <NavBar />
      <main className="page">
        <h1>Marketplace</h1>
        <Market wallet={player.wallet} />
      </main>
    </SessionGuard>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Gate />
    </Suspense>
  );
}
