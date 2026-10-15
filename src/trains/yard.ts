import { distance, type Vec2 } from '../geometry/pose';
import { headingKey, type Heading } from './dispatch';
import { JOB_TRAIN, JOBS, getJob, jobConsist, type JobId } from './jobs';
import { edgeEndPose, type Edge } from './network';
import { getStock, type ConsistEntry } from './stock';
import type { Train, TrainSim } from './sim';

// Yard work. Car sidings keep spare cars, parked in short rakes, one rake
// for a job each. When the jobs want another train and there's a rake for
// it, an engine comes out of the engine shed instead of a whole train
// appearing: it runs onto the shed's turntable, which turns it to face the
// way out, runs out past the sidings, backs onto the rake, couples up and
// goes to work. The turntables turn by themselves for any routed train
// (see dispatch.ts); here they also turn an engine round on the bridge.

/** Tunable choices, not measurements. */
export const YARD = {
  /** Room left between parked rakes, and at the buffer stop, mm. */
  gapMm: 40,
  /** Rakes stop this far short of the open end of the sidings, mm, clear of the turntable or switch. */
  clearMm: 60,
  /** How far an engine looks for somewhere to stop and back into the sidings from, mm. */
  lookMm: 12000,
  /** And backs no further than this to get there, mm. */
  backMm: 3000,
  /** An engine comes out of the shed this far back from the middle of the shed road, mm. */
  shedBackMm: 12,
  /** Gives up an errand that hasn't got anywhere in this long, seconds. */
  giveUpSeconds: 120,
};

/** A rake of spare cars standing in the sidings, and the job it is for. */
interface Rake {
  trainId: number;
  job: JobId;
  /** The car sidings it stands at, and how far out from the buffer stop. */
  sidings: string;
  d: number;
}

type Phase = 'to-table' | 'on-table' | 'turning' | 'to-reverse' | 'back-on' | 'done';

interface Errand {
  trainId: number;
  rakeId: number;
  job: JobId;
  phase: Phase;
  /** The shed's turntable and the line the engine drives onto it by. */
  table: { uid: string; line: number } | null;
  /** When it last moved on a phase, to give up on one that's stuck. */
  since: number;
}

export class Yard {
  private rakes: Rake[] = [];
  private errands: Errand[] = [];
  /** The sidings have been filled since jobs were last switched on. */
  stocked = false;

  constructor(private readonly sim: TrainSim) {}

  /** Forget everything: the track changed or the trains were cleared. */
  reset(): void {
    this.rakes = [];
    this.errands = [];
    this.stocked = false;
  }

  /** Call off every errand: the trains were put back where they started. */
  stop(): void {
    for (const e of this.errands) {
      const t = this.sim.train(e.trainId);
      if (t) (t.errand = false), (t.coupleTo = null);
    }
    this.errands = [];
  }

  /** Rakes still standing in the sidings, by job. */
  spares(): Map<JobId, number> {
    const out = new Map<JobId, number>();
    for (const r of this.live()) out.set(r.job, (out.get(r.job) ?? 0) + 1);
    return out;
  }

  /** Engines out fetching cars. */
  get busy(): number {
    return this.errands.length;
  }

  private live(): Rake[] {
    this.rakes = this.rakes.filter((r) => this.sim.train(r.trainId) && !this.errands.some((e) => e.rakeId === r.trainId) && !this.sim.train(r.trainId)!.vehicles.some((v) => v.def.motor));
    return this.rakes;
  }

  // ---- filling the sidings ----------------------------------------------------

  /** Jobs this layout has work for, the ones it's likeliest to want first. */
  private jobs(): JobId[] {
    const places = this.sim.places.map((p) => p.place);
    return JOBS.filter((j) => j.id !== 'free' && j.id !== 'workers' && j.goods.some((g) => places.some((p) => p.loads?.includes(g)) && places.some((p) => p.unloads?.includes(g)))).map((j) => j.id);
  }

  /** Park rakes of spare cars along every car sidings, one job after another. */
  stock(): number {
    this.stocked = true;
    const jobs = this.jobs();
    if (!jobs.length) return 0;
    let n = 0;
    let turn = 0;
    for (const point of this.sim.places.filter((p) => p.place.spares)) {
      const road = this.road(point.edgeKey);
      if (!road) continue;
      let d = YARD.gapMm;
      for (;;) {
        const job = jobs[turn % jobs.length];
        const consist = jobConsist(job).filter((c) => !getStock(c.stockId).motor && c.stockId !== JOB_TRAIN.tender);
        const length = consist.reduce((s, c) => s + getStock(c.stockId).length, 0) + consist.length;
        if (d + length > road.length - YARD.clearMm) break;
        const at = road.at(d + length / 2);
        const train = this.sim.addTrain(consist, { edgeKey: at.edge.key, s: at.s, reversed: at.reversed }, `Spare ${getJob(job).name.toLowerCase()} cars`);
        if (typeof train === 'string') break;
        this.rakes.push({ trainId: train.id, job, sidings: point.uid, d });
        d += length + YARD.gapMm;
        turn++;
        n++;
      }
    }
    return n;
  }

