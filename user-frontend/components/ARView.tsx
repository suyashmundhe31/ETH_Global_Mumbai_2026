"use client";

// Tilt-driven AR, ported from the creature-catcher prototype (camera + gyroscope mode):
//   phone flat (screen up)  -> Mapbox map only
//   phone upright           -> screen splits: camera AR on top, Mapbox map below
// The selected campaign's creatures (its GLB models from Swarm) appear on the floor in the camera view.
// Tapping one runs the same on-chain catch as the map's Catch button (Campaigns -> catchCreature).
// WebXR floor AR is not used: an immersive-ar session always takes the whole screen, so it can't share it
// with the map. Without a gyroscope (laptop), the 📷 button splits the screen and dragging looks around.

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import type { Campaign } from "@/lib/campaigns";
import { loadModel } from "@/lib/glb";

export type ARCatchOutcome = "caught" | "missed" | "failed";
type View = "map" | "split";

// Camera forward Y: 0 = phone upright, -1 = phone flat with the screen up. Hysteresis avoids flicker.
const TO_MAP = -0.6; // tilt past ~37° down -> map only
const TO_SPLIT = -0.4; // raise back above ~24° -> split
const MAX_ALIVE = 3; // creatures on the floor at once
const SPAWN_EVERY_MS = 1500;
const CREATURE_HEIGHT = 0.7; // m

type Live = { mesh: THREE.Group; hitbox: THREE.Mesh; baseY: number; phase: number; dying: number; hopTo?: THREE.Vector3 };

const PILL: React.CSSProperties = {
  border: "none",
  borderRadius: 12,
  padding: "8px 12px",
  background: "rgba(20, 24, 32, 0.85)",
  color: "#fff",
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
  fontWeight: 600,
  touchAction: "manipulation",
};

