import * as THREE from 'three';
import { poseAt } from '../geometry/path';
import type { Vec2 } from '../geometry/pose';
import type { Layout } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { toWorld } from '../render/pieceMesh';
import { getStock, STOCK, type StockDef } from './stock';
import { TrainSim, type StuckKind, type Train, type VehicleGeometry } from './sim';
import { AXLE_HEIGHT, buildVehicle } from './trainMesh';
import './trains.css';

// Trains on the layout. Drag engines and cars from the Trains panel onto the
// track: dropped by the end of a train they couple on, anywhere else they
// start a new train. On the track, drag a vehicle to lift it off (into
// another spot, or off the track to remove it) and tap one to turn it round.
// Each train carries its own controls. Owns the simulation and keeps its
// three.js objects in step with it; presses meant for trains are caught
// before the track editor sees them.

export interface TrainsHost {
  /** The layout as it stands now. */
  readonly layout: Layout;
  /** The placed pieces' objects, to find where a drop lands on the track. */
  readonly pieceObjects: THREE.Object3D;
}

const SPEEDS = [1, 2, 4] as const;
const LEVER_REACH = 24;
/** How far down the chosen way the lever's stripe runs. */
const STRIPE_MM = 110;
/** A vehicle dropped this close to a train's end couples on. */
const ATTACH_REACH_MM = 70;
/** Pointer travel, in pixels, before a press on a vehicle becomes a drag. */
const DRAG_THRESHOLD_PX = 6;

const leverMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.4, emissive: 0x6b4f00, emissiveIntensity: 0.25 });
const leverStem = new THREE.MeshStandardMaterial({ color: 0x5a4026, roughness: 0.8 });
const stuckMaterial = new THREE.MeshStandardMaterial({ color: 0xd33a2c, emissive: 0xd33a2c, emissiveIntensity: 0.6 });
const stuckGeometry = new THREE.TorusGeometry(26, 3, 10, 48);
const knobGeometry = new THREE.SphereGeometry(9, 24, 16);
const stemGeometry = new THREE.CylinderGeometry(2, 2, 22, 10);
const attachMaterial = new THREE.MeshBasicMaterial({ color: 0x1f9d55, transparent: true, opacity: 0.85 });
const attachGeometry = new THREE.TorusGeometry(10, 2.2, 10, 40);

const SHORT: Record<StuckKind, string> = {
  'ran-off': 'Ran off the end',
  buffer: 'At the buffer stop',
  stalled: 'Stalled',
  slipping: 'Wheels spinning',
  fighting: 'Engines fighting',
  crashed: 'Crashed',
  derailed: 'Derailed',
  tipped: 'Tipped over',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) => {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
};

/** Pictures of each vehicle for the panel, rendered from the 3D models once. */
function renderThumbnails(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(2);
    renderer.setSize(132, 72);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc4b0, 1.6));
    const sun = new THREE.DirectionalLight(0xfff8ee, 2);
    sun.position.set(200, 400, 300);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(22, 132 / 72, 10, 3000);
    for (const def of STOCK) {
      const model = buildVehicle(def);
      scene.add(model);
      // Three-quarter view from the front left, framed on the model.
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const reach = Math.max(size.x, size.y * 1.6) * 1.55;
      camera.position.set(center.x + reach * 0.62, center.y + reach * 0.42, center.z + reach * 0.95);
      camera.lookAt(center);
      renderer.render(scene, camera);
      out.set(def.id, renderer.domElement.toDataURL('image/png'));
      scene.remove(model);
    }
    renderer.dispose();
    renderer.forceContextLoss();
  } catch {
    // No WebGL to spare: the tiles show names only.
  }
  return out;
}

type DropTarget =
  | { kind: 'attach'; trainId: number; end: 'front' | 'back'; geo: VehicleGeometry }
  | { kind: 'track'; edgeKey: string; s: number; geo: { center: Vec2; heading: number } }
  | { kind: 'none'; at: Vec2 | null };

interface Carry {
  pointerId: number;
  stockId: string;
  ghost: THREE.Group;
  target: DropTarget;
  /** Lifted off the track rather than taken from the panel. */
  lifted: boolean;
}

