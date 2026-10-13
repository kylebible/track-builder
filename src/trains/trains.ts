import * as THREE from 'three';
import { poseAt } from '../geometry/path';
import type { Vec2 } from '../geometry/pose';
import type { Layout } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { toWorld } from '../render/pieceMesh';
import { attracts, getStock, polesOf, STOCK, type ConsistEntry, type StockDef } from './stock';
import { TrainSim, type Train } from './sim';
import { AXLE_HEIGHT, buildVehicle, POLE_COLOR } from './trainMesh';
import './trains.css';

// The Trains panel: build a train from engines and cars, put it on the
// track, and run it. Owns the simulation and keeps its three.js objects in
// step with it. Clicks meant for trains (placing one, throwing a switch
// lever) are caught before the track editor sees them.

export interface TrainsHost {
  /** The layout as it stands now. */
  readonly layout: Layout;
  /** The placed pieces' objects, to find where a click lands on the track. */
  readonly pieceObjects: THREE.Object3D;
}

const SPEEDS = [1, 2, 4] as const;
const LEVER_REACH = 24;
/** How far down the chosen way the lever's stripe runs. */
const STRIPE_MM = 110;

const leverMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.4, emissive: 0x6b4f00, emissiveIntensity: 0.25 });
const leverStem = new THREE.MeshStandardMaterial({ color: 0x5a4026, roughness: 0.8 });
const stuckMaterial = new THREE.MeshStandardMaterial({ color: 0xd33a2c, emissive: 0xd33a2c, emissiveIntensity: 0.6 });
const stuckGeometry = new THREE.TorusGeometry(26, 3, 10, 48);
const knobGeometry = new THREE.SphereGeometry(9, 24, 16);
const stemGeometry = new THREE.CylinderGeometry(2, 2, 22, 10);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) => {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
};

/** A little side view of a vehicle, magnets coloured by pole. */
function stockIcon(def: StockDef, reversed = false): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const w = def.length * 0.42;
  svg.setAttribute('viewBox', `-2 0 ${w + 4} 34`);
  svg.setAttribute('width', String(w + 4));
  svg.setAttribute('height', '34');
  const add = (tag: string, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
  };
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  const h = Math.min(22, def.height * 0.38);
  add('rect', { x: 2, y: 26 - h, width: w - 4, height: h, rx: 3, fill: hex(def.color) });
  if (def.motor) add('rect', { x: w * 0.55, y: 26 - h - 5, width: 4, height: 6, fill: '#2b2622' });
  const half = def.wheelbase * 0.21;
  for (const x of [w / 2 - half, w / 2 + half]) add('circle', { cx: x, cy: 28, r: 4, fill: '#a3262a' });
  const poles = polesOf({ reversed });
  // The vehicle's front is drawn on the right, the way the train runs.
  add('rect', { x: w - 2, y: 18, width: 3, height: 6, fill: hex(POLE_COLOR[poles.front]) });
  add('rect', { x: -1, y: 18, width: 3, height: 6, fill: hex(POLE_COLOR[poles.back]) });
  return svg;
}