export default function ARView({
  map,
  campaign,
  canCatch,
  distanceLabel,
  status,
  onCatch,
}: {
  map: mapboxgl.Map;
  /** The campaign whose creatures show up in AR (the map's selected / nearest one), or null. */
  campaign: Campaign | null;
  /** Within the catch radius (the CRE referee enforces the same rule on chain). */
  canCatch: boolean;
  distanceLabel: string;
  /** Catch progress from the map panel (MetaMask, CRE, VRF) or an error; "" when idle. */
  status: string;
  onCatch: () => Promise<ARCatchOutcome>;
}) {
  const [view, setViewState] = useState<View>("map");
  const viewRef = useRef<View>("map");
  const setView = (v: View) => {
    viewRef.current = v;
    setViewState(v);
  };
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState("");
  const [floorFound, setFloorFound] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(() => void) | null>(null);

  // Device orientation, shared by the tilt switch and the AR camera.
  const orient = useRef({ a: 0, b: 0, g: 0, ok: false });

  // The render loop and tap handler outlive renders: they read the latest props through a ref.
  const latest = useRef({ campaign, canCatch, onCatch });
  useEffect(() => {
    latest.current = { campaign, canCatch, onCatch };
  });

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  // --- Tilt -> view (works before the camera is on, so tilting up shows the "start camera" half) ---
  useEffect(() => {
    const q = new THREE.Quaternion(), eul = new THREE.Euler(), fwd = new THREE.Vector3();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const onOri = (e: DeviceOrientationEvent) => {
      if (e.beta == null) return;
      const o = orient.current;
      o.a = e.alpha ?? 0;
      o.b = e.beta;
      o.g = e.gamma ?? 0;
      o.ok = true;
      const d = THREE.MathUtils.DEG2RAD;
      eul.set(o.b * d, 0, -o.g * d, "YXZ"); // yaw doesn't matter for pitch
      fwd.set(0, 0, -1).applyQuaternion(q.setFromEuler(eul).multiply(q1));
      if (viewRef.current === "split" && fwd.y < TO_MAP) setView("map");
      else if (viewRef.current === "map" && fwd.y > TO_SPLIT) setView("split");
    };
    window.addEventListener("deviceorientation", onOri);
    return () => window.removeEventListener("deviceorientation", onOri);
  }, []);

  // --- Split: the map container moves to the bottom half (and Mapbox re-measures it) ---
  useEffect(() => {
    const el = map.getContainer();
    el.style.top = view === "split" ? "50%" : "0";
    try {
      map.resize();
    } catch {} // map already removed
  }, [view, map]);
  useEffect(() => {
    const el = map.getContainer();
    return () => {
      el.style.top = "0";
      stopRef.current?.();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [map]);

  // Different campaign -> different creatures.
  const resetRef = useRef<(() => void) | null>(null);
  useEffect(() => resetRef.current?.(), [campaign?.campaignId]);

  async function startCamera() {
    setCamError("");
    try {
      // iOS only grants motion access from inside a tap, so ask first.
      const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
      if (typeof DOE?.requestPermission === "function") {
        const p = await DOE.requestPermission().catch(() => "denied");
        if (p !== "granted") showToast("No motion access: drag the camera view to look around");
      }
      if (!window.isSecureContext) throw new Error("the camera needs HTTPS: open the game through your ngrok https:// link");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      setCamOn(true);
      runScene(stream);
    } catch (e) {
      setCamError(`Couldn't start the camera: ${e instanceof Error ? e.message : e}`);
    }
  }

  function runScene(stream: MediaStream) {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 30);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666688, 2.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(1, 3, 2);
    scene.add(sun);

    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    Object.assign(video.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover" });
    Object.assign(renderer.domElement.style, { position: "absolute", inset: "0", touchAction: "none" });
    host.prepend(video, renderer.domElement);
    video.play().catch(() => {});

    const resize = () => {
      const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight / 2;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    camera.position.set(0, 1.3, 0); // phone at chest height, floor at y = 0
    camera.rotation.set(-0.5, 0, 0, "YXZ"); // until the gyro answers

    // Device orientation -> camera rotation (same maths as three.js DeviceOrientationControls).
    const zee = new THREE.Vector3(0, 0, 1), eul = new THREE.Euler(), q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    let yaw0: number | null = null;
    const applyOrientation = () => {
      const o = orient.current;
      if (!o.ok) return;
      const d = THREE.MathUtils.DEG2RAD;
      if (yaw0 === null) yaw0 = o.a; // the way you face at start = forward
      eul.set(o.b * d, (o.a - yaw0) * d, -o.g * d, "YXZ");
      camera.quaternion.setFromEuler(eul).multiply(q1);
      camera.quaternion.multiply(q0.setFromAxisAngle(zee, -(screen.orientation?.angle ?? 0) * d));
    };

    // Floor ring + blue dots leading to the nearest creature.
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.1, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.8 }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);
    const crumbMat = new THREE.MeshBasicMaterial({ color: 0x3d7bff, transparent: true, opacity: 0.8, depthWrite: false });
    const crumbGeo = new THREE.CircleGeometry(0.035, 12).rotateX(-Math.PI / 2);
    const crumbs = Array.from({ length: 10 }, () => {
      const m = new THREE.Mesh(crumbGeo, crumbMat);
      m.visible = false;
      scene.add(m);
      return m;
    });

    let live: Live[] = [];
    let lastSpawn = 0;
    let spawning = 0; // bumped on reset, so a model that finishes loading for an old campaign is dropped
    let generation = 0;
    let nextModel = 0;
    let floorSeen = false;
    let stopped = false;
    let catching: Live | null = null; // the creature whose on-chain catch is in flight
    const floorPos = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const camQuat = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    const hitboxMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

    resetRef.current = () => {
      for (const l of live) scene.remove(l.mesh);
      live = [];
      generation++;
      spawning = 0;
      nextModel = 0;
      catching = null;
    };

    // One of the campaign's creature models (they take turns), placed near the floor ring.
    async function spawn(now: number) {
      const urls = latest.current.campaign?.creatures.map((c) => c.modelUrl) ?? [];
      if (!urls.length) return;
      const gen = generation;
      spawning++;
      lastSpawn = now;
      const at = floorPos.clone();
      try {
        const mesh = await loadModel(urls[nextModel++ % urls.length], CREATURE_HEIGHT);
        if (stopped || gen !== generation) return;
        const angle = Math.random() * Math.PI * 2, r = 0.15 + Math.random() * 0.4;
        mesh.position.set(at.x + Math.cos(angle) * r, at.y, at.z + Math.sin(angle) * r);
        // A generous invisible box, so a tap anywhere near the model counts.
        const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).multiplyScalar(1.3);
        const hitbox = new THREE.Mesh(new THREE.BoxGeometry(size.x || 0.5, size.y || 0.5, size.z || 0.5), hitboxMat);
        hitbox.position.y = (size.y || 0.5) / 2;
        mesh.add(hitbox);
        mesh.scale.setScalar(0.01);
        scene.add(mesh);
        live.push({ mesh, hitbox, baseY: at.y, phase: Math.random() * 10, dying: 0 });
      } catch (e) {
        console.error("AR: couldn't load the creature model", e);
      } finally {
        if (gen === generation) spawning--;
      }
    }

    // ---------- tap to catch: the same on-chain catch as the map's button ----------
    const raycaster = new THREE.Raycaster();
    async function onTap(ndc: THREE.Vector2) {
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(live.filter((l) => !l.dying).map((l) => l.hitbox), false)[0];
      const target = hit && live.find((l) => l.hitbox === hit.object);
      if (!target) return;
      if (catching) return showToast("Hold on, your catch is still being processed…");
      if (!latest.current.canCatch) return showToast("Too far: walk closer to the spawn point to catch it");
      catching = target;
      navigator.vibrate?.(40);
      const outcome = await latest.current.onCatch();
      if (catching !== target) return; // campaign changed meanwhile
      catching = null;
      if (stopped) return;
      if (outcome === "caught") {
        target.dying = 0.0001;
        navigator.vibrate?.(80);
        showToast("Caught! 🎉");
      } else if (outcome === "missed") {
        const a = Math.random() * Math.PI * 2;
        target.hopTo = target.mesh.position.clone().add(new THREE.Vector3(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5));
        navigator.vibrate?.([30, 40, 30]);
        showToast("It got away!");
      }
    }
    // A short press is a tap; without a gyro, dragging looks around.
    let down: { x: number; y: number; moved: number } | null = null;
    const look = { yaw: 0, pitch: -0.5 };
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, moved: 0 };
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy);
      down.x = e.clientX;
      down.y = e.clientY;
      if (!orient.current.ok) {
        look.yaw += dx * 0.005;
        look.pitch = THREE.MathUtils.clamp(look.pitch + dy * 0.005, -1.4, 0.6);
        camera.rotation.set(look.pitch, look.yaw, 0, "YXZ");
      }
    };
    const onUp = (e: PointerEvent) => {
      const tap = down && down.moved < 10;
      down = null;
      if (!tap) return;
      const r = el.getBoundingClientRect();
      void onTap(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);

    // ---------- loop (idle while the map has the whole screen) ----------
    renderer.setAnimationLoop((time: number) => {
      if (viewRef.current !== "split") return;
      applyOrientation();
      camera.updateMatrixWorld();
      camera.getWorldPosition(camPos);
      camera.getWorldQuaternion(camQuat);

      // The floor is the plane y = 0 where the centre of the view points, kept 1.6–2.6 m away.
      fwd.set(0, 0, -1).applyQuaternion(camQuat);
      reticle.visible = fwd.y < -0.15;
      if (reticle.visible) {
        floorPos.copy(camPos).addScaledVector(fwd, -camPos.y / fwd.y);
        const dx = floorPos.x - camPos.x, dz = floorPos.z - camPos.z, dist = Math.hypot(dx, dz);
        const k = THREE.MathUtils.clamp(dist, 1.6, 2.6) / dist;
        floorPos.set(camPos.x + dx * k, 0, camPos.z + dz * k);
        reticle.matrix.makeTranslation(floorPos.x, 0.002, floorPos.z);
        if (!floorSeen) {
          floorSeen = true;
          setFloorFound(true);
        }
      }

      let alive = spawning;
      for (const l of live) if (!l.dying) alive++;
      const max = Math.min(MAX_ALIVE, latest.current.campaign?.creatures.length ?? 0);
      if (floorSeen && reticle.visible && alive < max && time - lastSpawn > SPAWN_EVERY_MS) void spawn(time);

      for (let i = live.length - 1; i >= 0; i--) {
        const l = live[i], m = l.mesh;
        if (l.dying) {
          l.dying += 0.04;
          m.rotation.y += 0.4;
          m.position.y += 0.01;
          m.scale.setScalar(Math.max(0.001, 1 - l.dying));
          if (l.dying >= 1) {
            scene.remove(m);
            live.splice(i, 1);
          }
          continue;
        }
        if (m.scale.x < 1) m.scale.setScalar(Math.min(1, m.scale.x + 0.05));
        if (l.hopTo) {
          m.position.lerp(l.hopTo, 0.12);
          if (m.position.distanceTo(l.hopTo) < 0.01) l.hopTo = undefined;
        }
        const t = time / 1000 + l.phase;
        const busy = catching === l; // spins in place while the chain decides
        m.position.y = l.baseY + Math.abs(Math.sin(t * (busy ? 8 : 3))) * 0.04;
        if (busy) m.rotation.y += 0.08;
        else m.lookAt(camPos.x, m.position.y, camPos.z);
      }

      let target: Live | undefined;
      let best = Infinity;
      for (const l of live) {
        if (l.dying) continue;
        const d = Math.hypot(l.mesh.position.x - camPos.x, l.mesh.position.z - camPos.z);
        if (d < best) {
          best = d;
          target = l;
        }
      }
      crumbs.forEach((c, i) => {
        const dist = 0.4 + i * 0.3;
        c.visible = !!target && dist < best - 0.15;
        if (!c.visible || !target) return;
        const k = dist / best, tp = target.mesh.position;
        c.position.set(camPos.x + (tp.x - camPos.x) * k, target.baseY + 0.005, camPos.z + (tp.z - camPos.z) * k);
      });
      crumbMat.opacity = 0.45 + 0.35 * Math.abs(Math.sin(time / 300));

      renderer.render(scene, camera);
    });

    stopRef.current = () => {
      if (stopped) return;
      stopped = true;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      renderer.dispose();
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      el.remove();
      resetRef.current = null;
      stopRef.current = null;
    };
  }

  const hint = !campaign
    ? "No creatures nearby: walk towards a campaign on the map"
    : !camOn
      ? ""
      : !floorFound
        ? "Point the camera at the floor…"
        : canCatch
          ? `Tap a ${campaign.businessName} creature to catch it`
          : `${campaign.businessName} · ${distanceLabel}: walk closer to catch`;

  return (
    <>
      {/* Top half in split view: camera + creatures. Kept mounted so the camera survives tilting. */}
      <div
        ref={hostRef}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          top: 0,
          height: "50%",
          zIndex: 5,
          background: "#000",
          overflow: "hidden",
          display: view === "split" ? "block" : "none",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {!camOn && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16, color: "#fff", textAlign: "center" }}>
            <div>
              <div style={{ fontSize: 15, marginBottom: 10, opacity: 0.85 }}>
                {campaign ? `${campaign.businessName} creatures are nearby (${distanceLabel})` : "Hold your phone upright to hunt in AR"}
              </div>
              <button type="button" onClick={startCamera} style={{ ...PILL, fontSize: 15, padding: "12px 18px", background: "#16a34a" }}>
                📷 Start AR camera
              </button>
              {camError && <div style={{ marginTop: 10, fontSize: 13, color: "#fca5a5" }}>{camError}</div>}
            </div>
          </div>
        )}
        <div
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            bottom: 8,
            display: "grid",
            gap: 6,
            justifyItems: "center",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {toast && <span style={{ ...PILL, background: "rgba(22, 163, 74, 0.92)" }}>{toast}</span>}
          {status && <span style={PILL}>{status}</span>}
          {!status && hint && <span style={PILL}>{hint}</span>}
        </div>
      </div>

      {/* Manual switch (laptops have no gyroscope; also handy to override the tilt). */}
      <button
        type="button"
        aria-label={view === "split" ? "Show the map only" : "Show the AR camera"}
        onClick={() => setView(view === "split" ? "map" : "split")}
        style={{ ...PILL, position: "fixed", right: 12, top: view === "split" ? "calc(50% + 12px)" : "calc(68px + env(safe-area-inset-top))", zIndex: 6 }} // below the NavBar
      >
        {view === "split" ? "🗺 Map" : "📷 AR"}
      </button>
    </>
  );
}
