import type { Vec2 } from '../geometry/pose';
import type { Edge, TrackNetwork } from './network';
import type { Train, TrainSim } from './sim';

// Autorouting: trains that set the switches ahead of themselves and wait for
// each other instead of colliding. Each piece of track is a block. Every
// train holds the pieces it stands on, and as it runs it reserves the pieces
// ahead of it, far enough to stop in, throwing each facing switch it
// reserves its own way. A piece another train holds is a red light: the
// train brakes to a stop just short of it and waits until it is let go. A
// train given a destination follows the shortest way there (pieces other
// trains hold count as longer, so it takes the free side of a passing loop)
// and stops with its middle on the spot. One without a destination follows
// the levers as they are set, but takes the other way at a facing switch
// when the lever's way is taken and the other way leads on.

/** Tunable choices, not measurements. */
export const DISPATCH = {
  /** Braking for a held piece or a destination, mm/s². */
  brake: 400,
  /** Creeps the last bit at this speed, mm/s. */
  creep: 15,
  /** Reserves this far beyond its stopping distance, mm. */
  marginMm: 120,
  /** Stops this far short of a piece another train holds, or the end of the track. */
  gapMm: 14,
  /** A way through a piece another train holds counts as this much longer, mm. */
  busyCost: 2000,
  /** Reserves no further than this through to the next switch, mm. */
  sectionMm: 6000,
  /** How far down the other way at a switch to look for trains before taking it. */
  clearLookMm: 300,
  /** Within this of the spot counts as arrived. */
  arriveMm: 1.5,
};

/** Where to send a train: a place beside the track or an accessory (by uid), or a spot on a piece's path. */
export type Destination = { kind: 'place'; uid: string } | { kind: 'track'; edgeKey: string; s: number };

export interface Dispatch {
  dest: Destination;
  /** What the destination is called, for the card: "the water tower". */
  name: string;
  /** Which part of the train stops on the spot. */
  align: 'middle' | 'front';
  /** Leave the engines on when it gets there, to run straight on to the next leg. */
  keepRunning: boolean;
  state: 'travelling' | 'waiting' | 'arrived' | 'no-route';
  /** How far it has left to go, mm. */
  distance: number;
  /** Loading, unloading or stopped at the destination itself; arrived once that's done. */
  working?: boolean;
}

export interface RouteOptions {
  /** Which part of the train to stop on the spot: its middle (the default) or its front. */
  align?: 'middle' | 'front';
  /** Leave the engines on at the destination instead of switching them off. */
  keepRunning?: boolean;
}

/** A train that got where it was sent. */
export interface Arrival {
  trainId: number;
  /** The place or accessory, or null for a spot on the track. */
  uid: string | null;
  name: string;
  time: number;
}

/** Somewhere a train can be sent. */
export interface DestinationPoint {
  uid: string;
  name: string;
  at: Vec2;
  edgeKey: string;
  s: number;
}

/** Running along an edge, leaving it through end `leave`. */
export interface Heading {
  edge: Edge;
  leave: 0 | 1;
}

interface Way extends Heading {
  /** The switch point passed to get here, and which way it was set; null where there was no choice. */
  switchKey: string | null;
  index: number;
}

export const headingKey = (h: Heading) => `${h.edge.key}>${h.leave}`;
/** Distance from `s` along an edge's path to the end a heading leaves through. */
const toLeave = (h: Heading, s: number) => (h.leave === 1 ? h.edge.length - s : s);

/** The layout as a map of which way a train can go from where, for finding routes. */
export class RouteGraph {
  private readonly cache = new Map<string, { next: Way[]; end: 'open' | 'buffer' | null }>();
  /** Headings from which a train can run on for ever, without meeting the end of the track. */
  readonly live: Set<string>;
  /** Pieces with a switch point: where lines split or join. */
  readonly switchUids: Set<string>;

  constructor(readonly network: TrackNetwork) {
    this.live = this.findLive();
    this.switchUids = new Set(network.switches().map((sw) => sw.uid));
  }

