import * as THREE from 'three';
import { poseAt } from '../geometry/path';
import type { Vec2 } from '../geometry/pose';
import type { Layout } from '../layout/layout';
import { MODE, onBasicMode } from '../pieces/basic';
import * as D from '../pieces/dimensions';
import { toWorld } from '../render/pieceMesh';
import { cabPose, travelWay } from './cab';
import { cargoCount, getStock, STOCK, supplyLevel, type CargoKind, type StockDef } from './stock';
import { edgeGrade, edgeHeight } from './network';
import { TrainSim, type StuckKind, type Train, type VehicleGeometry } from './sim';
import { AXLE_HEIGHT, buildVehicle, showLoad } from './trainMesh';
import { AccessoryView } from './accessoryView';
import { EconomyView } from './economyView';
import { TrainList } from './trainList';
import { freshAboard, getJob, JOBS, tiredAboard, type JobId } from './jobs';
import { Synth } from '../sound/synth';
import { TrainSounds } from '../sound/trainSounds';
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

/** The orbit controls, handed over while riding along. */
export interface ViewControls {
  enabled: boolean;
  target: THREE.Vector3;
}

const SPEEDS = [1, 2, 4] as const;
const KEEP_COUPLED_KEY = 'track-builder:keep-coupled';
const HANDS_OFF_KEY = 'track-builder:jobs-run-themselves';

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Private browsing: the setting just isn't kept.
  }
}
const LEVER_REACH = 24;
/** How far down the chosen way the lever's stripe runs. */
const STRIPE_MM = 110;
/** A vehicle dropped this close to a train's end couples on. */
const ATTACH_REACH_MM = 70;
/** Pointer travel, in pixels, before a press on a vehicle becomes a drag. */
const DRAG_THRESHOLD_PX = 6;
/** Riding along: a wide view, and a near plane that clears the roof below. */
const CAB_FOV = 68;
const CAB_NEAR = 2;
/** Radians of look per pixel dragged while riding. */
const LOOK_PER_PX = 0.005;
/** How quickly the view swings round with the track, and back ahead after looking around. */
const FOLLOW_RATE = 7;
const LOOK_RETURN_RATE = 1.2;
/** Tipped down a touch, to see the track ahead as well as the horizon. */
const CAB_TILT = -0.24;

const leverMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.4, emissive: 0x6b4f00, emissiveIntensity: 0.25 });
const leverStem = new THREE.MeshStandardMaterial({ color: 0x5a4026, roughness: 0.8 });
const stuckMaterial = new THREE.MeshStandardMaterial({ color: 0xd33a2c, emissive: 0xd33a2c, emissiveIntensity: 0.6 });
const stuckGeometry = new THREE.TorusGeometry(26, 3, 10, 48);
const knobGeometry = new THREE.SphereGeometry(9, 24, 16);
const stemGeometry = new THREE.CylinderGeometry(2, 2, 22, 10);
const attachMaterial = new THREE.MeshBasicMaterial({ color: 0x1f9d55, transparent: true, opacity: 0.85 });
const attachGeometry = new THREE.TorusGeometry(10, 2.2, 10, 40);
const pinMaterial = new THREE.MeshStandardMaterial({ color: 0x2a7fd4, emissive: 0x1a4f88, emissiveIntensity: 0.4, roughness: 0.4 });
const pinGeometry = new THREE.ConeGeometry(8, 22, 20).rotateX(Math.PI);

/** An eye: watch from the train. */
const RIDE_ICON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';

const SHORT: Record<StuckKind, string> = {
  'ran-off': 'Ran off the end',
  buffer: 'At the buffer stop',
  stalled: 'Stalled',
  slipping: 'Wheels spinning',
  fighting: 'Engines fighting',
  crashed: 'Crashed',
  derailed: 'Derailed',
  tipped: 'Tipped over',
  'no-water': 'Out of water',
  'no-coal': 'Out of coal',
  'flat-battery': 'Battery flat',
};

/** The glow round a train hovered in the list: a box the size of each car. */
const HALO_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const HALO_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0.4, depthWrite: false });

/** How long a whistle's "Toot!" shows, ms. */
const BUBBLE_MS = 1600;

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
  | { kind: 'track'; edgeKey: string; s: number; geo: { center: Vec2; heading: number; z: number; pitch: number } }
  | { kind: 'none'; at: Vec2 | null };

interface Carry {
  pointerId: number;
  stockId: string;
  ghost: THREE.Group;
  target: DropTarget;
  /** Lifted off the track rather than taken from the panel. */
  lifted: boolean;
}

