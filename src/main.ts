import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Editor } from './builder/editor';
import { onBasicMode } from './pieces/basic';
import type { Vec2 } from './geometry/pose';
import { codeFromHash, decodeLayout, LayoutFileError } from './planning/file';
import { PlanningPanel } from './planning/panel';
import { autosave, loadAutosave } from './planning/storage';
import { Trains } from './trains/trains';
import { loadSceneryModels } from './render/sceneryModels';
import { DEFAULT_ENVIRONMENT, getEnvironment, inWater, offArea, type EnvironmentId } from './environments/environments';
import { EnvironmentPicker } from './environments/picker';
import { EnvironmentScene } from './environments/scene';
import { TemplatePicker } from './templates/picker';
import { Tour, markTourSeen, tourSeen } from './tour/tour';
import './style.css';

const container = document.getElementById('app')!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Past 2x the extra pixels cost a phone far more than they show.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
let planningTimer = 0;
const PLANNING_DELAY_MS = 120;
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
    select: button('select-mode'),
    copy: button('copy'),
    paste: button('paste'),
    duplicate: button('duplicate'),
    rotateLeft: button('rotate-left'),
    rotateRight: button('rotate-right'),
    flip: button('flip'),
    swap: button('swap'),
    bend: button('bend'),
    raise: button('raise'),
    lower: button('lower'),
    section: button('section'),
    fill: button('fill'),
    generate: button('generate'),
    remove: button('remove'),
    fit: button('fit'),
  },
  onFit: fitView,
  fillPanel: document.getElementById('fill-panel')!,
  generatePanel: document.getElementById('generate-panel')!,
  blocked: (layout) => {
    const env = getEnvironment(environment);
    return [...(offArea(layout, env)?.uids ?? []), ...(inWater(layout, env)?.uids ?? [])];
  },
  initial: restored ?? undefined,
  onChange: (layout) => {
    saved = autosave({ ...layout, environment });
    // The check is the slow part of an edit on a big layout; a burst of
    // edits (a held key, quick undos) runs it once, when they stop.
    window.clearTimeout(planningTimer);
    planningTimer = window.setTimeout(() => planning?.update(editor.layout), PLANNING_DELAY_MS);
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
  onTemplates: () => templatesPanel.showPopover(),
});
planning.update(editor.layout);
// Basic mode adds a check for pieces Brio doesn't sell.
onBasicMode(() => planning?.update(editor.layout));

const templatesPanel = document.getElementById('templates-panel')!;
new TemplatePicker(templatesPanel, (template) => {
  const hadOwn = editor.layout.pieces.length > 0;
  editor.load(template.build());
  // A template too big for the table comes with the scene it's laid out for.
  if (template.environment) setEnvironment(template.environment);
  templatesPanel.hidePopover();
  editor.flash(hadOwn ? `Started from the ${template.name.toLowerCase()}. Undo brings back yours.` : `Started from the ${template.name.toLowerCase()}.`);
  fitView();
});

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

const trains = new Trains(scene, camera, editor, container, document.getElementById('toolbar')!, orbit);
trains.onFocus = focusOn;

// The sidebar swaps between the parts palette and the list of trains.
const trainTab = document.getElementById('train-tab')!;
trainTab.append(trains.list.el);
const tabs = { track: document.getElementById('tab-track')!, trains: document.getElementById('tab-trains')! };
const tabCount = tabs.trains.querySelector<HTMLElement>('.tab-count')!;
function showTab(which: 'track' | 'trains'): void {
  tabs.track.setAttribute('aria-selected', String(which === 'track'));
  tabs.trains.setAttribute('aria-selected', String(which === 'trains'));
  document.getElementById('palette')!.hidden = which !== 'track';
  trainTab.hidden = which !== 'trains';
  if (which === 'trains') trains.list.update();
  try {
    localStorage.setItem('sidebar-tab', which);
  } catch {
    // Private windows can refuse; the tab just isn't remembered.
  }
}
trains.onShowList = () => showTab('trains');
tabs.track.onclick = () => showTab('track');
tabs.trains.onclick = () => showTab('trains');
try {
  if (localStorage.getItem('sidebar-tab') === 'trains') showTab('trains');
} catch {
  // Nothing remembered.
}
// Dragging the view round lets go of a followed train.
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) trains.following = null;
});
let followed: THREE.Vector3 | null = null;
/** Which train `followed` was, so going to another one doesn't carry over the gap between them. */
let followedId: number | null = null;

// A pump house in a scene with a river or lake has to be by the water.
trains.sim.economy.waterNear = (at, reach) => {
  const water = getEnvironment(environment).water;
  if (!water) return null;
  for (let r = 0; r <= reach; r += 50) {
    for (let a = 0; a < 16; a++) if (water.contains({ x: at.x + r * Math.cos((a * Math.PI) / 8), y: at.y + r * Math.sin((a * Math.PI) / 8) })) return true;
  }
  return false;
};

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
  // Riding along, the train places the camera.
  if (trains.riding) flight = null;
  // Keep a followed train in the middle, flying there or not.
  const follow = trains.followPoint();
  if (follow && followed && trains.following === followedId) {
    const delta = follow.clone().sub(followed);
    if (flight) {
      flight.toTarget.add(delta);
      flight.toCamera.add(delta);
    } else {
      orbit.target.add(delta);
      camera.position.add(delta);
    }
  }
  followed = follow;
  followedId = trains.following;
  const count = String(trains.sim.trains.length || '');
  if (tabCount.textContent !== count) {
    tabCount.textContent = count;
    tabCount.hidden = !count;
  }
  if (flight) {
    const t = Math.min(1, (performance.now() - flight.start) / FLIGHT_MS);
    orbit.target.lerpVectors(flight.fromTarget, flight.toTarget, ease(t));
    camera.position.lerpVectors(flight.fromCamera, flight.toCamera, ease(t));
    if (t === 1) flight = null;
  }
  if (!trains.riding) orbit.update();
  editor.tick(time);
  trains.tick(time);
  environmentScene.tick(time);
  environmentScene.reach(camera.position.distanceTo(orbit.target));
  renderer.render(scene, camera);
});

const tour = new Tour();
button('take-tour').onclick = () => {
  document.getElementById('help')!.hidePopover();
  tour.start();
};
// Shown once, to someone with nothing built yet; a returning builder has seen enough.
if (restored) markTourSeen();
else if (!tourSeen()) tour.start();

if (codeFromHash(location.hash)) openSharedLayout();
else if (editor.layout.pieces.length) fitView();

// Handy for poking at the layout from the browser console.
Object.assign(window, { editor, trains, fitView, orbit, setEnvironment, renderer });