  /** The ways on from the end of a heading, or how the track ends there. */
  ways(h: Heading): { next: Way[]; end: 'open' | 'buffer' | null } {
    const k = headingKey(h);
    let found = this.cache.get(k);
    if (!found) {
      const asked = { key: null as string | null, count: 1 };
      const first = this.network.onward(h.edge, h.leave, (key, count) => {
        asked.key = key;
        asked.count = count;
        return 0;
      });
      if (first.kind !== 'edge') found = { next: [], end: first.kind };
      else {
        const next: Way[] = [];
        for (let i = 0; i < asked.count; i++) {
          const o = i === 0 ? first : this.network.onward(h.edge, h.leave, () => i);
          if (o.kind === 'edge') next.push({ edge: o.edge, leave: o.enterAt === 0 ? 1 : 0, switchKey: asked.count > 1 ? asked.key : null, index: i });
        }
        found = { next, end: null };
      }
      this.cache.set(k, found);
    }
    return found;
  }

  private findLive(): Set<string> {
    const all: Heading[] = this.network.edges.flatMap((edge) => [{ edge, leave: 0 as const }, { edge, leave: 1 as const }]);
    const live = new Set(all.map(headingKey));
    // Strip away headings that only lead to dead ends until none are left to strip.
    for (let changed = true; changed; ) {
      changed = false;
      for (const h of all) {
        const k = headingKey(h);
        if (live.has(k) && !this.ways(h).next.some((w) => live.has(headingKey(w)))) {
          live.delete(k);
          changed = true;
        }
      }
    }
    return live;
  }

  /**
   * The shortest way from a point `remaining` mm before the end of `start`
   * to the spot `s` along edge `edgeKey`, never going back. `cost` makes
   * some edges count longer; `fixed` holds switches already set. The
   * distance is the real one, without the extra cost.
   */
  plan(
    start: Heading,
    remaining: number,
    target: { edgeKey: string; s: number },
    opts: { cost?: (edge: Edge) => number; fixed?: Map<string, number>; behind?: number } = {},
  ): { path: Heading[]; distance: number } | null {
    const cost = opts.cost ?? (() => 0);
    if (start.edge.key === target.edgeKey) {
      const d = remaining - toLeave(start, target.s);
      if (d >= -(opts.behind ?? 0)) return { path: [start], distance: d };
    }
    interface Node {
      h: Heading;
      /** Counting the extra cost. */
      cost: number;
      dist: number;
      prev: Node | null;
    }
    const best = new Map<string, number>();
    const heap = new Heap<Node>((a, b) => a.cost - b.cost);
    heap.push({ h: start, cost: remaining, dist: remaining, prev: null });
    best.set(headingKey(start), remaining);
    let found: { node: Node; cost: number; dist: number } | null = null;
    for (let node = heap.pop(); node; node = heap.pop()) {
      if (found && node.cost >= found.cost) break;
      if (node.cost > (best.get(headingKey(node.h)) ?? Infinity)) continue;
      for (const w of this.ways(node.h).next) {
        if (w.switchKey && opts.fixed?.has(w.switchKey) && opts.fixed.get(w.switchKey) !== w.index) continue;
        const extra = cost(w.edge);
        if (w.edge.key === target.edgeKey) {
          const into = w.edge.length - toLeave(w, target.s);
          const c = node.cost + extra + into;
          if (!found || c < found.cost) found = { node: { h: w, cost: c, dist: node.dist + into, prev: node }, cost: c, dist: node.dist + into };
        }
        const next: Node = { h: w, cost: node.cost + extra + w.edge.length, dist: node.dist + w.edge.length, prev: node };
        const k = headingKey(w);
        if (next.cost < (best.get(k) ?? Infinity)) {
          best.set(k, next.cost);
          heap.push(next);
        }
      }
    }
    if (!found) return null;
    const path: Heading[] = [];
    for (let n: Node | null = found.node; n; n = n.prev) path.unshift(n.h);
    return { path, distance: found.dist };
  }
}

/** A small binary heap. */
class Heap<T> {
  private readonly items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => number) {}
  push(item: T): void {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (this.less(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.less(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** What the dispatcher worked out for one train this frame. */
interface Control {
  /** Which way along its route the train was running. */
  dir: 1 | -1;
  /** Switches it has reserved and set, held that way until it is past them. */
  sticky: Map<string, number>;
  /** Where along its route its front must stop: short of a held piece or the end of the track. */
  stopFront: number | null;
  /** Where along its route its middle (or front) stops at the destination. */
  arrive: { u: number; ref: 'middle' | 'front' } | null;
}

/** How far along its route a run of vehicles reaches. */
function span(train: Train): { front: number; back: number } {
  return {
    front: Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2)),
    back: Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2)),
  };
}

