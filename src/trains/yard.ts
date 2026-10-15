import { distance, type Vec2 } from '../geometry/pose';
import { headingKey, type Destination, type Heading } from './dispatch';
import { ECONOMY, roomFor, staffOf, unitsOf } from './economy';
import { carrying, JOB_TRAIN, JOBS, getJob, jobConsist, suppliesGoods, takesGoods, type JobId } from './jobs';
import { edgeEndPose, type Edge } from './network';
import { getStock, type CargoKind, type ConsistEntry } from './stock';
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
  /** Leave a short pause between jobs before putting the wagons away. */
  idleSeconds: 12,
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

interface Return {
  trainId: number;
  job: JobId;
  sidings: string;
  road: string;
  d: number;
  target: Extract<Destination, { kind: 'track' }>;
  phase: 'to-reverse' | 'back-in' | 'leave' | 'to-shed';
  since: number;
}

export class Yard {
  private rakes: Rake[] = [];
  private errands: Errand[] = [];
  private returns: Return[] = [];
  private idleSince = new Map<number, number>();
  /** Roads already stocked, by siding uid and track geometry, including roads whose cars have been fetched. */
  private stockedRoads = new Map<string, string>();
  /** The sidings have been filled since jobs were last switched on. */
  stocked = false;

  constructor(private readonly sim: TrainSim) {}

  /** Forget everything: the track changed or the trains were cleared. */
  reset(): void {
    this.rakes = [];
    this.errands = [];
    this.returns = [];
    this.idleSince.clear();
    this.stockedRoads.clear();
    this.stocked = false;
  }

  /** Call off every errand: the trains were put back where they started. */
  stop(): void {
    for (const e of [...this.errands, ...this.returns]) {
      const t = this.sim.train(e.trainId);
      if (t) {
        t.errand = false;
        t.coupleTo = null;
        this.sim.clearRoute(t.id);
        this.sim.setThrottle(t.id, 0);
      }
    }
    this.errands = [];
    this.returns = [];
    this.idleSince.clear();
  }

  /** Rakes still standing in the sidings, by job. */
  spares(): Map<JobId, number> {
    const out = new Map<JobId, number>();
    for (const r of this.live()) {
      if (this.errands.some((e) => e.rakeId === r.trainId)) continue;
      out.set(r.job, (out.get(r.job) ?? 0) + 1);
    }
    return out;
  }

  /** Wagons and the goods still aboard them, for the siding's badge. */
  inventory(uid: string): { cars: number; cargo: Partial<Record<CargoKind, number>> } {
    let cars = 0;
    const cargo: Partial<Record<CargoKind, number>> = {};
    for (const rake of this.live().filter((r) => r.sidings === uid)) {
      const train = this.sim.train(rake.trainId)!;
      cars += train.consist.length;
      for (const [kind, units] of carrying(train.consist, getJob(rake.job).goods)) cargo[kind] = (cargo[kind] ?? 0) + units;
    }
    return { cars, cargo };
  }

  /** Engines fetching or putting away cars. */
  get busy(): number {
    return this.errands.length + this.returns.length;
  }

  private live(): Rake[] {
    this.rakes = this.rakes.filter((r) => {
      const train = this.sim.train(r.trainId);
      return train && !train.wrecked && !train.vehicles.some((v) => v.def.motor) && this.sim.places.some((p) => p.uid === r.sidings && p.place.spares);
    });
    return this.rakes;
  }

  /** Space for cars being put down, including cars placed by hand. */
  private clear(train: Train): boolean {
    return this.sim.trains.every((other) => other === train || other.vehicles.every((v) =>
      train.vehicles.every((w) => distance(v.geo.center, w.geo.center) > (v.def.length + w.def.length) / 2 + 20)));
  }

  /** Parked loads count as supply even if their original producer has gone. */
  readyJobs(): Set<JobId> {
    if (!this.hasShed) return new Set();
    return new Set(this.live().filter((r) => this.useful(r)).map((r) => r.job));
  }

