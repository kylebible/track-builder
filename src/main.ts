import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Editor } from './builder/editor';
import './style.css';

const container = document.getElementById('app')!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f1ea);

const camera = new THREE.PerspectiveCamera(40, 1, 10, 30000);
camera.position.set(0, 1000, 700);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI / 2 - 0.05;

const editor = new Editor(scene, camera, orbit, {
  canvas: container,
  palette: document.getElementById('palette')!,
  status: document.getElementById('status')!,
  buttons: {
    undo: button('undo'),
    redo: button('redo'),
    rotateLeft: button('rotate-left'),
    rotateRight: button('rotate-right'),
    flip: button('flip'),
    swap: button('swap'),
    section: button('section'),
    remove: button('remove'),
  },
});

scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a88f, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(800, 1800, 600);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -3000, right: 3000, top: 3000, bottom: -3000, far: 6000 });
scene.add(sun);

// 100 mm grid squares, with a heavier line every metre.
const FLOOR = 6000;
const fineGrid = new THREE.GridHelper(FLOOR, FLOOR / 100, 0xe0d8ca, 0xe0d8ca);
fineGrid.position.y = -0.4;
const metreGrid = new THREE.GridHelper(FLOOR, FLOOR / 1000, 0xb8ab97, 0xb8ab97);
metreGrid.position.y = -0.2;
scene.add(fineGrid, metreGrid);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR), new THREE.ShadowMaterial({ opacity: 0.15 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -1;
floor.receiveShadow = true;
scene.add(floor);

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
});

// Handy for poking at the layout from the browser console.
Object.assign(window, { editor });
