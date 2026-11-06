// Loads GLB models (e.g. creature models on Swarm) once per URL and hands out clones,
// normalised to a given height with the feet at y = 0 and centred on x/z.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

function load(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => gltf.scene);
    p.catch(() => cache.delete(url)); // let a later call retry a failed download
    cache.set(url, p);
  }
  return p;
}

/** A fresh copy of the model at `url`, `height` metres tall, wrapped in a group for placement. */
export async function loadModel(url: string, height: number): Promise<THREE.Group> {
  const model = (await load(url)).clone();
  model.traverse((o) => (o.frustumCulled = false)); // Mapbox's custom projection confuses three's culling
  const box = new THREE.Box3().setFromObject(model);
  const k = height / (box.max.y - box.min.y || 1);
  const c = box.getCenter(new THREE.Vector3());
  model.scale.setScalar(k);
  model.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  const wrap = new THREE.Group();
  wrap.add(model);
  return wrap;
}