  /**
   * The dead-end road a car sidings stands by, from its buffer stop out to
   * the first switch or turntable, and a way to find a spot `d` mm out from
   * the buffer: the edge, how far along its path, and whether a rake there
   * faces the path's start (its front toward the way out).
   */
  private road(edgeKey: string): { length: number; at: (d: number) => { edge: Edge; s: number; reversed: boolean } } | null {
    const graph = this.sim.dispatcher.graph;
    const first = this.sim.network.edge(edgeKey);
    if (!first || graph.switchUids.has(first.uid)) return null;
    const plain = (e: Edge) => !graph.switchUids.has(e.uid) && !this.sim.turntables.some((t) => t.uid === e.uid);
    // Which way is the buffer stop?
    const walk = (h: Heading): { path: Heading[]; end: 'buffer' | 'open' | null } => {
      const path: Heading[] = [h];
      for (let i = 0; i < 40; i++) {
        const { next, end } = graph.ways(path[path.length - 1]);
        if (next.length !== 1 || !plain(next[0].edge)) return { path, end: next.length ? null : end };
        path.push(next[0]);
      }
      return { path, end: null };
    };
    for (const leave of [0, 1] as const) {
      const deep = walk({ edge: first, leave });
      if (deep.end !== 'buffer') continue;
      const out = walk({ edge: first, leave: leave === 1 ? 0 : 1 });
      // From the buffer stop outwards: each heading runs away from the buffer.
      const headings: Heading[] = [...deep.path].reverse().map((h) => ({ edge: h.edge, leave: h.leave === 1 ? 0 : 1 }));
      headings.push(...out.path.slice(1));
      const length = headings.reduce((s, h) => s + h.edge.length, 0);
      return {
        length,
        at: (d: number) => {
          for (const h of headings) {
            if (d <= h.edge.length) return { edge: h.edge, s: h.leave === 1 ? d : h.edge.length - d, reversed: h.leave === 0 };
            d -= h.edge.length;
          }
          const h = headings[headings.length - 1];
          return { edge: h.edge, s: h.leave === 1 ? h.edge.length : 0, reversed: h.leave === 0 };
        },
      };
    }
    return null;
  }

  // ---- fetching ---------------------------------------------------------------

  /**
   * Bring out an engine from the engine shed to fetch the spare cars for
   * `job`. Returns the engine, or null if there's no rake for it, no shed,
   * or the shed's way out is blocked.
   */
  fetch(job: JobId): Train | null {
    // Only the rake nearest the way out can be reached: the others wait behind it.
    const live = this.live();
    const rake = live.find((r) => r.job === job && !live.some((o) => o.sidings === r.sidings && o.d > r.d));
    if (!rake) return null;
    const consist: ConsistEntry[] = jobConsist(job, 0);
    for (const shed of this.sim.network.layout.pieces.filter((p) => p.pieceId === 'engine-shed')) {
      const near = this.sim.nearestTrack(shed.pose, 30);
      if (!near) continue;
      // One at a time out of each shed.
      if (this.errands.some((e) => this.sim.train(e.trainId) && distance(this.sim.train(e.trainId)!.vehicles[0].geo.center, shed.pose) < 300)) continue;
      for (const reversed of [false, true]) {
        const edge = near.edge;
        // Back from the far end of the shed road a little, clear of whatever it leads onto.
        const train = this.sim.addTrain(consist, { edgeKey: edge.key, s: edge.length / 2 + (reversed ? 1 : -1) * YARD.shedBackMm, reversed }, undefined, job);
        if (typeof train === 'string') continue;
        // Facing out of the shed: onto its turntable, or on along the track.
        const ahead = this.ahead(train);
        const table = ahead ? this.tableAhead(ahead) : null;
        const clear = this.sim.trains.every((o) => o === train || o.vehicles.every((v) => train.vehicles.every((w) => distance(v.geo.center, w.geo.center) > (v.def.length + w.def.length) / 2 + 20)));
        if (!clear || (!table && (!ahead || !this.sim.dispatcher.graph.live.has(headingKey(ahead))))) {
          this.sim.removeTrain(train.id);
          continue;
        }
        train.name = `${getJob(job).name} train ${train.id}`;
        train.errand = true;
        this.errands.push({ trainId: train.id, rakeId: rake.trainId, job, phase: table ? 'to-table' : 'to-reverse', table, since: this.sim.time });
        return train;
      }
    }
    return null;
  }

