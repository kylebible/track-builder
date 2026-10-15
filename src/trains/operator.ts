import { headingKey } from './dispatch';
import { ECONOMY, staffOf } from './economy';
import { JOBS, needs, suppliesGoods, takesGoods, type JobId } from './jobs';
import type { Train, TrainSim } from './sim';
import type { Supply } from './stock';

const SUPPLIES: Supply[] = ['water', 'coal', 'charge'];

// Hands-off running. Switched on, the operator does what you'd otherwise
// do by hand to keep the jobs going: puts on job trains for whatever the
// places need, as many as the track has room for, and gets trains that
// have stopped going again. A train that stalls gets another engine; one
// that still can't make a climb backs down, and job trains like it go
// round another way from then on; one that has come
// off the rails is lifted off and replaced; one that has run dry is topped
// up. Two trains that meet nose to nose on a single line, one backs away.
// When trains jam solid, waiting on each other round the layout, it
// lifts the one that has waited longest off and runs one fewer from then
// on, trying one more again once things have flowed for a while. Workers'
// shifts last longer on a big layout, so trains can get round in time.

/** Tunable choices, not measurements. */
export const OPERATOR = {
  /** How often it looks over the fleet, seconds. */
  everySeconds: 2,
  /** Waits at least this long between putting trains on, seconds, so each gets clear first. */
  addGapSeconds: 6,
  /** After failing to find room for a train, waits this long before trying again. */
  noRoomSeconds: 30,
  /** Track per job train: a layout gets one train for this much of it, mm. */
  trackPerTrainMm: 1200,
  /** And no more than two, plus one for every this many switches (trains need places to pass). */
  switchesPerTrain: 3,
  /** Two trains waiting on each other this long are in a standoff, seconds. */
  standoffSeconds: 6,
  /** A train waiting this long counts towards a jam, seconds. */
  jamWaitSeconds: 20,
  /** This long jammed and it lifts a train off, seconds. */
  jamSeconds: 20,
  /** This long with nobody stuck and it tries one more train, seconds. */
  flowSeconds: 180,
  /** A train's speed round the layout, for sizing shifts, mm/s. */
  lapSpeed: 120,
  /** Shifts last at least this many laps of the layout. */
  shiftLaps: 2,
  /** Never more job trains than this, however big the layout. */
  maxTrains: 14,
  /** At most this many trains on one goods job. */
  maxPerJob: 3,
  /** Workers per workers train it aims for: 49 jobs to fill gets 4 workers trains. */
  staffPerWorkersTrain: 14,
  maxWorkersTrains: 4,
  /** A stalled job train gets another engine, up to this many in all; after that it backs off. */
  mostEngines: 3,
  /** A stalled job train is helped after this long, seconds. */
  stallSeconds: 2,
  /** A wrecked job train is lifted off after this long, seconds. */
  wreckSeconds: 4,
  /** Backs off to a stop at least this far beyond the train's length, mm. */
  clearMm: 250,
  /** Uphill steeper than this, along the way it was going, counts as the climb it stalled on. */
  climbGrade: 0.03,
};

export class Operator {
  /** Off by default: the layout is yours until you ask it to run itself. */
  on = false;
  private clock = 0;
  private addClock = 0;
  /** When each train started waiting, stalling or lying wrecked, by train id. */
  private readonly since = new Map<number, { what: string; at: number }>();
  /** How many job trains it runs now: starts from the layout's size and learns from jams. */
  private cap: number | null = null;
  private jammed = 0;
  private flowing = 0;

  constructor(private readonly sim: TrainSim) {}

  /** Switch hands-off running on or off. */
  setOn(on: boolean): void {
    this.on = on;
    this.cap = null;
    this.jammed = this.flowing = 0;
    this.since.clear();
    this.sim.economy.shiftScale = on ? this.shiftScale() : 1;
    // Spare cars into the sidings, for engines from the shed to fetch.
    if (on) this.sim.yard.stock();
  }

  /** The track changed: size things afresh. */
  rebuild(): void {
    this.cap = null;
    if (this.on) {
      this.sim.economy.shiftScale = this.shiftScale();
      this.sim.yard.stock();
    }
  }

  tick(dt: number): void {
    if (!this.on) return;
    this.clock -= dt;
    this.addClock -= dt;
    // Recovery is watched every frame so a stall is caught quickly.
    for (const train of [...this.sim.trains]) if (train.job !== 'free') this.watch(train);
    if (this.clock > 0) return;
    this.clock = OPERATOR.everySeconds;
    this.cap ??= this.room();
    this.partStandoffs();
    if (this.clearJams(OPERATOR.everySeconds)) return;
    if (this.addClock <= 0) this.staff();
  }