  get hasShed(): boolean {
    return this.sim.network.layout.pieces.some((p) => p.pieceId === 'engine-shed' && this.sim.nearestTrack(p.pose, 30));
  }

  /** Actual freight work, rather than merely a producer and consumer existing. */
  hasWork(job: JobId): boolean {
    if (this.hasShed && this.live().some((r) => r.job === job && this.useful(r))) return true;
    const sites = [...this.sim.economy.sites.values()];
    const open = (s: typeof sites[number]) => !s.blocked && (!staffOf(s) || s.crew.length > 0);
    return getJob(job).goods.some((kind) => sites.some((s) => open(s) && suppliesGoods(s, kind) && unitsOf(s, kind) > 0 &&
      sites.some((to) => to !== s && open(to) && to.place.unloads?.includes(kind) && roomFor(to, kind) > 0 &&
        (!s.place.store || (!to.place.store && (to.stock[kind] ?? 0) <= (to.place.holds?.[kind] ?? 0) * ECONOMY.low)))));
  }

  /** A loaded rake waits for demand; empty cars wait for something worth collecting. */
  private useful(rake: Rake): boolean {
    const train = this.sim.train(rake.trainId);
    if (!train) return false;
    const goods = getJob(rake.job).goods;
    const loaded = carrying(train.consist, goods);
    const sites = [...this.sim.economy.sites.values()].filter((s) => !s.blocked && (!staffOf(s) || s.crew.length > 0));
    const reach = (uid: string) => this.sim.dispatcher.distanceTo(train, uid) !== null;
    if (loaded.size) return sites.some((s) => !s.place.store && goods.some((kind) => loaded.has(kind) && s.place.unloads?.includes(kind) && roomFor(s, kind) > 0 &&
      (s.stock[kind] ?? 0) <= (s.place.holds?.[kind] ?? 0) * ECONOMY.low) && reach(s.uid));
    return goods.some((kind) => train.consist.some((c) => getStock(c.stockId).cargo?.kind === kind) &&
      sites.some((s) => suppliesGoods(s, kind) && unitsOf(s, kind) > 0 && reach(s.uid) && sites.some((to) => to !== s && to.place.unloads?.includes(kind) && roomFor(to, kind) > 0 &&
        (!s.place.store || (!to.place.store && (to.stock[kind] ?? 0) <= (to.place.holds?.[kind] ?? 0) * ECONOMY.low)) && reach(to.uid))));
  }

  working(id: number): void {
    this.idleSince.delete(id);
  }

  /** A brief lull is normal; a train with no work for a while puts its cars away. */
  idle(train: Train): boolean {
    if (train.job === 'free' || train.job === 'workers' || train.job === 'mail') return false;
    const since = this.idleSince.get(train.id);
    if (since === undefined) this.idleSince.set(train.id, this.sim.time);
    if (since === undefined || this.sim.time - since < YARD.idleSeconds) return false;
    this.idleSince.set(train.id, this.sim.time);
    return this.park(train);
  }

