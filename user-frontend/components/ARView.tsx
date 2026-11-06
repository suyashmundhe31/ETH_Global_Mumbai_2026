"use client";

// Geo-anchored AR camera.
//   Phone flat  -> the full 3D map.     Phone raised -> split screen: camera AR on top, the 3D map below
//   (still locked on the character).
// Every spawn from Arkiv sits in the camera view in its real-world direction (GPS + compass): far ones show
// as waypoints (pin + name + distance, pinned to the screen edge with an arrow when out of view), and a
// floor trail leads to the selected one. Inside the catch radius the creature itself stands there; tapping
// it runs the same on-chain catch as the map's Catch button.
// Without a compass the view starts facing the selected spawn (directions are approximate); without a
// gyroscope (laptops) dragging looks around.

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { CATCH_RADIUS, type Campaign } from "@/lib/campaigns";
import { loadModel } from "@/lib/glb";
import type { Player } from "@/lib/player";
import { IconArrowLeft, IconCamera, IconChevronSwap, IconCompass, IconPaw } from "@/components/icons";

export type ARCatchOutcome = "caught" | "missed" | "failed";

// Device forward Y: 0 = upright, -1 = flat with the screen up. Hysteresis avoids flicker.
const TO_MAP = -0.65; // tilt past ~40° down -> map
const TO_AR = -0.35; // raise above ~20° -> AR
const MAX_WAYPOINTS = 8;
const CREATURE_HEIGHT = 0.9; // m
const NEAR_SHOW = 3.5; // m — creatures are drawn between these distances in their true direction
const FAR_SHOW = 12; // m
const WAYPOINT_DIST = 30; // m — where out-of-range waypoints are anchored
const EYE = 1.4; // m — phone height
// Screen insets (within the top half) that off-screen waypoints stick to.
const EDGE = { top: 84, right: 34, bottom: 60, left: 34 };
const NAV_CLEARANCE = 66; // px — the top nav on wider screens (on phones it's a bottom tab bar)

type Live = {
  id: string;
  url: string;
  group: THREE.Group | null;
  hitbox: THREE.Mesh | null;
  born: number;
  dying: number;
  phase: number;
  scale: number;
  hop: THREE.Vector3 | null;
};

const M_PER_DEG = 111_320;
const offsetMetres = (from: mapboxgl.LngLat, to: mapboxgl.LngLat) => ({
  e: (to.lng - from.lng) * M_PER_DEG * Math.cos((from.lat * Math.PI) / 180),
  n: (to.lat - from.lat) * M_PER_DEG,
});
const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// Device orientation -> camera quaternion (three.js DeviceOrientationControls maths), world: -Z north, +X east.
const Q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const ZEE = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
function deviceQuat(out: THREE.Quaternion, a: number, b: number, g: number, screenAngle: number, euler = new THREE.Euler(), q0 = new THREE.Quaternion()) {
  const d = THREE.MathUtils.DEG2RAD;
  euler.set(b * d, a * d, -g * d, "YXZ");
  out.setFromEuler(euler).multiply(Q1);
  return out.multiply(q0.setFromAxisAngle(ZEE, -screenAngle * d));
}
/** Compass heading (rad, clockwise from north) of a camera quaternion's forward vector. */
function headingOf(q: THREE.Quaternion, v = new THREE.Vector3()) {
  v.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(v.x, -v.z);
}

type Orient = { a: number; b: number; g: number; ok: boolean; source: "none" | "absolute" | "ios" | "relative"; offset: number; offsetSet: boolean };

