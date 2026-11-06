"use client";

// The catch reveal: the one authored moment of the game. A rarity-coloured burst (glow, rays, two shock
// rings and sparks), the creature spinning in, its rarity wiped on, then the details. Reduced motion
// keeps only the fades.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ModelViewer from "@/components/ModelViewer";

export type Reveal = {
  creatureId: bigint;
  rarity: string;
  float: number;
  businessName: string;
  description: string;
  modelUrl: string;
};

const RARITY_HEX: Record<string, string> = {
  COMMON: "#a8b2c2",
  RARE: "#5596ff",
  EPIC: "#b877ff",
  LEGENDARY: "#ffb627",
};
const SPARKS: Record<string, number> = { COMMON: 26, RARE: 44, EPIC: 70, LEGENDARY: 110 };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function CatchReveal({ reveal, onClose }: { reveal: Reveal; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const [shownFloat, setShownFloat] = useState(reducedMotion() ? reveal.float : 0);
  const rarity = RARITY_HEX[reveal.rarity] ? reveal.rarity : "COMMON";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Float counts up once the stats appear.
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    const start = performance.now() + 750;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / 900));
      setShownFloat(reveal.float * (1 - Math.pow(1 - t, 4)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reveal.float]);

  // Sparks: a single burst from the creature, falling under light gravity. Stops by itself.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reducedMotion()) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const color = RARITY_HEX[rarity];
    const box = modelRef.current?.getBoundingClientRect();
    const ox = box ? box.left + box.width / 2 : w / 2, oy = box ? box.top + box.height / 2 : h * 0.34;
    const parts = Array.from({ length: SPARKS[rarity] }, () => {
      const a = Math.random() * Math.PI * 2, v = 2.5 + Math.random() * (rarity === "LEGENDARY" ? 9 : 6);
      return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 1, size: 1.5 + Math.random() * 3, white: Math.random() < 0.3 };
    });
    let raf = 0;
    const begin = performance.now() + 120;
    const frame = (now: number) => {
      if (now < begin) {
        raf = requestAnimationFrame(frame);
        return;
      }
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      for (const p of parts) {
        if (p.life <= 0) continue;
        alive++;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.97;
        p.vy = p.vy * 0.97 + 0.12;
        p.life -= 0.012;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.white ? "#ffffff" : color;
        ctx.beginPath();
        // Four-point star
        const s = p.size * (0.6 + p.life * 0.6);
        ctx.moveTo(p.x, p.y - s * 2);
        ctx.lineTo(p.x + s * 0.5, p.y - s * 0.5);
        ctx.lineTo(p.x + s * 2, p.y);
        ctx.lineTo(p.x + s * 0.5, p.y + s * 0.5);
        ctx.lineTo(p.x, p.y + s * 2);
        ctx.lineTo(p.x - s * 0.5, p.y + s * 0.5);
        ctx.lineTo(p.x - s * 2, p.y);
        ctx.lineTo(p.x - s * 0.5, p.y - s * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      if (alive) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [rarity]);

  const index = (reveal.creatureId & BigInt(0xffffffff)).toString();

  return (
    <div className="reveal" data-rarity={rarity} role="dialog" aria-modal="true" aria-labelledby="reveal-title">
      <canvas ref={canvasRef} className="reveal-sparks" aria-hidden="true" />

      <div className="reveal-body">
        <div className="reveal-model" ref={modelRef}>
          <div className="reveal-glow" aria-hidden="true" />
          <div className="reveal-rays" aria-hidden="true" />
          <span className="reveal-ring" aria-hidden="true" />
          <span className="reveal-ring" aria-hidden="true" />
          <ModelViewer url={reveal.modelUrl} height={260} intro />
        </div>
        <p className="reveal-kicker">You caught a creature at {reveal.businessName}</p>
        <h2 id="reveal-title" className="reveal-rarity">
          {rarity.charAt(0) + rarity.slice(1).toLowerCase()}
        </h2>

        <div className="reveal-stats">
          <div className="reveal-stat">
            <span>Float</span>
            <b className="num mono">{shownFloat.toFixed(6)}</b>
          </div>
          <div className="reveal-stat">
            <span>Creature</span>
            <b className="num">#{index}</b>
          </div>
          <div className="reveal-stat reveal-stat-wide">
            <span>Reward</span>
            <b>{reveal.description || "Discount from " + reveal.businessName}</b>
          </div>
        </div>

        <div className="reveal-actions">
          <Link href="/profile" className="btn btn-secondary btn-lg">
            View collection
          </Link>
          <button type="button" className="btn btn-primary btn-lg" onClick={onClose} autoFocus>
            Keep hunting
          </button>
        </div>
      </div>
    </div>
  );
}
