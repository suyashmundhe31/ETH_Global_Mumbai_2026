"use client";

// Small standalone 3D view of one GLB (the creature you just caught). Hovers gently, no spinning.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadModel } from "@/lib/glb";

export default function ModelViewer({ url, height = 180 }: { url: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let raf = 0;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 1, 4.2);
    camera.lookAt(0, 0.65, 0);

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();

    loadModel(url, 1.35)
      .then((obj) => {
        if (!alive) return;
        obj.rotation.y = -0.4; // three-quarter view
        scene.add(obj);
        const t0 = performance.now();
        const tick = () => {
          raf = requestAnimationFrame(tick);
          obj.position.y = Math.sin((performance.now() - t0) / 500) * 0.08;
          renderer.render(scene, camera);
        };
        tick();
      })
      .catch((err) => {
        console.error(`Failed to load ${url}`, err);
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      renderer.dispose();
    };
  }, [url]);

  if (failed) return null;
  return <canvas ref={canvasRef} aria-hidden="true" style={{ display: "block", width: "100%", height }} />;
}