  /** The heading a train's engine faces along, from its leading end. */
  private ahead(train: Train): Heading | null {
    const engine = train.vehicles.find((v) => v.def.motor);
    if (!engine) return null;
    const dir = engine.facing;
    const u = dir > 0 ? Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2)) : Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
    const seg = train.route.segmentAt(u);
    return { edge: seg.edge, leave: (dir > 0) !== seg.reversed ? 1 : 0 };
  }

  /** The turntable line a heading runs onto, past plain track, if it comes to one. */
  private tableAhead(h: Heading): { uid: string; line: number } | null {
    const graph = this.sim.dispatcher.graph;
    for (let i = 0; i < 6; i++) {
      if (this.sim.turntables.some((t) => t.uid === h.edge.uid)) return { uid: h.edge.uid, line: h.edge.index };
      const { next } = graph.ways(h);
      if (next.length !== 1) return null;
      h = next[0];
    }
    return null;
  }

  tick(): void {
    for (const errand of [...this.errands]) this.step(errand);
  }

  private finish(errand: Errand, train: Train | undefined): void {
    this.errands = this.errands.filter((e) => e !== errand);
    if (!train) return;
    train.errand = false;
    train.coupleTo = null;
  }

  private step(errand: Errand): void {
    const sim = this.sim;
    const train = sim.train(errand.trainId);
    if (!train || train.wrecked) return this.finish(errand, train);
    const rake = sim.train(errand.rakeId);
    const moved = (phase: Phase) => {
      errand.phase = phase;
      errand.since = sim.time;
    };
    if (sim.time - errand.since > YARD.giveUpSeconds) {
      // Stuck somewhere: let it get on with its job as it is (the operator sees to it from there).
      return this.finish(errand, train);
    }
    switch (errand.phase) {
      case 'to-table': {
        const t = errand.table!;
        const edge = sim.network.edge(`${t.uid}:${t.line}`)!;
        if (!train.dispatch || train.dispatch.dest.kind !== 'track' || train.dispatch.dest.edgeKey !== edge.key) {
          if (sim.routeTo(train.id, { kind: 'track', edgeKey: edge.key, s: edge.length / 2 }, { ahead: true })) return this.finish(errand, train);
          return;
        }
        if (train.dispatch.state === 'arrived') moved('on-table');
        return;
      }
      case 'on-table': {
        // On the bridge: turn it to face whichever way out leads on to the sidings.
        const t = errand.table!;
        const exit = this.wayOut(train, t.uid);
        if (!exit) return this.finish(errand, train);
        const err = sim.lineUp(t.uid, exit.line, { train, toward: exit.toward });
        if (err) return;
        moved('turning');
        return;
      }
      case 'turning': {
        const state = sim.tables.get(errand.table!.uid);
        if (!state || state.angle !== state.target || state.riders.length) return;
        moved('to-reverse');
        return;
      }
      case 'to-reverse': {
        if (!rake) return this.finish(errand, train);
        // On its way to somewhere to back in from.
        const d = train.dispatch;
        if (d && d.state !== 'arrived' && d.state !== 'no-route') return;
        // From here, a short way back onto the cars?
        train.coupleTo = rake.id;
        if (!sim.routeTo(train.id, this.rakeSpot(rake), { back: true }) && train.dispatch!.distance <= YARD.backMm) return moved('back-on');
        train.coupleTo = null;
        sim.clearRoute(train.id);
        const spot = this.reverseSpot(train, rake);
        if (!spot || sim.routeTo(train.id, spot, { ahead: true })) return this.finish(errand, train);
        return;
      }
      case 'back-on': {
        // Coupled: the cars have joined it.
        if (!rake || rake.vehicles.length === 0) {
          sim.clearRoute(train.id);
          sim.setThrottle(train.id, 0);
          train.destination = null;
          sim.notice(train, `${train.name} has coupled up to its cars in the yard and is off to work.`, train.vehicles[0].geo.center);
          return this.finish(errand, train);
        }
        if (!train.dispatch || train.dispatch.state === 'no-route') {
          train.coupleTo = rake.id;
          if (sim.routeTo(train.id, this.rakeSpot(rake), { back: true })) moved('to-reverse');
        }
        return;
      }
      case 'done':
        return this.finish(errand, train);
    }
  }

  /** The middle of a parked rake, to back onto. */
  private rakeSpot(rake: Train): { kind: 'track'; edgeKey: string; s: number } {
    const mid = (Math.max(...rake.vehicles.map((v) => v.u)) + Math.min(...rake.vehicles.map((v) => v.u))) / 2;
    const seg = rake.route.segmentAt(mid);
    const along = mid - seg.u0;
    return { kind: 'track', edgeKey: seg.edge.key, s: seg.reversed ? seg.edge.length - along : along };
  }

  /**
   * Which line to turn the bridge to, and the end to face, for an engine
   * standing on it: one that leads on to track it can run round for ever,
   * and the same way round as the other job trains if it can.
   */
  private wayOut(train: Train, uid: string): { line: number; toward: Vec2 } | null {
    const graph = this.sim.dispatcher.graph;
    const table = this.sim.turntables.find((t) => t.uid === uid);
    if (!table) return null;
    const others = this.sim.trains.filter((t) => t !== train && t.job !== 'free' && !t.errand && !t.wrecked);
    const theirs = others.map((t) => this.ahead(t)).filter((h): h is Heading => !!h).map(headingKey);
    let best: { line: number; toward: Vec2; score: number } | null = null;
    table.lines.forEach((l, line) => {
      const edge = this.sim.network.edge(l.edgeKey);
      if (!edge) return;
      for (const leave of [0, 1] as const) {
        const h: Heading = { edge, leave };
        const next = graph.ways(h).next;
        if (!next.length || !graph.live.has(headingKey(next[0]))) continue;
        // Same way round as the trains already out, if there are any.
        let same = !theirs.length;
        const seen = new Set<string>();
        const queue = [next[0]];
        while (queue.length && !same) {
          const q = queue.pop()!;
          const k = headingKey(q);
          if (seen.has(k)) continue;
          seen.add(k);
          if (theirs.includes(k)) same = true;
          queue.push(...graph.ways(q).next);
        }
        const p = edgeEndPose(edge, leave);
        const score = same ? 0 : 1;
        if (!best || score < best.score) best = { line, toward: { x: p.x, y: p.y }, score };
      }
    });
    return best;
  }

  /**
   * Somewhere ahead to stop and back into the sidings from: the nearest
   * stretch of plain track (no switch) the engine fits on, from which backing
   * up leads to the rake.
   */
  private reverseSpot(train: Train, rake: Train): { kind: 'track'; edgeKey: string; s: number } | null {
    const graph = this.sim.dispatcher.graph;
    const start = this.ahead(train);
    if (!start) return null;
    const length = train.vehicles.reduce((s, v) => s + v.def.length, 0) + 20;
    const target = this.rakeSpot(rake);
    const plain = (e: Edge) => !graph.switchUids.has(e.uid) && !this.sim.turntables.some((t) => t.uid === e.uid);
    /** A point `back` mm behind the end of the last heading in `run`, as a heading backing away from it and how far that heading has left. */
    const behind = (run: Heading[], back: number): { h: Heading; left: number } | null => {
      for (let i = run.length - 1; i >= 0; i--) {
        if (back <= run[i].edge.length) return { h: run[i], left: back };
        back -= run[i].edge.length;
      }
      return null;
    };
    interface Node {
      h: Heading;
      d: number;
      /** The plain track run onto, up to and including this heading. */
      run: Heading[];
    }
    const seen = new Set<string>();
    let frontier: Node[] = [{ h: start, d: 0, run: [] }];
    let best: { spot: { kind: 'track'; edgeKey: string; s: number }; cost: number } | null = null;
    while (frontier.length) {
      const next: Node[] = [];
      for (const node of frontier) {
        for (const w of graph.ways(node.h).next) {
          const k = headingKey(w);
          if (seen.has(k)) continue;
          seen.add(k);
          const d = node.d + w.edge.length;
          if (d > YARD.lookMm) continue;
          const run = plain(w.edge) ? [...node.run, w] : [];
          next.push({ h: w, d, run });
          if (run.reduce((s, h) => s + h.edge.length, 0) < length) continue;
          // Stopped with its rear end `length` back from the end of this piece, backing out the way it came.
          const rear = behind(run, length);
          const mid = behind(run, length / 2);
          if (!rear || !mid) continue;
          const back: Heading = { edge: rear.h.edge, leave: rear.h.leave === 1 ? 0 : 1 };
          const plan = graph.plan(back, rear.h.edge.length - rear.left, target);
          if (!plan || plan.distance > YARD.backMm) continue;
          const cost = d + plan.distance;
          const s = mid.h.leave === 1 ? mid.h.edge.length - mid.left : mid.left;
          if (!best || cost < best.cost) best = { spot: { kind: 'track', edgeKey: mid.h.edge.key, s }, cost };
        }
      }
      frontier = next;
    }
    return best?.spot ?? null;
  }
}