interface Press {
  pointerId: number;
  trainId: number;
  index: number;
  x: number;
  y: number;
}

export class Trains {
  readonly sim: TrainSim;
  private readonly root = new THREE.Group();
  private readonly vehiclesRoot = new THREE.Group();
  private readonly leversRoot = new THREE.Group();
  private readonly markersRoot = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Group>();
  private readonly raycaster = new THREE.Raycaster();
  /** The track top, where dragged vehicles are carried. */
  private readonly trackTop = new THREE.Plane(new THREE.Vector3(0, 1, 0), -D.TRACK_HEIGHT);

  private open = false;
  private paused = false;
  private speed: (typeof SPEEDS)[number] = 1;
  private layout: Layout;
  private lastTime: number | null = null;
  private toastUntil = 0;
  private noticesSeen = 0;
  private carry: Carry | null = null;
  private press: Press | null = null;
  private thumbnails: Map<string, string> | null = null;

  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly tiles: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly speedButtons: HTMLButtonElement[];
  private readonly toast: HTMLElement;
  /** Each train's own controls, floating over it. */
  private readonly hud: HTMLElement;
  private readonly cards = new Map<number, { card: HTMLElement; key: string }>();

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly host: TrainsHost,
    private readonly container: HTMLElement,
    toolbar: HTMLElement,
  ) {
    this.layout = host.layout;
    this.sim = new TrainSim(this.layout);
    this.root.add(this.vehiclesRoot, this.leversRoot, this.markersRoot);
    scene.add(this.root);

    this.toggle = el('button', { id: 'trains-button', title: 'Trains: drag engines and cars onto the track (Y)', type: 'button' });
    this.toggle.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><circle cx="8.5" cy="14" r=".5"/><circle cx="15.5" cy="14" r=".5"/><path d="m8 17-2 4"/><path d="m16 17 2 4"/></svg><span>Trains</span>';
    this.toggle.onclick = () => this.setOpen(!this.open);
    // Beside the view buttons, which stay pushed to the right.
    toolbar.insertBefore(el('div', { class: 'group' }, this.toggle), toolbar.lastElementChild);

    this.pauseButton = el('button', { class: 'tr-btn', type: 'button', onclick: () => this.setPaused(!this.paused) });
    this.speedButtons = SPEEDS.map((s) => el('button', { type: 'button', textContent: `${s}×`, title: `Run at ${s}× speed`, onclick: () => this.setSpeed(s) }));
    this.toast = el('div', { class: 'tr-toast', hidden: true });
    this.hud = el('div', { class: 'tr-hud' });
    this.tiles = el(
      'div',
      { class: 'tr-stock' },
      ...STOCK.map((def) => {
        const tile = el('button', { class: 'tr-tile', type: 'button', title: `Drag a ${def.name.toLowerCase()} onto the track` }, el('span', { class: 'tr-thumb' }), el('span', { textContent: def.name }));
        tile.dataset.stock = def.id;
        tile.addEventListener('pointerdown', (e) => this.pickUp(e, def));
        return tile;
      }),
    );
    this.panel = el(
      'section',
      { id: 'trains', hidden: true, ariaLabel: 'Trains' },
      el('header', {}, el('h2', { textContent: 'Trains' }), el('button', { class: 'tr-close', type: 'button', title: 'Close', textContent: '×', onclick: () => this.setOpen(false) })),
      el('p', { class: 'tr-lead', textContent: 'Drag engines and cars onto the track. Drop one by the end of a train to couple it on.' }),
      this.tiles,
      el('div', { class: 'tr-row' }, this.pauseButton, el('div', { class: 'seg' }, ...this.speedButtons), el('button', { class: 'tr-btn', type: 'button', textContent: 'Reset', title: 'Put every train back where it was built, stopped', onclick: () => this.reset() })),
      el('ul', { class: 'tr-hint' },
        el('li', { innerHTML: '<b>Tap a car</b> on the track to turn it round. Red and blue ends are the magnets: red pulls blue.' }),
        el('li', { innerHTML: '<b>Drag a car</b> to lift it off. Drop it off the track to take it away.' }),
        el('li', { innerHTML: 'Each train has its own controls. Tap a switch’s <b>yellow knob</b> to change its way.' }),
      ),
    );
    container.append(this.hud, this.panel, this.toast);

    // Window capture runs before the editor's handlers on the canvas.
    window.addEventListener('pointerdown', (e) => this.pointerDown(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    window.addEventListener('pointercancel', (e) => this.cancel(e));
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'y' || e.key === 'Y') this.setOpen(!this.open);
      else if (e.key === 'Escape' && this.carry) this.drop(false);
      else if (e.key === ' ' && this.sim.trains.length) {
        e.preventDefault();
        this.setPaused(!this.paused);
      }
    });
    this.setSpeed(1);
    this.setPaused(false);
    this.drawLevers();
    this.setOpen(false);
  }

  // ---- panel ---------------------------------------------------------------

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-pressed', String(open));
    if (open && !this.thumbnails) {
      this.thumbnails = renderThumbnails();
      for (const tile of this.tiles.querySelectorAll<HTMLElement>('.tr-tile')) {
        const url = this.thumbnails.get(tile.dataset.stock!);
        if (url) tile.querySelector('.tr-thumb')!.replaceChildren(el('img', { src: url, alt: '', draggable: false }));
      }
    }
    this.updateLeverVisibility();
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.pauseButton.textContent = paused ? '▶ Run' : '❚❚ Pause';
    this.pauseButton.title = paused ? 'Run the trains (Space)' : 'Pause every train (Space)';
  }

  private setSpeed(speed: (typeof SPEEDS)[number]): void {
    this.speed = speed;
    this.speedButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === speed)));
  }

  private reset(): void {
    this.sim.reset();
    this.noticesSeen = 0;
  }

  private say(message: string): void {
    this.toast.textContent = message;
    this.toast.hidden = false;
    this.toastUntil = performance.now() + 4500;
  }

  private updateLeverVisibility(): void {
    this.leversRoot.visible = this.open || this.sim.trains.length > 0;
  }

  // ---- each train's controls -----------------------------------------------

  private statusText(t: Train): string {
    const status = t.status;
    if (status.kind === 'stuck') return SHORT[status.stuck];
    if (status.kind === 'running') return `${Math.round(status.speed)} mm/s`;
    return t.throttle ? 'Starting' : 'Stopped';
  }

  private makeCard(t: Train): HTMLElement {
    const drive = (label: string, title: string, throttle: 1 | 0 | -1) =>
      el('button', {
        type: 'button',
        textContent: label,
        title,
        disabled: t.wrecked,
        className: t.throttle === throttle && !t.wrecked ? 'on' : '',
        onclick: () => {
          this.sim.setThrottle(t.id, throttle);
          if (throttle) this.setPaused(false);
        },
      });
    const act = (label: string, title: string, onclick: () => void, cls = '') => el('button', { type: 'button', class: cls, textContent: label, title, onclick });
    return el(
      'div',
      { class: 'tr-card' },
      el('div', { class: 'tr-card-head' }, el('b', { textContent: t.name }), el('span', { class: 'tr-card-status' })),
      el('div', { class: 'tr-card-row' },
        t.wrecked
          ? act('Put back on the rails', 'Put it back where it was built', () => this.restore(t), 'wide')
          : el('div', { class: 'seg drive' }, drive('◀', 'Engines in reverse', -1), drive('■', 'Engines off', 0), drive('▶', 'Engines forward', 1)),
        t.wrecked ? '' : act('⇄', 'Turn the whole train round', () => this.turnTrain(t)),
        act('✕', 'Take the train off the track', () => this.sim.removeTrain(t.id), 'danger'),
      ),
    );
  }

  private turnTrain(t: Train): void {
    const error = this.sim.turnAround(t.id);
    if (error) this.say(error);
  }

  private restore(t: Train): void {
    const { consist, placement, name } = t;
    this.sim.removeTrain(t.id);
    const again = this.sim.addTrain(consist, placement, name);
    if (typeof again === 'string') this.say(again);
  }

  /** Keep a card floating over each train, and its buttons current. */
  private drawCards(): void {
    const rect = this.container.getBoundingClientRect();
    const seen = new Set<number>();
    for (const t of this.sim.trains) {
      seen.add(t.id);
      const key = `${t.throttle}/${t.wrecked}/${t.name}`;
      let entry = this.cards.get(t.id);
      if (!entry || entry.key !== key) {
        const card = this.makeCard(t);
        if (entry) entry.card.replaceWith(card);
        else this.hud.append(card);
        entry = { card, key };
        this.cards.set(t.id, entry);
      }
      const { card } = entry;
      // Over the middle of the train, above its tallest roof.
      const xs = t.vehicles.map((v) => v.geo.center.x);
      const ys = t.vehicles.map((v) => v.geo.center.y);
      const mid = toWorld((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...t.vehicles.map((v) => v.def.height)) + AXLE_HEIGHT + 14);
      const p = mid.project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      card.hidden = !visible;
      if (visible) card.style.transform = `translate(${((p.x + 1) / 2) * rect.width}px, ${((1 - p.y) / 2) * rect.height}px) translate(-50%, -100%)`;
      card.classList.toggle('stuck', t.status.kind === 'stuck');
      const status = card.querySelector<HTMLElement>('.tr-card-status')!;
      status.textContent = this.statusText(t);
      status.title = t.status.kind === 'stuck' ? t.status.message : '';
      card.title = t.status.kind === 'stuck' ? t.status.message : '';
    }
    for (const [id, entry] of this.cards) {
      if (!seen.has(id)) {
        entry.card.remove();
        this.cards.delete(id);
      }
    }
  }

  // ---- picking up and dropping vehicles ----------------------------------

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.container.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private swallow(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
  }

  /** Start carrying a vehicle from the panel. */
  private pickUp(e: PointerEvent, def: StockDef): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.startCarry(e.pointerId, def.id, false);
    this.pointerMove(e);
  }

  private startCarry(pointerId: number, stockId: string, lifted: boolean): void {
    const ghost = buildVehicle(getStock(stockId));
    ghost.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = (o.material as THREE.Material).clone();
        m.transparent = true;
        m.opacity = 0.8;
        o.material = m;
        o.castShadow = false;
      }
    });
    this.root.add(ghost);
    this.carry = { pointerId, stockId, ghost, target: { kind: 'none', at: null }, lifted };
    document.body.classList.add('carrying-train');
  }

  /** What's under the pointer: a lever, or a vehicle (train and its place in it). */
  private hit(e: PointerEvent): { lever: string } | { trainId: number; index: number } | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.root.updateMatrixWorld();
    if (this.leversRoot.visible) {
      const lever = this.raycaster.intersectObject(this.leversRoot, true)[0];
      if (lever) return { lever: lever.object.userData.uid as string };
    }
    const vehicle = this.raycaster.intersectObject(this.vehiclesRoot, true)[0];
    if (vehicle) {
      let o: THREE.Object3D | null = vehicle.object;
      while (o && o.userData.trainId === undefined) o = o.parent;
      if (o) return { trainId: o.userData.trainId as number, index: o.userData.index as number };
    }
    return null;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.carry || !(e.target instanceof HTMLCanvasElement) || !this.container.contains(e.target)) return;
    const hit = this.hit(e);
    if (!hit) return;
    this.swallow(e);
    if ('lever' in hit) {
      this.sim.toggleLever(hit.lever);
      this.drawLevers();
      return;
    }
    this.press = { pointerId: e.pointerId, ...hit, x: e.clientX, y: e.clientY };
  }

  private pointerMove(e: PointerEvent): void {
    const press = this.press;
    if (press && e.pointerId === press.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD_PX) {
      // Lifting a vehicle off the track.
      this.press = null;
      const entry = this.sim.detach(press.trainId, press.index);
      if (entry) this.startCarry(e.pointerId, entry.stockId, true);
    }
    const carry = this.carry;
    if (!carry || e.pointerId !== carry.pointerId) return;
    carry.target = this.targetAt(e, carry.stockId);
    this.placeGhost(carry);
  }

  private pointerUp(e: PointerEvent): void {
    const press = this.press;
    if (press && e.pointerId === press.pointerId) {
      // A tap on a vehicle turns it round.
      this.press = null;
      const error = this.sim.turnVehicle(press.trainId, press.index);
      if (error) this.say(error);
      return;
    }
    const carry = this.carry;
    if (!carry || e.pointerId !== carry.pointerId) return;
    // Let go over the panel or off the canvas: put it away.
    // Touch keeps the press on the tile it began on, so look at what's under the finger.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const overCanvas = under instanceof HTMLCanvasElement && this.container.contains(under);
    this.drop(overCanvas);
  }

  private cancel(e: PointerEvent): void {
    if (this.press?.pointerId === e.pointerId) this.press = null;
    if (this.carry?.pointerId === e.pointerId) this.drop(false);
  }

  private drop(place: boolean): void {
    const carry = this.carry!;
    this.carry = null;
    this.root.remove(carry.ghost);
    document.body.classList.remove('carrying-train');
    const target = carry.target;
    if (!place || target.kind === 'none') {
      if (carry.lifted) this.say(`Took the ${getStock(carry.stockId).name.toLowerCase()} off the track.`);
      return;
    }
    if (target.kind === 'attach') {
      const error = this.sim.attach(target.trainId, target.end, carry.stockId);
      if (error) this.say(error);
      return;
    }
    const train = this.sim.addTrain([{ stockId: carry.stockId, reversed: false }], { edgeKey: target.edgeKey, s: target.s, reversed: false });
    if (typeof train === 'string') this.say(train);
    else if (getStock(carry.stockId).motor && !carry.lifted) this.say(`${train.name} is on the track. Drag cars next to it to couple them on, then press ▶.`);
  }

  /** Where a vehicle carried to the pointer would go. */
  private targetAt(e: PointerEvent, stockId: string): DropTarget {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObject(this.host.pieceObjects, true)[0];
    const point = hit?.point ?? this.raycaster.ray.intersectPlane(this.trackTop, new THREE.Vector3());
    if (!point) return { kind: 'none', at: null };
    const at = { x: point.x, y: -point.z };
    // By the end of a train: couple on.
    let best: { trainId: number; end: 'front' | 'back'; d: number } | null = null;
    for (const t of this.sim.trains) {
      if (t.wrecked) continue;
      const ends = [
        { end: 'front' as const, face: t.vehicles[0].geo.aheadFace },
        { end: 'back' as const, face: t.vehicles[t.vehicles.length - 1].geo.behindFace },
      ];
      for (const { end, face } of ends) {
        const d = Math.hypot(face.x - at.x, face.y - at.y);
        if (d < ATTACH_REACH_MM && (!best || d < best.d)) best = { trainId: t.id, end, d };
      }
    }
    if (best) {
      const geo = this.sim.attachPreview(best.trainId, best.end, stockId);
      if (geo) return { kind: 'attach', trainId: best.trainId, end: best.end, geo };
    }
    const track = this.sim.nearestTrack(at, 45);
    if (track) {
      const pose = poseAt(track.edge.path, track.s);
      return { kind: 'track', edgeKey: track.edge.key, s: track.s, geo: { center: pose, heading: pose.angle } };
    }
    return { kind: 'none', at };
  }

  private placeGhost(carry: Carry): void {
    const { ghost, target } = carry;
    ghost.visible = target.kind !== 'none' || target.at !== null;
    if (target.kind === 'none') {
      if (target.at) {
        // Held up off the track.
        ghost.position.copy(toWorld(target.at.x, target.at.y, 30));
        ghost.rotation.set(0, ghost.rotation.y, 0);
      }
      return;
    }
    ghost.position.copy(toWorld(target.geo.center.x, target.geo.center.y, 0));
    ghost.rotation.set(0, target.geo.heading, 0);
  }

  // ---- every frame ---------------------------------------------------------

  tick(time: number): void {
    const dt = this.lastTime === null ? 0 : (time - this.lastTime) / 1000;
    this.lastTime = time;
    if (this.host.layout !== this.layout) {
      this.layout = this.host.layout;
      const removed = this.sim.setLayout(this.layout);
      if (removed.length) this.say(`${removed.join(' and ')} ${removed.length > 1 ? 'were' : 'was'} taken off: the track under it changed.`);
      this.drawLevers();
    }
    if (!this.paused && dt > 0) this.sim.advance(Math.min(dt, 0.05) * this.speed);
    this.drawTrains(time);
    this.drawCards();
    this.updateLeverVisibility();
    const notices = this.sim.notices;
    if (notices.length && notices[notices.length - 1].time !== this.noticesSeen) {
      this.noticesSeen = notices[notices.length - 1].time;
      this.say(notices[notices.length - 1].message);
    }
    if (!this.toast.hidden && performance.now() > this.toastUntil) this.toast.hidden = true;
  }

  private drawTrains(time: number): void {
    const seen = new Set<string>();
    this.markersRoot.clear();
    const carry = this.carry;
    for (const train of this.sim.trains) {
      train.vehicles.forEach((v, i) => {
        const key = `${train.id}:${i}:${v.def.id}`;
        seen.add(key);
        let mesh = this.meshes.get(key);
        if (!mesh) {
          mesh = buildVehicle(v.def);
          this.meshes.set(key, mesh);
          this.vehiclesRoot.add(mesh);
        }
        mesh.userData.trainId = train.id;
        mesh.userData.index = i;
        const { center, heading } = v.geo;
        mesh.position.copy(toWorld(center.x, center.y, 0));
        mesh.rotation.set(0, heading, 0);
        if (v.derailed) {
          // Off the rails: dropped and tipped over a little.
          mesh.position.y = -AXLE_HEIGHT * 0.5;
          mesh.rotateX(0.35);
          mesh.rotateZ(-0.15);
        }
      });
      if (train.status.kind === 'stuck') this.markersRoot.add(this.stuckMarker(train.status.at, time));
    }
    for (const [key, mesh] of this.meshes) {
      if (!seen.has(key)) {
        this.vehiclesRoot.remove(mesh);
        this.meshes.delete(key);
      }
    }
    // Where a carried vehicle would couple on.
    if (carry?.target.kind === 'attach') {
      const train = this.sim.train(carry.target.trainId);
      if (train) {
        const v = carry.target.end === 'front' ? train.vehicles[0] : train.vehicles[train.vehicles.length - 1];
        const face = carry.target.end === 'front' ? v.geo.aheadFace : v.geo.behindFace;
        const ring = new THREE.Mesh(attachGeometry, attachMaterial);
        ring.position.copy(toWorld(face.x, face.y, AXLE_HEIGHT + 2));
        ring.rotation.y = v.geo.heading + Math.PI / 2;
        ring.scale.setScalar(1 + 0.12 * Math.sin(time / 150));
        this.markersRoot.add(ring);
      }
    }
  }

  private stuckMarker(at: Vec2, time: number): THREE.Object3D {
    const ring = new THREE.Mesh(stuckGeometry, stuckMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(toWorld(at.x, at.y, D.TRACK_HEIGHT + 30));
    ring.scale.setScalar(1 + 0.15 * Math.sin(time / 180));
    return ring;
  }

  /** A yellow knob over each switch, and a yellow stripe down the way it is set. */
  private drawLevers(): void {
    this.leversRoot.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry instanceof THREE.TubeGeometry) o.geometry.dispose();
    });
    this.leversRoot.clear();
    for (const sw of this.sim.network.switches()) {
      const choice = sw.choices[(this.sim.levers.get(sw.uid) ?? 0) % sw.choices.length];
      // Switch paths all start at the trunk.
      const points: THREE.Vector3[] = [];
      for (let s = 8; s <= Math.min(STRIPE_MM, choice.length); s += 4) {
        const p = poseAt(choice.path, s);
        points.push(toWorld(p.x, p.y, D.TRACK_HEIGHT + 0.6));
      }
      if (points.length > 1) {
        const stripe = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length * 2, 2.2, 6), leverMaterial);
        stripe.userData.uid = sw.uid;
        this.leversRoot.add(stripe);
      }
      const p = poseAt(choice.path, Math.min(LEVER_REACH, choice.length));
      const knob = new THREE.Mesh(knobGeometry, leverMaterial);
      knob.position.copy(toWorld(p.x, p.y, D.TRACK_HEIGHT + 22));
      knob.userData.uid = sw.uid;
      const stem = new THREE.Mesh(stemGeometry, leverStem);
      stem.position.copy(toWorld(p.x, p.y, D.TRACK_HEIGHT + 11));
      stem.userData.uid = sw.uid;
      this.leversRoot.add(knob, stem);
    }
  }
}
