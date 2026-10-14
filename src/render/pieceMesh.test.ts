import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getPiece } from '../pieces/catalog';
import { buildPieceObject } from './pieceMesh';

/** Signed volume of a triangle soup: positive when every face points outwards. */
function signedVolume(geometry: THREE.BufferGeometry): number {
  const p = geometry.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    volume += a.dot(b.clone().cross(c)) / 6;
  }
  return volume;
}

describe('piece meshes', () => {
  it.each(['straight-medium', 'curve-large', 'switch-curved'])('%s faces point out of the wood', (id) => {
    const track = buildPieceObject(getPiece(id)).children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    expect(track.length).toBeGreaterThan(0);
    for (const mesh of track) expect(signedVolume(mesh.geometry)).toBeGreaterThan(0);
  });

  it('a medium straight has about the wood volume of the real piece', () => {
    const [mesh] = buildPieceObject(getPiece('straight-medium')).children as THREE.Mesh[];
    // 40 x 12 mm section, less two grooves, over 144 mm.
    const volume = signedVolume(mesh.geometry);
    expect(volume).toBeGreaterThan(144 * 40 * 12 * 0.8);
    expect(volume).toBeLessThan(144 * 40 * 12);
  });
});
