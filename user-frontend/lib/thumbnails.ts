// Still thumbnails of creature GLBs for grids (collection, marketplace). One shared offscreen renderer
// draws them one at a time, so a grid of 40 creatures costs one WebGL context instead of 40.

import * as THREE from "three";
import { loadModel } from "@/lib/glb";

const SIZE = 384;
const cache = new Map<string, Promise<string>>();
let renderer: THREE.WebGLRenderer | null = null;
let queue: Promise<unknown> = Promise.resolve();

function setup() {
  if (renderer) return renderer;
  const canvas = document.createElement("canvas");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  return renderer;
}

async function draw(url: string): Promise<string> {
  const r = setup();
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.3));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(-3, 2, -2);
  scene.add(rim);
  const model = await loadModel(url, 1.35);
  model.rotation.y = -0.45;
  scene.add(model);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 1.05, 4.2);
  camera.lookAt(0, 0.68, 0);
  r.clear();
  r.render(scene, camera);
  return r.domElement.toDataURL("image/png");
}

/** PNG data URL of the model at `url` (cached per URL; rejects if the model can't be loaded). */
export function thumbnail(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = queue.then(() => draw(url));
    queue = p.catch(() => null);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}