/** Which way along its route a train's engines drive it: +1, -1, or 0 when off or fighting. */
export function driveDir(train: Train): 1 | -1 | 0 {
  if (!train.throttle) return 0;
  return Math.sign(train.vehicles.reduce((sum, v) => sum + (v.def.motor ? train.throttle * v.facing : 0), 0)) as 1 | -1 | 0;
}

/** Keeps trains apart and sets switches for them, every frame while autoroute is on. */
export class Dispatcher {
  graph: RouteGraph;
  /** Which train holds each piece, by piece uid. */
  readonly holds = new Map<string, number>();
  /** Trains that got where they were sent, newest last. */
  readonly arrivals: Arrival[] = [];
  private readonly controls = new Map<number, Control>();

  constructor(private readonly sim: TrainSim) {
    this.graph = new RouteGraph(sim.network);
  }

  /** The track changed: find the ways afresh. */
  rebuild(): void {
    this.graph = new RouteGraph(this.sim.network);
    this.holds.clear();
    for (const c of this.controls.values()) c.sticky.clear();
  }

  /** Let go of everything: autoroute is off. */
  clear(): void {
    this.holds.clear();
    this.controls.clear();
  }

  /** Everywhere a train can be sent: places beside the track, stations, the loader and cranes. */
  destinations(): DestinationPoint[] {
    const out: DestinationPoint[] = [];
    for (const p of this.sim.places) {
      if (p.place.pass) continue;
      out.push({ uid: p.uid, name: p.place.name, at: p.at, edgeKey: p.edgeKey, s: p.s });
    }
    const NAMES = { station: 'Station', loader: 'Cargo loader', crane: 'Crane' } as const;
    for (const a of this.sim.accessories) {
      if (a.kind !== 'station' && a.kind !== 'loader' && a.kind !== 'crane') continue;
      out.push({ uid: a.uid, name: NAMES[a.kind], at: a.at, edgeKey: a.edgeKey, s: (a.from + a.to) / 2 });
    }
    // Tell apart places of the same kind.
    const counts = new Map<string, number>();
    for (const d of out) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const d of out) {
      if (counts.get(d.name)! < 2) continue;
      const n = (seen.get(d.name) ?? 0) + 1;
      seen.set(d.name, n);
      d.name = `${d.name} ${n}`;
    }
    return out;
  }

  private target(dest: Destination): { edgeKey: string; s: number; name: string; uid: string | null } | null {
    if (dest.kind === 'track') {
      const edge = this.sim.network.edge(dest.edgeKey);
      return edge ? { edgeKey: dest.edgeKey, s: Math.min(Math.max(dest.s, 0), edge.length), name: 'the spot', uid: null } : null;
    }
    const d = this.destinations().find((p) => p.uid === dest.uid);
    return d ? { edgeKey: d.edgeKey, s: d.s, name: d.name, uid: d.uid } : null;
  }

  /** Send a train somewhere. Returns an error message, or null once it is on its way. */
  routeTo(trainId: number, dest: Destination, opts: RouteOptions = {}): string | null {
    const train = this.sim.train(trainId);
    if (!train) return 'That train has gone.';
    if (train.wrecked) return `Put ${train.name} back on the rails first.`;
    const facing = Math.sign(train.vehicles.reduce((s, v) => s + (v.def.motor ? v.facing : 0), 0));
    if (!train.vehicles.some((v) => v.def.motor)) return `${train.name} has no engine to drive it.`;
    if (!facing) return `${train.name}'s engines face both ways. Turn one round first.`;
    const target = this.target(dest);
    if (!target) return 'That place isn’t on the track.';
    const align = opts.align ?? 'middle';
    // Whichever way round is shorter: on ahead, or backing up.
    let best: { dir: 1 | -1; distance: number } | null = null;
    for (const dir of [1, -1] as const) {
      const way = this.wayTo(train, dir, target, align, null);
      if (way && (!best || Math.abs(way.distance) < Math.abs(best.distance))) best = { dir, distance: way.distance };
    }
    const name = target.uid ? `the ${target.name.charAt(0).toLowerCase()}${target.name.slice(1)}` : target.name;
    if (!best) return `There’s no way from where ${train.name} is to ${name}.`;
    this.sim.autoroute = true;
    train.dispatch = { dest, name, align, keepRunning: !!opts.keepRunning, state: 'travelling', distance: Math.max(0, best.distance) };
    this.controls.delete(train.id);
    this.sim.setThrottle(train.id, (best.dir * facing) as 1 | -1);
    return null;
  }

  /** Forget where a train was going. It runs on under the dispatcher's care. */
  clearRoute(trainId: number): void {
    const train = this.sim.train(trainId);
    if (train) train.dispatch = null;
  }

  /**
   * How far a train running `dir` along its route has to go to line up with
   * the target, and the way there from its leading end (null when it is
   * already alongside), or null if it can't get there.
   */
  private wayTo(train: Train, dir: 1 | -1, target: { edgeKey: string; s: number }, align: 'middle' | 'front', control: Control | null): { distance: number; path: Heading[] | null } | null {
    const { front, back } = span(train);
    const f = dir > 0 ? front : back;
    const mid = (front + back) / 2;
    if (align === 'middle') {
      // Already alongside? (Just past the middle counts: it stops there.)
      const tail = dir > 0 ? back : front;
      let d: number | null = null;
      for (const seg of train.route.segments) {
        if (seg.edge.key !== target.edgeKey) continue;
        const u = seg.u0 + (seg.reversed ? seg.edge.length - target.s : target.s);
        const dm = (u - mid) * dir;
        if ((u - tail) * dir >= 0 && (u - f) * dir <= 0 && (d === null || Math.abs(dm) < Math.abs(d))) d = dm;
      }
      if (d !== null) return { distance: d, path: null };
    }
    const { start, remaining } = this.startOf(train, dir);
    const plan = this.graph.plan(start, remaining, target, {
      cost: (e) => (this.heldByOther(e.uid, train.id) || this.turnedAway(e) ? DISPATCH.busyCost : 0),
      fixed: control?.sticky,
      behind: align === 'front' ? DISPATCH.arriveMm * 2 : 0,
    });
    if (!plan) return null;
    return { distance: plan.distance + (align === 'middle' ? Math.abs(f - mid) : 0), path: plan.path };
  }

  /** The heading a train's leading end is on, running `dir`, and how far that end is from the heading's end. */
  private startOf(train: Train, dir: 1 | -1): { start: Heading; remaining: number; f: number } {
    const { front, back } = span(train);
    const f = dir > 0 ? front : back;
    const seg = train.route.segmentAt(f);
    const start: Heading = { edge: seg.edge, leave: (dir > 0) !== seg.reversed ? 1 : 0 };
    const remaining = Math.max(0, dir > 0 ? seg.u0 + seg.edge.length - f : f - seg.u0);
    return { start, remaining, f };
  }

  /** A line across a turntable whose bridge isn't turned to it: the train would wait there. */
  private turnedAway(edge: Edge): boolean {
    return this.sim.turntables.some((t) => t.uid === edge.uid) && !this.sim.linedUp(edge.uid, edge.index);
  }

  private heldByOther(uid: string, trainId: number): boolean {
    const holder = this.holds.get(uid);
    return holder !== undefined && holder !== trainId;
  }

  /** Every frame: hold, reserve and set switches, and see who has arrived. */
  update(): void {
    const trains = this.sim.trains;
    const ids = new Set(trains.map((t) => t.id));
    for (const [uid, id] of this.holds) if (!ids.has(id)) this.holds.delete(uid);
    for (const id of this.controls.keys()) if (!ids.has(id)) this.controls.delete(id);
    // Every train holds the pieces it stands on.
    const under = new Map<number, Set<string>>();
    for (const t of trains) {
      const { front, back } = span(t);
      const uids = new Set(t.route.segments.filter((s) => s.u0 + s.edge.length > back - 2 && s.u0 < front + 2).map((s) => s.edge.uid));
      under.set(t.id, uids);
      for (const uid of uids) this.holds.set(uid, t.id);
    }
    for (const t of trains) this.lookAhead(t, under);
  }

  private lookAhead(train: Train, under: Map<number, Set<string>>): void {
    const mine = under.get(train.id)!;
    const reserved = new Set<string>();
    const release = () => {
      for (const [uid, id] of this.holds) if (id === train.id && !mine.has(uid) && !reserved.has(uid)) this.holds.delete(uid);
    };
    train.waitReason = null;
    const dir = driveDir(train);
    if (!dir || train.wrecked) {
      this.controls.delete(train.id);
      release();
      return;
    }
    let control = this.controls.get(train.id);
    if (!control || control.dir !== dir) {
      control = { dir, sticky: new Map(), stopFront: null, arrive: null };
      this.controls.set(train.id, control);
    }
    control.stopFront = null;
    control.arrive = null;
    const { start, remaining, f } = this.startOf(train, dir);
    const { front, back } = span(train);
    const mid = (front + back) / 2;

    // Where it's going, and the way there.
    let path: Heading[] | null = null;
    let travel = Infinity;
    const dispatch = train.dispatch;
    if (dispatch && dispatch.state !== 'arrived') {
      const target = this.target(dispatch.dest);
      // Work at the place itself (loading at a mine, a station stop) finishes first; then it has arrived.
      const here = target?.uid ?? null;
      const working = here !== null && (train.stop?.uid === here || (train.hold?.uid === here && train.hold.until != null));
      if (working) dispatch.working = true;
      const way = target && this.wayTo(train, dir, target, dispatch.align, control);
      if (target && dispatch.working && !working) return this.arrive(train, target, release);
      if (!target || !way) {
        // Lining up for the work there can take it past the spot; that's no reason to give up.
        if (!dispatch.working) dispatch.state = 'no-route';
      } else {
        if (dispatch.state === 'no-route') dispatch.state = 'travelling';
        dispatch.distance = Math.max(0, way.distance);
        travel = way.distance;
        const ref = dispatch.align === 'middle' ? mid : f;
        control.arrive = { u: ref + way.distance * dir, ref: dispatch.align };
        path = way.path;
        const still = train.vehicles.every((v) => Math.abs(v.v) < 1);
        if (way.distance <= DISPATCH.arriveMm && still && !working && !train.hold) return this.arrive(train, target, release);
      }
    }

    // Another train on the piece it is on, ahead of it.
    for (const other of this.sim.trains) {
      if (other === train || !under.get(other.id)!.has(start.edge.uid)) continue;
      const ahead = this.ahead(train, dir, f, other);
      if (ahead !== null && (control.stopFront === null || ahead - DISPATCH.gapMm < (control.stopFront - f) * dir)) {
        control.stopFront = f + (ahead - DISPATCH.gapMm) * dir;
        train.waitReason = `Waiting for ${other.name}`;
      }
    }

    // Reserve the way ahead, far enough to stop in, and on through the next
    // switch that splits the line and down the way it takes there, up to the
    // switch at its far end: like a signalman handing over the single line
    // from one passing loop to the next. A train never waits halfway along
    // single track, where one coming the other way could meet it head on.
    const speed = Math.max(...train.vehicles.map((v) => Math.abs(v.v)));
    const need = Math.min((speed * speed) / (2 * DISPATCH.brake) + speed * 0.1 + DISPATCH.marginMm, travel + 20);
    const sticky = new Map<string, number>();
    let h: Heading = start;
    let d = remaining;
    let k = 0;
    let split = false;
    for (;;) {
      if (d >= need && (d >= DISPATCH.sectionMm || d >= travel + 20)) break;
      const { next, end } = this.graph.ways(h);
      if (!next.length) {
        if (end === 'open') {
          this.stopAt(control, f, dir, d - DISPATCH.gapMm);
          if (!train.waitReason) train.waitReason = 'Stopped before the end of the track';
        }
        break;
      }
      if (d >= need && split && this.graph.switchUids.has(next[0].edge.uid) && next[0].edge.uid !== h.edge.uid) break;
      let pick = next[0];
      if (next.length > 1) {
        const key = next[0].switchKey!;
        const planned = path && path[k] && headingKey(path[k]) === headingKey(h) && path[k + 1] ? next.find((w) => headingKey(w) === headingKey(path![k + 1])) : undefined;
        pick = planned ?? next[control.sticky.get(key) ?? this.chooseClear(train, next, key)] ?? next[0];
      }
      // Round a loop to its own track.
      if (reserved.has(pick.edge.uid) && d >= need) break;
      const holder = this.holds.get(pick.edge.uid);
      if (holder !== undefined && holder !== train.id) {
        this.stopAt(control, f, dir, d - DISPATCH.gapMm);
        train.waitReason = `Waiting for ${this.sim.train(holder)?.name ?? 'another train'}`;
        break;
      }
      this.holds.set(pick.edge.uid, train.id);
      reserved.add(pick.edge.uid);
      if (pick.switchKey) {
        sticky.set(pick.switchKey, pick.index);
        this.sim.setLever(pick.switchKey, pick.index, next.length);
      }
      if (path && path[k + 1] && headingKey(path[k + 1]) === headingKey(pick)) k++;
      else path = null;
      if (next.length > 1) split = true;
      h = pick;
      d += pick.edge.length;
    }
    control.sticky = sticky;
    release();
    if (dispatch && dispatch.state !== 'arrived' && dispatch.state !== 'no-route') {
      const waiting = train.waitReason !== null && control.stopFront !== null && (control.stopFront - f) * dir < 5;
      dispatch.state = waiting ? 'waiting' : 'travelling';
    }
  }

  private arrive(train: Train, target: { uid: string | null; name: string }, release: () => void): void {
    const dispatch = train.dispatch!;
    dispatch.state = 'arrived';
    dispatch.distance = 0;
    dispatch.working = false;
    this.arrivals.push({ trainId: train.id, uid: target.uid, name: target.name, time: this.sim.time });
    if (this.arrivals.length > 20) this.arrivals.shift();
    if (!dispatch.keepRunning) this.sim.setThrottle(train.id, 0);
    this.controls.delete(train.id);
    release();
  }

  private stopAt(control: Control, f: number, dir: 1 | -1, d: number): void {
    const u = f + d * dir;
    if (control.stopFront === null || (u - control.stopFront) * dir < 0) control.stopFront = u;
  }

  /** How far ahead of the train's leading end (at `f`, running `dir`) the nearest end of another train is, along its route. */
  private ahead(train: Train, dir: 1 | -1, f: number, other: Train): number | null {
    let best: number | null = null;
    for (const v of other.vehicles) {
      const seg = other.route.segmentAt(v.u);
      const along = v.u - seg.u0;
      const s = seg.reversed ? seg.edge.length - along : along;
      for (const mine of train.route.segments) {
        if (mine.edge.key !== seg.edge.key) continue;
        const u = mine.u0 + (mine.reversed ? mine.edge.length - s : s);
        const d = (u - f) * dir - v.def.length / 2;
        if (d > -v.def.length / 2 && (best === null || d < best)) best = Math.max(0, d);
      }
    }
    return best;
  }

  /** At a facing switch with no plan: the lever's way if it's clear, or another way that's clear and leads on. */
  private chooseClear(train: Train, next: Way[], key: string): number {
    const lever = (this.sim.levers.get(key) ?? 0) % next.length;
    if (this.isClear(train, next[lever])) return lever;
    const other = next.findIndex((w, i) => i !== lever && this.graph.live.has(headingKey(w)) && this.isClear(train, w));
    return other >= 0 ? other : lever;
  }

  /** Whether the way on from `h`, following the levers, is free of other trains for a little way. */
  private isClear(train: Train, h: Heading): boolean {
    let d = 0;
    for (let at: Heading | undefined = h; at && d < DISPATCH.clearLookMm; ) {
      if (this.heldByOther(at.edge.uid, train.id)) return false;
      d += at.edge.length;
      const { next } = this.graph.ways(at);
      at = next.length > 1 ? next[(this.sim.levers.get(next[0].switchKey!) ?? 0) % next.length] : next[0];
    }
    return true;
  }

  /**
   * How far a train may still run this step before it must stand: to the
   * stop short of a held piece, or to its destination. Null when nothing
   * holds it back.
   */
  room(train: Train, dir: number): number | null {
    const c = this.controls.get(train.id);
    if (!c || !dir || c.dir !== dir) return null;
    const { front, back } = span(train);
    const f = dir > 0 ? front : back;
    let d = Infinity;
    if (c.stopFront !== null) d = Math.min(d, (c.stopFront - f) * dir);
    // A stop beside the track, or at the station or loader it was sent to, lines the train up itself.
    const dest = train.dispatch?.dest;
    const lining = !!train.stop || (!!train.hold && dest?.kind === 'place' && train.hold.uid === dest.uid);
    if (c.arrive && !lining) d = Math.min(d, (c.arrive.u - (c.arrive.ref === 'middle' ? (front + back) / 2 : f)) * dir);
    return d === Infinity ? null : d;
  }

  /** The highest speed that still stops within `room` mm. */
  static cap(room: number): number {
    return Math.max(DISPATCH.creep, Math.sqrt(2 * DISPATCH.brake * Math.max(0, room)));
  }
}
