"use client";

// Game-lobby navigation: illustrated tiles. A floating top bar on wide screens, a bottom tab bar on phones
// (the active tile pops up out of the bar).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Avatar, { shortAddr } from "@/components/Avatar";
import { useWalletGuard } from "@/lib/useWalletGuard";
import { ArtChest, ArtMap, ArtShop, BrandMark, IconCheck, IconCopy, IconLogout } from "@/components/icons";

const LINKS = [
  { href: "/", label: "Map", Art: ArtMap },
  { href: "/profile", label: "Collection", Art: ArtChest },
  { href: "/marketplace", label: "Market", Art: ArtShop },
];

export default function NavBar({ wallet }: { wallet?: string }) {
  const path = usePathname();
  // Every logged-in page has the nav: if MetaMask switches away from the session's wallet, the session ends.
  useWalletGuard(wallet);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const copy = () => {
    if (!wallet) return;
    navigator.clipboard
      ?.writeText(wallet)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => null);
  };

  const signOut = async () => {
    await fetch("/api/logout", { method: "POST" }).catch(() => null);
    location.href = "/";
  };

  return (
    <header className="nav">
      <nav className="nav-bar" aria-label="Main">
        <Link href="/" className="nav-brand" aria-label="Creature Map home">
          <BrandMark />
          <span className="nav-brand-name">Creature Map</span>
        </Link>

        <div className="nav-tabs">
          {LINKS.map(({ href, label, Art }) => (
            <Link key={href} href={href} className="nav-tab" aria-current={path === href ? "page" : undefined}>
              <Art />
              <span className="nav-tab-label">{label}</span>
            </Link>
          ))}
        </div>

        {wallet && (
          <div ref={menuRef} style={{ position: "relative", display: "flex" }}>
            <button type="button" className="nav-wallet" aria-haspopup="menu" aria-expanded={menu} aria-label="Wallet" onClick={() => setMenu((m) => !m)}>
              <Avatar address={wallet} />
              <span className="nav-wallet-addr num">{shortAddr(wallet)}</span>
            </button>
            {menu && (
              <div role="menu" className="panel nav-menu">
                <div className="nav-menu-head">
                  <Avatar address={wallet} size={40} />
                  <div style={{ minWidth: 0 }}>
                    <strong>Your wallet</strong>
                    <span className="num">{shortAddr(wallet)}</span>
                  </div>
                </div>
                <button type="button" role="menuitem" className="btn btn-ghost btn-sm btn-block" style={{ justifyContent: "flex-start" }} onClick={copy}>
                  {copied ? <IconCheck /> : <IconCopy />}
                  {copied ? "Copied" : "Copy address"}
                </button>
                <button type="button" role="menuitem" className="btn btn-ghost btn-sm btn-block" style={{ justifyContent: "flex-start", color: "var(--danger)" }} onClick={() => void signOut()}>
                  <IconLogout />
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </nav>
    </header>
  );
}
