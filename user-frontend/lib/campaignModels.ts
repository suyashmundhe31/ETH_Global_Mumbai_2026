// 3D creature model (GLB from Swarm) hovering at each visible campaign, drawn with three.js in a
// Mapbox custom layer. One model per campaign, like the markers.

import * as THREE from "three";
import mapboxgl from "mapbox-gl";
import { loadModel } from "@/lib/glb";

export const MODEL_HEIGHT = 1.35; // m
const SCALE = 2.5; // same game-style exaggeration as the player
const MIN_SCREEN_PX = 45; // never smaller than this on screen
const HOVER = 0.6; // m above the ground at rest, bobbing ±HOVER/2

export type CampaignModel = { id: string; lngLat: mapboxgl.LngLat; url: string };
type Entry = CampaignModel & { obj: THREE.Object3D | null; phase: number };

export function createCampaignModels(map: mapboxgl.Map) {
  const entries = new Map<string, Entry>();
  let destroyed = false;
  let visible = true;

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(30, 100, 50);
  scene.add(sun);

  const attach = (e: Entry) => {
    loadModel(e.url, MODEL_HEIGHT)
      .then((obj) => {
        // Still wanted, with the same model?
        if (destroyed || entries.get(e.id) !== e) return;
        e.obj = obj;
        scene.add(obj);
        map.triggerRepaint();
      })
      .catch((err) => console.error(`Failed to load creature model ${e.url}`, err));
  };

  /** Show exactly these campaigns (adds, moves, swaps models and removes as needed). */
  const set = (list: CampaignModel[]) => {
    const live = new Set(list.map((c) => c.id));
    for (const [id, e] of entries) {
      if (!live.has(id)) {
        if (e.obj) scene.remove(e.obj);
        entries.delete(id);
      }
    }
    for (const c of list) {
      const old = entries.get(c.id);
      if (old && old.url === c.url) {
        old.lngLat = c.lngLat;
        continue;
      }
      if (old?.obj) scene.remove(old.obj);
      const e: Entry = { ...c, obj: null, phase: Math.random() * Math.PI * 2 };
      entries.set(c.id, e);
      attach(e);
    }
    map.triggerRepaint();
  };

  let renderer: THREE.WebGLRenderer | null = null;
  const layer: mapboxgl.CustomLayerInterface = {
    id: "campaign-models",
    type: "custom",
    renderingMode: "3d",
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(_gl, matrix) {
      const shown = [...entries.values()].filter((e) => e.obj);
      if (!renderer || !shown.length || !visible) return;
      // Scene units: metres from the first campaign (x = east, y = up, z = south).
      const origin = shown[0].lngLat;
      const m = mapboxgl.MercatorCoordinate.fromLngLat(origin, 0);
      const s = m.meterInMercatorCoordinateUnits();
      const pxPerMetre = (512 * 2 ** map.getZoom()) / (40_075_016.686 * Math.cos((origin.lat * Math.PI) / 180));
      const enlarge = Math.max(SCALE, MIN_SCREEN_PX / (MODEL_HEIGHT * pxPerMetre));
      const t = performance.now() / 1000;
      for (const e of shown) {
        const p = mapboxgl.MercatorCoordinate.fromLngLat(e.lngLat, 0);
        const hover = (HOVER + Math.sin(t * 2 + e.phase) * (HOVER / 2)) * enlarge;
        e.obj!.position.set((p.x - m.x) / s, hover, (p.y - m.y) / s);
        e.obj!.scale.setScalar(enlarge);
      }
      const transform = new THREE.Matrix4()
        .makeTranslation(m.x, m.y, m.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(transform);
      renderer.resetState();
      renderer.render(scene, camera);
      map.triggerRepaint(); // keep hovering
    },
  };

  return {
    layer,
    set,
    /** Hidden in the AR minimap (its markers shrink to dots there). */
    setVisible(on: boolean) {
      visible = on;
      map.triggerRepaint();
    },
    destroy() {
      destroyed = true;
      entries.clear();
    },
  };
}
