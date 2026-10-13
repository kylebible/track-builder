import { distance, normalizeAngle, type Vec2 } from '../geometry/pose';
import type { Layout } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { getPiece } from '../pieces/catalog';
import { poseAt } from '../geometry/path';
import { TrackNetwork, type Edge } from './network';
import { Route, type Chooser } from './route';
import { attracts, getStock, WHEEL_RADIUS, type ConsistEntry, type StockDef } from './stock';

// A small, purpose-built simulation of wooden trains. The grooves keep every
// axle on the track centreline, so each vehicle only moves along the track:
// one position and one speed. What stops a train comes from the geometry:
// a long rigid wheelbase scrubs its flanges round a tight curve, a coupling
// pulling across a bend presses the wheels into the groove, a wheel has to
// climb out of a gap or over a step at a rough joint, and a magnet only
// holds so hard. Forces in newtons, distances in mm, speeds in mm/s.

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
  /** Magnet faces slid this far across each other (overhangs swinging out on a bend) peel apart. */
  magnetSlideMm: 12,
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
}

export interface VehicleGeometry {
  center: Vec2;
  heading: number;
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
}

export interface Coupling {
  /** The poles face N to S. */
  attract: boolean;
  coupled: boolean;
  /** Pull through the coupling, positive when stretched; negative is a push. */
  force: number;
}

export type StuckKind = 'ran-off' | 'buffer' | 'stalled' | 'slipping' | 'fighting' | 'crashed' | 'derailed' | 'tipped';

export interface Stuck {
  kind: 'stuck';
  stuck: StuckKind;
  message: string;
  at: Vec2;
}

export type TrainStatus = { kind: 'stopped' } | { kind: 'running'; speed: number } | Stuck;

export interface Placement {
  edgeKey: string;
  /** Distance along the edge's path of the train's middle. */
  s: number;
  /** The train's front points toward the path's start. */
  reversed: boolean;
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
}

