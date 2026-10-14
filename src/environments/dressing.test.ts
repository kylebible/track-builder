import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { dressGrass, dressLake, dressRiver, dressSnow, dressTown } from './dressing';

/** Every vertex of a baked scene, in plan mm (x, y) and height. */
function* points(group: THREE.Group): Generator<[number, number, number]> {
  for (const child of group.children) {
    const position = (child as THREE.Mesh).geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) yield [position.getX(i), -position.getZ(i), position.getY(i)];
  }
}

describe('scene dressing', () => {
  it('leaves the middle of the open scenes clear for building', () => {
    for (const dress of [dressGrass, dressRiver, dressLake, dressSnow]) {
      const group = dress();
      expect(group.children.length).toBeGreaterThan(5);
      // One expect per scene, not per vertex: there are hundreds of thousands.
      let inside: string | null = null;
      for (const [x, y, z] of points(group)) {
        if (z > 1 && Math.abs(x) < 850 && Math.abs(y) < 600) {
          inside = `${dress.name} has something at ${x}, ${y}`;
          break;
        }
      }
      expect(inside).toBeNull();
    }
  });

  it('keeps buildings out of the middle town block', () => {
    let tall = 0;
    for (const [x, y, z] of points(dressTown())) if (Math.abs(x) < 400 && Math.abs(y) < 400 && z > 1) tall++;
    expect(tall).toBe(0);
  });
});