  /** Back idle wagons into a free siding, leaving their cargo aboard. */
  park(train: Train): boolean {
    const sim = this.sim;
    if (train.errand || train.wrecked || train.job === 'free' || train.job === 'workers' || train.job === 'mail') return false;
    if (!this.hasShed) return false;
    const firstCar = train.vehicles.findIndex((v) => !!v.def.cargo);
    if (firstCar < 1 || !train.vehicles.slice(0, firstCar).some((v) => v.def.motor) ||
      train.vehicles.slice(firstCar).some((v) => v.def.motor || v.def.id === JOB_TRAIN.tender) ||
      train.vehicles.filter((v) => v.def.motor).some((v) => v.facing !== 1)) return false;
    const length = train.vehicles.slice(firstCar).reduce((s, v) => s + v.def.length, 0) + train.vehicles.length - firstCar;
    const total = train.vehicles.reduce((s, v) => s + v.def.length, 0);
    for (const point of sim.places.filter((p) => p.place.spares)) {
      const road = this.road(point.edgeKey);
      if (!road || this.returns.some((e) => e.road === road.signature) || this.errands.some((e) => this.live().some((r) => r.trainId === e.rakeId && r.sidings === point.uid))) continue;
      let d = YARD.gapMm;
      for (const other of sim.trains) {
        if (other === train) continue;
        for (const v of other.vehicles) {
          const seg = other.route.segmentAt(v.u);
          const s = seg.reversed ? seg.edge.length - (v.u - seg.u0) : v.u - seg.u0;
          const along = road.along(seg.edge.key, s);
          if (along !== null) d = Math.max(d, along + v.def.length / 2 + YARD.gapMm);
        }
      }
      if (d + length > road.length - YARD.clearMm || d + total / 2 > road.length) continue;
      const at = road.at(d + total / 2);
      const target: Return['target'] = { kind: 'track', edgeKey: at.edge.key, s: at.s };
      // Try backing in directly; otherwise run clear of the junction first.
      let phase: Return['phase'] = 'back-in';
      const before = { dispatch: train.dispatch, throttle: train.throttle };
      if (sim.routeTo(train.id, target, { back: true }) || train.dispatch!.distance > YARD.backMm) {
        const spot = this.reverseSpot(train, target);
        if (!spot || sim.routeTo(train.id, spot, { ahead: true })) {
          sim.clearRoute(train.id);
          train.dispatch = before.dispatch;
          sim.setThrottle(train.id, before.throttle);
          continue;
        }
        phase = 'to-reverse';
      }
      train.errand = true;
      train.destination = point.uid;
      this.returns.push({ trainId: train.id, job: train.job, sidings: point.uid, road: road.signature, d, target, phase, since: sim.time });
      sim.notice(train, `${train.name} is putting its wagons in the car sidings until there is work for them.`, train.vehicles[0].geo.center);
      return true;
    }
    return false;
  }

  private putAway(returning: Return): void {
    const sim = this.sim;
    const train = sim.train(returning.trainId);
    const finish = () => {
      this.returns = this.returns.filter((r) => r !== returning);
      if (train) {
        train.errand = false;
        train.destination = null;
        sim.clearRoute(train.id);
        sim.setThrottle(train.id, 0);
        // Once unhooked, this is only the returning engine. Never leave
        // an abandoned engine running loose if its way home is blocked.
        if (returning.phase === 'leave' || returning.phase === 'to-shed') sim.removeTrain(train.id);
      }
    };
    if (!train || train.wrecked) return finish();
    if (returning.phase === 'to-reverse' || returning.phase === 'back-in') {
      const point = sim.places.find((p) => p.uid === returning.sidings && p.place.spares);
      if (!point || this.road(point.edgeKey)?.signature !== returning.road) return finish();
    }
    if (sim.time - returning.since > YARD.giveUpSeconds || train.dispatch?.state === 'no-route') return finish();
    if (train.dispatch?.state !== 'arrived') return;
    returning.since = sim.time;
    switch (returning.phase) {
      case 'to-reverse':
        if (sim.routeTo(train.id, returning.target, { back: true })) return finish();
        returning.phase = 'back-in';
        return;
      case 'back-in': {
        const index = train.vehicles.findIndex((v) => !!v.def.cargo);
        const rake = sim.uncouple(train.id, index);
        if (typeof rake === 'string') return finish();
        rake.name = `Parked ${getJob(returning.job).name.toLowerCase()} wagons`;
        this.rakes.push({ trainId: rake.id, job: returning.job, sidings: returning.sidings, d: returning.d });
        train.job = 'free';
        const exit = this.reverseSpot(train, returning.target);
        if (!exit || sim.routeTo(train.id, exit, { ahead: true })) {
          // The wagons are safe; put the engine back in the pool if it cannot get out.
          sim.removeTrain(train.id);
          return finish();
        }
        returning.phase = 'leave';
        sim.notice(rake, `${rake.name} are waiting in the sidings with their cargo kept aboard.`, rake.vehicles[0].geo.center);
        return;
      }
      case 'leave': {
        for (const shed of sim.network.layout.pieces.filter((p) => p.pieceId === 'engine-shed')) {
          const near = sim.nearestTrack(shed.pose, 30);
          if (near && !sim.routeTo(train.id, { kind: 'track', edgeKey: near.edge.key, s: near.edge.length / 2 })) {
            returning.phase = 'to-shed';
            return;
          }
        }
        sim.removeTrain(train.id);
        return finish();
      }
      case 'to-shed':
        sim.removeTrain(train.id);
        return finish();
    }
  }

