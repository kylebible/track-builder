import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MODEL_FOOTPRINTS } from './footprints';
import { SCENERY_MODELS } from './models';

describe('scenery footprints', () => {
  it('match the models', () => {
    for (const [name, build] of Object.entries(SCENERY_MODELS)) {
      const b = new THREE.Box3().setFromObject(build());
      // Plan y is three.js -z.
      const [x0, x1, y0, y1] = MODEL_FOOTPRINTS[name] ?? [];
      expect([x0, x1, y0, y1].map((n) => n ?? NaN), name).toEqual([b.min.x, b.max.x, -b.max.z, -b.min.z].map((n) => Math.round(n) + 0));
    }
  });
});
