import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import NavBar from "@/components/NavBar";
import Market from "@/components/Market";

async function Marketplace() {
  const player = await currentPlayer();
  if (!player) redirect("/");
  return (
    <main style={PAGE}>
      <NavBar />
      <h1>Marketplace</h1>
      <Market wallet={player.wallet} />
    </main>
  );
}

const PAGE: React.CSSProperties = {
  minHeight: "100%",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: "calc(88px + env(safe-area-inset-top)) 16px 24px",
  background: "#141820",
  color: "#fff",
  font: "16px system-ui, sans-serif",
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Marketplace />
    </Suspense>
  );
}
