import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import NavBar from "@/components/NavBar";
import Market from "@/components/Market";

async function Marketplace() {
  const player = await currentPlayer();
  if (!player) redirect("/");
  return (
    <>
      <NavBar wallet={player.wallet} />
      <main className="page">
        <div className="page-inner">
          <Market wallet={player.wallet} />
        </div>
      </main>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Marketplace />
    </Suspense>
  );
}