  /** Shifts long enough for a train to get round a big layout a couple of times. */
  private shiftScale(): number {
    const track = this.sim.network.edges.reduce((s, e) => s + e.length, 0);
    return Math.max(1, (OPERATOR.shiftLaps * track) / OPERATOR.lapSpeed / ECONOMY.shiftSeconds);
  }

  /** How many job trains it's running now. */
  get trainCap(): number {
    return this.cap ?? this.room();
  }

  /**
   * Two trains nose to nose, each waiting for the other: met head on, or
   * each wanting the line the other is on. One backs away to the nearest
   * stop behind it so the other can pass.
   */
  private partStandoffs(): void {
    const sim = this.sim;
    const waiting = (t: Train) => {
      const s = this.since.get(t.id);
      return s?.what === 'wait' && sim.time - s.at >= OPERATOR.standoffSeconds;
    };
    for (const a of sim.trains) {
      if (a.job === 'free' || !waiting(a)) continue;
      const b = sim.trains.find((t) => `Waiting for ${t.name}` === a.waitReason);
      if (!b || !waiting(b) || b.waitReason !== `Waiting for ${a.name}`) continue;
      // The newer train gives way, or the other one if it can't.
      const [first, second] = a.id > b.id || b.job === 'free' ? [a, b] : [b, a];
      for (const t of [first, second]) {
        if (t.job === 'free' || !this.backOff(t)) continue;
        this.since.delete(t.id);
        this.since.delete((t === a ? b : a).id);
        sim.notice(t, `${t.name} met ${(t === a ? b : a).name} nose to nose, so it’s backing away to let it by.`, t.vehicles[0].geo.center);
        return;
      }
    }
  }

  /**
   * Trains waiting on each other round the layout for good: lift the one
   * that has waited longest off, and run one fewer. True if it did.
   */
  private clearJams(dt: number): boolean {
    const sim = this.sim;
    const stuck = [...this.since].filter(([, s]) => s.what === 'wait' && sim.time - s.at >= OPERATOR.jamWaitSeconds);
    const working = sim.trains.filter((t) => t.job !== 'free' && !t.wrecked);
    if (stuck.length && stuck.length >= Math.max(2, Math.ceil(working.length / 3))) {
      this.jammed += dt;
      this.flowing = 0;
    } else {
      this.jammed = 0;
      this.flowing = stuck.length ? 0 : this.flowing + dt;
    }
    if (this.flowing >= OPERATOR.flowSeconds && this.cap! < this.room()) {
      this.cap!++;
      this.flowing = 0;
    }
    if (this.jammed < OPERATOR.jamSeconds) return false;
    this.jammed = 0;
    // Keep at least one workers train: without them everything stops.
    const workers = working.filter((t) => t.job === 'workers').length;
    const pick = stuck
      .map(([id, s]) => ({ train: sim.train(id)!, at: s.at }))
      .filter(({ train }) => train && (train.job !== 'workers' || workers > 1))
      .sort((a, b) => a.at - b.at)[0];
    if (!pick) return false;
    this.cap = Math.max(2, working.length - 1);
    this.since.delete(pick.train.id);
    sim.removeTrain(pick.train.id);
    sim.notice(pick.train, `Trains were jammed waiting on each other, so ${pick.train.name} was lifted off. Running ${this.cap} job trains from now on.`, pick.train.vehicles[0].geo.center);
    return true;
  }

  /** How many trains each job ought to have on this layout, given what the places need now. */
  wanted(): Map<JobId, number> {
    const sim = this.sim;
    const sites = [...sim.economy.sites.values()];
    const out = new Map<JobId, number>();
    const has = (job: JobId) => sim.trains.some((t) => t.job === job);
    const now = needs(sim.economy, has, sim.stations.length > 0);
    const parked = sim.yard.readyJobs();
    const hasSidings = sim.places.some((p) => p.place.spares);
    for (const job of JOBS) {
      if (job.id === 'free') continue;
      if (job.id === 'workers') {
        const staff = sites.reduce((n, s) => n + staffOf(s), 0);
        if (staff && sim.stations.length) out.set('workers', Math.min(OPERATOR.maxWorkersTrains, Math.ceil(staff / OPERATOR.staffPerWorkersTrain)));
        continue;
      }
      // A job is worth a train only where something makes its goods and somewhere takes them.
      const makes = parked.has(job.id) || sites.some((s) => job.goods.some((k) => suppliesGoods(s, k)));
      const takes = sites.some((s) => job.goods.some((k) => takesGoods(s, k, sites)));
      const fuel = job.id === 'coal' && sites.some((s) => s.place.id === 'coaling-stage' || s.place.id === 'power-station');
      if (!makes || !(takes || fuel)) continue;
      // Once wagons can be put away, do not replace an idle train with a
      // fresh one while all the loads or all the destinations are unavailable.
      if (hasSidings && job.id !== 'mail' && !sim.yard.hasWork(job.id)) continue;
      const short = now.filter((n) => n.job === job.id).length;
      out.set(job.id, Math.min(OPERATOR.maxPerJob, 1 + Math.floor(short / 4)));
    }
    return out;
  }

