import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CATALOG } from '../pieces/catalog';

// The scenery GLB files, loaded once at startup so pieces can be built
// synchronously. The files come from `npm run scenery`; see
// src/scenery/models.ts.

const loaded = new Map<string, THREE.Object3D>();

export const modelUrl = (name: string): string => `${import.meta.env.BASE_URL}models/scenery/${name}.glb`;

export async function loadSceneryModels(): Promise<void> {
  const loader = new GLTFLoader();
  const names = [...new Set(CATALOG.flatMap((p) => (p.model ? [p.model] : [])))];
  await Promise.all(
    names.map(async (name) => {
      try {
        loaded.set(name, (await loader.loadAsync(modelUrl(name))).scene);
      } catch (error) {
        console.warn(`Scenery model ${name} didn't load`, error);
      }
    }),
  );
}

/** A copy of a loaded model, or an empty group if it failed to load. */
export function sceneryModel(name: string): THREE.Object3D {
  return loaded.get(name)?.clone(true) ?? new THREE.Group();
}
