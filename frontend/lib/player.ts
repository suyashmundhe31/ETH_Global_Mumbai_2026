// Player avatar: a glTF model drawn with three.js inside a Mapbox custom layer (shared WebGL context).
// Dev mode: click the map to walk there. Otherwise follows real GPS via watchPosition.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import mapboxgl from "mapbox-gl";

export const MODEL_URL = "/models/player.glb";
export const PLAYER_START: [number, number] = [72.8636, 19.0656];
export const PLAYER_HEIGHT = 1.8; // m — model is auto-scaled to this height from its bounding box
// Real 1.8 m is only ~3 px tall at zoom 17, so (like Pokémon GO) the avatar never drops below this
// on-screen height. Set to 0 for strict real-world size.
export const PLAYER_MIN_SCREEN_PX = 65;
// Game-style exaggeration applied at every zoom (2.5 → ~4.5 m tall next to 11 m street lamps). 1 = real size.
export const PLAYER_SCALE = 2.5;
export const ROTATION_OFFSET = 0; // rad — add if the model doesn't face +Z (e.g. Math.PI to flip)
export const WALK_SPEED = 1.4; // m/s — dev-mode click-to-walk speed
export const RUN_SPEED = 3; // m/s — above this the "Running" clip plays
export const SHIFT_RUN_SPEED = 5; // m/s — arrow keys + Shift in dev mode
const FADE = 0.3; // s — animation crossfade
const GPS_JUMP = 100; // m — GPS fixes further than this teleport instead of walking
const GPS_JITTER = 2; // m — ignore GPS movement smaller than this

type ClipName = "Idle" | "Walking" | "Running";

export function createPlayer(map: mapboxgl.Map, devMode: boolean) {
  let pos = new mapboxgl.LngLat(...PLAYER_START);
  let target: mapboxgl.LngLat | null = null;
  let speed = WALK_SPEED;
  let heading = 0;
  let dev = devMode;
  let destroyed = false;

  // --- three.js scene (model space: glTF Y-up, metres) ---
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(30, 100, 50);
  scene.add(sun);

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

  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      if (destroyed) return;
      const model = gltf.scene;
      model.traverse((o) => (o.frustumCulled = false)); // custom projection confuses three's culling
      // Scale to PLAYER_HEIGHT metres and stand the feet on the ground.
      const box = new THREE.Box3().setFromObject(model);
      const k = PLAYER_HEIGHT / (box.max.y - box.min.y);
      model.scale.setScalar(k);
      model.position.y = -box.min.y * k;
      scene.add(model);

      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
      console.log("Player clips:", gltf.animations.map((c) => c.name));
      play("Idle");
    },
    undefined,
    (err) => console.error(`Failed to load ${MODEL_URL}`, err),
  );

  // --- Mapbox custom layer ---
  let renderer: THREE.WebGLRenderer | null = null;
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
      const pxPerMetre = (512 * 2 ** map.getZoom()) / (40_075_016.686 * Math.cos((pos.lat * Math.PI) / 180));
      const enlarge = Math.max(PLAYER_SCALE, PLAYER_MIN_SCREEN_PX / (PLAYER_HEIGHT * pxPerMetre));
      const s = m.meterInMercatorCoordinateUnits() * enlarge;
      // Mercator is Z-up with Y pointing south: flip Y, rotate glTF Y-up to Z-up, then face heading.
      const transform = new THREE.Matrix4()
        .makeTranslation(m.x, m.y, m.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeRotationY(heading + ROTATION_OFFSET));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(transform);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };

  // --- Movement loop ---
  const clock = new THREE.Clock();
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);

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
      heading = Math.atan2(east, -north); // mercator y points south
      map.setCenter(pos);
    } else if (target) {
      const a = mapboxgl.MercatorCoordinate.fromLngLat(pos);
      const b = mapboxgl.MercatorCoordinate.fromLngLat(target);
      const dist = Math.hypot(b.x - a.x, b.y - a.y) / a.meterInMercatorCoordinateUnits();
      const step = speed * dt;
      // Face direction of travel: mercator x = east, y = south.
      heading = Math.atan2(b.x - a.x, b.y - a.y);
      if (dist <= step) {
        pos = target;
        target = null;
      } else {
        const f = step / dist;
        pos = new mapboxgl.MercatorCoordinate(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 0).toLngLat();
      }
      map.setCenter(pos);
    }

    play(target || keyMove ? (speed > RUN_SPEED ? "Running" : "Walking") : "Idle");
    mixer?.update(dt);
    map.triggerRepaint();
  };
  raf = requestAnimationFrame(tick);

  // Dev mode: click to walk.
  const onClick = (e: mapboxgl.MapMouseEvent) => {
    if (!dev) return;
    target = e.lngLat;
    speed = WALK_SPEED;
  };
  map.on("click", onClick);

  // Dev mode: right-click places the player (ignored if the right button was dragged to rotate the map).
  let rightDown: mapboxgl.Point | null = null;
  const onMouseDown = (e: mapboxgl.MapMouseEvent) => {
    if (e.originalEvent.button === 2) rightDown = e.point;
  };
  const onContextMenu = (e: mapboxgl.MapMouseEvent) => {
    if (!dev || (rightDown && rightDown.dist(e.point) > 5)) return;
    pos = e.lngLat;
    target = null;
    map.setCenter(pos);
  };
  map.on("mousedown", onMouseDown);
  map.on("contextmenu", onContextMenu);

  // Dev mode: arrow keys move (Mapbox's own arrow-key panning is disabled while dev mode is on).
  const keys = new Set<string>();
  const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  const onKeyDown = (e: KeyboardEvent) => {
    if (!dev) return;
    if (ARROWS.includes(e.key)) e.preventDefault();
    keys.add(e.key);
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);
  const clearKeys = () => keys.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", clearKeys);
  if (dev) map.keyboard.disable();

  // Real GPS.
  let watchId: number | null = null;
  let lastFix = 0;
  const startGps = () => {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        const next = new mapboxgl.LngLat(p.coords.longitude, p.coords.latitude);
        const d = pos.distanceTo(next);
        const dtS = lastFix ? (p.timestamp - lastFix) / 1000 : 0;
        lastFix = p.timestamp;
        if (d > GPS_JUMP || dtS <= 0) {
          pos = next; // first fix or big jump: teleport
          target = null;
          map.setCenter(pos);
        } else if (d > GPS_JITTER) {
          target = next;
          speed = p.coords.speed || d / dtS; // some devices report 0/null while moving
        }
      },
      (err) => console.warn("GPS error:", err.message),
      { enableHighAccuracy: true, maximumAge: 1000 },
    );
  };
  const stopGps = () => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    lastFix = 0;
  };
  if (!dev) startGps();

  return {
    layer,
    getPosition: () => pos,
    setDevMode(on: boolean) {
      if (on === dev) return;
      dev = on;
      target = null;
      keys.clear();
      if (on) map.keyboard.disable();
      else map.keyboard.enable();
      if (on) stopGps();
      else startGps();
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
    },
  };
}
