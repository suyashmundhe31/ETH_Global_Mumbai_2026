import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import MyCreatures from "@/components/MyCreatures";
import NavBar from "@/components/NavBar";

// Verified players only; everyone else goes back to the login on "/".
async function Gate() {
  const player = await currentPlayer();
  if (!player) redirect("/");
  return (
    <>
      <NavBar />
      <main style={{ padding: 40 }}>
        <h1>Profile</h1>
        <p>wallet: {player.wallet}</p>
        <h2>Creatures</h2>
        <MyCreatures wallet={player.wallet} />
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