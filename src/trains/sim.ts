import { distance, normalizeAngle, type Vec2 } from '../geometry/pose';
import type { Layout } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { getPiece } from '../pieces/catalog';
import { poseAt } from '../geometry/path';
import { edgeHeight, TrackNetwork, type Edge } from './network';
import { Route, type Chooser } from './route';
import { baseOf } from '../layout/layout';
import { attracts, CRATE_KG, getStock, supplyLevel, WHEEL_RADIUS, type CargoKind, type ConsistEntry, type StockDef, type Supply } from './stock';
import { doWork, getPlace, planWork, workSeconds, workSpan, type PlaceDef, type Visit, type Work } from './stops';
import { Economy, type Site } from './economy';
import { freshAboard, jobConsist, nextStop, type JobId } from './jobs';
import { Operator } from './operator';
import { ACCESSORY, findAccessories, onRoute, type Accessory, type AccessoryKind, type Job } from './accessories';
import { Dispatcher, type Arrival, type Destination, type DestinationPoint, type Dispatch, type RouteOptions } from './dispatch';
import { findTurntables, headingToward, lineAt, lineToward, turn, turnPoint, TURNTABLE, type Turntable, type TurntableState } from './turntable';

// A small, purpose-built simulation of wooden trains. The grooves keep every
// axle on the track centreline, so each vehicle only moves along the track:
// one position and one speed. What stops a train comes from the geometry:
// a long rigid wheelbase scrubs its flanges round a tight curve, a coupling
// pulling across a bend presses the wheels into the groove, a wheel has to
// climb out of a gap or over a step at a rough joint, a ramp pulls it back
// downhill, and a magnet only holds so hard. Forces in newtons, distances in mm, speeds in mm/s.

/** Tunable estimates, not measurements. */
export const PHYSICS = {
  gravity: 9.81,
  /** Wooden axles turning in wooden bodies, wheels on wood. */
  rollingResistance: 0.04,
  /** Wheel flange rubbing the groove wall. */
  flangeFriction: 0.3,
  /** Extra drag from the motor's gears when an engine is switched off. */
  gearDragN: 0.15,
  /** Pull a pair of magnets holds before letting go. */
  magnetHoldN: 0.9,
  /** Magnets snap together from this close. */
  magnetReachMm: 4,
  /**
   * Magnet faces slid this far across each other (overhangs swinging out on a
   * bend) peel apart. A big steam engine's tender swings about 19 mm across
   * through a parallel switch's S-bend, which real trains run happily.
   */
  magnetSlideMm: 24,
  /** Same poles push apart up to this far. */
  repelReachMm: 8,
  repelForceN: 0.25,
  /** Springiness of a coupled pair being stretched, N per mm. */
  couplingStiffness: 0.25,
  couplingDamping: 0.003,
  /** Vehicles pressed together, N per mm. */
  contactStiffness: 2,
  contactDamping: 0.006,
  /** A wheel this far off line where two pieces meet drops out of the groove. */
  derailLateralMm: 2.5,
  derailAngleDeg: 8,
  /** Lateral and angular mismatch at a joint act like a step this many mm high per mm / per degree. */
  stepPerLateralMm: 0.15,
  stepPerDeg: 0.04,
  /** How far before a buffer stop's dead end its block stops the wheels. */
  bufferBlockMm: 10,
  /** Below this speed with the motor on, a train counts as not moving. */
  stallSpeed: 1,
  stallSeconds: 1.2,
  /** Simulation step, seconds. */
  dt: 0.0005,
};

/**
 * Outside Basic mode magnets are forgiving: they hold this many times as
 * hard and let faces slide this many times as far before peeling apart.
 * Basic mode uses PHYSICS as it stands, the closest we have to the real thing.
 */
export const EASY_MAGNETS = { hold: 2, slide: 1.5 };

/** How far an engine runs on full stores, mm under power. Tunable, chosen so a lap or few of a play-table layout uses a good part of them. */
export const SUPPLIES = {
  waterMm: 15000,
  coalMm: 12000,
  /** A tender carries far more coal than the engine's own bunker. */
  tenderCoalMm: 40000,
  chargeMm: 40000,
  /** A water tank car tops the boiler up by this much a load, once it falls below `topUpBelow`. */
  tankTopUp: 0.3,
  topUpBelow: 0.7,
  /** Warn once a store falls below this. */
  low: 0.2,
};

/** How trains stop at places beside the track. */
export const STOPPING = {
  /** Looks this far ahead for a place to stop at, mm. */
  lookAhead: 130,
  /** Braking, mm/s². */
  brake: 400,
  /** Creeps the last bit at this speed. */
  creep: 15,
  /** A slow board holds trains to this share of their speed. */
  slowFactor: 0.4,
  /** For this far past the board, beyond the train's own length. */
  slowMm: 250,
};

/** How often job trains look again at where to go, seconds. */
const JOB_SECONDS = 0.5;

const AXLE_HEIGHT_MM = D.TRACK_HEIGHT - D.GROOVE_DEPTH + WHEEL_RADIUS;

export interface Vehicle {
  def: StockDef;
  entry: ConsistEntry;
  /** +1 when the vehicle's own front points along the route. */
  facing: 1 | -1;
  /** Midway between the axles, along the route. */
  u: number;
  /** Speed along the route. */
  v: number;
  derailed: boolean;
  /** Filled in every step. */
  geo: VehicleGeometry;
  drag: Drag;
  /** The motor's grip was the limit this step. */
  slipping: boolean;
  motorForce: number;
  /** An engine whose store has run dry: it can't drive. */
  empty: Supply | null;
}

export interface VehicleGeometry {
  center: Vec2;
  heading: number;
  /** Height of the track under the middle of the vehicle, above the floor. */
  z: number;
  /** Nose up (positive) or down, radians, on a ramp. */
  pitch: number;
  frontAxle: Vec2;
  rearAxle: Vec2;
  /** Magnet faces at the route-forward and route-back ends. */
  aheadFace: Vec2;
  behindFace: Vec2;
  /** Wheel-to-track misalignment at each axle, radians. */
  yaw: [number, number];
}

export interface Drag {
  rolling: number;
  curve: number;
  joint: number;
  /** The joint crossing that pushed back hardest, if any. */
  jointAt: number | null;
  buffer: number;
  /** Gravity's pull along the route on a ramp, positive pulling route-forward. */
  slope: number;
  /** Braking for a signal, a station or another accessory. */
  brake: number;
}

export interface Coupling {
  /** The poles face N to S. */
  attract: boolean;
  coupled: boolean;
  /** Pull through the coupling, positive when stretched; negative is a push. */
  force: number;
}

export type StuckKind = 'ran-off' | 'buffer' | 'stalled' | 'slipping' | 'fighting' | 'crashed' | 'derailed' | 'tipped' | 'no-water' | 'no-coal' | 'flat-battery';

export interface Stuck {
  kind: 'stuck';
  stuck: StuckKind;
  message: string;
  at: Vec2;
}

export type TrainStatus = { kind: 'stopped' } | { kind: 'running'; speed: number } | { kind: 'waiting'; message: string } | Stuck;

/** An accessory a train is braking or waiting for. */
export interface Hold {
  uid: string;
  kind: AccessoryKind;
  reason: string;
  /** The wagon being loaded or unloaded, or -1. */
  vehicle: number;
  /** Arrived and waiting until this time, for a station, the loader or a crane. */
  until: number | null;
  /** Passengers getting off and on at a station. */
  work?: Work;
}

/** The next accessory a train has to stop for, and how far it has left to go. */
interface Stop {
  acc: Accessory;
  d: number;
  vehicle: number;
}

const REASONS: Record<AccessoryKind, string> = {
  signal: 'Waiting at the red signal',
  bridge: 'Waiting for the bridge',
  station: 'Stopped at the station',
  loader: 'Loading',
  crane: 'Unloading',
  turntable: 'Waiting for the turntable',
};

const DWELL: Partial<Record<AccessoryKind, number>> = {
  station: ACCESSORY.stationSeconds,
  loader: ACCESSORY.loaderSeconds,
  crane: ACCESSORY.craneSeconds,
};

export interface Placement {
  edgeKey: string;
  /** Distance along the edge's path of the train's middle. */
  s: number;
  /** The train's front points toward the path's start. */
  reversed: boolean;
}

/** A place beside the track that trains stop at or act on, found on the track. */
export interface PlacePoint {
  uid: string;
  place: PlaceDef;
  edgeKey: string;
  /** Along the edge's path. */
  s: number;
  at: Vec2;
  z: number;
}

export interface StopState {
  uid: string;
  place: PlaceDef;
  /** Where along the train's route the place is. */
  u: number;
  /** Which way along the route the train is going. */
  dir: 1 | -1;
  phase: 'approach' | 'dwell';
  work: Work;
  /** The vehicles lined up with the place, first and last. */
  span: [number, number];
}

/** Something that happens as a train passes a sign, for the view to show. */
export interface PassEvent {
  trainId: number;
  kind: 'whistle' | 'slow';
  at: Vec2;
  z: number;
  time: number;
}

export interface Notice {
  trainId: number;
  message: string;
  at: Vec2;
  time: number;
}

export interface Train {
  id: number;
  name: string;
  consist: ConsistEntry[];
  placement: Placement;
  route: Route;
  /** Front of the train (furthest along the route) first. */
  vehicles: Vehicle[];
  /** Between vehicle i and i + 1. */
  couplings: Coupling[];
  /** Engine switch: forward, off, reverse (each engine relative to its own front). */
  throttle: 1 | 0 | -1;
  status: TrainStatus;
  /** Derailed or crashed: holds still until reset. */
  wrecked: boolean;
  stillFor: number;
  hold: Hold | null;
  /** Stations it has already stopped at and not yet left behind. */
  served: Set<string>;
  /** Stopping at, or stopped at, a place beside the track. */
  stop: StopState | null;
  /** How far it has run, mm, to tell when it has passed somewhere. */
  odometer: number;
  /** Places it has just been to, by uid, left alone until the odometer reaches the value. */
  ignore: Map<string, number>;
  /** Held to a slow speed until the odometer reaches this. */
  slowUntil: number;
  /** What it's for: a job train picks its own stops and sets the levers to get there. */
  job: JobId;
  /** The place it's heading for, by uid. */
  destination: string | null;
  /** The last place it worked at. */
  lastStop: string | null;
  /** Where autoroute is taking it, if anywhere. */
  dispatch: Dispatch | null;
  /** What autoroute is holding it back for, if anything: "Waiting for Train 2". */
  waitReason: string | null;
  /** A job train backing away from a climb it couldn't make or a train it was stuck behind. */
  backingOff: boolean;
}

