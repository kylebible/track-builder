import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CATALOG } from './pieces/catalog';
import type { PieceCategory } from './pieces/types';
import { buildPieceObject } from './render/pieceMesh';
import './style.css';

// Phase 1 showcase: every launch piece laid out on a 100 mm grid at true
// size, so dimensions can be eyeballed against the real thing.

const container = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.domElement.style.position = 'absolute';
labels.domElement.style.inset = '0';
labels.domElement.style.pointerEvents = 'none';
container.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f1ea);

const camera = new THREE.PerspectiveCamera(40, 1, 5, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a88f, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(800, 1800, 600);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -2500, right: 2500, top: 2500, bottom: -2500, far: 6000 });
scene.add(sun);

const ROW_ORDER: PieceCategory[] = ['straight', 'curve', 'switch', 'crossing', 'buffer'];
const CELL = 340;
const COLUMNS = 6;

const rows: THREE.Group[] = [];
let rowZ = 0;
for (const category of ROW_ORDER) {
  const pieces = CATALOG.filter((p) => p.category === category);
  for (let start = 0; start < pieces.length; start += COLUMNS) {
    const row = new THREE.Group();
    pieces.slice(start, start + COLUMNS).forEach((piece, i) => {
      const object = buildPieceObject(piece);
      // Center each piece in its cell.
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      object.position.set(i * CELL - center.x, 0, -center.z);

      const label = document.createElement('div');
      label.className = 'piece-label';
      label.innerHTML = `${piece.name}${piece.brioIds.length ? `<small>${piece.brioIds.join(', ')}</small>` : ''}`;
      const tag = new CSS2DObject(label);
      tag.position.set(i * CELL, 0, (box.max.z - box.min.z) / 2 + 45);
      row.add(object, tag);
    });
    row.position.z = rowZ;
    rowZ += CELL;
    rows.push(row);
    scene.add(row);
  }
}

const bounds = new THREE.Box3();
rows.forEach((r) => bounds.expandByObject(r));
const middle = bounds.getCenter(new THREE.Vector3());
const size = bounds.getSize(new THREE.Vector3());

const gridSize = Math.ceil(Math.max(size.x, size.z) / 100 + 4) * 100;
const grid = new THREE.GridHelper(gridSize, gridSize / 100, 0xb8ab97, 0xd8cfc0);
grid.position.set(middle.x, -0.1, middle.z);
scene.add(grid);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(gridSize, gridSize), new THREE.ShadowMaterial({ opacity: 0.15 }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(middle.x, -0.2, middle.z);
floor.receiveShadow = true;
scene.add(floor);

controls.target.copy(middle);
camera.position.set(middle.x, Math.max(size.x, size.z) * 1.5, middle.z + size.z * 0.6);

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
});