  /** Room on this layout for this many job trains: by its length, and by how many places trains can pass. */
  room(): number {
    const track = this.sim.network.edges.reduce((s, e) => s + e.length, 0);
    const passing = 2 + Math.floor(this.sim.network.switches().length / OPERATOR.switchesPerTrain);
    return Math.max(1, Math.min(OPERATOR.maxTrains, Math.floor(track / OPERATOR.trackPerTrainMm), passing));
  }

  /** Put on one train for the job furthest short of what it wants, if there's room. */
  private staff(): void {
    const sim = this.sim;
    const working = sim.trains.filter((t) => t.job !== 'free' && !t.wrecked);
    if (working.length >= this.trainCap) return;
    // Not while anyone is held up: another train would only add to it.
    if ([...this.since.values()].some((s) => s.what === 'wait' && sim.time - s.at > 8)) return;
    const count = (job: JobId) => working.filter((t) => t.job === job).length;
    // Shortest of trains for its share first; workers break ties. If the
    // first job's rake is blocked, another job can still clear the road.
    const requests = [...this.wanted()].filter(([job, want]) => want > count(job))
      .sort(([a, na], [b, nb]) => ((nb - count(b)) / nb + (b === 'workers' ? 0.01 : 0)) - ((na - count(a)) / na + (a === 'workers' ? 0.01 : 0)));
    for (const [pick] of requests) {
      const fetching = sim.yard.fetch(pick);
      if (fetching) {
        this.addClock = OPERATOR.addGapSeconds;
        sim.notice(fetching, `${fetching.name} came out of the engine shed to fetch spare ${JOBS.find((j) => j.id === pick)!.name.toLowerCase()} cars from the sidings.`, fetching.vehicles[0].geo.center);
        return;
      }
      // Wait for parked wagons instead of manufacturing replacements.
      if (sim.yard.hasShed && sim.yard.spares().has(pick)) continue;
      const train = sim.addJobTrain(pick);
      if (typeof train === 'string') continue;
      this.addClock = OPERATOR.addGapSeconds;
      sim.notice(train, `${train.name} put on: the ${JOBS.find((j) => j.id === pick)!.name.toLowerCase()} jobs needed another train.`, train.vehicles[0].geo.center);
      return;
    }
    if (requests.length) this.addClock = OPERATOR.noRoomSeconds;
  }