const ZERO_DRAG = (): Drag => ({ rolling: 0, curve: 0, joint: 0, jointAt: null, buffer: 0 });

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
  /** Which way each switch lever points, by piece. */
  readonly levers = new Map<string, number>();
  readonly notices: Notice[] = [];
  time = 0;
  private nextId = 1;
  private readonly choose: Chooser = (uid, count) => (this.levers.get(uid) ?? 0) % count;

  constructor(layout: Layout) {
    this.network = new TrackNetwork(layout);
  }

  // ---- building trains ---------------------------------------------------

  /** The track point nearest `point`, within `reach` mm. */
  nearestTrack(point: Vec2, reach = 40): { edge: Edge; s: number } | null {
    let best: { edge: Edge; s: number; d: number } | null = null;
    for (const edge of this.network.edges) {
      const steps = Math.max(1, Math.ceil(edge.length / 4));
      for (let i = 0; i <= steps; i++) {
        const s = (edge.length * i) / steps;
        const d = distance(poseAt(edge.path, s), point);
        if (d < reach && (!best || d < best.d)) best = { edge, s, d };
      }
    }
    return best && { edge: best.edge, s: best.s };
  }

  /** Put a train on the track with its middle at `placement`. Returns an error message if it won't fit. */
  addTrain(consist: ConsistEntry[], placement: Placement, name?: string): Train | string {
    if (!consist.length) return 'Add an engine or a car first.';
    const laid = this.lay(consist, placement);
    if (typeof laid === 'string') return laid;
    const { vehicles } = laid;
    for (let a = 0; a < vehicles.length; a++) {
      for (let b = a + 2; b < vehicles.length; b++) {
        if (overlaps(vehicles[a], vehicles[b])) return 'This train is longer than the loop it is on.';
      }
    }
    const id = this.nextId++;
    const train: Train = {
      id,
      name: name ?? `Train ${id}`,
      consist: consist.map((c) => ({ ...c })),
      placement,
      ...laid,
      throttle: 0,
      status: { kind: 'stopped' },
      wrecked: false,
      stillFor: 0,
    };
    this.trains.push(train);
    this.measure(train);
    return train;
  }

  private lay(consist: ConsistEntry[], placement: Placement): Pick<Train, 'route' | 'vehicles' | 'couplings'> | string {
    const edge = this.network.edge(placement.edgeKey);
    if (!edge) return 'That track has gone.';
    const route = new Route(edge, placement.reversed, 0);
    let mid = placement.reversed ? edge.length - placement.s : placement.s;
    const defs = consist.map((c) => getStock(c.stockId));
    const total = defs.reduce((sum, d) => sum + d.length, 0) + PHYSICS.repelReachMm * consist.length;
    route.extend(this.network, this.choose, mid - total / 2 - 60, mid + total / 2 + 60);
    // Slide the train back on from a dead end, if it hangs over one.
    if (route.front) mid = Math.min(mid, route.front.u - total / 2 - 2);
    if (route.back) mid = Math.max(mid, route.back.u + total / 2 + 2);
    if ((route.front && mid + total / 2 > route.front.u) || (route.back && mid - total / 2 < route.back.u)) {
      return 'There is not enough track here for this train.';
    }
    const couplings: Coupling[] = consist.slice(1).map((c, i) => {
      const attract = attracts(consist[i], c);
      return { attract, coupled: attract, force: 0 };
    });
    const vehicles: Vehicle[] = [];
    let front = mid + total / 2;
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
    return { route, vehicles, couplings };
  }

  removeTrain(id: number): void {
    const i = this.trains.findIndex((t) => t.id === id);
    if (i >= 0) this.trains.splice(i, 1);
  }

  /** Lift a train off and put it back the other way round, in the same spot. */
  turnAround(id: number): string | null {
    const train = this.trains.find((t) => t.id === id);
    if (!train) return null;
    return this.replace(train, { ...train.placement, reversed: !train.placement.reversed });
  }

  /** Put every train back where it was placed, stopped. */
  reset(): void {
    for (const train of [...this.trains]) this.replace(train, train.placement);
    this.notices.length = 0;
  }

  private replace(train: Train, placement: Placement): string | null {
    const laid = this.lay(train.consist, placement);
    if (typeof laid === 'string') return laid;
    Object.assign(train, laid, { placement, throttle: 0, status: { kind: 'stopped' }, wrecked: false, stillFor: 0 });
    this.measure(train);
    return null;
  }

  setThrottle(id: number, throttle: 1 | 0 | -1): void {
    const train = this.trains.find((t) => t.id === id);
    if (train && !train.wrecked) {
      train.throttle = throttle;
      train.stillFor = 0;
    }
  }

  /** Point a switch's lever at its next way. Track already reserved ahead of trains is let go so they take the new way. */
  toggleLever(uid: string): void {
    this.levers.set(uid, (this.levers.get(uid) ?? 0) + 1);
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
    return removed;
  }

  // ---- running ------------------------------------------------------------

  /** Run the world on by `seconds`. */
  advance(seconds: number): void {
    const steps = Math.round(Math.min(seconds, 0.1) / PHYSICS.dt);
    for (let i = 0; i < steps; i++) this.step(PHYSICS.dt);
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
    const reach = v.def.length / 2;
    const front = { x: center.x + dir.x * reach, y: center.y + dir.y * reach };
    const back = { x: center.x - dir.x * reach, y: center.y - dir.y * reach };
    // Track headings run along the route; turn them to the vehicle's own front.
    const own = v.facing === 1 ? 0 : Math.PI;
    return {
      center,
      heading,
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
    const P = PHYSICS;
    const { route, vehicles, couplings } = train;
    const lo = Math.min(...vehicles.map((v) => v.u - v.def.length / 2));
    const hi = Math.max(...vehicles.map((v) => v.u + v.def.length / 2));
    route.extend(this.network, this.choose, lo - 40, hi + 40);
    this.measure(train);

    const force = vehicles.map(() => 0);
    const lateral = vehicles.map(() => 0);

    // Magnets and buffers between neighbours.
    couplings.forEach((c, i) => {
      const a = vehicles[i];
      const b = vehicles[i + 1];
      const { along: g, across } = this.faceOffset(a, b);
      const closing = a.v - b.v;
      let pull = 0;
      if (c.attract) {
        if (c.coupled) {
          if (g > 0) pull = Math.max(0, P.couplingStiffness * g + P.couplingDamping * closing);
          if (pull > P.magnetHoldN || across > P.magnetSlideMm) {
            const why = pull > P.magnetHoldN ? 'pulled apart' : 'slid apart on the bend';
            c.coupled = false;
            pull = 0;
            this.notice(train, `${train.name} came uncoupled behind the ${a.def.name.toLowerCase()}: the magnets ${why} on the ${pieceName(this.network, route.segmentAt(a.u).edge.uid).toLowerCase()}.`, a.geo.behindFace);
          }
        } else {
          if (g < 0.3 && across < P.magnetSlideMm / 2) c.coupled = true;
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
      const weight = v.def.massKg * P.gravity;
      const drag = ZERO_DRAG();
      drag.rolling = P.rollingResistance * weight;
      drag.curve = P.flangeFriction * ((weight / 2) * (Math.abs(Math.sin(v.geo.yaw[0])) + Math.abs(Math.sin(v.geo.yaw[1]))) + lateral[i]);

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
      if (v.def.motor) {
        if (train.throttle === 0) {
          drag.rolling += P.gearDragN;
        } else {
          const way = train.throttle * v.facing;
          const m = v.def.motor;
          let f = m.stallForceN * (1 - (v.v * way) / m.freeSpeedMm);
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
      const resist = v.drag.rolling + v.drag.curve + v.drag.joint;
      const f = force[i];
      const toAccel = 1000 / v.def.massKg;
      if (v.v === 0) {
        if (Math.abs(f) > resist) v.v = (f - Math.sign(f) * resist) * toAccel * dt;
      } else {
        const next = v.v + (f - Math.sign(v.v) * resist) * toAccel * dt;
        v.v = Math.sign(next) !== Math.sign(v.v) ? 0 : next;
      }
      v.u += v.v * dt;
    });

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
    this.updateStatus(train, dt);
  }

  private updateStatus(train: Train, dt: number): void {
    const engines = train.vehicles.filter((v) => v.def.motor);
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
    const parts = { rolling: sum('rolling'), curve: sum('curve'), joint: sum('joint') };
    const need = parts.rolling + parts.curve + parts.joint;
    const numbers = `It needs ${need.toFixed(2)} N to move; the engine${engines.length > 1 ? 's give' : ' gives'} ${pull.toFixed(2)} N.`;
    if (engines.some((v) => v.slipping)) {
      return stuck('slipping', `${name}'s wheels are spinning: the load is more than the engine can grip. ${numbers}`, head.geo.center);
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

  private wreck(train: Train, v: Vehicle, kind: StuckKind, message: string, at: Vec2): void {
    v.derailed = kind !== 'crashed';
    train.wrecked = true;
    for (const x of train.vehicles) x.v = 0;
    train.status = { kind: 'stuck', stuck: kind, message, at };
    this.notice(train, message, at);
  }

  private notice(train: Train, message: string, at: Vec2): void {
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
        if (!overlaps(x.v, y.v)) continue;
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