const ZERO_DRAG = (): Drag => ({ rolling: 0, curve: 0, joint: 0, jointAt: null, buffer: 0, slope: 0, brake: 0 });

/** A vehicle's weight with whatever it carries, kg. */
const massOf = (v: Vehicle) => v.def.massKg + (v.entry.load ? CRATE_KG : 0);

/** Which way along its route a train's engines drive it: +1, -1, or 0 when off or fighting. */
function travelDir(train: Train): number {
  if (!train.throttle) return 0;
  return Math.sign(train.vehicles.reduce((sum, v) => sum + (v.def.motor ? train.throttle * v.facing : 0), 0));
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
/** A vehicle's heading along the route, whichever way round it is. */
const routeHeading = (v: Vehicle) => v.geo.heading + (v.facing === 1 ? 0 : Math.PI);

/** Horizontal push a wheel needs to climb a step `h` high. */
function climbForce(weight: number, h: number): { force: number; reach: number } {
  const r = WHEEL_RADIUS;
  if (h <= 0) return { force: 0, reach: 0 };
  const hh = Math.min(h, r * 0.95);
  const reach = Math.sqrt(2 * r * hh - hh * hh);
  return { force: (weight * reach) / (r - hh), reach };
}

/** How deep a wheel drops into a gap `gap` mm wide. */
function gapDrop(gap: number): number {
  const half = Math.min(gap / 2, WHEEL_RADIUS);
  return WHEEL_RADIUS - Math.sqrt(WHEEL_RADIUS * WHEEL_RADIUS - half * half);
}

export function pieceName(network: TrackNetwork, uid: string): string {
  const piece = network.piece(uid);
  return piece ? getPiece(piece.pieceId).name.replace(/,.*$/, '') : 'track';
}

export class TrainSim {
  network: TrackNetwork;
  readonly trains: Train[] = [];
  /** Which way each switch lever points, by switch point (`uid:connectorId`). */
  readonly levers = new Map<string, number>();
  readonly notices: Notice[] = [];
  /** Signs passed, newest last, for the view. */
  readonly events: PassEvent[] = [];
  /** Places beside the track, found afresh whenever the layout changes. */
  places: PlacePoint[] = [];
  /** Engines use up water, coal and charge as they run. */
  useSupplies = true;
  /** Units unloaded at places so far, by cargo. */
  readonly delivered: Partial<Record<CargoKind, number>> = {};
  /** Stock and staff at every place. Off, places have everything and need nobody. */
  readonly economy = new Economy();
  useEconomy = true;
  private jobClock = 0;
  time = 0;
  /** Accessories with track to work on, found afresh whenever the layout changes. */
  accessories: Accessory[] = [];
  /** Signals set to red, by uid. Signals start green. */
  readonly redSignals = new Set<string>();
  /** Lifting bridges: whether each is set to go up, and how far up it is (0 to 1). */
  readonly bridges = new Map<string, { up: boolean; lift: number }>();
  /** Turntables in the layout, found afresh whenever the layout changes, and how each bridge stands. */
  turntables: Turntable[] = [];
  readonly tables = new Map<string, TurntableState>();
  /** Crates each crane has stacked beside it. */
  readonly piles = new Map<string, number>();
  /** Loading and unloading in progress, by accessory uid. */
  readonly jobs = new Map<string, Job>();
  private nextId = 1;
  private seed = 20261014;
  private readonly deliver = (kind: CargoKind, n: number) => (this.delivered[kind] = (this.delivered[kind] ?? 0) + n);
  /** Repeatable random numbers, so runs and tests come out the same. */
  private readonly rand = () => ((this.seed = (this.seed * 16807) % 2147483647) / 2147483647);
  private readonly choose: Chooser = (key, count) => (this.levers.get(key) ?? 0) % count;
  /** Trains set the switches ahead of them and wait for each other rather than collide. */
  autoroute = false;
  /** Magnets as strong as real ones (Basic mode); off, they're EASY_MAGNETS. */
  realMagnets = true;
  /** Coupled vehicles never come apart on their own, so long and job trains stay whole. */
  keepCoupled = false;
  /** Counts lever changes, so the view knows to redraw them. */
  leverVersion = 0;
  readonly dispatcher: Dispatcher;
  /** Runs the jobs by itself when switched on: adds trains where they're needed and gets stuck ones going. */
  readonly operator: Operator;
  /**
   * Climbs job trains have stalled on, by heading (`edgeKey>end`), with how
   * much pull per newton of weight the train that stalled had. Trains no
   * stronger than that go round another way.
   */
  readonly steep = new Map<string, number>();

  constructor(layout: Layout) {
    this.network = new TrackNetwork(layout);
    this.findAccessories();
    this.dispatcher = new Dispatcher(this);
    this.operator = new Operator(this);
  }

  /** Most pull a train's engines can give, per newton of its weight. */
  climbRatio(train: Train): number {
    const weight = train.vehicles.reduce((s, v) => s + massOf(v) * PHYSICS.gravity, 0);
    const pull = train.vehicles.reduce((s, v) => s + (v.def.motor ? Math.min(v.def.motor.stallForceN, v.def.motor.grip * massOf(v) * PHYSICS.gravity) : 0), 0);
    return weight ? pull / weight : 0;
  }

  /** Whether a job train should keep off a heading because a train like it stalled climbing there. */
  tooSteep(train: Train, heading: string): boolean {
    if (train.job === 'free') return false;
    const ratio = this.steep.get(heading);
    return ratio !== undefined && this.climbRatio(train) <= ratio * 1.02;
  }

  // ---- autoroute ------------------------------------------------------------

  /** Turn autoroute on or off. Off, trains forget where they were sent. */
  setAutoroute(on: boolean): void {
    this.autoroute = on;
    if (on) return;
    for (const t of this.trains) {
      t.dispatch = null;
      t.waitReason = null;
    }
    this.dispatcher.clear();
  }

  /** Everywhere a train can be sent. */
  destinations(): DestinationPoint[] {
    return this.dispatcher.destinations();
  }

  /**
   * Send a train to a place (by uid) or a spot on the track. Turns autoroute
   * on, picks the shorter way round (ahead or backing up) and starts the
   * engines. Returns an error message, or null once it is on its way.
   */
  routeTo(trainId: number, dest: Destination, opts?: RouteOptions): string | null {
    return this.dispatcher.routeTo(trainId, dest, opts);
  }

  /** Forget where a train was sent; it keeps running under autoroute. */
  clearRoute(trainId: number): void {
    this.dispatcher.clearRoute(trainId);
  }

  /** Trains that got where they were sent, newest last. */
  get arrivals(): readonly Arrival[] {
    return this.dispatcher.arrivals;
  }

  /** Point a switch's lever a given way (autoroute does this as it reserves track). */
  setLever(key: string, index: number, count: number): void {
    if ((this.levers.get(key) ?? 0) % count === index) return;
    this.levers.set(key, index);
    this.leversMoved();
  }

  private findAccessories(): void {
    this.accessories = findAccessories(this.network.layout, (key) => this.network.edge(key), (p, reach, height) => this.nearestTrack(p, reach, height));
    const uids = new Set(this.accessories.map((a) => a.uid));
    for (const map of [this.bridges, this.piles, this.jobs]) for (const uid of map.keys()) if (!uids.has(uid)) map.delete(uid);
    for (const uid of this.redSignals) if (!uids.has(uid)) this.redSignals.delete(uid);
    this.turntables = findTurntables(this.network.layout);
    for (const uid of this.tables.keys()) if (!this.turntables.some((t) => t.uid === uid)) this.tables.delete(uid);
    for (const t of this.turntables) {
      if (!this.tables.has(t.uid)) this.tables.set(t.uid, { angle: t.lines[0].angle, target: t.lines[0].angle, riders: [], from: t.lines[0].angle });
    }
    this.places = this.findPlaces();
    const station = getPlace('station')!;
    this.economy.sync([
      ...this.places,
      ...this.accessories.filter((a) => a.kind === 'station').map((a) => ({ uid: a.uid, place: station, at: a.at })),
    ]);
  }

  /** Stations, as places in the economy. */
  get stations(): Site[] {
    return this.economy.all('station');
  }

  /** What the economy has to say about `train` working at `uid`, if it's running. */
  private visit(train: Train, uid: string): Visit | undefined {
    if (!this.useEconomy) return undefined;
    const site = this.economy.site(uid);
    if (!site) return undefined;
    let wanted: number | undefined;
    if (site.place.id === 'station' && train.job === 'workers') {
      const coming = this.trains.filter((t) => t.job === 'workers').reduce((n, t) => n + freshAboard(t.consist), 0);
      wanted = Math.max(0, this.economy.openSlots() - coming);
    }
    return { economy: this.economy, site, job: train.job, wanted };
  }

  /** Every place piece that sits on the track, and where. */
  private findPlaces(): PlacePoint[] {
    const out: PlacePoint[] = [];
    for (const piece of this.network.layout.pieces) {
      const place = getPlace(piece.pieceId);
      // Trains stop at stations as accessories; see `control`.
      if (!place || place.id === 'station') continue;
      const near = this.nearestTrack(piece.pose, 12, baseOf(piece));
      if (near) out.push({ uid: piece.uid, place, edgeKey: near.edge.key, s: near.s, at: { x: piece.pose.x, y: piece.pose.y }, z: baseOf(piece) });
    }
    return out;
  }

  // ---- building trains ---------------------------------------------------

  /**
   * The track point nearest `point`, within `reach` mm in plan. Given a
   * `height`, track at that level wins over track above or below it.
   */
  nearestTrack(point: Vec2, reach = 40, height?: number): { edge: Edge; s: number } | null {
    let best: { edge: Edge; s: number; d: number } | null = null;
    for (const edge of this.network.edges) {
      const steps = Math.max(1, Math.ceil(edge.length / 4));
      for (let i = 0; i <= steps; i++) {
        const s = (edge.length * i) / steps;
        const plan = distance(poseAt(edge.path, s), point);
        if (plan >= reach) continue;
        const d = plan + (height === undefined ? 0 : Math.abs(edgeHeight(edge, s) - height));
        if (!best || d < best.d) best = { edge, s, d };
      }
    }
    return best && { edge: best.edge, s: best.s };
  }

  /** Put a train on the track with its middle at `placement`. Returns an error message if it won't fit. */
  addTrain(consist: ConsistEntry[], placement: Placement, name?: string, job?: JobId): Train | string {
    const edge = this.network.edge(placement.edgeKey);
    if (!edge) return 'That track has gone.';
    const table = this.turntables.find((t) => t.uid === edge.uid);
    if (table && !this.linedUp(table.uid, edge.index)) return 'Turn the turntable to that line first.';
    const mid = placement.reversed ? edge.length - placement.s : placement.s;
    return this.spawn(new Route(edge, placement.reversed, 0), consist, mid, { name, job });
  }

  /**
   * A standard train for a job (engine, tender and cars) put on free track,
   * by a place it works at if there's room, and set going. Returns an error message if there's nowhere.
   */
  addJobTrain(job: JobId, cars?: number, engines?: number): Train | string {
    const consist = jobConsist(job, cars, engines);
    const name = `${job[0].toUpperCase()}${job.slice(1)} train ${this.nextId}`;
    // Track by the places first, then anywhere, longest pieces first.
    const near = [...this.places.map((p) => p.edgeKey), ...this.accessories.filter((a) => a.kind === 'station').map((a) => a.edgeKey)];
    const edges = [...new Set([...near, ...[...this.network.edges].sort((a, b) => b.length - a.length).map((e) => e.key)])];
    const clear = (t: Train) =>
      this.trains.every((o) => o === t || o.vehicles.every((v) => t.vehicles.every((w) => distance(v.geo.center, w.geo.center) > (v.def.length + w.def.length) / 2 + 60)));
    // Facing the same way round as the other job trains if it can, so they never meet head on.
    const others = this.trains.filter((t) => t.job !== 'free');
    for (const sameWay of others.length ? [true, false] : [false]) {
      for (const edgeKey of edges) {
        const edge = this.network.edge(edgeKey);
        if (!edge) continue;
        for (const reversed of [false, true]) {
          const train = this.addTrain(consist, { edgeKey, s: edge.length / 2, reversed }, name, job);
          if (typeof train === 'string') continue;
          // Too close to another train, facing the wrong way, or up a siding with nowhere to go: try somewhere else.
          const stuck = !this.destinations().some((d) => this.dispatcher.distanceTo(train, d.uid, { ahead: true }) !== null);
          if (!clear(train) || stuck || (sameWay && !this.dispatcher.sameWayRound(others[0], train))) {
            this.removeTrain(train.id);
            continue;
          }
          this.setThrottle(train.id, 1);
          this.autoroute = true;
          return train;
        }
      }
    }
    return 'There’s no free track long enough for a train. Lay more track or move a train.';
  }

  setJob(id: number, job: JobId): void {
    const train = this.train(id);
    if (!train) return;
    train.job = job;
    train.destination = null;
  }

  /** A new train laid on `route` with its middle at `mid`. */
  private spawn(route: Route, consist: ConsistEntry[], mid: number, options: { name?: string; speeds?: number[]; throttle?: Train['throttle']; job?: JobId } = {}): Train | string {
    const laid = this.layOn(route, consist, mid);
    if (typeof laid === 'string') return laid;
    const id = this.nextId++;
    const train: Train = {
      id,
      name: options.name ?? `Train ${id}`,
      consist: consist.map((c) => ({ ...c })),
      ...laid,
      throttle: options.throttle ?? 0,
      status: { kind: 'stopped' },
      wrecked: false,
      stillFor: 0,
      hold: null,
      served: new Set(),
      stop: null,
      odometer: 0,
      ignore: new Map(),
      slowUntil: 0,
      job: options.job ?? 'free',
      destination: null,
      lastStop: null,
      dispatch: null,
      waitReason: null,
      backingOff: false,
    };
    options.speeds?.forEach((v, i) => (train.vehicles[i].v = v));
    this.trains.push(train);
    return train;
  }

  /** Lay `consist` on the same track again, with its middle at `mid` along the train's route. */
  private rebuild(train: Train, consist: ConsistEntry[], mid: number, speeds?: number[]): string | null {
    const laid = this.layOn(train.route.clone(), consist, mid);
    if (typeof laid === 'string') return laid;
    Object.assign(train, laid, { consist: consist.map((c) => ({ ...c })), status: { kind: 'stopped' }, wrecked: false, stillFor: 0, hold: null, stop: null });
    this.dropJobs(train.id);
    speeds?.forEach((v, i) => (train.vehicles[i].v = v));
    return null;
  }

  private lay(consist: ConsistEntry[], placement: Placement): ReturnType<TrainSim['layOn']> {
    const edge = this.network.edge(placement.edgeKey);
    if (!edge) return 'That track has gone.';
    return this.layOn(new Route(edge, placement.reversed, 0), consist, placement.reversed ? edge.length - placement.s : placement.s);
  }

  /** Lay vehicles nose to tail along `route`, the train's middle at `mid`. */
  private layOn(route: Route, consist: ConsistEntry[], mid: number): Pick<Train, 'route' | 'vehicles' | 'couplings' | 'placement'> | string {
    if (!consist.length) return 'Add an engine or a car first.';
    const defs = consist.map((c) => getStock(c.stockId));
    const length = defs.reduce((sum, d) => sum + d.length, 0);
    // Room for magnets that push apart, too.
    const room = length + PHYSICS.repelReachMm * consist.length;
    route.extend(this.network, this.choose, mid - room / 2 - 60, mid + room / 2 + 60);
    // Slide the train back on from a dead end, if it hangs over one.
    if (route.front) mid = Math.min(mid, route.front.u - room / 2 - 2);
    if (route.back) mid = Math.max(mid, route.back.u + room / 2 + 2);
    if ((route.front && mid + room / 2 > route.front.u) || (route.back && mid - room / 2 < route.back.u)) {
      return 'There is not enough track here for this train.';
    }
    const couplings: Coupling[] = consist.slice(1).map((c, i) => {
      const attract = attracts(consist[i], c);
      return { attract, coupled: attract, force: 0 };
    });
    const vehicles: Vehicle[] = [];
    let front = mid + length / 2;
    consist.forEach((entry, i) => {
      const def = defs[i];
      const vehicle: Vehicle = {
        def,
        entry,
        facing: entry.reversed ? -1 : 1,
        u: front - def.length / 2,
        v: 0,
        derailed: false,
        geo: undefined as unknown as VehicleGeometry,
        drag: ZERO_DRAG(),
        slipping: false,
        motorForce: 0,
        empty: null,
      };
      if (i > 0) {
        // Seat it against the one ahead, measuring the real gap across a bend.
        const ahead = vehicles[i - 1];
        const want = couplings[i - 1].attract ? 0 : PHYSICS.repelReachMm * 0.75;
        for (let k = 0; k < 6; k++) {
          vehicle.geo = this.geometry(route, vehicle);
          vehicle.u -= want - this.faceOffset(ahead, vehicle).along;
        }
      }
      vehicle.geo = this.geometry(route, vehicle);
      vehicles.push(vehicle);
      front = vehicle.u - def.length / 2;
    });
    for (let a = 0; a < vehicles.length; a++) {
      for (let b = a + 2; b < vehicles.length; b++) {
        if (overlaps(vehicles[a], vehicles[b])) return 'This train is longer than the loop it is on.';
      }
    }
    return { route, vehicles, couplings, placement: placementAt(route, mid) };
  }

  removeTrain(id: number): void {
    const i = this.trains.findIndex((t) => t.id === id);
    if (i >= 0) this.trains.splice(i, 1);
    this.dropJobs(id);
  }

  private dropJobs(trainId: number): void {
    for (const [uid, job] of this.jobs) if (job.trainId === trainId) this.jobs.delete(uid);
  }

  train(id: number): Train | undefined {
    return this.trains.find((t) => t.id === id);
  }

  /** Lift a train off and put it back the other way round, in the same spot. */
  turnAround(id: number): string | null {
    const train = this.train(id);
    if (!train) return null;
    const { front, back } = span(train);
    return this.replace(train, placementAt(train.route, (front + back) / 2), true);
  }

  /** Put every train back where it was last placed or built, stopped, emptied and with full stores. */
  reset(): void {
    for (const train of [...this.trains]) {
      train.consist = train.consist.map(({ stockId, reversed }) => ({ stockId, reversed }));
      train.ignore.clear();
      train.slowUntil = 0;
      train.dispatch = null;
      this.replace(train, train.placement, false);
    }
    for (const state of this.tables.values()) Object.assign(state, { angle: state.target, from: state.target, riders: [] });
    this.notices.length = 0;
    this.events.length = 0;
    for (const k of Object.keys(this.delivered)) delete this.delivered[k as CargoKind];
    for (const train of this.trains) {
      train.destination = null;
      train.lastStop = null;
    }
    this.economy.reset();
  }

  private replace(train: Train, placement: Placement, turn: boolean): string | null {
    const laid = this.lay(train.consist, turn ? { ...placement, reversed: !placement.reversed } : placement);
    if (typeof laid === 'string') return laid;
    Object.assign(train, laid, { throttle: 0, status: { kind: 'stopped' }, wrecked: false, stillFor: 0, hold: null, stop: null, dispatch: null });
    this.dropJobs(train.id);
    return null;
  }

  // ---- coupling and uncoupling by hand ------------------------------------

  /** Where a vehicle added to one end of a train would sit, for a preview. */
  attachPreview(id: number, end: 'front' | 'back', stockId: string): VehicleGeometry | null {
    const train = this.train(id);
    if (!train || train.wrecked) return null;
    const def = getStock(stockId);
    const neighbour = end === 'front' ? train.vehicles[0] : train.vehicles[train.vehicles.length - 1];
    const { front, back } = span(train);
    const u = end === 'front' ? front + def.length / 2 : back - def.length / 2;
    train.route.extend(this.network, this.choose, u - def.length, u + def.length);
    if ((train.route.front && u + def.length / 2 > train.route.front.u) || (train.route.back && u - def.length / 2 < train.route.back.u)) return null;
    const ghost = { def, facing: neighbour.facing, u } as Vehicle;
    return this.geometry(train.route, ghost);
  }

  /** Add a vehicle to one end of a train, turned to couple with its neighbour. */
  attach(id: number, end: 'front' | 'back', stockId: string): string | null {
    const train = this.train(id);
    if (!train) return 'That train has gone.';
    if (train.wrecked) return `Put ${train.name} back on the rails first.`;
    const def = getStock(stockId);
    const neighbour = end === 'front' ? train.consist[0] : train.consist[train.consist.length - 1];
    const entry: ConsistEntry = { stockId, reversed: neighbour.reversed };
    const { front, back } = span(train);
    const speeds = train.vehicles.map((v) => v.v);
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return end === 'front'
      ? this.rebuild(train, [entry, ...train.consist], (front + def.length + back) / 2, [mean, ...speeds])
      : this.rebuild(train, [...train.consist, entry], (front + back - def.length) / 2, [...speeds, mean]);
  }

  /**
   * Lift one vehicle off a train. What was in front of it and what was
   * behind it carry on as two trains. Returns the vehicle lifted off.
   */
  detach(id: number, index: number): ConsistEntry | null {
    const train = this.train(id);
    if (!train) return null;
    const entry = train.consist[index];
    const parts = [
      { from: 0, to: index },
      { from: index + 1, to: train.consist.length },
    ].filter((p) => p.to > p.from);
    const route = train.route;
    const plans = parts.map(({ from, to }) => {
      const vs = train.vehicles.slice(from, to);
      const { front, back } = span({ vehicles: vs });
      return { consist: train.consist.slice(from, to), mid: (front + back) / 2, speeds: vs.map((v) => v.v) };
    });
    this.removeTrain(id);
    plans.forEach((plan, i) => {
      if (i === 0) {
        // The first part keeps the train's name and place in the list.
        if (this.rebuild(train, plan.consist, plan.mid, plan.speeds) === null) this.trains.push(train);
      } else {
        this.spawn(route.clone(), plan.consist, plan.mid, { speeds: plan.speeds, throttle: train.throttle });
      }
    });
    return entry;
  }

  /** Turn one vehicle round where it stands, so its magnets face the other way. */
  turnVehicle(id: number, index: number): string | null {
    const train = this.train(id);
    if (!train) return null;
    const consist = train.consist.map((c, i) => (i === index ? { ...c, reversed: !c.reversed } : c));
    const { front, back } = span(train);
    return this.rebuild(train, consist, (front + back) / 2);
  }

  /**
   * Trains whose ends have run together, nose to tail on the same track,
   * become one train, as magnets snap together. (Same poles join the list
   * too, and then push apart.)
   */
  private coupleTouching(): void {
    for (const a of this.trains) {
      for (const b of this.trains) {
        if (a === b || a.wrecked || b.wrecked) continue;
        // Two job trains that bump stay two trains, each with its own job.
        if (a.job !== 'free' && b.job !== 'free') continue;
        for (const endA of ['front', 'back'] as const) {
          for (const endB of ['front', 'back'] as const) {
            const va = endA === 'front' ? a.vehicles[0] : a.vehicles[a.vehicles.length - 1];
            const vb = endB === 'front' ? b.vehicles[0] : b.vehicles[b.vehicles.length - 1];
            const faceA = endA === 'front' ? va.geo.aheadFace : va.geo.behindFace;
            const faceB = endB === 'front' ? vb.geo.aheadFace : vb.geo.behindFace;
            const outA = routeHeading(va) + (endA === 'front' ? 0 : Math.PI);
            const outB = routeHeading(vb) + (endB === 'front' ? 0 : Math.PI);
            // Facing each other within 25 degrees.
            if (Math.cos(outA - outB) > -0.9) continue;
            const dir = { x: Math.cos(outA), y: Math.sin(outA) };
            const d = sub(faceB, faceA);
            const along = dot(d, dir);
            const across = Math.abs(d.x * dir.y - d.y * dir.x);
            if (along > 1.5 || along < -25 || across > 8) continue;
            this.merge(a, endA, b, Math.cos(routeHeading(va) - routeHeading(vb)) > 0);
            return;
          }
        }
      }
    }
  }

  private merge(a: Train, endA: 'front' | 'back', b: Train, sameWay: boolean): void {
    // B in A's running order.
    const order = sameWay ? b.consist.map((c) => ({ ...c })) : [...b.consist].reverse().map((c) => ({ ...c, reversed: !c.reversed }));
    const speedsB = sameWay ? b.vehicles.map((v) => v.v) : [...b.vehicles].reverse().map((v) => -v.v);
    const lengthB = b.vehicles.reduce((s, v) => s + v.def.length, 0);
    const { front, back } = span(a);
    const speedsA = a.vehicles.map((v) => v.v);
    const throttle = a.throttle || b.throttle;
    const result =
      endA === 'front'
        ? this.rebuild(a, [...order, ...a.consist], (front + lengthB + back) / 2, [...speedsB, ...speedsA])
        : this.rebuild(a, [...a.consist, ...order], (front + back - lengthB) / 2, [...speedsA, ...speedsB]);
    if (result !== null) return;
    a.throttle = throttle;
    this.removeTrain(b.id);
  }

  setThrottle(id: number, throttle: 1 | 0 | -1): void {
    const train = this.trains.find((t) => t.id === id);
    if (train && !train.wrecked) {
      train.throttle = throttle;
      train.stillFor = 0;
    }
  }

  /**
   * Point a switch's lever at its next way, by switch point key, or every
   * lever on a piece given just its uid. Track already reserved ahead of
   * trains is let go so they take the new way.
   */
  toggleLever(key: string): void {
    const keys = key.includes(':') ? [key] : this.network.switches().filter((sw) => sw.uid === key).map((sw) => sw.key);
    for (const k of keys) this.levers.set(k, (this.levers.get(k) ?? 0) + 1);
    this.leversMoved();
  }

  private leversMoved(): void {
    this.leverVersion++;
    for (const train of this.trains) {
      const ahead = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
      const behind = Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
      train.route.cut(behind, ahead);
    }
  }

  /**
   * Follow edits to the track. Trains whose track is untouched keep
   * running; a train whose track moved under it is taken off. Returns the
   * names of trains taken off.
   */
  setLayout(layout: Layout): string[] {
    const old = this.network;
    this.network = new TrackNetwork(layout);
    const removed: string[] = [];
    for (const train of [...this.trains]) {
      const lo = Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
      const hi = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
      const kept = train.route.segments.filter((s) => s.u0 + s.edge.length >= lo && s.u0 <= hi);
      const same = kept.every((s) => {
        const before = old.piece(s.edge.uid);
        const after = this.network.piece(s.edge.uid);
        return before && after && after.pieceId === before.pieceId && after.flipped === before.flipped &&
          distance(after.pose, before.pose) < 1e-6 && Math.abs(normalizeAngle(after.pose.angle - before.pose.angle)) < 1e-9;
      });
      const placementOk = this.network.edge(train.placement.edgeKey);
      if (!same || !kept.length) {
        removed.push(train.name);
        this.removeTrain(train.id);
        continue;
      }
      train.route.rebase(kept.map((s) => ({ ...s, edge: this.network.edge(s.edge.key)! })));
      if (!placementOk) train.placement = { edgeKey: kept[0].edge.key, s: kept[0].edge.length / 2, reversed: kept[0].reversed };
    }
    this.findAccessories();
    this.dispatcher.rebuild();
    this.steep.clear();
    this.operator.rebuild();
    return removed;
  }

  /** Find the track up to `reach` mm beyond either end of a train, as far as it goes, to see what's coming. */
  lookAround(train: Train, reach: number): void {
    const lo = Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
    const hi = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
    train.route.extend(this.network, this.choose, lo - reach, hi + reach);
  }

  // ---- running ------------------------------------------------------------

  /** Run the world on by `seconds`. */
  advance(seconds: number): void {
    if (this.autoroute) this.dispatcher.update();
    const steps = Math.round(Math.min(seconds, 0.1) / PHYSICS.dt);
    if (this.useEconomy) this.economy.tick(steps * PHYSICS.dt);
    if (this.useEconomy) this.operator.tick(steps * PHYSICS.dt);
    this.jobClock -= steps * PHYSICS.dt;
    if (this.jobClock <= 0) {
      this.jobClock = JOB_SECONDS;
      for (const train of this.trains) this.runJob(train);
    }
    for (let i = 0; i < steps; i++) this.step(PHYSICS.dt);
    this.moveBridges(steps * PHYSICS.dt);
    this.moveTurntables(steps * PHYSICS.dt);
    this.forgetStations();
    this.coupleTouching();
    for (const train of this.trains) {
      const lo = Math.min(...train.vehicles.map((v) => v.u));
      const hi = Math.max(...train.vehicles.map((v) => v.u));
      train.route.trim(lo - 400, hi + 400);
    }
    this.checkCrashes();
  }

  step(dt: number): void {
    this.time += dt;
    for (const train of this.trains) if (!train.wrecked) this.stepTrain(train, dt);
  }

  private geometry(route: Route, v: Vehicle): VehicleGeometry {
    const half = v.def.wheelbase / 2;
    const fa = route.poseAt(v.u + half * v.facing);
    const ra = route.poseAt(v.u - half * v.facing);
    const d = sub(fa, ra);
    const l = len(d) || 1;
    const dir = { x: d.x / l, y: d.y / l };
    const heading = Math.atan2(dir.y, dir.x);
    const center = { x: (fa.x + ra.x) / 2, y: (fa.y + ra.y) / 2 };
    const zf = route.heightAt(v.u + half * v.facing);
    const zr = route.heightAt(v.u - half * v.facing);
    const reach = v.def.length / 2;
    const front = { x: center.x + dir.x * reach, y: center.y + dir.y * reach };
    const back = { x: center.x - dir.x * reach, y: center.y - dir.y * reach };
    // Track headings run along the route; turn them to the vehicle's own front.
    const own = v.facing === 1 ? 0 : Math.PI;
    return {
      center,
      heading,
      z: (zf + zr) / 2,
      pitch: Math.atan2(zf - zr, 2 * half || 1),
      frontAxle: fa,
      rearAxle: ra,
      aheadFace: v.facing === 1 ? front : back,
      behindFace: v.facing === 1 ? back : front,
      yaw: [normalizeAngle(heading - fa.angle - own), normalizeAngle(heading - ra.angle - own)],
    };
  }

  /**
   * How two neighbours' magnet faces sit relative to each other: apart
   * along the line of the train (negative when pressed together), and slid
   * sideways across each other (on a bend, overhanging ends swing out of
   * line).
   */
  private faceOffset(ahead: Vehicle, behind: Vehicle): { along: number; across: number } {
    // Far apart, measure along the track: the straight-line distance means
    // nothing once the two are on different stretches of a loop.
    const along = ahead.u - ahead.def.length / 2 - (behind.u + behind.def.length / 2);
    if (Math.abs(along) > 20) return { along, across: 0 };
    const d = sub(ahead.geo.behindFace, behind.geo.aheadFace);
    const mid = routeHeading(behind) + normalizeAngle(routeHeading(ahead) - routeHeading(behind)) / 2;
    const dir = { x: Math.cos(mid), y: Math.sin(mid) };
    return { along: dot(d, dir), across: Math.abs(d.x * dir.y - d.y * dir.x) };
  }

  private measure(train: Train): void {
    for (const v of train.vehicles) v.geo = this.geometry(train.route, v);
  }

  private stepTrain(train: Train, dt: number): void {
    if (this.riding(train)) return;
    const P = PHYSICS;
    const { route, vehicles, couplings } = train;
    const lo = Math.min(...vehicles.map((v) => v.u - v.def.length / 2));
    const hi = Math.max(...vehicles.map((v) => v.u + v.def.length / 2));
    // Look further ahead for places to stop at.
    const dir = Math.sign(travelDir(train)) as 1 | -1 | 0;
    const ahead = STOPPING.lookAhead;
    route.extend(this.network, this.choose, lo - 40 - (dir < 0 ? ahead : 0), hi + 40 + (dir > 0 ? ahead : 0));
    this.measure(train);
    // Autoroute: how far it may run before it has to stand.
    const room = this.autoroute && dir ? this.dispatcher.room(train, dir) : null;
    const held = room !== null && room <= 0.5;
    const braking = (this.accessories.length ? this.control(train, dt) : ((train.hold = null), false)) || held;
    const dwelling = train.stop?.phase === 'dwell';

    const force = vehicles.map(() => 0);
    const lateral = vehicles.map(() => 0);

    // Magnets and buffers between neighbours.
    const hold = P.magnetHoldN * (this.realMagnets ? 1 : EASY_MAGNETS.hold);
    const slide = P.magnetSlideMm * (this.realMagnets ? 1 : EASY_MAGNETS.slide);
    couplings.forEach((c, i) => {
      const a = vehicles[i];
      const b = vehicles[i + 1];
      const { along: g, across } = this.faceOffset(a, b);
      const closing = a.v - b.v;
      let pull = 0;
      if (c.attract) {
        if (c.coupled) {
          if (g > 0) pull = Math.max(0, P.couplingStiffness * g + P.couplingDamping * closing);
          if (!this.keepCoupled && (pull > hold || across > slide)) {
            const why = pull > hold ? 'pulled apart' : 'slid apart on the bend';
            c.coupled = false;
            pull = 0;
            this.notice(train, `${train.name} came uncoupled behind the ${a.def.name.toLowerCase()}: the magnets ${why} on the ${pieceName(this.network, route.segmentAt(a.u).edge.uid).toLowerCase()}.`, a.geo.behindFace);
          }
        } else {
          if (g < 0.3 && across < slide / 2) c.coupled = true;
          if (g > 0 && g < P.magnetReachMm) pull = 0.5 * P.magnetHoldN * (1 - g / P.magnetReachMm) ** 2;
        }
      } else if (g < P.repelReachMm) {
        pull = -P.repelForceN * (1 - Math.max(g, 0) / P.repelReachMm) ** 2;
      }
      const push = g < 0 ? Math.max(0, -P.contactStiffness * g - P.contactDamping * closing) : 0;
      c.force = pull - push;
      force[i] -= c.force;
      force[i + 1] += c.force;
      // Pulling or pushing across a bend presses the wheels sideways into
      // the groove. The magnets meet face on, so the force runs along the
      // bisector of the two vehicles' headings.
      const sin = Math.abs(Math.sin(normalizeAngle(routeHeading(a) - routeHeading(b)) / 2));
      lateral[i] += Math.abs(c.force) * sin;
      lateral[i + 1] += Math.abs(c.force) * sin;
    });

    vehicles.forEach((v, i) => {
      const weight = massOf(v) * P.gravity;
      const drag = ZERO_DRAG();
      drag.rolling = P.rollingResistance * weight;
      drag.curve = P.flangeFriction * ((weight / 2) * (Math.abs(Math.sin(v.geo.yaw[0])) + Math.abs(Math.sin(v.geo.yaw[1]))) + lateral[i]);
      // Uphill along the route, gravity pulls back.
      const grade = route.gradeAt(v.u);
      drag.slope = grade ? (-weight * grade) / Math.sqrt(1 + grade * grade) : 0;
      force[i] += drag.slope;

      // Wheels crossing from one piece to the next.
      for (const axle of [v.u + v.def.wheelbase / 2, v.u - v.def.wheelbase / 2]) {
        for (const c of route.crossings) {
          const h = (c.fit.unjoined ? gapDrop(c.fit.gapMm) : 0) + P.stepPerLateralMm * c.fit.lateralMm + P.stepPerDeg * c.fit.angleDeg;
          const { force: climb, reach } = climbForce(weight / 2, h);
          const zone = Math.max(reach, c.fit.unjoined ? c.fit.gapMm / 2 : 0, 0.5);
          if (Math.abs(axle - c.u) > zone) continue;
          if (climb > drag.joint) {
            drag.joint = climb;
            drag.jointAt = c.u;
          }
          const off = c.fit.lateralMm > P.derailLateralMm || c.fit.angleDeg > P.derailAngleDeg || (c.fit.unjoined && c.fit.gapMm > WHEEL_RADIUS * 1.6);
          if (off && Math.abs(axle - c.u) < 1) {
            const where = c.fit.unjoined ? 'gap' : 'joint';
            return this.wreck(train, v, 'derailed', `${train.name} came off the rails at the ${where} between the ${pieceName(this.network, c.uids[0]).toLowerCase()} and the ${pieceName(this.network, c.uids[1]).toLowerCase()}.`, c.at);
          }
        }
      }

      // Buffer stops at either end of the line.
      if (i === 0 && route.front?.kind === 'buffer') {
        const into = v.u + v.def.length / 2 - (route.front.u - P.bufferBlockMm);
        if (into > 0) drag.buffer = P.contactStiffness * into + P.contactDamping * Math.max(v.v, 0);
        force[i] -= drag.buffer;
      }
      if (i === vehicles.length - 1 && route.back?.kind === 'buffer') {
        const into = route.back.u + P.bufferBlockMm - (v.u - v.def.length / 2);
        if (into > 0) drag.buffer = P.contactStiffness * into - P.contactDamping * Math.min(v.v, 0);
        force[i] += drag.buffer;
      }

      // The motor.
      v.motorForce = 0;
      v.slipping = false;
      if (braking) {
        // Brakes on, and held firmly once stopped.
        drag.brake = (massOf(v) * ACCESSORY.brakeMmS2) / 1000 + (Math.abs(v.v) < 1 ? 0.6 * weight : 0);
      }
      v.empty = this.useSupplies ? (v.def.supplies?.find((s) => supplyLevel(train.consist[i], s) <= 0) ?? null) : null;
      if (v.def.motor) {
        if (train.throttle === 0 || braking || dwelling || v.empty) {
          drag.rolling += P.gearDragN;
        } else {
          const way = train.throttle * v.facing;
          const m = v.def.motor;
          const free = m.freeSpeedMm * (train.odometer < train.slowUntil ? STOPPING.slowFactor : 1);
          let f = m.stallForceN * (1 - (v.v * way) / free);
          f = Math.max(-m.stallForceN, Math.min(m.stallForceN, f));
          const grip = m.grip * weight;
          if (Math.abs(f) > grip) {
            f = Math.sign(f) * grip;
            v.slipping = true;
          }
          v.motorForce = f * way;
          force[i] += v.motorForce;
        }
      }
      v.drag = drag;
    });
    if (train.wrecked) return;

    // Move: friction resists motion, and holds a vehicle still until pushed hard enough.
    vehicles.forEach((v, i) => {
      const resist = v.drag.rolling + v.drag.curve + v.drag.joint + v.drag.brake;
      const f = force[i];
      const toAccel = 1000 / massOf(v);
      if (dwelling) {
        v.v = 0;
        return;
      }
      if (v.v === 0) {
        if (Math.abs(f) > resist) v.v = (f - Math.sign(f) * resist) * toAccel * dt;
      } else {
        const next = v.v + (f - Math.sign(v.v) * resist) * toAccel * dt;
        v.v = Math.sign(next) !== Math.sign(v.v) ? 0 : next;
      }
      v.u += v.v * dt;
    });
    if (room !== null && dir) {
      const cap = held ? 0 : Dispatcher.cap(room);
      for (const v of vehicles) if (v.v * dir > cap) v.v = cap * dir;
    }

    // Off the end of the track, or over on a bend.
    for (const v of vehicles) {
      const axles = [v.u + v.def.wheelbase / 2, v.u - v.def.wheelbase / 2];
      if (route.front?.kind === 'open' && Math.max(...axles) > route.front.u + 2) {
        return this.wreck(train, v, 'ran-off', `${train.name} ran off the end of the track.`, route.front.at);
      }
      if (route.back?.kind === 'open' && Math.min(...axles) < route.back.u - 2) {
        return this.wreck(train, v, 'ran-off', `${train.name} ran off the end of the track.`, route.back.at);
      }
      const sideways = v.v * v.v * Math.abs(route.curvatureAt(v.u));
      const cg = AXLE_HEIGHT_MM + v.def.height * 0.4;
      if (sideways > P.gravity * 1000 * (D.GROOVE_SPACING / 2 / cg)) {
        return this.wreck(train, v, 'tipped', `The ${v.def.name.toLowerCase()} tipped over on the bend.`, v.geo.center);
      }
    }
    train.odometer += Math.abs(vehicles[0].v) * dt;
    if (this.useSupplies) this.burn(train, dt);
    this.serveStops(train, dt, dir);
    this.updateStatus(train, dt);
  }

  // ---- jobs -----------------------------------------------------------------

  /** Pick where a job train goes next, and send it there by autoroute. */
  private runJob(train: Train): void {
    if (train.job === 'free' || train.wrecked || !train.vehicles.some((v) => v.def.motor)) return;
    // Up against a buffer stop: back out and carry on the other way.
    if (train.status.kind === 'stuck' && train.status.stuck === 'buffer' && train.throttle) {
      train.throttle = train.throttle === 1 ? -1 : 1;
      train.stillFor = 0;
      train.status = { kind: 'stopped' };
      train.destination = null;
      this.clearRoute(train.id);
      return;
    }
    if (!this.useEconomy || train.stop || train.hold?.until != null || train.dispatch?.working) return;
    // Backing away from trouble: let it get clear before choosing again.
    if (train.backingOff) {
      if (train.dispatch && (train.dispatch.state === 'travelling' || train.dispatch.state === 'waiting')) return;
      train.backingOff = false;
    }
    const going = train.dispatch && train.dispatch.state !== 'arrived' && train.dispatch.dest.kind === 'place' ? train.dispatch.dest.uid : null;
    const dest = nextStop(train.job, train.consist, this.economy, this.stations, (uid) => this.dispatcher.distanceTo(train, uid, { ahead: true }), train.lastStop);
    train.destination = dest;
    if (dest === going) return;
    if (!dest) {
      // Nothing to do: on round to the next station, keeping to the main line rather than
      // wandering into a siding, and looking again on the way.
      const idle = this.stations
        .map((s) => ({ uid: s.uid, d: this.dispatcher.distanceTo(train, s.uid, { ahead: true }) }))
        .filter((s) => s.d !== null && s.uid !== train.lastStop)
        .sort((a, b) => a.d! - b.d!)[0];
      if (!idle) this.clearRoute(train.id);
      else if (idle.uid !== going) this.routeTo(train.id, { kind: 'place', uid: idle.uid }, { keepRunning: true, ahead: true });
      return;
    }
    if (this.routeTo(train.id, { kind: 'place', uid: dest }, { keepRunning: true, ahead: true })) train.destination = null;
  }

  /** A train has finished at a place: choose where next. */
  private arrived(train: Train, uid: string): void {
    train.lastStop = uid;
    train.destination = null;
    this.jobClock = 0;
  }

  // ---- supplies and places beside the track --------------------------------

  /** Engines under power use up their stores; a tender's coal goes first, and a water tank car tops the boiler up. */
  private burn(train: Train, dt: number): void {
    const S = SUPPLIES;
    train.vehicles.forEach((v, i) => {
      if (!v.def.motor || !v.def.supplies || !v.motorForce) return;
      const entry = train.consist[i];
      const run = Math.abs(v.v) * dt;
      const use = (holder: ConsistEntry, supply: Supply, mm: number, who: string) => {
        const before = supplyLevel(holder, supply);
        const after = Math.max(0, before - run / mm);
        holder[supply] = after;
        if (before > S.low && after <= S.low) {
          const what = { water: 'water', coal: 'coal', charge: 'charge' }[supply];
          const where = { water: 'a water tower', coal: 'a coaling stage', charge: 'a charging post' }[supply];
          this.notice(train, `${train.name}'s ${who} is running low on ${what}. Stop it at ${where}.`, v.geo.center);
        }
      };
      const name = v.def.name.toLowerCase();
      for (const supply of v.def.supplies) {
        if (supply === 'coal') {
          const tender = train.consist.find((c) => getStock(c.stockId).supplies?.includes('coal') && !getStock(c.stockId).motor && supplyLevel(c, 'coal') > 0);
          if (tender) use(tender, 'coal', S.tenderCoalMm, 'tender');
          else use(entry, 'coal', S.coalMm, name);
        } else if (supply === 'water') {
          use(entry, 'water', S.waterMm, name);
          if (supplyLevel(entry, 'water') < S.topUpBelow && train.job !== 'water') {
            const tank = train.consist.find((c) => getStock(c.stockId).cargo?.kind === 'water' && (c.units ?? 0) > 0);
            if (tank) {
              tank.units = (tank.units ?? 0) - 1;
              entry.water = Math.min(1, supplyLevel(entry, 'water') + S.tankTopUp);
            }
          }
        } else {
          use(entry, supply, S.chargeMm, name);
        }
      }
    });
  }

  /**
   * Where a place is along a train's route: the nearest one ahead of
   * `from` going `dir`, counting up to `behind` mm back, if the route
   * reaches it.
   */
  private placeU(train: Train, point: PlacePoint, from: number, dir: 1 | -1, behind = 40): number | null {
    let best: number | null = null;
    for (const seg of train.route.segments) {
      if (seg.edge.key !== point.edgeKey) continue;
      const u = seg.u0 + (seg.reversed ? seg.edge.length - point.s : point.s);
      const d = (u - from) * dir;
      if (d > -behind && (best === null || d < (best - from) * dir)) best = u;
    }
    return best;
  }

  /** The middle of vehicles `a` to `b`, along the route. */
  private middleOf(train: Train, [a, b]: [number, number]): number {
    return (train.vehicles[a].u + train.vehicles[b].u) / 2;
  }

  /** Stop at places with work for this train, do the work, and act on signs as they pass. */
  private serveStops(train: Train, dt: number, dir: 1 | -1 | 0): void {
    for (const [uid, until] of train.ignore) if (train.odometer > until) train.ignore.delete(uid);
    const length = train.vehicles.reduce((s, v) => s + v.def.length, 0);
    const stop = train.stop;
    if (stop && (!dir || dir !== stop.dir || !this.places.some((p) => p.uid === stop.uid))) {
      // Switched off or turned back: let the place go.
      train.ignore.set(stop.uid, train.odometer + length + STOPPING.lookAhead);
      train.stop = null;
    }
    if (!dir) return;
    if (train.stop) {
      const stop = train.stop;
      if (stop.phase === 'approach') {
        const d = (stop.u - this.middleOf(train, stop.span)) * dir;
        if (d <= 0.5) {
          stop.phase = 'dwell';
          for (const v of train.vehicles) v.v = 0;
        } else {
          const cap = Math.max(STOPPING.creep, Math.sqrt(2 * STOPPING.brake * d));
          for (const v of train.vehicles) if (v.v * dir > cap) v.v = cap * dir;
        }
        return;
      }
      const done = doWork(stop.work, train.consist, dt, this.deliver);
      if (done) {
        train.ignore.set(stop.uid, train.odometer + length + STOPPING.lookAhead);
        train.stop = null;
        this.arrived(train, stop.uid);
      }
      return;
    }
    const front = dir > 0 ? Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2)) : Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
    for (const point of this.places) {
      if (train.ignore.has(point.uid)) continue;
      const pass = point.place.pass;
      if (pass) {
        const u = this.placeU(train, point, front, dir);
        if (u === null) continue;
        const d = (u - front) * dir;
        if (d > 2 || d < -30) continue;
        train.ignore.set(point.uid, train.odometer + length + 60);
        if (pass === 'slow') train.slowUntil = train.odometer + length + STOPPING.slowMm;
        this.events.push({ trainId: train.id, kind: pass, at: point.at, z: point.z, time: this.time });
        if (this.events.length > 20) this.events.shift();
        continue;
      }
      // Coming up ahead of the train's front, or alongside it (just left the place before).
      const u = this.placeU(train, point, front, dir, length);
      if (u === null) continue;
      const d = (u - front) * dir;
      if (d <= -length || d > STOPPING.lookAhead) continue;
      const work = planWork(point.place, train.consist, this.rand, this.visit(train, point.uid));
      const span = work && workSpan(work);
      const lineUp: [number, number] = span ?? [0, train.vehicles.length - 1];
      if (!work || (u - this.middleOf(train, lineUp)) * dir <= 0) {
        // Nothing to do here, or the cars that need it have gone by.
        train.ignore.set(point.uid, train.odometer + d + length + STOPPING.lookAhead);
        continue;
      }
      train.stop = { uid: point.uid, place: point.place, u, dir, phase: 'approach', work, span: lineUp };
      return;
    }
  }

  private updateStatus(train: Train, dt: number): void {
    const engines = train.vehicles.filter((v) => v.def.motor);
    if (train.stop?.phase === 'dwell') {
      train.status = { kind: 'waiting', message: `At the ${train.stop.place.name.toLowerCase()}` };
      train.stillFor = 0;
      return;
    }
    const still = train.vehicles.every((v) => Math.abs(v.v) <= PHYSICS.stallSpeed);
    if (train.hold && still) {
      train.status = { kind: 'waiting', message: train.hold.reason };
      train.stillFor = 0;
      return;
    }
    if (this.autoroute && still && (train.waitReason || train.dispatch?.state === 'arrived' || train.dispatch?.state === 'no-route')) {
      const d = train.dispatch;
      const message = train.waitReason ?? (d?.state === 'arrived' ? `At ${d.name}` : `No way to ${d!.name}`);
      train.status = { kind: 'waiting', message };
      train.stillFor = 0;
      return;
    }
    if (train.throttle === 0 || !engines.length) {
      const moving = train.vehicles.some((v) => Math.abs(v.v) > PHYSICS.stallSpeed);
      train.status = moving ? { kind: 'running', speed: Math.max(...train.vehicles.map((v) => Math.abs(v.v))) } : { kind: 'stopped' };
      train.stillFor = 0;
      return;
    }
    const speed = Math.max(...engines.map((v) => Math.abs(v.v)));
    if (speed > PHYSICS.stallSpeed) {
      train.stillFor = 0;
      train.status = { kind: 'running', speed };
      return;
    }
    train.stillFor += dt;
    if (train.stillFor >= PHYSICS.stallSeconds && train.status.kind !== 'stuck') {
      const stuck = this.diagnose(train);
      train.status = stuck;
      this.notice(train, stuck.message, stuck.at);
    }
  }

  /** Why a train with its motor on isn't moving. */
  private diagnose(train: Train): Stuck {
    const { vehicles } = train;
    const engines = vehicles.filter((v) => v.def.motor);
    const name = train.name;
    const stuck = (stuck: StuckKind, message: string, at: Vec2): Stuck => ({ kind: 'stuck', stuck, message, at });
    const head = engines[0];
    const dry = engines.find((v) => v.empty);
    if (dry?.empty) {
      const what = { water: ['no-water', 'has run out of water. Stop it by a water tower, or couple on a water tank car'], coal: ['no-coal', 'has run out of coal. Stop it by a coaling stage, or couple on a tender'], charge: ['flat-battery', 'has a flat battery. Stop it by a charging post'] } as const;
      const [kind, why] = what[dry.empty];
      return stuck(kind, `${name}'s ${dry.def.name.toLowerCase()} ${why}. Reset puts every train back with full stores.`, dry.geo.center);
    }
    if (vehicles.some((v) => v.drag.buffer > 0.01)) {
      const v = vehicles.find((x) => x.drag.buffer > 0.01)!;
      return stuck('buffer', `${name} is up against the buffer stop.`, v.geo.center);
    }
    const ways = new Set(engines.map((v) => Math.sign(v.motorForce)).filter((s) => s !== 0));
    if (ways.size > 1) return stuck('fighting', `${name}'s engines are pushing against each other. Turn one round.`, head.geo.center);
    // Only the vehicles the engines are actually coupled to are a load.
    const group = this.coupledGroup(train, vehicles.indexOf(head));
    const pull = engines.filter((v) => group.includes(v)).reduce((s, v) => s + Math.abs(v.motorForce), 0);
    const sum = (k: 'rolling' | 'curve' | 'joint') => group.reduce((s, v) => s + v.drag[k], 0);
    // Gravity holding the train back, against the way the engines push.
    const push = Math.sign(engines.reduce((s, v) => s + v.motorForce, 0)) || 1;
    const climb = Math.max(0, -push * group.reduce((s, v) => s + v.drag.slope, 0));
    const parts = { rolling: sum('rolling'), curve: sum('curve'), joint: sum('joint') };
    const need = parts.rolling + parts.curve + parts.joint + climb;
    const numbers = `It needs ${need.toFixed(2)} N to move; the engine${engines.length > 1 ? 's give' : ' gives'} ${pull.toFixed(2)} N.`;
    const uphill = climb >= parts.joint && climb >= parts.curve && climb >= parts.rolling * 0.5;
    if (engines.some((v) => v.slipping)) {
      const where = uphill ? ' on the ramp' : '';
      return stuck('slipping', `${name}'s wheels are spinning${where}: the load is more than the engine can grip. ${numbers}${uphill ? ' Try fewer cars.' : ''}`, head.geo.center);
    }
    if (uphill) {
      const v = group.reduce((a, b) => (Math.abs(b.drag.slope) > Math.abs(a.drag.slope) ? b : a));
      const ramp = pieceName(this.network, train.route.segmentAt(v.u).edge.uid).toLowerCase();
      return stuck('stalled', `${name} can't get up the ${ramp}: the climb takes ${climb.toFixed(2)} N on top of ${(parts.rolling + parts.curve + parts.joint).toFixed(2)} N of drag. ${numbers} Try fewer cars.`, v.geo.center);
    }
    if (parts.joint >= parts.curve && parts.joint >= parts.rolling * 0.5) {
      const v = group.reduce((a, b) => (b.drag.joint > a.drag.joint ? b : a));
      const c = train.route.crossings.find((x) => x.u === v.drag.jointAt);
      if (c) {
        const what = c.fit.unjoined ? `the ${c.fit.gapMm.toFixed(1)} mm gap` : 'a rough joint';
        return stuck('stalled', `${name} is stuck at ${what} between the ${pieceName(this.network, c.uids[0]).toLowerCase()} and the ${pieceName(this.network, c.uids[1]).toLowerCase()}. ${numbers}`, c.at);
      }
    }
    if (parts.curve >= parts.rolling * 0.5) {
      const v = group.reduce((a, b) => (b.drag.curve > a.drag.curve ? b : a));
      const piece = pieceName(this.network, train.route.segmentAt(v.u).edge.uid).toLowerCase();
      return stuck('stalled', `${name} is binding on the ${piece}: the bend adds ${parts.curve.toFixed(2)} N of flange drag to ${parts.rolling.toFixed(2)} N of rolling drag. ${numbers}`, v.geo.center);
    }
    return stuck('stalled', `${name} is too heavy for its engine${engines.length > 1 ? 's' : ''}. ${numbers}`, head.geo.center);
  }

  /** The run of coupled vehicles that includes vehicle `i`. */
  private coupledGroup(train: Train, i: number): Vehicle[] {
    let a = i;
    let b = i;
    while (a > 0 && train.couplings[a - 1].coupled) a--;
    while (b < train.vehicles.length - 1 && train.couplings[b].coupled) b++;
    return train.vehicles.slice(a, b + 1);
  }

  // ---- accessories ----------------------------------------------------------

  /** Tap an accessory: a signal turns red or green, a lifting bridge goes up or down. Returns an error message. */
  toggleAccessory(uid: string): string | null {
    const acc = this.accessories.find((a) => a.uid === uid);
    if (!acc) return null;
    if (acc.kind === 'signal') {
      if (!this.redSignals.delete(uid)) this.redSignals.add(uid);
      return null;
    }
    if (acc.kind !== 'bridge') return null;
    const bridge = this.bridges.get(uid) ?? { up: false, lift: 0 };
    if (!bridge.up) {
      const on = this.trains.find((t) => {
        const { front, back } = span(t);
        return onRoute(t.route, acc).some(([a, b]) => b > back && a < front);
      });
      if (on) return `${on.name} is on the bridge. Lift it once the train is across.`;
    }
    bridge.up = !bridge.up;
    this.bridges.set(uid, bridge);
    return null;
  }

  /** Whether a lifting bridge is up, or on its way up or down: trains can't cross. */
  bridgeOpen(uid: string): boolean {
    const b = this.bridges.get(uid);
    return !!b && (b.up || b.lift > 0);
  }

  private moveBridges(dt: number): void {
    for (const [uid, b] of this.bridges) {
      const step = dt / ACCESSORY.bridgeSeconds;
      b.lift = b.up ? Math.min(1, b.lift + step) : Math.max(0, b.lift - step);
      if (b.lift < 0.02) continue;
      // Anything on the span as it lifts falls off it.
      const acc = this.accessories.find((a) => a.uid === uid)!;
      for (const train of this.trains) {
        if (train.wrecked) continue;
        for (const [a, z] of onRoute(train.route, acc)) {
          const v = train.vehicles.find((x) => [x.u + x.def.wheelbase / 2, x.u - x.def.wheelbase / 2].some((axle) => axle > a && axle < z));
          if (v) {
            this.wreck(train, v, 'ran-off', `${train.name} ran onto the lifting bridge while it was up.`, acc.at);
            break;
          }
        }
      }
    }
  }

  /** Whether a turntable's bridge stands still lined up with `line`, so trains can run across. */
  linedUp(uid: string, line: number): boolean {
    const table = this.turntables.find((t) => t.uid === uid);
    const state = this.tables.get(uid);
    return !!table && !!state && state.angle === state.target && lineAt(table, state.angle) === line;
  }

  /**
   * Turn a turntable's bridge to the end nearest `point`, or on to the next
   * line for a point by the pivot (unless `middleSteps` is off, as while
   * dragging). A train standing wholly on the bridge turns with it; one
   * partly on stops it turning. Returns an error message.
   */
  turnTurntable(uid: string, point: Vec2, middleSteps = true): string | null {
    const table = this.turntables.find((t) => t.uid === uid);
    const state = this.tables.get(uid);
    if (!table || !state) return null;
    const line = lineToward(table, point, state.target, middleSteps);
    if (lineAt(table, state.target) === line) return null;
    const still = state.angle === state.target;
    const lines = this.accessories.filter((a) => a.kind === 'turntable' && a.uid === uid);
    const riders: number[] = [];
    for (const train of this.trains) {
      if (state.riders.includes(train.id)) continue;
      const { front, back } = span(train);
      for (const acc of lines) {
        for (const [a, z] of onRoute(train.route, acc)) {
          if (z <= back || a >= front) continue;
          const aboard = still && !train.wrecked && back >= a - 1 && front <= z + 1 && acc.line === lineAt(table, state.angle);
          if (!aboard) return `${train.name} is partly on the turntable. Turn it once the train is clear, or all the way on.`;
          riders.push(train.id);
        }
      }
    }
    if (still) Object.assign(state, { from: state.angle, riders });
    state.target = headingToward(table, line, state.angle);
    return null;
  }

  private moveTurntables(dt: number): void {
    for (const table of this.turntables) {
      const state = this.tables.get(table.uid)!;
      if (!turn(state, dt)) continue;
      // At rest: trains that rode round go on along the line the bridge now lies on.
      const delta = state.angle - state.from;
      const line = lineAt(table, state.angle);
      for (const id of state.riders) {
        const train = this.trains.find((t) => t.id === id);
        const seg = train?.route.segments.find((s) => s.edge.uid === table.uid);
        const edge = this.network.edge(table.lines[line]?.edgeKey ?? '');
        if (!train || !seg || !edge) continue;
        const heading = table.lines[seg.edge.index].angle + delta;
        const flip = Math.cos(heading - table.lines[line].angle) < 0;
        train.route.rebase([{ edge, reversed: seg.reversed !== flip, u0: seg.u0 }]);
        train.hold = null;
        this.measure(train);
      }
      Object.assign(state, { from: state.angle, riders: [] });
    }
  }

  /** A train turning round on a turntable: it holds still on the bridge and swings round with it. */
  private riding(train: Train): boolean {
    const table = this.turntables.find((t) => this.tables.get(t.uid)?.riders.includes(train.id));
    if (!table) return false;
    const state = this.tables.get(table.uid)!;
    const delta = state.angle - state.from;
    this.measure(train);
    for (const v of train.vehicles) {
      v.v = 0;
      const g = v.geo;
      for (const k of ['center', 'frontAxle', 'rearAxle', 'aheadFace', 'behindFace'] as const) g[k] = turnPoint(table, g[k], delta);
      g.heading = normalizeAngle(g.heading + delta);
    }
    train.hold = null;
    train.stillFor = 0;
    train.status = { kind: 'waiting', message: 'Turning on the turntable' };
    return true;
  }

  /** Let go of stations a train has left behind, so it stops there again next time round. */
  private forgetStations(): void {
    for (const train of this.trains) {
      if (!train.served.size) continue;
      const { front, back } = span(train);
      for (const uid of train.served) {
        const acc = this.accessories.find((a) => a.uid === uid);
        if (!acc || !onRoute(train.route, acc).some(([a, b]) => b > back - 100 && a < front + 100)) train.served.delete(uid);
      }
    }
  }

  /**
   * The next accessory ahead that this train must stop for, measured from
   * the part of the train that has to line up with it: the front for a
   * signal or bridge, the middle at a station, a wagon at the loader or crane.
   */
  private nextStop(train: Train, dir: number): Stop | null {
    const { front: f, back: b } = span(train);
    const front = dir > 0 ? f : b;
    const mid = (f + b) / 2;
    let best: Stop | null = null;
    const consider = (acc: Accessory, d: number, vehicle = -1) => {
      if (d >= -3 && (!best || d < best.d)) best = { acc, d, vehicle };
    };
    for (const acc of this.accessories) {
      for (const [a, z] of onRoute(train.route, acc)) {
        switch (acc.kind) {
          case 'signal': {
            if (!this.redSignals.has(acc.uid)) break;
            // Only trains coming toward its lamps.
            const heading = train.route.poseAt(a).angle + (dir < 0 ? Math.PI : 0);
            if (Math.cos(heading - acc.angle) > -0.5) break;
            consider(acc, (a - front) * dir - ACCESSORY.signalGapMm);
            break;
          }
          case 'bridge':
            if (this.bridgeOpen(acc.uid)) consider(acc, ((dir > 0 ? a : z) - front) * dir - ACCESSORY.bridgeGapMm);
            break;
          case 'turntable':
            if (!this.linedUp(acc.uid, acc.line!)) consider(acc, ((dir > 0 ? a : z) - front) * dir - TURNTABLE.gapMm);
            break;
          case 'station':
            // Goods trains run through; workers trains and free trains stop.
            if (!train.served.has(acc.uid) && (train.job === 'free' || train.job === 'workers')) consider(acc, (a - mid) * dir);
            break;
          case 'loader':
          case 'crane':
            train.vehicles.forEach((v, i) => {
              const loaded = !!v.entry.load;
              if (v.def.carries && loaded === (acc.kind === 'crane')) consider(acc, (a - v.u) * dir, i);
            });
            break;
        }
      }
    }
    return best;
  }

  /** Brake for whatever is ahead, wait there, and do the work. Returns whether to brake this step. */
  private control(train: Train, dt: number): boolean {
    const dir = travelDir(train);
    const stop = dir ? this.nextStop(train, dir) : null;
    if (!stop) {
      train.hold = null;
      return false;
    }
    const { acc, d, vehicle } = stop;
    let hold = train.hold;
    const same = hold !== null && hold.uid === acc.uid && hold.vehicle === vehicle;
    if (same && hold!.until !== null) {
      if (this.time < hold!.until) {
        if (hold!.work) doWork(hold!.work, train.consist, dt, this.deliver);
        return true;
      }
      // Anyone still on the platform hops on as it leaves.
      if (hold!.work) doWork(hold!.work, train.consist, Infinity, this.deliver);
      this.finish(train, stop);
      train.hold = null;
      return false;
    }
    const speed = Math.max(0, ...train.vehicles.map((v) => v.v * dir));
    // Brake hard enough to stop right on the spot.
    const brake = d <= 0.5 || speed * speed > 2 * ACCESSORY.brakeMmS2 * d;
    if (!brake && d > 60) {
      train.hold = null;
      return false;
    }
    if (!same) hold = train.hold = { uid: acc.uid, kind: acc.kind, reason: REASONS[acc.kind], vehicle, until: null };
    const dwell = DWELL[acc.kind];
    if (dwell && d <= 3 && train.vehicles.every((v) => Math.abs(v.v) < 0.5)) {
      const job = this.jobs.get(acc.uid);
      if (job && job.trainId !== train.id) return true;
      hold!.until = this.time + dwell;
      if (acc.kind === 'station') {
        hold!.work = planWork(getPlace('station')!, train.consist, this.rand, this.visit(train, acc.uid)) ?? undefined;
        if (hold!.work) hold!.until = this.time + Math.max(dwell, workSeconds(hold!.work));
      }
      if (acc.kind !== 'station') this.jobs.set(acc.uid, { trainId: train.id, vehicle, start: this.time, end: hold!.until });
      return true;
    }
    return brake;
  }

  private finish(train: Train, { acc, vehicle }: Stop): void {
    this.jobs.delete(acc.uid);
    if (acc.kind === 'station') {
      train.served.add(acc.uid);
      this.arrived(train, acc.uid);
    }
    if (acc.kind === 'loader' || acc.kind === 'crane') {
      const load = acc.kind === 'loader' ? 'crate' : undefined;
      for (const entry of [train.consist[vehicle], train.vehicles[vehicle].entry]) {
        if (load) entry.load = load;
        else delete entry.load;
      }
      if (acc.kind === 'crane') this.piles.set(acc.uid, (this.piles.get(acc.uid) ?? 0) + 1);
    }
  }

  private wreck(train: Train, v: Vehicle, kind: StuckKind, message: string, at: Vec2): void {
    v.derailed = kind !== 'crashed';
    train.wrecked = true;
    for (const x of train.vehicles) x.v = 0;
    train.status = { kind: 'stuck', stuck: kind, message, at };
    this.notice(train, message, at);
  }

  notice(train: Train, message: string, at: Vec2): void {
    this.notices.push({ trainId: train.id, message, at, time: this.time });
    if (this.notices.length > 20) this.notices.shift();
  }

  /** Vehicles that aren't neighbours running into each other: trains meeting, or a train catching its own tail. */
  private checkCrashes(): void {
    const all = this.trains.flatMap((t) => t.vehicles.map((v, i) => ({ t, v, i })));
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        const x = all[a];
        const y = all[b];
        if (x.t === y.t && Math.abs(x.i - y.i) < 2) continue;
        if (x.t.wrecked && y.t.wrecked) continue;
        if (!overlaps(x.v, y.v) || passesOver(x.v, y.v)) continue;
        const at = { x: (x.v.geo.center.x + y.v.geo.center.x) / 2, y: (x.v.geo.center.y + y.v.geo.center.y) / 2 };
        const message = x.t === y.t ? `${x.t.name} ran into its own tail. The loop is too short for it.` : `${x.t.name} and ${y.t.name} crashed.`;
        for (const t of new Set([x.t, y.t])) {
          if (t.wrecked) continue;
          t.wrecked = true;
          for (const v of t.vehicles) v.v = 0;
          t.status = { kind: 'stuck', stuck: 'crashed', message, at };
        }
        this.notice(x.t, message, at);
      }
    }
  }
}