  /** Notice a job train in trouble, and sort it out once it has been in trouble a little while. */
  private watch(train: Train): void {
    const sim = this.sim;
    const status = train.status;
    let what: string | null = null;
    if (train.wrecked) what = 'wrecked';
    else if (status.kind === 'stuck' && (status.stuck === 'stalled' || status.stuck === 'slipping')) what = 'stalled';
    else if (status.kind === 'stuck' && (status.stuck === 'no-water' || status.stuck === 'no-coal' || status.stuck === 'flat-battery')) what = 'dry';
    else if (status.kind === 'stuck' && status.stuck === 'fighting') what = 'fighting';
    else if (train.waitReason?.startsWith('Waiting for') && train.vehicles.every((v) => Math.abs(v.v) < 2)) what = 'wait';
    if (!what) {
      this.since.delete(train.id);
      return;
    }
    const was = this.since.get(train.id);
    if (!was || was.what !== what) {
      this.since.set(train.id, { what, at: sim.time });
      return;
    }
    const long = sim.time - was.at;
    const at = train.vehicles[0].geo.center;
    if (what === 'wrecked' && long >= OPERATOR.wreckSeconds) {
      sim.removeTrain(train.id);
      this.since.delete(train.id);
      // Trains running into each other is a sign there are too many: run one fewer for a while.
      if (train.status.kind === 'stuck' && train.status.stuck === 'crashed') {
        const working = sim.trains.filter((t) => t.job !== 'free' && !t.wrecked).length;
        this.cap = Math.max(Math.ceil(this.room() / 2), Math.min(this.trainCap - 1, working));
        this.flowing = 0;
      }
      this.addClock = Math.max(this.addClock, OPERATOR.noRoomSeconds);
      sim.notice(train, `${train.name} was lifted off after coming off the rails; another will be put on if it's needed.`, at);
    } else if (what === 'dry' && long >= OPERATOR.stallSeconds) {
      // The fitters top it up where it stands, enough to get to a tower or stage.
      for (const entry of train.consist) for (const supply of SUPPLIES) if (entry[supply] !== undefined) entry[supply] = Math.max(entry[supply]!, 0.6);
      train.stillFor = 0;
      train.status = { kind: 'stopped' };
      this.since.delete(train.id);
      sim.notice(train, `${train.name} ran dry and was topped up where it stood.`, at);
    } else if (what === 'fighting' && long >= OPERATOR.stallSeconds) {
      sim.removeTrain(train.id);
      this.since.delete(train.id);
      sim.notice(train, `${train.name} had engines pushing against each other and was lifted off.`, at);
    } else if (what === 'stalled' && long >= OPERATOR.stallSeconds) {
      this.since.delete(train.id);
      // First another engine, up to a few: the way you'd sort it out by hand.
      const engines = train.vehicles.filter((v) => v.def.motor);
      if (engines.length < OPERATOR.mostEngines) {
        const engine = engines[0].def.id;
        const atBack = !train.vehicles[0].def.motor && !!train.vehicles[train.vehicles.length - 1].def.motor;
        if (sim.attach(train.id, atBack ? 'back' : 'front', engine) === null) {
          train.stillFor = 0;
          sim.notice(train, `${train.name} stalled, so another engine was coupled on.`, at);
          return;
        }
      }
      const climbs = this.climbsUnder(train);
      const ratio = sim.climbRatio(train);
      for (const key of climbs) sim.steep.set(key, Math.max(sim.steep.get(key) ?? 0, ratio));
      const why = climbs.length ? 'couldn’t make the climb, so it’s backing down and job trains like it will go round another way' : 'stalled, so it’s backing off to try another way';
      if (!this.backOff(train)) sim.notice(train, `${train.name} ${climbs.length ? 'couldn’t make the climb' : 'stalled'} and has nowhere to back off to. Give it another engine or fewer cars.`, at);
      else sim.notice(train, `${train.name} ${why}.`, at);
    }
  }

  /** Headings under a train that climb the way it was going: where it stalled. */
  private climbsUnder(train: Train): string[] {
    const dir = Math.sign(train.vehicles.reduce((s, v) => s + (v.def.motor ? train.throttle * v.facing : 0), 0));
    if (!dir) return [];
    const lo = Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
    const hi = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
    const out: string[] = [];
    for (const seg of train.route.segments) {
      if (seg.u0 + seg.edge.length < lo || seg.u0 > hi) continue;
      const heading = { edge: seg.edge, leave: ((dir > 0) !== seg.reversed ? 1 : 0) as 0 | 1 };
      // Steepest uphill along this piece the way the train runs.
      let up = 0;
      for (let u = Math.max(lo, seg.u0); u <= Math.min(hi, seg.u0 + seg.edge.length); u += 5) up = Math.max(up, train.route.gradeAt(u) * dir);
      if (up > OPERATOR.climbGrade) out.push(headingKey(heading));
    }
    return out;
  }

  /**
   * Send a train backwards to the nearest stop behind it that it can get
   * clear to, so it can choose again from there. False if there's none.
   */
  private backOff(train: Train): boolean {
    const sim = this.sim;
    const length = train.vehicles.reduce((s, v) => s + v.def.length, 0);
    let best: { uid: string; d: number } | null = null;
    for (const dest of sim.dispatcher.destinations()) {
      const d = sim.dispatcher.distanceTo(train, dest.uid, { back: true });
      if (d === null || d < length / 2 + OPERATOR.clearMm) continue;
      if (!best || d < best.d) best = { uid: dest.uid, d };
    }
    if (!best) return false;
    if (sim.dispatcher.routeTo(train.id, { kind: 'place', uid: best.uid }, { keepRunning: true, back: true })) return false;
    train.backingOff = true;
    train.destination = null;
    train.stillFor = 0;
    train.status = { kind: 'stopped' };
    return true;
  }
}