export default function ARView({
  map,
  player,
  open,
  setOpen,
  disabled,
  campaigns,
  selectedId,
  onSelect,
  busy,
  onCatch,
}: {
  map: mapboxgl.Map;
  player: Player;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Dev mode: AR is off. */
  disabled: boolean;
  /** Visible spawns, nearest first. */
  campaigns: Campaign[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy: boolean;
  onCatch: (c: Campaign) => Promise<ARCatchOutcome>;
}) {
  const active = open && !disabled;
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState("");
  const [compass, setCompass] = useState<Orient["source"]>("none");
  const [toast, setToast] = useState<{ text: string; good?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const wpEls = useRef(new Map<string, HTMLButtonElement>());
  const stopRef = useRef<(() => void) | null>(null);
  const granted = useRef(false); // camera allowed once: reopening AR restarts it without another tap
  const orient = useRef<Orient>({ a: 0, b: 0, g: 0, ok: false, source: "none", offset: 0, offsetSet: false });

  // The render loop and tap handler outlive renders: they read the latest props through a ref.
  const latest = useRef({ campaigns, selectedId, busy, onCatch, onSelect });
  useEffect(() => {
    latest.current = { campaigns, selectedId, busy, onCatch, onSelect };
  });

  const showToast = (text: string, good = false) => {
    setToast({ text, good });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  // --- Orientation: compass-corrected when the device has one; also drives the tilt switch ---
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });
  useEffect(() => {
    if (disabled) return;
    const o = orient.current;
    const q = new THREE.Quaternion(), fwd = new THREE.Vector3();
    let tilt: "flat" | "upright" | null = null;

    const update = (a: number, b: number, g: number) => {
      o.a = a;
      o.b = b;
      o.g = g;
      o.ok = true;
      fwd.set(0, 0, -1).applyQuaternion(deviceQuat(q, a, b, g, 0));
      // Only transitions switch views, so closing AR by hand while upright sticks until the phone goes flat.
      const next = fwd.y < TO_MAP ? "flat" : fwd.y > TO_AR ? "upright" : tilt;
      if (next !== tilt) {
        if (tilt !== null) setOpen(next === "upright");
        tilt = next;
      }
    };
    const onAbsolute = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null) return;
      o.source = "absolute";
      o.offset = 0;
      o.offsetSet = true;
      update(e.alpha, e.beta, e.gamma ?? 0);
    };
    const onRelative = (e: DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number }) => {
      if (e.beta == null) return;
      if (o.source === "absolute") return; // Android sends both; the absolute stream wins
      if (e.absolute && e.alpha != null) return onAbsolute(e);
      const a = e.alpha ?? 0, b = e.beta, g = e.gamma ?? 0;
      const h = e.webkitCompassHeading;
      if (typeof h === "number" && !Number.isNaN(h) && (e.webkitCompassAccuracy ?? 0) >= 0) {
        // iOS: alpha is relative; webkitCompassHeading is true-ish heading. Keep a smoothed offset between them.
        const rel = headingOf(deviceQuat(q, a, b, g, screen.orientation?.angle ?? 0));
        const sample = wrapPi(THREE.MathUtils.degToRad(h) - rel);
        o.offset = o.offsetSet ? o.offset + wrapPi(sample - o.offset) * 0.05 : sample;
        o.offsetSet = true;
        o.source = "ios";
      } else if (o.source === "none") {
        o.source = "relative";
      }
      update(a, b, g);
    };
    window.addEventListener("deviceorientationabsolute", onAbsolute as EventListener);
    window.addEventListener("deviceorientation", onRelative as EventListener);
    const sourceTimer = setInterval(() => setCompass(o.source), 1000);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onAbsolute as EventListener);
      window.removeEventListener("deviceorientation", onRelative as EventListener);
      clearInterval(sourceTimer);
    };
  }, [disabled, setOpen]);

  // --- AR on/off: the map moves to the bottom half (and Mapbox re-measures it), and back ---
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.ar = "on";
    const raf = requestAnimationFrame(() => {
      try {
        map.resize();
        player.recenter();
      } catch {}
    });
    return () => {
      cancelAnimationFrame(raf);
      stopRef.current?.();
      setCamOn(false);
      delete root.dataset.ar;
      requestAnimationFrame(() => {
        try {
          map.resize();
          player.recenter();
        } catch {}
      });
    };
  }, [active, map, player]);

  useEffect(
    () => () => {
      stopRef.current?.();
      if (toastTimer.current) clearTimeout(toastTimer.current);
      delete document.documentElement.dataset.ar;
    },
    [],
  );

  function runScene(stream: MediaStream) {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 3, 2);
    scene.add(sun);

    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    host.prepend(video, renderer.domElement);
    video.play().catch(() => {});

    const size = { w: 1, h: 1 };
    const resize = () => {
      size.w = host.clientWidth || innerWidth;
      size.h = host.clientHeight || innerHeight;
      renderer.setSize(size.w, size.h);
      camera.aspect = size.w / size.h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    camera.position.set(0, EYE, 0);

    // Floor trail toward the selected spawn: chevrons with a travelling pulse.
    const chevShape = new THREE.Shape();
    chevShape.moveTo(-0.16, -0.06);
    chevShape.lineTo(0, 0.08);
    chevShape.lineTo(0.16, -0.06);
    chevShape.lineTo(0.16, -0.12);
    chevShape.lineTo(0, 0.02);
    chevShape.lineTo(-0.16, -0.12);
    chevShape.closePath();
    const chevGeo = new THREE.ShapeGeometry(chevShape).rotateX(-Math.PI / 2);
    const trail = Array.from({ length: 12 }, () => {
      const m = new THREE.Mesh(chevGeo, new THREE.MeshBasicMaterial({ color: 0x4be3a0, transparent: true, opacity: 0.8, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      return m;
    });
    // Ground ring under creatures in range.
    const ringGeo = new THREE.RingGeometry(0.42, 0.5, 48).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x4be3a0, transparent: true, opacity: 0.7, depthWrite: false });

    const live = new Map<string, Live>();
    const rings = new Map<string, THREE.Mesh>();
    let stopped = false;
    let catching: Live | null = null;
    const camPos = new THREE.Vector3(0, EYE, 0);
    const tmp = new THREE.Vector3();
    const camSpace = new THREE.Vector3();
    const qDev = new THREE.Quaternion(), qYaw = new THREE.Quaternion();
    const euler = new THREE.Euler(), q0 = new THREE.Quaternion();
    const hitboxMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

    // Without any orientation data (laptop): look around by dragging.
    const look = { yaw: 0, pitch: -0.12, set: false };

    const spawn = (id: string, url: string) => {
      const l: Live = { id, url, group: null, hitbox: null, born: 0, dying: 0, phase: Math.random() * 10, scale: 1, hop: null };
      live.set(id, l);
      loadModel(url, CREATURE_HEIGHT)
        .then((g) => {
          if (stopped || live.get(id) !== l) return;
          const s = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3()).multiplyScalar(1.4);
          const hitbox = new THREE.Mesh(new THREE.BoxGeometry(s.x || 0.6, s.y || 0.9, s.z || 0.6), hitboxMat);
          hitbox.position.y = (s.y || 0.9) / 2;
          g.add(hitbox);
          g.scale.setScalar(0.001);
          scene.add(g);
          l.group = g;
          l.hitbox = hitbox;
          l.born = performance.now();
        })
        .catch((e) => console.warn("AR: couldn't load the creature model", e));
      return l;
    };

    // ---------- tap to catch ----------
    const raycaster = new THREE.Raycaster();
    async function onTap(ndc: THREE.Vector2) {
      raycaster.setFromCamera(ndc, camera);
      const boxes = [...live.values()].filter((l) => l.hitbox && !l.dying).map((l) => l.hitbox!);
      const hit = raycaster.intersectObjects(boxes, false)[0];
      const target = hit && [...live.values()].find((l) => l.hitbox === hit.object);
      if (!target) return;
      const c = latest.current.campaigns.find((x) => x.campaignId === target.id);
      if (!c) return;
      latest.current.onSelect(c.campaignId);
      if (catching || latest.current.busy) return showToast("Hold on, your catch is still being processed…");
      catching = target;
      navigator.vibrate?.(40);
      const outcome = await latest.current.onCatch(c);
      catching = null;
      if (stopped) return;
      if (outcome === "caught") {
        target.dying = 0.0001;
        navigator.vibrate?.(80);
      } else if (outcome === "missed" && target.group) {
        const a = Math.random() * Math.PI * 2;
        target.hop = target.group.position.clone().add(new THREE.Vector3(Math.cos(a) * 0.8, 0, Math.sin(a) * 0.8));
        navigator.vibrate?.([30, 40, 30]);
      }
    }
    let down: { x: number; y: number; moved: number } | null = null;
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
        look.pitch = THREE.MathUtils.clamp(look.pitch + dy * 0.005, -1.3, 0.8);
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

    /** Screen placement of a waypoint: on screen, or stuck to the inset edge with an arrow. */
    const placeWaypoint = (btn: HTMLButtonElement, world: THREE.Vector3) => {
      camSpace.copy(world).applyMatrix4(camera.matrixWorldInverse);
      tmp.copy(world).project(camera);
      const behind = camSpace.z > 0;
      const onScreen = !behind && Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1;
      const bw = btn.offsetWidth || 40, bh = btn.offsetHeight || 60;
      if (onScreen) {
        const sx = ((tmp.x + 1) / 2) * size.w, sy = ((1 - tmp.y) / 2) * size.h;
        btn.dataset.edge = "false";
        btn.style.transform = `translate3d(${sx - bw / 2}px, ${sy - bh}px, 0)`;
        return;
      }
      // Direction on screen from the centre: camera-space x right, y up (still valid for points behind).
      let dx = camSpace.x, dy = -camSpace.y;
      if (behind && Math.abs(dx) < 1e-3) dx = 1e-3;
      if (behind) dy = Math.abs(dy) * 0.25; // behind you: slide along the bottom-ish sides, not the top
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const top = EDGE.top + (size.w > 640 ? NAV_CLEARANCE : 0);
      const cx = size.w / 2, cy = (top + size.h - EDGE.bottom) / 2;
      const hw = cx - EDGE.left, hh = (size.h - EDGE.bottom - top) / 2;
      const t = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6));
      const sx = cx + dx * t, sy = cy + dy * t;
      btn.dataset.edge = "true";
      btn.style.transform = `translate3d(${sx - 20}px, ${sy - 20}px, 0)`;
      const arrow = btn.querySelector<HTMLElement>(".wp-arrow");
      if (arrow) arrow.style.transform = `rotate(${Math.atan2(dx, -dy)}rad) translateY(-30px)`;
    };

    // ---------- loop ----------
    renderer.setAnimationLoop((time: number) => {
      const o = orient.current;
      const { campaigns: list, selectedId: sel } = latest.current;
      const me = player.getPosition();
      const selected = list.find((c) => c.campaignId === sel) ?? list[0] ?? null;

      // Camera orientation.
      if (o.ok) {
        deviceQuat(qDev, o.a, o.b, o.g, screen.orientation?.angle ?? 0, euler, q0);
        if (!o.offsetSet && selected) {
          // No compass: start facing the selected spawn.
          const { e, n } = offsetMetres(me, selected.lngLat);
          o.offset = wrapPi(Math.atan2(e, n) - headingOf(qDev));
          o.offsetSet = true;
        }
        camera.quaternion.copy(qYaw.setFromAxisAngle(UP, -o.offset)).multiply(qDev);
      } else {
        if (!look.set && selected) {
          const { e, n } = offsetMetres(me, selected.lngLat);
          look.yaw = -Math.atan2(e, n);
          look.set = true;
        }
        camera.rotation.set(look.pitch, look.yaw, 0, "YXZ");
      }
      camera.updateMatrixWorld();

      // Spawns: creatures for those in range, waypoints for all of them.
      const keep = new Set<string>();
      list.slice(0, MAX_WAYPOINTS).forEach((c) => {
        const { e, n } = offsetMetres(me, c.lngLat);
        const d = Math.hypot(e, n) || 0.001;
        const dirX = e / d, dirZ = -n / d;
        const inRange = d <= CATCH_RADIUS;
        const btn = wpEls.current.get(c.campaignId);
        let anchorY = EYE + 0.9;
        let anchorD = Math.min(d, WAYPOINT_DIST);

        if (inRange) {
          keep.add(c.campaignId);
          let l = live.get(c.campaignId);
          if (!l || l.dying) l = spawn(c.campaignId, c.modelUrl);
          const show = THREE.MathUtils.clamp(d, NEAR_SHOW, FAR_SHOW);
          l.scale = THREE.MathUtils.clamp(show / 4, 1, 2.4);
          anchorD = show;
          anchorY = CREATURE_HEIGHT * l.scale + 0.45;
          if (l.group && !l.hop) l.group.position.set(dirX * show, 0, dirZ * show);
          let ring = rings.get(c.campaignId);
          if (!ring) {
            ring = new THREE.Mesh(ringGeo, ringMat);
            rings.set(c.campaignId, ring);
            scene.add(ring);
          }
          const at = l.group?.position ?? tmp.set(dirX * show, 0, dirZ * show);
          ring.position.set(at.x, 0.01, at.z);
          ring.scale.setScalar(l.scale * (1 + 0.06 * Math.sin(time / 300)));
        }

        if (btn) {
          btn.hidden = false;
          placeWaypoint(btn, tmp.set(dirX * anchorD, anchorY, dirZ * anchorD).clone());
          btn.dataset.inRange = String(inRange);
          btn.dataset.selected = String(c.campaignId === selected?.campaignId);
          const label = btn.querySelector(".wp-dist");
          const text = inRange ? "Tap to catch" : fmtDist(d);
          if (label && label.textContent !== text) label.textContent = text;
        }
      });
      for (const [id, btn] of wpEls.current) if (!list.slice(0, MAX_WAYPOINTS).some((c) => c.campaignId === id)) btn.hidden = true;

      // Creatures: spawn-in, idle, catching spin, caught swirl, leaving range.
      for (const [id, l] of live) {
        if (!keep.has(id) && !l.dying) l.dying = 0.0001;
        const g = l.group;
        if (!g) {
          if (l.dying) live.delete(id);
          continue;
        }
        if (l.dying) {
          l.dying += 0.035;
          g.rotation.y += 0.35;
          g.position.y += 0.03;
          g.scale.setScalar(Math.max(0.001, l.scale * (1 - l.dying)));
          if (l.dying >= 1) {
            scene.remove(g);
            live.delete(id);
            const r = rings.get(id);
            if (r) {
              scene.remove(r);
              rings.delete(id);
            }
          }
          continue;
        }
        const age = Math.min(1, (time - l.born) / 700);
        const pop = age >= 1 ? 1 : 1 - Math.pow(2, -10 * age);
        g.scale.setScalar(l.scale * Math.max(0.001, pop));
        if (l.hop) {
          g.position.lerp(l.hop, 0.12);
          if (g.position.distanceTo(l.hop) < 0.02) l.hop = null;
        }
        const t = time / 1000 + l.phase;
        const spinning = catching === l;
        g.position.y = Math.abs(Math.sin(t * (spinning ? 8 : 2.6))) * 0.06 * l.scale;
        if (spinning) g.rotation.y += 0.09;
        else g.lookAt(camPos.x, g.position.y, camPos.z);
      }
      for (const [id, r] of rings)
        if (!live.has(id)) {
          scene.remove(r);
          rings.delete(id);
        }

      // Floor trail toward the selected spawn.
      let trailLen = 0;
      let tx = 0, tz = -1;
      if (selected) {
        const { e, n } = offsetMetres(me, selected.lngLat);
        const d = Math.hypot(e, n) || 0.001;
        tx = e / d;
        tz = -n / d;
        trailLen = d <= CATCH_RADIUS ? THREE.MathUtils.clamp(d, NEAR_SHOW, FAR_SHOW) - 0.8 : 9;
      }
      const yaw = Math.atan2(-tx, -tz);
      trail.forEach((m, i) => {
        const at = 1.2 + i * 0.7;
        m.visible = !!selected && at < trailLen;
        if (!m.visible) return;
        m.position.set(tx * at, 0.01, tz * at);
        m.rotation.set(0, yaw, 0);
        const wave = (time / 600 - i * 0.18) % 1;
        (m.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.65 * Math.max(0, 1 - Math.abs(wave < 0 ? wave + 1 : wave) * 2.2);
      });

      renderer.render(scene, camera);
    });

    stopRef.current = () => {
      if (stopped) return;
      stopped = true;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      renderer.dispose();
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      el.remove();
      stopRef.current = null;
    };
  }

  async function startCamera() {
    if (stopRef.current) return;
    setCamError("");
    try {
      // iOS only grants motion access from inside a tap, so ask first.
      const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
      if (!granted.current && typeof DOE?.requestPermission === "function") {
        const p = await DOE.requestPermission().catch(() => "denied");
        if (p !== "granted") showToast("No motion access: drag the view to look around");
      }
      if (!window.isSecureContext) throw new Error("the camera needs HTTPS. Open the game through its https:// link.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (!activeRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      granted.current = true;
      setCamOn(true);
      runScene(stream);
    } catch (e) {
      setCamError(`Couldn't start the camera: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Camera already allowed once: reopening AR restarts it without another tap.
  useEffect(() => {
    if (active && granted.current) void startCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active) return null;

  const target = campaigns.find((c) => c.campaignId === selectedId) ?? campaigns[0] ?? null;
  const me = player.getPosition();
  const targetDist = target ? target.lngLat.distanceTo(me) : 0;
  const inRange = !!target && targetDist <= CATCH_RADIUS;
  const cycle = () => {
    if (campaigns.length < 2 || !target) return;
    const i = campaigns.findIndex((c) => c.campaignId === target.campaignId);
    onSelect(campaigns[(i + 1) % campaigns.length].campaignId);
  };

  const hint = !target
    ? "No creatures nearby. Walk around to find a spawn."
    : inRange
      ? `Tap the ${target.businessName} creature to catch it`
      : `Follow the waypoint to ${target.businessName}`;

  return (
    <>
      <div ref={hostRef} className="ar" aria-label="AR camera">
        <div className="wp-layer">
          {campaigns.slice(0, MAX_WAYPOINTS).map((c) => (
            <button
              key={c.campaignId}
              type="button"
              className="wp"
              hidden
              ref={(node) => {
                if (node) wpEls.current.set(c.campaignId, node);
                else wpEls.current.delete(c.campaignId);
              }}
              onClick={() => onSelect(c.campaignId)}
              aria-label={`${c.businessName} waypoint`}
            >
              <span className="wp-pin">
                <IconPaw />
                <span className="wp-arrow" />
              </span>
              <span className="wp-label">
                {c.businessName}
                <small className="wp-dist" />
              </span>
            </button>
          ))}
        </div>

        <div className="ar-top">
          <button type="button" className="icon-btn" aria-label="Back to the map" onClick={() => setOpen(false)}>
            <IconArrowLeft />
          </button>
          {target && (
            <div className="ar-target panel" data-in-range={inRange}>
              <span className="ar-target-icon">
                <IconPaw />
              </span>
              <span className="ar-target-text">
                <strong>{target.businessName}</strong>
                <span>
                  {inRange ? "In range · tap to catch" : `${fmtDist(targetDist)} away`}
                </span>
              </span>
            </div>
          )}
          {campaigns.length > 1 && (
            <button type="button" className="icon-btn" aria-label="Next spawn" onClick={cycle}>
              <IconChevronSwap />
            </button>
          )}
        </div>

        {camOn && (
          <div className="ar-bottom">
            {toast && <span className={toast.good ? "ar-pill ar-pill-success" : "ar-pill"}>{toast.text}</span>}
            {compass === "relative" && (
              <span className="ar-pill" style={{ color: "var(--warn)" }}>
                <IconCompass />
                No compass: directions are approximate
              </span>
            )}
            {!busy && <span className="ar-pill">{hint}</span>}
          </div>
        )}

        {!camOn && (
          <div className="ar-start">
            <div className="ar-start-card panel">
              <div className="ar-start-icon">
                <IconCamera />
              </div>
              <h2>Hunt in AR</h2>
              <p>
                {target
                  ? `${target.businessName} creatures are ${inRange ? "right here" : fmtDist(targetDist) + " away"}. Turn on the camera and follow the waypoints.`
                  : "Turn on the camera to see nearby creatures in the real world."}
              </p>
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void startCamera()}>
                <IconCamera />
                Turn on camera
              </button>
              {camError && (
                <div className="notice notice-error" style={{ marginTop: 12, textAlign: "left" }}>
                  {camError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

    </>
  );
}
