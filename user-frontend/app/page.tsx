import { Suspense } from "react";
import { currentPlayer } from "@/lib/currentPlayer";
import LoginButton from "@/components/LoginButton";
import MapClient from "@/components/MapClient";
import NavBar from "@/components/NavBar";
import { BrandMark, IconGift, IconPin, IconShield } from "@/components/icons";

// Reads the session cookie at request time: verified players get the map, others get the login.
async function Gate() {
  const player = await currentPlayer();
  if (player)
    return (
      <>
        <MapClient wallet={player.wallet} />
        <NavBar wallet={player.wallet} />
      </>
    );
  return (
    <main className="login">
      <div className="login-grid" aria-hidden="true" />
      <section className="login-card panel">
        <BrandMark className="nav-brand-mark" />
        <h1>Creature Map</h1>
        <p>Hunt creatures hidden around your city and turn every catch into a real reward.</p>
        <ul className="login-steps">
          <li>
            <span className="login-step-icon">
              <IconPin />
            </span>
            <span>
              <b>Walk to a spawn</b>
              Local businesses place creatures at real locations.
            </span>
          </li>
          <li>
            <span className="login-step-icon">
              <IconShield />
            </span>
            <span>
              <b>Catch it on chain</b>
              Your position is verified and the rarity rolled fairly.
            </span>
          </li>
          <li>
            <span className="login-step-icon">
              <IconGift />
            </span>
            <span>
              <b>Redeem or trade</b>
              Unlock the reward code, or list the creature on the market.
            </span>
          </li>
        </ul>
        <LoginButton />
      </section>
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
