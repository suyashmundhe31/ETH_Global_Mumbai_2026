import { Suspense } from "react";
import { cookies } from "next/headers";
import { read } from "@/lib/session";
import { getPlayer } from "@/lib/players";
import LoginButton from "@/components/LoginButton";
import MapClient from "@/components/MapClient";

// Reads the session cookie at request time: verified players get the map, others get the login.
async function Gate() {
  const id = read((await cookies()).get("session")?.value);
  const player = id ? getPlayer(id) : null;
  if (player) return <MapClient wallet={player.wallet} />;
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
