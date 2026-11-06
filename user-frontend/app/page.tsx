import { Suspense } from "react";
import { currentPlayer } from "@/lib/currentPlayer";
import LoginButton from "@/components/LoginButton";
import MapClient from "@/components/MapClient";
import NavBar from "@/components/NavBar";

// Reads the session cookie at request time: verified players get the map, others get the login.
async function Gate() {
  const player = await currentPlayer();
  if (player)
    return (
      <>
        <MapClient wallet={player.wallet} />
        <NavBar />
      </>
    );
  return (
    <main style={{ padding: 40 }}>
      <h1>Creature Map</h1>
      <p>Verify you are human to play.</p>
      <LoginButton />
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <Gate />
    </Suspense>
  );
}
