import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Models are put together from many small meshes (a piece's pegs and
// holes, a coach's windows and wheels), and every mesh is a draw call, in
// the shadow pass too. A big layout with trains running had thousands. A
// model's fixed parts don't move relative to each other, so this bakes
// them into one mesh per material.
//
// Named objects are left as they are, with everything under them: names
// are how the app finds the parts it moves, hides or recolours (a lifting
// bridge's deck, a wagon's cargo, a crane's arm), and loaded scenery models
// keep their own structure.

/** Meshes that can be baked together: same material, shadows and attributes. */
function bakeKey(mesh: THREE.Mesh): string | null {
  const material = mesh.material;
  if (Array.isArray(material) || mesh.geometry.morphAttributes.position) return null;
  const attributes = Object.keys(mesh.geometry.attributes).sort().join(',');
  return `${material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${attributes}`;
}

/**
 * Bake the fixed meshes of `root` (in place) into one mesh per material.
 * Returns `root`. Geometries baked are copies; shared ones are untouched.
 */
export function mergeStaticMeshes<T extends THREE.Object3D>(root: T): T {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, THREE.Mesh[]>();
  const visit = (o: THREE.Object3D) => {
    for (const child of o.children) {
      if (child.name || !child.visible) continue;
      if (child instanceof THREE.Mesh && child.constructor === THREE.Mesh && child.children.length === 0) {
        const key = bakeKey(child);
        if (key) {
          const list = groups.get(key);
          if (list) list.push(child);
          else groups.set(key, [child]);
        }
      } else if (child.constructor === THREE.Group || child.constructor === THREE.Object3D) {
        visit(child);
      }
    }
  };
  visit(root);

  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map((mesh) => {
      const matrix = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
      let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      g.applyMatrix4(matrix);
      // A mirrored part turns inside out once baked; wind it back.
      if (matrix.determinant() < 0) g = flipWinding(g);
      return g;
    });
    const merged = mergeGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    if (!merged) continue;
    const first = meshes[0];
    const baked = new THREE.Mesh(merged, first.material);
    baked.castShadow = first.castShadow;
    baked.receiveShadow = first.receiveShadow;
    for (const mesh of meshes) mesh.removeFromParent();
    root.add(baked);
  }
  // Groups the meshes came out of are empty now.
  const prune = (o: THREE.Object3D) => {
    for (const child of [...o.children] as THREE.Object3D[]) {
      if (child.name || !(child instanceof THREE.Group) || child.constructor !== THREE.Group) continue;
      prune(child);
      if (child.children.length === 0) child.removeFromParent();
    }
  };
  prune(root);
  return root;
}

/** Swap the second and third corner of every triangle of a non-indexed geometry. */
function flipWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const attribute of Object.values(g.attributes)) {
    const a = attribute as THREE.BufferAttribute;
    for (let i = 0; i + 2 < a.count; i += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k);
        a.setComponent(i + 1, k, a.getComponent(i + 2, k));
        a.setComponent(i + 2, k, t);
      }
    }
  }
  return g;
}
