"use client";

// Small standalone 3D view of one GLB (the creature you just caught). Hovers gently.
// `intro`: the creature bursts in (scale up from a point with a decelerating spin) before it settles.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadModel } from "@/lib/glb";
import { IconPaw } from "@/components/icons";

const INTRO_MS = 1100;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

export default function ModelViewer({ url, height = 180, intro = false }: { url: string; height?: number; intro?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let raf = 0;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 1, 4.2);
    camera.lookAt(0, 0.65, 0);

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    loadModel(url, 1.35)
      .then((obj) => {
        if (!alive) return;
        const REST_YAW = -0.4; // three-quarter view
        obj.rotation.y = REST_YAW;
        scene.add(obj);
        const t0 = performance.now();
        const tick = () => {
          raf = requestAnimationFrame(tick);
          const ms = performance.now() - t0;
          if (intro && !reduced && ms < INTRO_MS) {
            const t = ms / INTRO_MS;
            obj.scale.setScalar(Math.max(0.01, easeOutBack(Math.min(1, t * 1.25))));
            obj.rotation.y = REST_YAW - (1 - easeOutExpo(t)) * Math.PI * 3;
            obj.position.y = (1 - easeOutExpo(t)) * 0.5;
          } else {
            obj.scale.setScalar(1);
            obj.rotation.y = REST_YAW;
            obj.position.y = Math.sin((ms - (intro ? INTRO_MS : 0)) / 500) * 0.08;
          }
          renderer.render(scene, camera);
        };
        tick();
      })
      .catch((err) => {
        console.warn(`Failed to load ${url}`, err);
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    };
  }, [url, intro]);

  if (failed)
    return (
      <div style={{ height, display: "grid", placeItems: "center", color: "var(--rc, var(--text-3))", position: "relative" }}>
        <IconPaw style={{ width: 72, height: 72 }} />
      </div>
    );
  return <canvas ref={canvasRef} aria-hidden="true" style={{ display: "block", width: "100%", height }} />;
}
