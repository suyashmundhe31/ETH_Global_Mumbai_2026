import { Suspense } from "react";
import { currentPlayer } from "@/lib/currentPlayer";
import LoginButton from "@/components/LoginButton";
import MapClient from "@/components/MapClient";
import NavBar from "@/components/NavBar";
import SessionGuard from "@/components/SessionGuard";

// Reads the session cookie at request time: verified humans get the map, everyone else the World ID login.
async function Gate() {
  const player = await currentPlayer();
  if (player)
    return (
      <SessionGuard wallet={player.wallet}>
        <MapClient wallet={player.wallet} />
        <NavBar />
      </SessionGuard>
    );
  return (
    <main className="page" style={{ maxWidth: 440, margin: "0 auto", paddingTop: 80 }}>
      <h1>HunterVersep</h1>
      <p>Catch AR creatures around you and win rewards from local businesses.</p>
      <p className="muted">Only verified humans can play: connect MetaMask, then verify with World ID.</p>
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
