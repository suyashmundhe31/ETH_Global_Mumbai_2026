import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentPlayer } from "@/lib/currentPlayer";
import NavBar from "@/components/NavBar";

async function Marketplace() {
  if (!(await currentPlayer())) redirect("/");
  return (
    <main style={PAGE}>
      <NavBar />
      <h1>Marketplace</h1>
      <p style={{ color: "#9aa3b2" }}>Coming soon: trade creatures and items with other players.</p>
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
