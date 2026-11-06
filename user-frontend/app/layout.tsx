import type { Metadata, Viewport } from "next";
import { Lilita_One, Nunito } from "next/font/google";
import "./globals.css";
import TouchGuard from "@/components/TouchGuard";

// Self-hosted by next/font at build time: Lilita One is the chunky game lettering, Nunito the rounded UI text.
const lilita = Lilita_One({ subsets: ["latin"], weight: "400", variable: "--font-lilita", display: "swap" });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap" });

export const metadata: Metadata = {
  title: "Creature Map",
  description: "Hunt creatures around your city, catch them on chain and redeem real rewards.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Creature Map" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0d4aa3",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lilita.variable} ${nunito.variable}`}>
      <body>
        <TouchGuard />
        {children}
      </body>
    </html>
  );
}
