import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Editor } from './builder/editor';
import type { Vec2 } from './geometry/pose';
import { codeFromHash, decodeLayout, LayoutFileError } from './planning/file';
import { PlanningPanel } from './planning/panel';
import { autosave, loadAutosave } from './planning/storage';
import { Trains } from './trains/trains';
import { loadSceneryModels } from './render/sceneryModels';
import { DEFAULT_ENVIRONMENT, type EnvironmentId } from './environments/environments';
import { EnvironmentPicker } from './environments/picker';
import { EnvironmentScene } from './environments/scene';
import './style.css';

const container = document.getElementById('app')!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
container.appendChild(renderer.domElement);

// The environment sets the background and a fog that fades the floor into it.
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(35, 1, 10, 30000);
camera.position.set(0, 1500, 950);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI / 2 - 0.12;
orbit.minDistance = 150;
orbit.maxDistance = 8000;

/** Camera moves in progress: where to, and when it started. */
let flight: { fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromCamera: THREE.Vector3; toCamera: THREE.Vector3; start: number } | null = null;
const FLIGHT_MS = 450;

/** Frame every placed piece, keeping the current viewing angle. */
function fitView(): void {
  const box = new THREE.Box3().setFromObject(editor.pieceObjects);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 250);
  const vFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hFov = Math.atan(Math.tan(vFov) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(vFov, hFov))) * 1.05;
  const direction = camera.position.clone().sub(orbit.target).normalize();
  flight = {
    fromTarget: orbit.target.clone(),
    toTarget: center,
    fromCamera: camera.position.clone(),
    toCamera: center.clone().add(direction.multiplyScalar(distance)),
    start: performance.now(),
  };
}

/** Bring a spot on the floor to the middle of the view, close enough to see a joint. */
function focusOn(at: Vec2): void {
  const target = new THREE.Vector3(at.x, 0, -at.y);
  const offset = camera.position.clone().sub(orbit.target);
  offset.setLength(Math.min(offset.length(), 900));
  flight = {
    fromTarget: orbit.target.clone(),
    toTarget: target,
    fromCamera: camera.position.clone(),
    toCamera: target.clone().add(offset),
    start: performance.now(),
  };
}

let saved = true;
let planning: PlanningPanel | null = null;
const restored = loadAutosave();
/** What the track is built on: a table, a rug, the floor. */
// Layouts saved before environments existed were built on the grid mat, so they stay on it.
let environment: EnvironmentId = restored ? (restored.environment ?? 'grid') : DEFAULT_ENVIRONMENT;

// Scenery pieces are built from these, so they have to be in before the editor.
await loadSceneryModels();

const editor = new Editor(scene, camera, orbit, {
  canvas: container,
  palette: document.getElementById('palette')!,
  status: document.getElementById('status')!,
  empty: document.getElementById('empty')!,
  buttons: {
    undo: button('undo'),
    redo: button('redo'),
    rotateLeft: button('rotate-left'),
    rotateRight: button('rotate-right'),
    flip: button('flip'),
    swap: button('swap'),
    section: button('section'),
    remove: button('remove'),
    fit: button('fit'),
  },
  onFit: fitView,
  initial: restored ?? undefined,
  onChange: (layout) => {
    saved = autosave({ ...layout, environment });
    planning?.update(layout);
  },
});

planning = new PlanningPanel(editor, {
  partsButton: button('parts-button'),
  partsPanel: document.getElementById('parts-panel')!,
  checkButton: button('check-button'),
  checkPanel: document.getElementById('check-panel')!,
  sharePanel: document.getElementById('share-panel')!,
  onFocus: focusOn,
  saved: () => saved,
  environment: () => environment,
  onEnvironment: (id) => setEnvironment(id),
});
planning.update(editor.layout);

/** Open the layout a share link carries, then tidy the address so a reload keeps later edits. */
async function openSharedLayout(): Promise<void> {
  const code = codeFromHash(location.hash);
  if (!code) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const hadOwn = editor.layout.pieces.length > 0;
    const layout = await decodeLayout(code);
    editor.load(layout);
    if (layout.environment) setEnvironment(layout.environment);
    editor.flash(hadOwn ? 'Opened a shared layout. Undo brings back yours.' : 'Opened a shared layout.');
    fitView();
  } catch (e) {
    editor.flash(e instanceof LayoutFileError ? e.message : "Couldn't open that share link.");
  }
}
window.addEventListener('hashchange', openSharedLayout);

const trains = new Trains(scene, camera, editor, container, document.getElementById('toolbar')!);

const hemisphere = new THREE.HemisphereLight(0xffffff, 0xcfc4b0, 1.5);
scene.add(hemisphere);
const sun = new THREE.DirectionalLight(0xfff8ee, 2.0);
sun.position.set(700, 1800, 900);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.radius = 4;
// Without a normal bias the track shadows its own top and reads muddy brown.
sun.shadow.normalBias = 2;
sun.shadow.bias = -0.0002;
Object.assign(sun.shadow.camera, { left: -3000, right: 3000, top: 3000, bottom: -3000, far: 6000 });
scene.add(sun);

const environmentScene = new EnvironmentScene(scene, hemisphere, sun);
const picker = new EnvironmentPicker(document.getElementById('scene-panel')!, (id) => setEnvironment(id));

/** Build on something else: redraw around the track, recheck it and save. */
function setEnvironment(id: EnvironmentId): void {
  environment = id;
  environmentScene.show(id);
  picker.set(id);
  planning?.update(editor.layout);
  saved = autosave({ ...editor.layout, environment });
}
environmentScene.show(environment);
picker.set(environment);

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

renderer.setAnimationLoop((time) => {
  if (flight) {
    const t = Math.min(1, (performance.now() - flight.start) / FLIGHT_MS);
    orbit.target.lerpVectors(flight.fromTarget, flight.toTarget, ease(t));
    camera.position.lerpVectors(flight.fromCamera, flight.toCamera, ease(t));
    if (t === 1) flight = null;
  }
  orbit.update();
  editor.tick(time);
  trains.tick(time);
  renderer.render(scene, camera);
});

if (codeFromHash(location.hash)) openSharedLayout();
else if (editor.layout.pieces.length) fitView();

// Handy for poking at the layout from the browser console.
Object.assign(window, { editor, trains, fitView, orbit, setEnvironment });
