import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import NavBar from "@/components/NavBar";
import Profile from "@/components/Profile";
import SessionGuard from "@/components/SessionGuard";

// Verified players only; everyone else goes back to the World ID login on "/".
async function Gate() {
  const player = await currentPlayer();
  if (!player) redirect("/");
  return (
    <SessionGuard wallet={player.wallet}>
      <NavBar />
      <main className="page">
        <Profile wallet={player.wallet} />
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
