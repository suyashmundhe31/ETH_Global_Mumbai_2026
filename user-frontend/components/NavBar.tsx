"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "🗺 Map" },
  { href: "/profile", label: "👤 Profile" },
  { href: "/marketplace", label: "🛒 Marketplace" },
];

export default function NavBar() {
  const path = usePathname();
  return (
    <nav
      style={{
        position: "fixed",
        top: "calc(12px + env(safe-area-inset-top))",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        display: "flex",
        gap: 4,
        padding: 4,
        borderRadius: 24,
        background: "rgba(20, 24, 32, 0.85)",
        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
        font: "600 14px system-ui, sans-serif",
        maxWidth: "calc(100vw - 24px)",
      }}
    >
      {LINKS.map(({ href, label }) => {
        const active = path === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "10px 14px",
              borderRadius: 20,
              color: "#fff",
              textDecoration: "none",
              whiteSpace: "nowrap",
              background: active ? "rgba(255, 255, 255, 0.18)" : "transparent",
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