export class Trains {
  readonly sim: TrainSim;
  private readonly root = new THREE.Group();
  private readonly vehiclesRoot = new THREE.Group();
  private readonly leversRoot = new THREE.Group();
  private readonly markersRoot = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Group>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -D.TRACK_HEIGHT);

  private open = false;
  private paused = false;
  private speed: (typeof SPEEDS)[number] = 1;
  private placing = false;
  private consist: ConsistEntry[] = [{ stockId: 'battery-engine', reversed: false }];
  private layout: Layout;
  private lastTime: number | null = null;
  private lastPanel = 0;
  private toastUntil = 0;
  private noticesSeen = 0;

  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly consistEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly placeButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly speedButtons: HTMLButtonElement[];
  private readonly toast: HTMLElement;

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

    this.toggle = el('button', { id: 'trains-button', title: 'Run trains on the layout (Y)', type: 'button' });
    this.toggle.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><path d="M8 21l-2 0"/><path d="M18 21l-2 0"/><circle cx="8.5" cy="14" r=".5"/><circle cx="15.5" cy="14" r=".5"/><path d="m8 17-2 4"/><path d="m16 17 2 4"/></svg><span>Trains</span>';
    this.toggle.onclick = () => this.setOpen(!this.open);
    // Beside the view buttons, which stay pushed to the right.
    toolbar.insertBefore(el('div', { class: 'group' }, this.toggle), toolbar.lastElementChild);

    this.pauseButton = el('button', { class: 'tr-btn', type: 'button', onclick: () => this.setPaused(!this.paused) });
    this.speedButtons = SPEEDS.map((s) =>
      el('button', { type: 'button', textContent: `${s}×`, title: `Run at ${s}× speed`, onclick: () => this.setSpeed(s) }),
    );
    this.consistEl = el('div', { class: 'tr-consist' });
    this.listEl = el('ul', { class: 'tr-list' });
    this.placeButton = el('button', { class: 'tr-btn primary', type: 'button', textContent: 'Put on track', onclick: () => this.setPlacing(!this.placing) });
    this.toast = el('div', { class: 'tr-toast', hidden: true });

    const tiles = el(
      'div',
      { class: 'tr-stock' },
      ...STOCK.map((def) =>
        el('button', { class: 'tr-tile', type: 'button', title: `Add a ${def.name.toLowerCase()} to the back`, onclick: () => this.addStock(def.id) }, stockIcon(def), el('span', { textContent: def.name })),
      ),
    );

    this.panel = el(
      'section',
      { id: 'trains', hidden: true, ariaLabel: 'Trains' },
      el('header', {}, el('h2', { textContent: 'Trains' }), el('button', { class: 'tr-close', type: 'button', title: 'Close', textContent: '×', onclick: () => this.setOpen(false) })),
      el('div', { class: 'tr-row' }, this.pauseButton, el('div', { class: 'seg' }, ...this.speedButtons), el('button', { class: 'tr-btn', type: 'button', textContent: 'Reset', title: 'Put every train back where it started', onclick: () => this.reset() })),
      el('h3', { textContent: 'Build a train' }),
      tiles,
      this.consistEl,
      el('div', { class: 'tr-row' }, this.placeButton, el('button', { class: 'tr-btn', type: 'button', textContent: 'Clear', onclick: () => this.setConsist([]) })),
      el('h3', { textContent: 'On the track' }),
      this.listEl,
      el('p', { class: 'tr-hint', innerHTML: 'Tap a switch’s <b>yellow knob</b> to change which way it sends trains. Red and blue ends are the magnets: red pulls blue.' }),
    );
    container.append(this.panel, this.toast);

    // Window capture runs before the editor's handlers on the canvas.
    window.addEventListener('pointerdown', (e) => this.pointerDown(e), { capture: true });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'y' || e.key === 'Y') this.setOpen(!this.open);
      else if (e.key === 'Escape' && this.placing) this.setPlacing(false);
      else if (e.key === ' ' && this.open) {
        e.preventDefault();
        this.setPaused(!this.paused);
      }
    });
    this.setSpeed(1);
    this.setPaused(false);
    this.renderConsist();
    this.renderList();
    this.drawLevers();
    this.setOpen(false);
  }

  // ---- panel ---------------------------------------------------------------

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-pressed', String(open));
    this.leversRoot.visible = open;
    if (!open) this.setPlacing(false);
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

  private setPlacing(placing: boolean): void {
    this.placing = placing && this.consist.length > 0;
    this.placeButton.textContent = this.placing ? 'Tap the track…' : 'Put on track';
    this.placeButton.classList.toggle('active', this.placing);
    this.container.classList.toggle('placing-train', this.placing);
    if (this.placing) this.say('Tap a piece of track to put the train there. It will face along the piece.');
  }

  private addStock(id: string): void {
    this.setConsist([...this.consist, { stockId: id, reversed: false }]);
  }

  private setConsist(consist: ConsistEntry[]): void {
    this.consist = consist;
    if (!consist.length) this.setPlacing(false);
    this.renderConsist();
  }

  private renderConsist(): void {
    this.consistEl.replaceChildren();
    if (!this.consist.length) {
      this.consistEl.append(el('p', { class: 'tr-empty', textContent: 'Tap an engine or car above to start a train.' }));
      return;
    }
    // The first vehicle is the front, drawn on the right (the row runs right to left).
    const row = el('div', { class: 'tr-chain' });
    this.consist.forEach((entry, i) => {
      const def = getStock(entry.stockId);
      if (i > 0) {
        const ok = attracts(this.consist[i - 1], entry);
        row.append(el('span', { class: `tr-link ${ok ? 'ok' : 'bad'}`, title: ok ? 'Magnets hold' : 'Same poles: these push apart. Turn one round.', textContent: ok ? '' : '!' }));
      }
      const chip = el(
        'div',
        { class: 'tr-chip', title: def.name },
        stockIcon(def, entry.reversed),
        el('div', { class: 'tr-chip-actions' },
          el('button', { type: 'button', title: 'Turn round', textContent: '⇄', onclick: () => this.setConsist(this.consist.map((c, j) => (j === i ? { ...c, reversed: !c.reversed } : c))) }),
          el('button', { type: 'button', title: 'Take off', textContent: '×', onclick: () => this.setConsist(this.consist.filter((_, j) => j !== i)) }),
        ),
      );
      row.append(chip);
    });
    const bad = this.consist.some((c, i) => i > 0 && !attracts(this.consist[i - 1], c));
    const engines = this.consist.filter((c) => getStock(c.stockId).motor).length;
    const note = bad
      ? 'Some magnets face the same way and will push apart.'
      : !engines
        ? 'No engine: this train will only move if pushed.'
        : `${this.consist.length} vehicle${this.consist.length > 1 ? 's' : ''}, ${Math.round(this.consist.reduce((s, c) => s + getStock(c.stockId).length, 0))} mm long. Front on the right.`;
    this.consistEl.append(row, el('p', { class: `tr-note${bad ? ' warn' : ''}`, textContent: note }));
  }

  /** What the train list shows apart from status text; the list is rebuilt only when this changes. */
  private listKey = '';

  private renderList(): void {
    const trains = this.sim.trains;
    const key = trains.map((t) => `${t.id}/${t.throttle}/${t.wrecked}/${t.vehicles.length}/${t.couplings.filter((c) => !c.coupled).length}`).join(',');
    if (key === this.listKey && trains.length) {
      trains.forEach((t, i) => {
        const row = this.listEl.children[i] as HTMLElement;
        row.className = `tr-train ${t.status.kind}`;
        row.querySelector('.tr-status')!.textContent = this.statusText(t);
      });
      return;
    }
    this.listKey = key;
    if (!trains.length) {
      this.listEl.replaceChildren(el('li', { class: 'tr-empty', textContent: 'No trains yet.' }));
      return;
    }
    this.listEl.replaceChildren(...trains.map((t) => this.trainRow(t)));
  }

  private statusText(t: Train): string {
    const status = t.status;
    if (status.kind === 'stuck') return status.message;
    if (status.kind === 'running') return `Running at ${Math.round(status.speed)} mm/s`;
    return t.throttle ? 'Starting…' : 'Stopped';
  }

  private trainRow(t: Train): HTMLElement {
    const status = t.status;
    const text = this.statusText(t);
    const loose = t.couplings.filter((c) => !c.coupled).length;
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
          this.renderList();
        },
      });
    return el(
      'li',
      { class: `tr-train ${status.kind}` },
      el('div', { class: 'tr-train-head' }, el('b', { textContent: t.name }), el('span', { class: 'tr-cars', textContent: `${t.vehicles.length} vehicle${t.vehicles.length > 1 ? 's' : ''}${loose ? `, ${loose} uncoupled` : ''}` })),
      el('p', { class: 'tr-status', textContent: text }),
      el('div', { class: 'tr-row' },
        el('div', { class: 'seg drive' }, drive('◀', 'Engines in reverse', -1), drive('■', 'Engines off', 0), drive('▶', 'Engines forward', 1)),
        el('button', { class: 'tr-btn', type: 'button', textContent: t.wrecked ? 'Put back' : 'Turn round', title: t.wrecked ? 'Put it back where it started' : 'Lift it off and put it back facing the other way', onclick: () => this.turnOrRestore(t) }),
        el('button', { class: 'tr-btn danger', type: 'button', title: 'Take it off the track', textContent: 'Remove', onclick: () => { this.sim.removeTrain(t.id); this.renderList(); } }),
      ),
    );
  }

  private turnOrRestore(t: Train): void {
    const error = t.wrecked ? this.restore(t) : this.sim.turnAround(t.id);
    if (error) this.say(error);
    this.renderList();
  }

  private restore(t: Train): string | null {
    const consist = t.consist;
    const placement = t.placement;
    this.sim.removeTrain(t.id);
    const again = this.sim.addTrain(consist, placement, t.name);
    return typeof again === 'string' ? again : null;
  }

  private reset(): void {
    this.sim.reset();
    this.noticesSeen = 0;
    this.renderList();
  }

  private say(message: string): void {
    this.toast.textContent = message;
    this.toast.hidden = false;
    this.toastUntil = performance.now() + 4500;
  }

  // ---- pointer ---------------------------------------------------------------

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement) || !this.container.contains(e.target)) return;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.root.updateMatrixWorld();
    if (this.open) {
      const lever = this.raycaster.intersectObject(this.leversRoot, true)[0];
      if (lever) {
        this.sim.toggleLever(lever.object.userData.uid as string);
        this.drawLevers();
        return this.swallow(e);
      }
    }
    if (!this.placing) return;
    this.swallow(e);
    const hit = this.raycaster.intersectObject(this.host.pieceObjects, true)[0];
    const point = hit ? hit.point : this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    if (!point) return;
    const at = this.sim.nearestTrack({ x: point.x, y: -point.z });
    if (!at) {
      this.say('That isn’t on the track. Tap a piece of track.');
      return;
    }
    const train = this.sim.addTrain(this.consist, { edgeKey: at.edge.key, s: at.s, reversed: false });
    if (typeof train === 'string') {
      this.say(train);
      return;
    }
    this.setPlacing(false);
    this.say(`${train.name} is on the track. Press ▶ to start it.`);
    this.renderList();
  }

  private swallow(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
  }

  private ndc(e: PointerEvent): THREE.Vector2 {
    const rect = this.container.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
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
      this.renderList();
    }
    if (!this.paused && dt > 0) this.sim.advance(Math.min(dt, 0.05) * this.speed);
    this.drawTrains(time);
    const notices = this.sim.notices;
    if (notices.length && notices[notices.length - 1].time !== this.noticesSeen) {
      this.noticesSeen = notices[notices.length - 1].time;
      this.say(notices[notices.length - 1].message);
    }
    if (time - this.lastPanel > 250) {
      this.lastPanel = time;
      if (this.open) this.renderList();
    }
    if (!this.toast.hidden && performance.now() > this.toastUntil) this.toast.hidden = true;
  }

  private drawTrains(time: number): void {
    const seen = new Set<string>();
    this.markersRoot.clear();
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
