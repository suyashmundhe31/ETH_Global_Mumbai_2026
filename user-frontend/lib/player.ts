// Player avatar: a glTF model drawn with three.js inside a Mapbox custom layer (shared WebGL context).
//
// GPS mode (default): the avatar follows real GPS. The camera is locked onto the player: no panning, no
//   click-to-walk; pinch / scroll zoom and rotate pivot around the player. Fixes are smoothed so the avatar
//   walks continuously between them instead of stop-start, and jitter / inaccurate fixes are ignored.
// Dev mode: free roam without GPS. Click to walk, right-click to teleport, arrow keys (+Shift to run).
// In both modes the camera stays fixed on the character, Pokémon GO style.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import mapboxgl from "mapbox-gl";

export const MODEL_URL = "/models/player.glb";
export const PLAYER_START: [number, number] = [72.8636, 19.0656];
export const PLAYER_HEIGHT = 1.8; // m — model is auto-scaled to this height from its bounding box
// Real 1.8 m is only ~3 px tall at zoom 17, so the avatar never drops below this on-screen height.
export const PLAYER_MIN_SCREEN_PX = 65;
// Game-style exaggeration applied at every zoom (2.5 → ~4.5 m tall next to 11 m street lamps). 1 = real size.
export const PLAYER_SCALE = 2.5;
export const ROTATION_OFFSET = 0; // rad — add if the model doesn't face +Z (e.g. Math.PI to flip)
export const WALK_SPEED = 1.4; // m/s — dev-mode click-to-walk speed
export const RUN_SPEED = 3; // m/s — above this the "Running" clip plays
export const SHIFT_RUN_SPEED = 5; // m/s — arrow keys + Shift in dev mode
const FADE = 0.3; // s — animation crossfade
const TURN_RATE = 10; // 1/s — heading smoothing
const IDLE_GRACE = 0.35; // s — stay in the walk cycle this long after stopping (avoids flicker between steps)

// GPS tracking (see gpsStep): steps from the accelerometer move the avatar instantly in the direction the
// phone points; GPS fixes continuously pull it onto your true position; standing still ignores GPS drift.
const GPS_JUMP = 150; // m — fixes further than this teleport instead of walking
const GPS_MAX_ACCURACY = 65; // m — ignore worse fixes once we have a good one
const RANGE_RADIUS = 50; // m — the white circle around the player
const COMPASS_FRESH = 2000; // ms
const STRIDE = 0.72; // m per step
const STEP_WINDOW = 1100; // ms — a step this recent means "walking"
const STILL_AFTER = 1800; // ms — no step for this long means "standing"
const MOVING = 0.3; // m/s — avatar speed above this plays the walk cycle and faces the direction of travel
const M_PER_DEG = 111_320;

/** Avatar heading (model space: atan2(east, south)) for a compass bearing in radians clockwise from north. */
const fromBearing = (b: number) => Math.atan2(Math.sin(b), -Math.cos(b));
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export type GpsStatus =
  | { kind: "locating" }
  | { kind: "live"; accuracy: number }
  | { kind: "denied" }
  | { kind: "unavailable"; message: string }
  | { kind: "dev" };

type ClipName = "Idle" | "Walking" | "Running";