interface Ride {
  trainId: number;
  way: 1 | -1;
  /** Smoothed way of travel and nose up, so curves and joints don't jolt the view. */
  heading: number;
  pitch: number;
  /** Looking round from straight ahead. */
  lookYaw: number;
  lookPitch: number;
  look: { pointerId: number; x: number; y: number; yaw: number; pitch: number } | null;
  /** The orbit view to come back to. */
  saved: { position: THREE.Vector3; target: THREE.Vector3; fov: number; near: number };
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
  /** The view's size in CSS pixels, for placing cards and bubbles over the 3D view. */
  private viewSize: { width: number; height: number };
  private readonly root = new THREE.Group();
  private readonly vehiclesRoot = new THREE.Group();
  private readonly leversRoot = new THREE.Group();
  private readonly markersRoot = new THREE.Group();
  /** Glows round the train hovered in the sidebar's list. */
  private readonly haloRoot = new THREE.Group();
  /** The sidebar's list of trains. */
  readonly list: TrainList;
  /** The train lit up from the list, if any. */
  highlighted: number | null = null;
  /** The train the view follows, if any. */
  following: number | null = null;
  /** The train whose controls are open in the sidebar's list, if any. */
  selected: number | null = null;
  /** Shows the sidebar's list of trains; set by the page. */
  onShowList: (() => void) | null = null;
  /** Moves the view to a spot; set by the page. */
  onFocus: ((at: Vec2) => void) | null = null;
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
  /** A turntable being turned by a drag round its pit. */
  private turning: { pointerId: number; uid: string } | null = null;
  private thumbnails: Map<string, string> | null = null;
  private readonly accessories: AccessoryView;
  readonly sounds: TrainSounds;
  private ride: Ride | null = null;

  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly tiles: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly speedButtons: HTMLButtonElement[];
  private readonly toast: HTMLElement;
  /** Each train's own controls, floating over it. */
  private readonly hud: HTMLElement;
  private readonly cards = new Map<number, { card: HTMLElement; key: string }>();
  /** Bubbles over engines as they pass signs. */
  private readonly bubbles: { el: HTMLElement; at: THREE.Vector3; until: number }[] = [];
  private eventsSeen = 0;
  private readonly deliveries: HTMLElement;
  private readonly economyView: EconomyView;
  private readonly autorouteBox: HTMLInputElement;
  private leverVersion = 0;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly host: TrainsHost,
    private readonly container: HTMLElement,
    toolbar: HTMLElement,
    private readonly controls: ViewControls,
  ) {
    this.layout = host.layout;
    // Measuring the page every frame, after the cards have moved, makes the browser lay it out again.
    const measure = () => ({ width: container.clientWidth, height: container.clientHeight });
    this.viewSize = measure();
    new ResizeObserver(() => (this.viewSize = measure())).observe(container);
    this.sim = new TrainSim(this.layout);
    // Basic mode has real magnets; otherwise they're forgiving.
    this.sim.realMagnets = MODE.basic;
    onBasicMode((basic) => (this.sim.realMagnets = basic));
    this.sim.keepCoupled = loadFlag(KEEP_COUPLED_KEY);
    this.accessories = new AccessoryView(this.sim, host.pieceObjects);
    this.root.add(this.vehiclesRoot, this.leversRoot, this.markersRoot, this.haloRoot, this.accessories.root);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.list = new TrainList({
      get trains() {
        return self.sim.trains;
      },
      statusText: (t) => this.statusText(t),
      loadText: (t) => this.loadText(t),
      destText: (t) => this.destText(t),
      goTo: (id) => this.goTo(id),
      get following() {
        return self.following;
      },
      get selected() {
        return self.selected;
      },
      select: (id) => this.select(id),
      highlight: (id) => (this.highlighted = id),
      setThrottle: (id, throttle) => {
        this.sim.setThrottle(id, throttle);
        if (throttle) this.setPaused(false);
      },
      openPanel: () => this.setOpen(true),
    });
    scene.add(this.root);

    this.toggle = el('button', { id: 'trains-button', title: 'Trains: drag engines and cars onto the track (Y)', type: 'button' });
    this.toggle.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><circle cx="8.5" cy="14" r=".5"/><circle cx="15.5" cy="14" r=".5"/><path d="m8 17-2 4"/><path d="m16 17 2 4"/></svg><span>Trains</span>';
    this.toggle.onclick = () => this.setOpen(!this.open);
    this.sounds = new TrainSounds(new Synth(), camera);
    this.muteButton = el('button', { id: 'sound-button', type: 'button', onclick: () => this.setMuted(!this.sounds.synth.muted) });
    // Beside the view buttons, which stay pushed to the right.
    toolbar.insertBefore(el('div', { class: 'group' }, this.toggle, this.muteButton), toolbar.lastElementChild);

    this.pauseButton = el('button', { class: 'tr-btn', type: 'button', onclick: () => this.setPaused(!this.paused) });
    this.speedButtons = SPEEDS.map((s) => el('button', { type: 'button', textContent: `${s}×`, title: `Run at ${s}× speed`, onclick: () => this.setSpeed(s) }));
    this.toast = el('div', { class: 'tr-toast', hidden: true });
    this.hud = el('div', { class: 'tr-hud' });
    const tile = (def: StockDef) => {
      const t = el('button', { class: 'tr-tile', type: 'button', title: `Drag a ${def.name.toLowerCase()} onto the track${def.cargo ? `. It carries ${def.cargo.capacity} ${cargoCount(def.cargo.kind, def.cargo.capacity).replace(/^\d+ /, '')}` : ''}` }, el('span', { class: 'tr-thumb' }), el('span', { textContent: def.name }));
      t.dataset.stock = def.id;
      t.addEventListener('pointerdown', (e) => this.pickUp(e, def));
      return t;
    };
    const powered = (def: StockDef) => def.motor || def.supplies;
    this.tiles = el(
      'div',
      {},
      el('h3', { textContent: 'Engines' }),
      el('div', { class: 'tr-stock' }, ...STOCK.filter(powered).map(tile)),
      el('h3', { textContent: 'Cars' }),
      el('div', { class: 'tr-stock' }, ...STOCK.filter((d) => !powered(d)).map(tile)),
    );
    const supplies = el('input', { type: 'checkbox', checked: this.sim.useSupplies, onchange: () => (this.sim.useSupplies = supplies.checked) });
    this.deliveries = el('p', { class: 'tr-deliveries' });
    const keepCoupled = el('input', {
      type: 'checkbox',
      checked: this.sim.keepCoupled,
      onchange: () => saveFlag(KEEP_COUPLED_KEY, (this.sim.keepCoupled = keepCoupled.checked)),
    });
    this.sim.operator.setOn(loadFlag(HANDS_OFF_KEY));
    this.economyView = new EconomyView(this.sim, this.hud, camera, container, {
      addJobTrain: (job) => this.addJobTrain(job),
      runByItself: (on) => {
        this.sim.operator.setOn(on);
        saveFlag(HANDS_OFF_KEY, on);
        if (on) this.setPaused(false);
      },
    });
    this.autorouteBox = el('input', { type: 'checkbox', checked: this.sim.autoroute, onchange: () => this.sim.setAutoroute(this.autorouteBox.checked) });
    this.panel = el(
      'section',
      { id: 'trains', hidden: true, ariaLabel: 'Trains' },
      el('header', {}, el('h2', { textContent: 'Trains' }), el('button', { class: 'tr-close', type: 'button', title: 'Close', textContent: '×', onclick: () => this.setOpen(false) })),
      el('p', { class: 'tr-lead', textContent: 'Drag engines and cars onto the track. Drop one by the end of a train to couple it on.' }),
      this.tiles,
      el('div', { class: 'tr-row' }, this.pauseButton, el('div', { class: 'seg' }, ...this.speedButtons), el('button', { class: 'tr-btn', type: 'button', textContent: 'Reset', title: 'Put every train back where it was built, stopped', onclick: () => this.reset() })),
      el('label', { class: 'tr-check', title: 'Steam engines burn water and coal and battery engines use charge. Top them up at a water tower, coaling stage or charging post.' }, supplies, ' Engines use up water, coal and charge'),
      el('label', { class: 'tr-check', title: 'Magnets never let go on their own, however long the train or tight the bend, so job trains and long trains stay in one piece. Off, they pull or slide apart like real ones (more readily in Basic mode).' }, keepCoupled, ' Keep trains coupled'),
      el('label', { class: 'tr-check', title: 'Each train reserves the track ahead of it and sets the switches its way. A train waits short of track another train is on instead of running into it, and takes the free side of a passing loop.' }, this.autorouteBox, ' Autoroute: trains set switches and wait for each other'),
      this.deliveries,
      this.economyView.section,
      el('h3', { textContent: 'Tips' }),
      el('ul', { class: 'tr-hint' },
        el('li', { innerHTML: 'With this panel open, <b>tap a car</b> on the track to turn it round. Red and blue ends are the magnets: red pulls blue. With it shut, tapping a train opens it in the sidebar’s Trains list.' }),
        el('li', { innerHTML: '<b>Drag a car</b> to lift it off. Drop it off the track to take it away.' }),
        el('li', { innerHTML: 'Each train has its own controls. Tap a switch’s <b>yellow knob</b> to change its way.' }),
        el('li', { innerHTML: '<b>Tap a signal</b> to turn it red or green. Trains stop at stations, and under the cargo loader and by the crane to load and unload open wagons. The lifting bridge’s knob raises it.' }),
        el('li', { innerHTML: '<b>Ride along</b> (C) watches from the cab. Drag to look around; Esc gets off.' }),
        el('li', { innerHTML: '<b>Go to</b> on a train’s card sends it to a station or trackside place by the shortest way, setting switches as it goes. It backs up if that’s quicker.' }),
        el('li', { innerHTML: 'Put <b>trackside</b> places from the parts palette over a straight: trains stop at water towers, mines and more when there’s work for them. <b>Jobs</b> above says what each place needs.' }),
      ),
    );
    container.append(this.hud, this.panel, this.toast);

    // Window capture runs before the editor's handlers on the canvas.
    window.addEventListener('pointerdown', (e) => this.pointerDown(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    window.addEventListener('pointercancel', (e) => this.cancel(e));
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'y' || e.key === 'Y') this.setOpen(!this.open);
      else if (e.key === 'm' || e.key === 'M') this.setMuted(!this.sounds.synth.muted);
      else if (e.key === 'c' || e.key === 'C') this.toggleRide();
      else if (e.key === 'Escape' && this.carry) this.drop(false);
      else if (e.key === 'Escape' && this.ride) this.leaveCab();
      else if (e.key === ' ' && this.sim.trains.length) {
        e.preventDefault();
        this.setPaused(!this.paused);
      }
    });
    this.setSpeed(1);
    this.setPaused(false);
    this.setMuted(this.sounds.synth.muted);
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

  private setMuted(muted: boolean): void {
    this.sounds.synth.setMuted(muted);
    const b = this.muteButton;
    b.setAttribute('aria-pressed', String(muted));
    b.title = muted ? 'Sound is off: turn it on (M)' : 'Sound is on: mute it (M)';
    b.innerHTML = muted
      ? '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg><span>Muted</span>'
      : '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg><span>Sound</span>';
  }

  private reset(): void {
    this.sim.reset();
    this.noticesSeen = 0;
    this.eventsSeen = 0;
  }

  private addJobTrain(job: JobId): void {
    const train = this.sim.addJobTrain(job);
    if (typeof train === 'string') {
      this.say(train);
      return;
    }
    this.setPaused(false);
    this.say(`${train.name} is on its way. ${getJob(job).blurb}`);
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

  statusText(t: Train): string {
    const status = t.status;
    if (status.kind === 'stuck') return SHORT[status.stuck];
    if (status.kind === 'running') return `${Math.round(status.speed)} mm/s`;
    if (status.kind === 'waiting') return status.message;
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
      el('div', { class: 'tr-card-load' }),
      t.vehicles.some((v) => v.def.motor) ? this.jobRow(t) : '',
      el('div', { class: 'tr-card-work', hidden: true }, el('span'), el('i', {}, el('i'))),
      t.job === 'free' ? this.destinationPicker(t) : '',
      el('div', { class: 'tr-card-row' },
        t.wrecked
          ? act('Put back on the rails', 'Put it back where it was built', () => this.restore(t), 'wide')
          : el('div', { class: 'seg drive' }, drive('◀', 'Engines in reverse', -1), drive('■', 'Engines off', 0), drive('▶', 'Engines forward', 1)),
        t.wrecked ? '' : act('⇄', 'Turn the whole train round', () => this.turnTrain(t)),
        t.wrecked || !t.vehicles.some((v) => v.def.motor) ? '' : this.whistleButton(t),
        this.ride?.trainId === t.id
          ? act('Get off', 'Back to the overhead view (Esc)', () => this.leaveCab(), 'ride on')
          : el('button', { type: 'button', class: 'ride', title: 'Ride along: watch from the cab (C)', innerHTML: RIDE_ICON, onclick: () => this.enterCab(t.id) }),
        act('✕', 'Take the train off the track', () => this.sim.removeTrain(t.id), 'danger'),
      ),
    );
  }

  /** The job picker, and where the train is heading for it. */
  private jobRow(t: Train): HTMLElement {
    const select = el(
      'select',
      { class: 'tr-job', title: 'What this train is for. With a job it picks its own stops and sets the switches.', onchange: () => this.sim.setJob(t.id, select.value as JobId) },
      ...JOBS.map((j) => el('option', { value: j.id, textContent: `${j.icon} ${j.name}`, selected: j.id === t.job, title: j.blurb })),
    );
    return el('div', { class: 'tr-card-job' }, select, el('span', { class: 'tr-card-dest' }));
  }

  /** Where a job train is heading, for its card. */
  destText(t: Train): string {
    if (t.job === 'free') return '';
    if (!this.sim.useEconomy) return 'Places need nothing';
    if (!t.destination) return 'Nothing to do';
    const site = this.sim.economy.site(t.destination);
    return site ? `→ ${site.place.name}` : '';
  }

  /** "Go to…": send the train to a station or a place beside the track. */
  private destinationPicker(t: Train): HTMLElement | string {
    const places = this.sim.destinations();
    if (t.wrecked || !t.vehicles.some((v) => v.def.motor) || !places.length) return '';
    const current = t.dispatch?.dest.kind === 'place' ? t.dispatch.dest.uid : '';
    const select = el(
      'select',
      {
        class: 'tr-dest',
        title: 'Send this train somewhere: it finds the way and sets the switches',
        onchange: () => {
          if (!select.value) {
            this.sim.clearRoute(t.id);
            return;
          }
          const error = this.sim.routeTo(t.id, { kind: 'place', uid: select.value });
          if (error) {
            this.say(error);
            select.value = current;
            return;
          }
          this.autorouteBox.checked = true;
          this.setPaused(false);
        },
      },
      el('option', { value: '', textContent: t.dispatch ? 'Stop going there' : 'Go to…' }),
      ...places.map((p) => el('option', { value: p.uid, textContent: p.name })),
    );
    select.value = current;
    return el('div', { class: 'tr-card-row' }, select);
  }

  /** Stores and cargo, for the card: "Water 60% · Coal 80% · 5 passengers". */
  loadText(t: Train): string {
    const parts: string[] = [];
    const stores = new Map<string, number>();
    t.consist.forEach((entry) => {
      const def = getStock(entry.stockId);
      if (!this.sim.useSupplies) return;
      for (const s of def.supplies ?? []) {
        // A tender's coal and the engine's own show as one.
        const level = supplyLevel(entry, s);
        stores.set(s, Math.max(stores.get(s) ?? 0, level));
      }
    });
    const NAMES = { water: 'Water', coal: 'Coal', charge: 'Battery' } as Record<string, string>;
    for (const [s, level] of stores) parts.push(`${NAMES[s]} ${Math.round(level * 100)}%`);
    const cargo = new Map<CargoKind, number>();
    for (const entry of t.consist) {
      const kind = getStock(entry.stockId).cargo?.kind;
      if (kind) cargo.set(kind, (cargo.get(kind) ?? 0) + (entry.units ?? 0));
    }
    if (t.job === 'workers' && cargo.has('passengers')) {
      // Workers rather than passengers.
      const fresh = freshAboard(t.consist);
      const tired = tiredAboard(t.consist);
      cargo.set('passengers', cargo.get('passengers')! - fresh - tired);
      if (fresh) parts.push(`${fresh} going to work`);
      if (tired) parts.push(`${tired} tired, going home`);
    }
    const carried = [...cargo].filter(([, n]) => n);
    if (carried.length) for (const [kind, n] of carried) parts.push(cargoCount(kind, n));
    else if (cargo.size && parts.every((p) => !/going/.test(p))) parts.push('Cars empty');
    return parts.join(' · ');
  }

  /** Bubbles over engines passing signs, and the tally of deliveries. */
  private drawPlaces(time: number): void {
    const rect = this.viewSize;
    const screen = (at: THREE.Vector3): string | null => {
      const p = at.clone().project(this.camera);
      if (p.z >= 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return null;
      return `translate(${((p.x + 1) / 2) * rect.width}px, ${((1 - p.y) / 2) * rect.height}px) translate(-50%, -100%)`;
    };
    // Signs passed since last time.
    for (const e of this.sim.events) {
      if (e.time <= this.eventsSeen) continue;
      const bubble = el('div', { class: `tr-bubble ${e.kind}`, textContent: e.kind === 'whistle' ? 'Toot toot!' : 'Slow' });
      this.hud.append(bubble);
      const train = this.sim.train(e.trainId);
      if (train && e.kind === 'whistle') this.sounds.whistle(train, undefined, true);
      const engine = train?.vehicles.find((v) => v.def.motor) ?? train?.vehicles[0];
      const at = engine ? toWorld(engine.geo.center.x, engine.geo.center.y, engine.geo.z + engine.def.height + 30) : toWorld(e.at.x, e.at.y, e.z + 90);
      this.bubbles.push({ el: bubble, at, until: time + BUBBLE_MS });
    }
    if (this.sim.events.length) this.eventsSeen = this.sim.events[this.sim.events.length - 1].time;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      const transform = time < b.until ? screen(b.at) : null;
      if (time >= b.until) {
        b.el.remove();
        this.bubbles.splice(i, 1);
        continue;
      }
      b.el.hidden = !transform;
      if (transform) b.el.style.transform = transform;
    }
    // What's been delivered so far.
    const delivered = Object.entries(this.sim.delivered).filter(([, n]) => n) as [CargoKind, number][];
    const text = delivered.length ? `Delivered: ${delivered.map(([k, n]) => cargoCount(k, n)).join(', ')}.` : '';
    if (this.deliveries.textContent !== text) this.deliveries.textContent = text;
    this.deliveries.hidden = !text;
  }

  private whistleButton(t: Train): HTMLButtonElement {
    const b = el('button', { type: 'button', class: 'whistle', title: 'Blow the whistle', onclick: () => this.sounds.whistle(t, undefined, true) });
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';
    return b;
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
    else if (this.ride?.trainId === t.id) this.ride.trainId = again.id;
  }

  // ---- riding along -------------------------------------------------------

  /** True while the view rides on a train; the orbit view waits until it gets off. */
  get riding(): boolean {
    return this.ride !== null;
  }

  private toggleRide(): void {
    if (this.ride) this.leaveCab();
    else {
      // The one that's going, else the first.
      const t = this.sim.trains.find((x) => x.throttle && !x.wrecked) ?? this.sim.trains[0];
      if (t) this.enterCab(t.id);
      else this.say('Put an engine on the track to ride along.');
    }
  }

  private enterCab(trainId: number): void {
    const t = this.sim.train(trainId);
    if (!t) return;
    const saved = this.ride?.saved ?? { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov, near: this.camera.near };
    const way = travelWay(t, 1);
    const pose = cabPose(t, way);
    this.ride = { trainId, way, heading: pose.heading, pitch: pose.pitch, lookYaw: 0, lookPitch: 0, look: null, saved };
    this.controls.enabled = false;
    this.camera.fov = CAB_FOV;
    this.camera.near = CAB_NEAR;
    this.camera.updateProjectionMatrix();
    document.body.classList.add('riding');
    this.placeCab(0);
  }

  private leaveCab(): void {
    const ride = this.ride;
    if (!ride) return;
    this.ride = null;
    this.camera.position.copy(ride.saved.position);
    this.controls.target.copy(ride.saved.target);
    this.camera.fov = ride.saved.fov;
    this.camera.near = ride.saved.near;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(ride.saved.target);
    this.controls.enabled = true;
    document.body.classList.remove('riding');
  }

  /** Put the eye on the ridden train, swinging round smoothly with it. */
  private placeCab(dt: number): void {
    const ride = this.ride!;
    const t = this.sim.train(ride.trainId);
    if (!t) {
      this.leaveCab();
      return;
    }
    // Facing the other way when it reverses: turn round at once rather than swing through the side.
    const way = travelWay(t, ride.way);
    const pose = cabPose(t, way);
    if (way !== ride.way || dt === 0) {
      ride.way = way;
      ride.heading = pose.heading;
      ride.pitch = pose.pitch;
    } else {
      const k = 1 - Math.exp(-dt * FOLLOW_RATE);
      ride.heading += Math.atan2(Math.sin(pose.heading - ride.heading), Math.cos(pose.heading - ride.heading)) * k;
      ride.pitch += (pose.pitch - ride.pitch) * k;
    }
    if (!ride.look && dt > 0) {
      const back = Math.exp(-dt * LOOK_RETURN_RATE);
      ride.lookYaw *= back;
      ride.lookPitch *= back;
    }
    const yaw = ride.heading + ride.lookYaw;
    const pitch = ride.pitch + ride.lookPitch + CAB_TILT;
    const eye = toWorld(pose.x, pose.y, pose.z);
    // Plan (x, y) is world (x, -z).
    const dir = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.add(dir));
    this.controls.enabled = false;
  }

  /** Keep a card floating over each train, and its buttons current. */
  /**
   * The open train's controls: in its row in the sidebar's list, or, riding
   * along, pinned to the foot of the view. No cards float over trains.
   */
  private drawCards(): void {
    const seen = new Set<number>();
    if (this.selected !== null && !this.sim.train(this.selected)) this.selected = null;
    const shown = this.ride ? this.ride.trainId : this.selected;
    for (const t of this.sim.trains) {
      if (t.id !== shown) continue;
      const riding = this.ride?.trainId === t.id;
      const home = riding ? this.hud : this.list.slot(t.id);
      if (!home) continue;
      seen.add(t.id);
      const dest = t.dispatch?.dest.kind === 'place' ? t.dispatch.dest.uid : '';
      const key = `${t.throttle}/${t.wrecked}/${t.name}/${t.vehicles.some((v) => v.def.motor)}/${riding}/${dest}/${this.sim.destinations().length}/${t.job}`;
      let entry = this.cards.get(t.id);
      if (!entry || entry.key !== key || entry.card.parentElement !== home) {
        const card = this.makeCard(t);
        entry?.card.remove();
        home.append(card);
        entry = { card, key };
        this.cards.set(t.id, entry);
      }
      const { card } = entry;
      card.classList.toggle('pinned', riding);
      card.classList.toggle('in-list', !riding);
      card.classList.toggle('stuck', t.status.kind === 'stuck');
      const load = card.querySelector<HTMLElement>('.tr-card-load')!;
      const loadText = this.loadText(t);
      if (load.textContent !== loadText) load.textContent = loadText;
      load.hidden = !loadText;
      // What's being done where it's stopped, and how far along.
      const work = card.querySelector<HTMLElement>('.tr-card-work')!;
      const doing = t.stop?.phase === 'dwell' ? t.stop.work : t.hold?.until != null ? t.hold.work : undefined;
      work.hidden = !doing;
      if (doing) {
        const span = work.querySelector('span')!;
        if (span.textContent !== doing.summary) span.textContent = doing.summary;
        work.querySelector<HTMLElement>('i i')!.style.width = `${doing.total ? Math.round((100 * doing.done) / doing.total) : 100}%`;
      }
      const heading = card.querySelector<HTMLElement>('.tr-card-dest');
      if (heading) {
        const text = this.destText(t);
        if (heading.textContent !== text) heading.textContent = text;
      }
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
  private hit(e: PointerEvent): { lever: string } | { accessory: string; at: Vec2 } | { trainId: number; index: number } | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.root.updateMatrixWorld();
    if (this.leversRoot.visible) {
      const accessory = this.accessories.hit(this.raycaster);
      // A vehicle standing on a turntable is nearer than the pit under it.
      const vehicle = accessory && this.raycaster.intersectObject(this.vehiclesRoot, true)[0];
      if (accessory && !(vehicle && vehicle.distance < accessory.distance)) return { accessory: accessory.uid, at: { x: accessory.point.x, y: -accessory.point.z } };
    }
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
    if (this.ride) {
      // Riding along, the view is the train's: a drag looks around, and switches can still be thrown.
      this.swallow(e);
      if (hit && 'lever' in hit) {
        this.sim.toggleLever(hit.lever);
        this.drawLevers();
      } else this.ride.look = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.ride.lookYaw, pitch: this.ride.lookPitch };
      return;
    }
    if (!hit) return;
    this.swallow(e);
    if ('lever' in hit) {
      this.sim.toggleLever(hit.lever);
      this.drawLevers();
      return;
    }
    if ('accessory' in hit && this.sim.tables.has(hit.accessory)) {
      // Tap an end to turn the bridge to it, or by the pivot for the next line; or drag it round.
      const error = this.sim.turnTurntable(hit.accessory, hit.at);
      if (error) this.say(error);
      this.turning = { pointerId: e.pointerId, uid: hit.accessory };
      return;
    }
    if ('accessory' in hit) {
      const error = this.sim.toggleAccessory(hit.accessory);
      if (error) this.say(error);
      return;
    }
    this.press = { pointerId: e.pointerId, ...hit, x: e.clientX, y: e.clientY };
  }

  private pointerMove(e: PointerEvent): void {
    const look = this.ride?.look;
    if (look && e.pointerId === look.pointerId) {
      this.ride!.lookYaw = look.yaw + (e.clientX - look.x) * LOOK_PER_PX;
      this.ride!.lookPitch = THREE.MathUtils.clamp(look.pitch + (e.clientY - look.y) * LOOK_PER_PX, -1.2, 1.2);
      return;
    }
    if (this.turning?.pointerId === e.pointerId) {
      const at = this.planAt(e);
      if (at) this.sim.turnTurntable(this.turning.uid, at, false);
      return;
    }
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
    if (this.turning?.pointerId === e.pointerId) {
      this.turning = null;
      return;
    }
    if (this.ride?.look?.pointerId === e.pointerId) {
      this.ride.look = null;
      return;
    }
    const press = this.press;
    if (press && e.pointerId === press.pointerId) {
      this.press = null;
      // Building trains (the panel open), a tap turns a car round; otherwise it opens the train in the sidebar.
      if (this.open) {
        const error = this.sim.turnVehicle(press.trainId, press.index);
        if (error) this.say(error);
      } else {
        this.select(press.trainId);
      }
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
    if (this.turning?.pointerId === e.pointerId) this.turning = null;
    if (this.ride?.look?.pointerId === e.pointerId) this.ride.look = null;
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

  /** The point on the track top under the pointer, in plan. */
  private planAt(e: PointerEvent): Vec2 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const point = this.raycaster.ray.intersectPlane(this.trackTop, new THREE.Vector3());
    return point && { x: point.x, y: -point.z };
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
    // Pointing at raised track, prefer that level over the floor under it.
    const track = this.sim.nearestTrack(at, 45, hit ? point.y - D.TRACK_HEIGHT : undefined);
    if (track) {
      const pose = poseAt(track.edge.path, track.s);
      const geo = { center: pose, heading: pose.angle, z: edgeHeight(track.edge, track.s), pitch: Math.atan(edgeGrade(track.edge, track.s)) };
      return { kind: 'track', edgeKey: track.edge.key, s: track.s, geo };
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
    ghost.position.copy(toWorld(target.geo.center.x, target.geo.center.y, target.geo.z));
    ghost.rotation.set(0, target.geo.heading, 0);
    ghost.rotateZ(target.geo.pitch);
  }

  // ---- every frame ---------------------------------------------------------

  /** Open a train's controls in the sidebar and go to it, or close them. */
  select(id: number | null): void {
    this.selected = id;
    if (id === null) return;
    this.goTo(id);
    this.onShowList?.();
    this.list.update();
    this.list.reveal(id);
  }

  /** Fly the view to a train and follow it as it runs. */
  goTo(id: number): void {
    const at = this.centreOf(id);
    if (!at) return;
    this.following = id;
    this.onFocus?.(at);
  }

  /** Where the followed train is now, or null when there's none to follow. */
  followPoint(): THREE.Vector3 | null {
    if (this.following === null) return null;
    const train = this.sim.train(this.following);
    const at = this.centreOf(this.following);
    if (!train || !at || this.ride) {
      this.following = null;
      return null;
    }
    return toWorld(at.x, at.y, Math.min(...train.vehicles.map((v) => v.geo.z)));
  }

  private centreOf(id: number): Vec2 | null {
    const train = this.sim.train(id);
    if (!train?.vehicles.length) return null;
    const xs = train.vehicles.map((v) => v.geo.center.x);
    const ys = train.vehicles.map((v) => v.geo.center.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  /** A soft glow round each car of the train hovered in the list. */
  private drawHalo(time: number): void {
    this.haloRoot.clear();
    const train = this.highlighted === null ? undefined : this.sim.train(this.highlighted);
    if (!train) return;
    HALO_MATERIAL.opacity = 0.32 + 0.14 * Math.sin(time / 180);
    for (const v of train.vehicles) {
      const halo = new THREE.Mesh(HALO_GEOMETRY, HALO_MATERIAL);
      halo.scale.set(v.def.length + 14, v.def.height + AXLE_HEIGHT + 14, v.def.width + 14);
      halo.position.copy(toWorld(v.geo.center.x, v.geo.center.y, v.geo.z + (v.def.height + AXLE_HEIGHT) / 2 - 4));
      halo.rotation.set(0, v.geo.heading, 0);
      halo.rotateZ(v.geo.pitch);
      this.haloRoot.add(halo);
    }
  }

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
    if (this.sim.leverVersion !== this.leverVersion) this.drawLevers();
    if (this.autorouteBox.checked !== this.sim.autoroute) this.autorouteBox.checked = this.sim.autoroute;
    this.sounds.update(this.sim, !this.paused);
    this.drawTrains(time);
    this.drawHalo(time);
    // Only while the sidebar shows it.
    if (this.list.el.offsetParent) this.list.update();
    if (this.ride) this.placeCab(dt);
    this.drawCards();
    this.drawPlaces(time);
    this.updateLeverVisibility();
    this.accessories.update(this.layout, time, this.leversRoot.visible);
    this.economyView.update(time, !this.ride && (this.open || this.sim.trains.length > 0));
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
        showLoad(mesh, v.def, train.consist[i]);
        const { center, heading } = v.geo;
        mesh.position.copy(toWorld(center.x, center.y, v.geo.z));
        mesh.rotation.set(0, heading, 0);
        // Nose up a ramp: the model's own front is +x.
        mesh.rotateZ(v.geo.pitch);
        if (v.derailed) {
          // Off the rails: dropped and tipped over a little.
          mesh.position.y = v.geo.z - AXLE_HEIGHT * 0.5;
          mesh.rotateX(0.35);
          mesh.rotateZ(-0.15);
        }
      });
      if (train.status.kind === 'stuck') this.markersRoot.add(this.stuckMarker(train.status.at, this.heightNear(train.status.at), time));
      if (train.dispatch && train.dispatch.state !== 'arrived') {
        const dest = train.dispatch.dest;
        const at = dest.kind === 'place' ? this.sim.destinations().find((p) => p.uid === dest.uid)?.at : undefined;
        if (at) this.markersRoot.add(this.destinationPin(at, this.heightNear(at), time));
      }
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
        ring.position.copy(toWorld(face.x, face.y, v.geo.z + AXLE_HEIGHT + 2));
        ring.rotation.y = v.geo.heading + Math.PI / 2;
        ring.scale.setScalar(1 + 0.12 * Math.sin(time / 150));
        this.markersRoot.add(ring);
      }
    }
  }

  private readonly heights = new Map<string, number>();

  /** Height of the track nearest a spot, remembered per spot since stuck markers redraw every frame. */
  private heightNear(at: Vec2): number {
    const key = `${at.x.toFixed(1)},${at.y.toFixed(1)}`;
    let z = this.heights.get(key);
    if (z === undefined) {
      const track = this.sim.nearestTrack(at, 60);
      z = track ? edgeHeight(track.edge, track.s) : 0;
      if (this.heights.size > 50) this.heights.clear();
      this.heights.set(key, z);
    }
    return z;
  }

  private stuckMarker(at: Vec2, z: number, time: number): THREE.Object3D {
    const ring = new THREE.Mesh(stuckGeometry, stuckMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(toWorld(at.x, at.y, z + D.TRACK_HEIGHT + 30));
    ring.scale.setScalar(1 + 0.15 * Math.sin(time / 180));
    return ring;
  }

  /** A pin bobbing over where a train is headed. */
  private destinationPin(at: Vec2, z: number, time: number): THREE.Object3D {
    const pin = new THREE.Mesh(pinGeometry, pinMaterial);
    pin.position.copy(toWorld(at.x, at.y, z + D.TRACK_HEIGHT + 140 + 6 * Math.sin(time / 220)));
    return pin;
  }

  /** A yellow knob over each switch, and a yellow stripe down the way it is set. */
  private drawLevers(): void {
    this.leverVersion = this.sim.leverVersion;
    this.leversRoot.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry instanceof THREE.TubeGeometry) o.geometry.dispose();
    });
    this.leversRoot.clear();
    for (const sw of this.sim.network.switches()) {
      const { edge, end } = sw.choices[(this.sim.levers.get(sw.key) ?? 0) % sw.choices.length];
      // Measured from the switch point, whichever end of the path that is.
      const from = (d: number) => (end === 0 ? d : edge.length - d);
      const points: THREE.Vector3[] = [];
      for (let d = 8; d <= Math.min(STRIPE_MM, edge.length); d += 4) {
        const p = poseAt(edge.path, from(d));
        points.push(toWorld(p.x, p.y, edgeHeight(edge, from(d)) + D.TRACK_HEIGHT + 0.6));
      }
      if (points.length > 1) {
        const stripe = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length * 2, 2.2, 6), leverMaterial);
        stripe.userData.uid = sw.key;
        this.leversRoot.add(stripe);
      }
      const reach = from(Math.min(LEVER_REACH, edge.length));
      const p = poseAt(edge.path, reach);
      const z = edgeHeight(edge, reach);
      const knob = new THREE.Mesh(knobGeometry, leverMaterial);
      knob.position.copy(toWorld(p.x, p.y, z + D.TRACK_HEIGHT + 22));
      knob.userData.uid = sw.key;
      const stem = new THREE.Mesh(stemGeometry, leverStem);
      stem.position.copy(toWorld(p.x, p.y, z + D.TRACK_HEIGHT + 11));
      stem.userData.uid = sw.key;
      this.leversRoot.add(knob, stem);
    }
  }
}
