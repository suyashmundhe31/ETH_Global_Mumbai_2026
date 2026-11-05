import { cookies } from "next/headers";
import { read } from "@/lib/session";
import { getPlayer } from "@/lib/players";
import LoginButton from "./LoginButton";

export default async function Home() {
  const id = read((await cookies()).get("session")?.value);
  const player = id ? getPlayer(id) : null;
  return (
    <main style={{ padding: 40 }}>
      <h1>Game</h1>
      {player ? <p>✅ Verified human · wallet {player.wallet.slice(0, 8)}…{player.wallet.slice(-4)}</p> : <LoginButton />}
    </main>
  );
}