const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export function createPlayer(
  map: mapboxgl.Map,
  options: { devMode: boolean; onStatus?: (s: GpsStatus) => void; onFollowChange?: (following: boolean) => void },
) {
  let pos = new mapboxgl.LngLat(...PLAYER_START);
  let fix: mapboxgl.LngLat | null = null; // latest accepted raw GPS fix
  let target: mapboxgl.LngLat | null = null;
  let speed = WALK_SPEED;
  let heading = 0;
  let headingTarget = 0;
  let dev = options.devMode;
  let destroyed = false;
  let follow = true;
  let movingFor = 0; // s since the avatar last moved (for IDLE_GRACE)
  // GPS tracking state
  let fixAcc = 50; // m
  let fixAt = 0; // performance.now() of the last fix
  let fixVel = { e: 0, n: 0 }; // m/s, from the device's GPS speed + course
  let vel = { e: 0, n: 0 }; // m/s, smoothed avatar velocity
  let walkRate = 1; // walk-cycle playback speed (matches your step rate)
  let status: GpsStatus = dev ? { kind: "dev" } : { kind: "locating" };

  const setStatus = (s: GpsStatus) => {
    status = s;
    options.onStatus?.(s);
  };
  const setFollow = (on: boolean) => {
    if (follow === on) return;
    follow = on;
    options.onFollowChange?.(on);
  };

  // --- three.js scene (model space: glTF Y-up, metres) ---
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(30, 100, 50);
  scene.add(sun);

  // Soft contact shadow under the feet: grounds the avatar so it doesn't look like it floats over roads.
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  shadow.position.y = 0.02;
  scene.add(shadow);

  // 50 m range circle on the ground, in real metres (not enlarged like the avatar). Drawn in the same pass.
  const ringScene = new THREE.Scene();
  const ringCamera = new THREE.Camera();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(RANGE_RADIUS, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false }),
  );
  const edge = new THREE.Mesh(
    new THREE.RingGeometry(RANGE_RADIUS - 0.9, RANGE_RADIUS, 128).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  disc.position.y = edge.position.y = 0.4; // just above the road surface: no z-fighting
  ringScene.add(disc, edge);
  const ringTransform = new THREE.Matrix4();

  let mixer: THREE.AnimationMixer | null = null;
  const actions = new Map<string, THREE.AnimationAction>();
  let current: ClipName | null = null;

  const play = (name: ClipName) => {
    const next = actions.get(name);
    if (current === name || !next) return;
    next.reset().fadeIn(FADE).play();
    if (current) actions.get(current)?.fadeOut(FADE);
    current = name;
  };

  const holder = new THREE.Group();
  scene.add(holder);
  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      if (destroyed) return;
      const model = gltf.scene;
      model.traverse((o) => (o.frustumCulled = false)); // custom projection confuses three's culling
      const box = new THREE.Box3().setFromObject(model);
      const k = PLAYER_HEIGHT / (box.max.y - box.min.y);
      model.scale.setScalar(k);
      model.position.y = -box.min.y * k;
      holder.add(model);
      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
      play("Idle");
    },
    undefined,
    (err) => console.error(`Failed to load ${MODEL_URL}`, err),
  );

  // --- Mapbox custom layer ---
  let renderer: THREE.WebGLRenderer | null = null;
  const transform = new THREE.Matrix4();
  const rotX = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const rotY = new THREE.Matrix4();
  const scaleV = new THREE.Vector3();
  const layer: mapboxgl.CustomLayerInterface = {
    id: "player",
    type: "custom",
    renderingMode: "3d",
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(_gl, matrix) {
      if (!renderer) return;
      const m = mapboxgl.MercatorCoordinate.fromLngLat(pos, 0);
      const unit = m.meterInMercatorCoordinateUnits();
      ringTransform.makeTranslation(m.x, m.y, m.z).scale(scaleV.set(unit, -unit, unit)).multiply(rotX);
      ringCamera.projectionMatrix.fromArray(matrix).multiply(ringTransform);
      renderer.resetState();
      renderer.render(ringScene, ringCamera);
      const pxPerMetre = (512 * 2 ** map.getZoom()) / (40_075_016.686 * Math.cos((pos.lat * Math.PI) / 180));
      const enlarge = Math.max(PLAYER_SCALE, PLAYER_MIN_SCREEN_PX / (PLAYER_HEIGHT * pxPerMetre));
      const s = unit * enlarge;
      // Mercator is Z-up with Y pointing south: flip Y, rotate glTF Y-up to Z-up, then face heading.
      transform
        .makeTranslation(m.x, m.y, m.z)
        .scale(scaleV.set(s, -s, s))
        .multiply(rotX)
        .multiply(rotY.makeRotationY(heading + ROTATION_OFFSET));
      camera.projectionMatrix.fromArray(matrix).multiply(transform);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };

  // --- Camera ---
  const followCamera = () => {
    if (!follow) return;
    // Don't fight an in-progress camera animation (recenter, mode switch).
    if (map.isEasing()) return;
    const c = map.getCenter();
    if (Math.abs(c.lng - pos.lng) < 1e-8 && Math.abs(c.lat - pos.lat) < 1e-8) return;
    map.jumpTo({ center: pos });
  };

  // --- GPS tracking (real-time, drift-free) ---
  /** Moves `pos` one frame toward where you really are. Returns true when the avatar is visibly moving. */
  const gpsStep = (dt: number) => {
    if (!fix || dt <= 0) return false;
    const now = performance.now();
    const kx = M_PER_DEG * Math.cos((pos.lat * Math.PI) / 180);
    // The fix, projected forward by the device-reported velocity (GPS positions lag 1–2 s behind you).
    const lead = Math.min((now - fixAt) / 1000, 2);
    const errE = (fix.lng - pos.lng) * kx + fixVel.e * lead;
    const errN = (fix.lat - pos.lat) * M_PER_DEG + fixVel.n * lead;
    const err = Math.hypot(errE, errN);
    if (err > GPS_JUMP) {
      pos = fix;
      vel = { e: 0, n: 0 };
      return false;
    }

    const stepping = motionOk && now - lastStepAt < STEP_WINDOW;
    const still = motionOk && now - lastStepAt > STILL_AFTER;
    const compassOk = compass !== null && now - compassAt < COMPASS_FRESH;

    // 1) Dead reckoning: each detected step moves you right away, in the direction the phone points.
    let de = 0, dn = 0;
    if (stepping && compassOk) {
      const sp = Math.min(Math.max(cadence * STRIDE, 0.6), 2.6);
      de = Math.sin(compass!) * sp * dt;
      dn = Math.cos(compass!) * sp * dt;
    }

    // 2) GPS correction, stronger with better accuracy. Standing still: hold position unless GPS is clearly elsewhere.
    const accK = Math.min(Math.max(10 / Math.max(fixAcc, 4), 0.3), 1.6);
    let gain: number;
    if (!motionOk) gain = err < Math.min(fixAcc * 0.25, 2.5) ? 0 : 1.4 * accK; // no motion sensor: smoothed GPS
    else if (still) gain = err > Math.max(fixAcc, 10) ? 0.8 : 0; // drift inside the accuracy circle is ignored
    else gain = (stepping ? 1.1 : 0.7) * accK;
    const k = 1 - Math.exp(-gain * dt);
    de += errE * k;
    dn += errN * k;

    if (de || dn) pos = new mapboxgl.LngLat(pos.lng + de / kx, pos.lat + dn / M_PER_DEG);

    // Smoothed velocity drives the facing direction.
    const f = 1 - Math.exp(-6 * dt);
    vel = { e: vel.e + (de / dt - vel.e) * f, n: vel.n + (dn / dt - vel.n) * f };
    const sp = Math.hypot(vel.e, vel.n);
    if (sp > MOVING) headingTarget = Math.atan2(vel.e, -vel.n); // model space: atan2(east, south)
    else if (stepping && compassOk) headingTarget = fromBearing(compass!); // tiny steps: face where you walk
    // Walking animation follows your feet, not the map: every detected step animates, even if the avatar
    // barely moves on the map. The legs keep pace with your step rate.
    speed = Math.max(sp, stepping ? cadence * STRIDE : 0);
    walkRate = stepping ? Math.min(Math.max(cadence / 1.8, 0.75), 1.5) : 1;
    return stepping || sp > MOVING;
  };

  // --- Movement loop ---
  const clock = new THREE.Clock();
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);
    let moved = false;

    // Arrow keys (dev mode), relative to the camera: ↑ away from camera, ← → sideways.
    const fwd = +keys.has("ArrowUp") - +keys.has("ArrowDown");
    const side = +keys.has("ArrowRight") - +keys.has("ArrowLeft");
    const keyMove = dev && (fwd !== 0 || side !== 0);
    if (keyMove) {
      target = null;
      speed = keys.has("Shift") ? SHIFT_RUN_SPEED : WALK_SPEED;
      const b = (map.getBearing() * Math.PI) / 180;
      let east = Math.sin(b) * fwd + Math.cos(b) * side;
      let north = Math.cos(b) * fwd - Math.sin(b) * side;
      const n = Math.hypot(east, north);
      east /= n;
      north /= n;
      const a = mapboxgl.MercatorCoordinate.fromLngLat(pos);
      const step = speed * dt * a.meterInMercatorCoordinateUnits();
      pos = new mapboxgl.MercatorCoordinate(a.x + east * step, a.y - north * step, 0).toLngLat();
      headingTarget = Math.atan2(east, -north); // mercator y points south
      moved = true;
      setFollow(true);
    } else if (!dev) {
      moved = gpsStep(dt);
    } else if (target) {
      const a = mapboxgl.MercatorCoordinate.fromLngLat(pos);
      const b = mapboxgl.MercatorCoordinate.fromLngLat(target);
      const unit = a.meterInMercatorCoordinateUnits();
      const dist = Math.hypot(b.x - a.x, b.y - a.y) / unit;
      const step = speed * dt;
      if (dist > 0.05) headingTarget = Math.atan2(b.x - a.x, b.y - a.y); // mercator x = east, y = south
      if (dist <= step) {
        pos = target;
        target = null;
      } else {
        const f = step / dist;
        pos = new mapboxgl.MercatorCoordinate(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 0).toLngLat();
      }
      moved = true;
    }

    // GPS mode, not moving: face where the phone points.
    if (!dev && !moved && compass !== null && performance.now() - compassAt < COMPASS_FRESH) headingTarget = fromBearing(compass);
    heading = lerpAngle(heading, headingTarget, 1 - Math.exp(-TURN_RATE * dt));
    movingFor = moved ? 0 : movingFor + dt;
    const walking = movingFor < IDLE_GRACE;
    play(walking ? (speed > RUN_SPEED ? "Running" : "Walking") : "Idle");
    const walkClip = actions.get("Walking");
    if (walkClip) walkClip.timeScale += ((dev ? 1 : walkRate) - walkClip.timeScale) * Math.min(1, dt * 4);
    mixer?.update(dt);
    followCamera();
    map.triggerRepaint();
  };
  raf = requestAnimationFrame(tick);

  // --- Dev mode input ---
  const onClick = (e: mapboxgl.MapMouseEvent) => {
    if (!dev) return;
    target = e.lngLat;
    speed = WALK_SPEED;
    setFollow(true);
  };
  map.on("click", onClick);

  // Right-click places the player (ignored if the right button was dragged to rotate the map).
  let rightDown: mapboxgl.Point | null = null;
  const onMouseDown = (e: mapboxgl.MapMouseEvent) => {
    if (e.originalEvent.button === 2) rightDown = e.point;
  };
  const onContextMenu = (e: mapboxgl.MapMouseEvent) => {
    if (!dev || (rightDown && rightDown.dist(e.point) > 5)) return;
    pos = e.lngLat;
    target = null;
    setFollow(true);
  };
  map.on("mousedown", onMouseDown);
  map.on("contextmenu", onContextMenu);


  const keys = new Set<string>();
  const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  const onKeyDown = (e: KeyboardEvent) => {
    if (!dev) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (ARROWS.includes(e.key)) e.preventDefault();
    keys.add(e.key);
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);
  const clearKeys = () => keys.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", clearKeys);

  /** The camera is always locked on the character (GPS and dev mode): no panning; pinch / scroll zoom,
   *  rotate and tilt all pivot around the player. Dev mode only adds tap-to-walk and arrow keys. */
  const applyControls = () => {
    map.keyboard.disable(); // arrows move the player in dev mode
    map.boxZoom.disable();
    map.dragPan.disable();
    map.doubleClickZoom.disable(); // zooms around the tap point, which would move the camera off the player
    map.scrollZoom.enable({ around: "center" });
    map.touchZoomRotate.enable({ around: "center" });
    map.dragRotate.enable();
    map.touchPitch.enable();
  };
  applyControls();

  // --- Compass (phone heading). One cheap listener; iOS needs a one-time permission from a tap. ---
  let compass: number | null = null; // rad, clockwise from north (smoothed)
  let compassAt = 0;
  let absolute = false;
  const takeBearing = (deg: number) => {
    const b = ((deg + (screen.orientation?.angle ?? 0)) * Math.PI) / 180;
    compass = compass === null ? b : wrapPi(compass + wrapPi(b - compass) * 0.25);
    compassAt = performance.now();
  };
  const onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.alpha == null) return;
    absolute = true;
    takeBearing(360 - e.alpha);
  };
  const onOrientation = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    if (absolute) return;
    if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) takeBearing(e.webkitCompassHeading);
    else if (e.absolute && e.alpha != null) takeBearing(360 - e.alpha);
  };
  window.addEventListener("deviceorientationabsolute", onAbsolute as EventListener);
  window.addEventListener("deviceorientation", onOrientation as EventListener);
  // --- Step detector (accelerometer). A few float ops per event: cheap. ---
  let motionOk = false; // the device sends motion data
  let lastStepAt = 0;
  let cadence = 1.8; // steps/s, smoothed
  let gravity = 9.81;
  let armed = true;
  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    motionOk = true;
    const mag = Math.hypot(a.x, a.y, a.z);
    gravity += (mag - gravity) * 0.02; // slow low-pass = gravity
    const hp = mag - gravity; // the bounce of each step
    const now = performance.now();
    if (armed && hp > 1.3 && now - lastStepAt > 260) {
      const gap = now - lastStepAt;
      if (gap < 1500) cadence += (Math.min(Math.max(1000 / gap, 1), 3.5) - cadence) * 0.3;
      lastStepAt = now;
      armed = false;
    } else if (hp < 0) {
      armed = true;
    }
  };
  window.addEventListener("devicemotion", onMotion);

  const askMotion = () => {
    type Perm = { requestPermission?: () => Promise<string> };
    const w = window as unknown as { DeviceOrientationEvent?: Perm; DeviceMotionEvent?: Perm };
    if (typeof w.DeviceOrientationEvent?.requestPermission === "function") w.DeviceOrientationEvent.requestPermission().catch(() => null);
    if (typeof w.DeviceMotionEvent?.requestPermission === "function") w.DeviceMotionEvent.requestPermission().catch(() => null);
  };
  window.addEventListener("pointerdown", askMotion, { once: true });

  // --- Real GPS ---
  let watchId: number | null = null;
  const startGps = () => {
    if (watchId !== null) return;
    if (!navigator.geolocation) {
      setStatus({ kind: "unavailable", message: "This browser has no location access." });
      return;
    }
    setStatus({ kind: "locating" });
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (dev) return;
        const acc = p.coords.accuracy ?? 999;
        const next = new mapboxgl.LngLat(p.coords.longitude, p.coords.latitude);
        if (fix && acc > GPS_MAX_ACCURACY) return; // keep the last good fix rather than jump around
        const first = !fix;
        fix = next;
        fixAcc = acc;
        fixAt = performance.now();
        // Device-reported velocity (lets the tracker lead the lagging fix). Unknown course = no lead.
        const v = p.coords.speed, c = p.coords.heading;
        fixVel = v != null && v > 0.3 && c != null && !Number.isNaN(c) ? { e: Math.sin((c * Math.PI) / 180) * v, n: Math.cos((c * Math.PI) / 180) * v } : { e: 0, n: 0 };
        setStatus({ kind: "live", accuracy: Math.round(acc) });
        if (first) {
          pos = next; // first fix: teleport, camera snaps along
          target = null;
          map.jumpTo({ center: pos });
          setFollow(true);
        }
      },
      (err) => {
        console.warn("GPS error:", err.message);
        if (err.code === err.PERMISSION_DENIED) setStatus({ kind: "denied" });
        else if (!fix) setStatus({ kind: "unavailable", message: err.message || "Couldn't get a location fix." });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  };
  const stopGps = () => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  };
  if (dev) setStatus({ kind: "dev" });
  else startGps();

  return {
    layer,
    /** Displayed (smoothed) position: what the avatar and the camera show. */
    getPosition: () => pos,
    /** Best known real position: the latest GPS fix in GPS mode, the avatar in dev mode. Used for catches. */
    getFix: () => (dev ? pos : (fix ?? pos)),
    getStatus: () => status,
    isFollowing: () => follow,
    setDevMode(on: boolean) {
      if (on === dev) return;
      dev = on;
      target = null;
      keys.clear();
      applyControls();
      if (on) {
        stopGps();
        setStatus({ kind: "dev" });
      } else {
        fix = null;
        vel = { e: 0, n: 0 };
        startGps();
      }
      setFollow(true);
      map.easeTo({ center: pos, duration: 400 });
    },
    recenter() {
      setFollow(true);
      map.easeTo({ center: pos, duration: 450 });
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      stopGps();
      map.off("click", onClick);
      map.off("mousedown", onMouseDown);
      map.off("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
      window.removeEventListener("deviceorientationabsolute", onAbsolute as EventListener);
      window.removeEventListener("deviceorientation", onOrientation as EventListener);
      window.removeEventListener("pointerdown", askMotion);
      window.removeEventListener("devicemotion", onMotion);
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;
