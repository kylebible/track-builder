import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SCENERY_MODELS } from '../src/scenery/models';

// Writes every model in src/scenery/models.ts to public/models/scenery as
// GLB. Run with `npm run scenery`.

// GLTFExporter reads its buffers through FileReader, which Node lacks.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((b) => {
      this.result = b;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
Object.assign(globalThis, { FileReader: NodeFileReader });

/**
 * Bake each model down to one mesh per material, without UVs (nothing is
 * textured), so a model is a handful of draw calls and a few kilobytes.
 */
function flatten(model: THREE.Group): THREE.Group {
  model.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    let g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    g.deleteAttribute('uv');
    g.clearGroups();
    const list = byMaterial.get(o.material) ?? [];
    list.push(g);
    byMaterial.set(o.material, list);
  });
  const out = new THREE.Group();
  out.name = model.name;
  for (const [material, geometries] of byMaterial) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    mesh.name = material.name;
    out.add(mesh);
  }
  return out;
}

export async function exportAll(outDir = 'public/models/scenery'): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const exporter = new GLTFExporter();
  for (const [name, build] of Object.entries(SCENERY_MODELS)) {
    const model = flatten(build());
    const glb = (await exporter.parseAsync(model, { binary: true })) as ArrayBuffer;
    writeFileSync(`${outDir}/${name}.glb`, Buffer.from(glb));
    let triangles = 0;
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) triangles += o.geometry.attributes.position.count / 3;
    });
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    console.log(
      `${name}.glb  ${(glb.byteLength / 1024).toFixed(1)} kB  ${triangles} triangles  ` +
        `${size.x.toFixed(0)} x ${size.z.toFixed(0)} x ${size.y.toFixed(0)} mm (l x w x h)`,
    );
  }
}