/** How far a run of vehicles reaches along its route, magnet face to magnet face. */
function span(train: Pick<Train, 'vehicles'>): { front: number; back: number } {
  return {
    front: Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2)),
    back: Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2)),
  };
}

/** The placement that puts a train's middle at `u` on `route`. */
function placementAt(route: Route, u: number): Placement {
  const seg = route.segmentAt(u);
  const along = Math.min(Math.max(u - seg.u0, 0), seg.edge.length);
  return { edgeKey: seg.edge.key, s: seg.reversed ? seg.edge.length - along : along, reversed: seg.reversed };
}

/**
 * Whether two vehicles are on different levels, one passing over the other.
 * A full level up counts as clear, as it does in the layout check.
 */
function passesOver(a: Vehicle, b: Vehicle): boolean {
  return Math.abs(a.geo.z - b.geo.z) >= D.HEADROOM;
}

/** Whether two vehicles' footprints overlap (separating axis test on two rectangles). */
function overlaps(a: Vehicle, b: Vehicle): boolean {
  const shrink = 3;
  const boxes = [a, b].map((v) => ({
    c: v.geo.center,
    axes: [
      { x: Math.cos(v.geo.heading), y: Math.sin(v.geo.heading) },
      { x: -Math.sin(v.geo.heading), y: Math.cos(v.geo.heading) },
    ],
    half: [v.def.length / 2 - shrink, v.def.width / 2 - shrink],
  }));
  if (distance(boxes[0].c, boxes[1].c) > (a.def.length + b.def.length) / 2) return false;
  const d = sub(boxes[1].c, boxes[0].c);
  for (const box of boxes) {
    for (const axis of box.axes) {
      const r = boxes.reduce((s, q) => s + q.half[0] * Math.abs(dot(q.axes[0], axis)) + q.half[1] * Math.abs(dot(q.axes[1], axis)), 0);
      if (Math.abs(dot(d, axis)) > r) return false;
    }
  }
  return true;
}
