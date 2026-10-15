import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/pieces/catalog';

// The runtime loads shipped GLBs, not the procedural model builders. A new
// catalog entry must include its exported asset or it is invisible in both
// the palette and the layout, even though the source model exists.
const models = [...new Set(CATALOG.flatMap((piece) => piece.model ? [piece.model] : []))];

describe('shipped scenery models', () => {
  it.each(models)('%s loads with visible geometry', async (name) => {
    const bytes = readFileSync(new URL(`../public/models/scenery/${name}.glb`, import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { scene } = await new GLTFLoader().parseAsync(buffer, '');
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.isEmpty()).toBe(false);
    const size = bounds.getSize(new THREE.Vector3());
    for (const dimension of [size.x, size.y, size.z]) {
      expect(Number.isFinite(dimension)).toBe(true);
      expect(dimension).toBeGreaterThan(0);
    }
  });
});
