import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import MyCreatures from "@/components/MyCreatures";
import NavBar from "@/components/NavBar";

// Profile + collection (one page). Verified players only; everyone else goes back to the login on "/".
async function Gate() {
  const player = await currentPlayer();
  if (!player) redirect("/");
  return (
    <>
      <NavBar wallet={player.wallet} />
      <main className="page">
        <div className="page-inner">
          <MyCreatures wallet={player.wallet} />
        </div>
      </main>
    </>
  );
}

export default function Profile() {
  return (
    <Suspense fallback={null}>
      <Gate />
    </Suspense>
  );
}