  // ---- filling the sidings ----------------------------------------------------

  /** Jobs this layout has work for, the ones it's likeliest to want first. */
  private jobs(): JobId[] {
    const sites = [...this.sim.economy.sites.values()];
    return JOBS.filter((j) => j.id !== 'free' && j.id !== 'workers' && j.goods.some((g) => sites.some((s) => suppliesGoods(s, g)) && sites.some((s) => takesGoods(s, g, sites)))).map((j) => j.id);
  }

  /** Park rakes of spare cars along every car sidings, one job after another. */
  stock(): number {
    this.stocked = true;
    const points = this.sim.places.filter((p) => p.place.spares);
    for (const uid of this.stockedRoads.keys()) if (!points.some((p) => p.uid === uid)) this.stockedRoads.delete(uid);
    const jobs = this.jobs();
    if (!jobs.length) return 0;
    let n = 0;
    let turn = 0;
    for (const point of points) {
      const road = this.road(point.edgeKey);
      if (!road) continue;
      if ([...this.stockedRoads.values()].includes(road.signature)) {
        this.stockedRoads.set(point.uid, road.signature);
        continue;
      }
      this.stockedRoads.set(point.uid, road.signature);
      // Keep any cars that survived a track edit; never stock over them.
      if (this.live().some((r) => r.sidings === point.uid)) continue;
      let d = YARD.gapMm;
      for (;;) {
        const job = jobs[turn % jobs.length];
        const consist = jobConsist(job).filter((c) => !getStock(c.stockId).motor && c.stockId !== JOB_TRAIN.tender);
        const length = consist.reduce((s, c) => s + getStock(c.stockId).length, 0) + consist.length;
        if (d + length > road.length - YARD.clearMm) break;
        const at = road.at(d + length / 2);
        const train = this.sim.addTrain(consist, { edgeKey: at.edge.key, s: at.s, reversed: at.reversed }, `Spare ${getJob(job).name.toLowerCase()} cars`);
        if (typeof train === 'string') break;
        if (!this.clear(train)) {
          this.sim.removeTrain(train.id);
          break;
        }
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
  private road(edgeKey: string): { length: number; signature: string; along: (edgeKey: string, s: number) => number | null; at: (d: number) => { edge: Edge; s: number; reversed: boolean } } | null {
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
        signature: JSON.stringify(headings.map(({ edge, leave }) => [edge.key, edge.path, edge.base, leave])),
        along: (key, s) => {
          let d = 0;
          for (const h of headings) {
            if (h.edge.key === key) return d + (h.leave === 1 ? s : h.edge.length - s);
            d += h.edge.length;
          }
          return null;
        },
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
    const rake = live.find((r) => r.job === job && this.useful(r) && !this.errands.some((e) => e.rakeId === r.trainId) && !live.some((o) => o.sidings === r.sidings && o.d > r.d) && !this.returns.some((e) => e.sidings === r.sidings));
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
        if (!this.clear(train) || (!table && (!ahead || !this.sim.dispatcher.graph.live.has(headingKey(ahead))))) {
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
    for (const returning of [...this.returns]) this.putAway(returning);
    for (const id of this.idleSince.keys()) if (!this.sim.train(id)) this.idleSince.delete(id);
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
        const spot = this.reverseSpot(train, this.rakeSpot(rake));
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
  private reverseSpot(train: Train, target: Extract<Destination, { kind: 'track' }>): Extract<Destination, { kind: 'track' }> | null {
    const graph = this.sim.dispatcher.graph;
    const start = this.ahead(train);
    if (!start) return null;
    const length = train.vehicles.reduce((s, v) => s + v.def.length, 0) + 20;
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
