import { cargoCount, getStock, supplyLevel, type CargoKind, type ConsistEntry, type Supply } from './stock';

// Places beside the track where trains stop to do something: a station
// where passengers get off and on, a water tower that fills a steam
// engine's boiler, a mine that fills coal hoppers, and so on. A train with
// its engines on stops at one only when there's work for it there (or it's
// a station), lines the cars that need it up with the place, waits while
// the work is done, and carries on. A few signs act as a train goes by.

export type PassEffect = 'whistle' | 'slow';

export interface PlaceDef {
  /** The catalog piece that is this place. */
  id: string;
  name: string;
  /** Tops up these engine (and tender) stores. */
  refills?: Supply[];
  /** Fills cars that carry these. */
  loads?: CargoKind[];
  /** Empties cars that carry these. */
  unloads?: CargoKind[];
  /** Empties and refills cars that carry these; passengers, some get off and some get on. */
  swaps?: CargoKind[];
  /** Trains stop here even with nothing to do. */
  alwaysStop?: boolean;
  /** Not a stop: something a train does as it goes by. */
  pass?: PassEffect;
  /** One line for the palette. */
  blurb: string;
}

export const PLACES: readonly PlaceDef[] = [
  { id: 'station', name: 'Station', swaps: ['passengers'], alwaysStop: true, blurb: 'Trains stop. Passengers get off and on the coaches.' },
  { id: 'water-tower', name: 'Water tower', refills: ['water'], loads: ['water'], blurb: 'Fills steam engines’ boilers and water tank cars.' },
  { id: 'coaling-stage', name: 'Coaling stage', refills: ['coal'], blurb: 'Tops up steam engines and tenders with coal.' },
  { id: 'charging-post', name: 'Charging post', refills: ['charge'], blurb: 'Charges battery engines.' },
  { id: 'coal-mine', name: 'Coal mine', loads: ['coal'], blurb: 'Fills coal hoppers.' },
  { id: 'power-station', name: 'Power station', unloads: ['coal'], blurb: 'Empties coal hoppers.' },
  { id: 'farm', name: 'Farm', loads: ['animals', 'milk'], blurb: 'Loads cows into cattle cars and milk into milk cars.' },
  { id: 'market', name: 'Market', unloads: ['animals', 'milk'], blurb: 'Unloads cows and milk.' },
  { id: 'post-office', name: 'Post office', swaps: ['mail'], blurb: 'Swaps the mail van’s bags for new ones.' },
  { id: 'lumber-camp', name: 'Lumber camp', loads: ['logs'], blurb: 'Loads logs onto timber cars.' },
  { id: 'sawmill', name: 'Sawmill', unloads: ['logs'], loads: ['crates'], blurb: 'Takes logs and sends out crates of planks.' },
  { id: 'toy-factory', name: 'Toy factory', loads: ['cars', 'crates'], blurb: 'Loads toy cars onto car carriers, and crates.' },
  { id: 'goods-shed', name: 'Goods shed', unloads: ['crates', 'cars'], blurb: 'Unloads crates and toy cars.' },
  { id: 'whistle-board', name: 'Whistle board', pass: 'whistle', blurb: 'Engines whistle as they pass.' },
  { id: 'slow-board', name: 'Slow board', pass: 'slow', blurb: 'Trains slow down past it.' },
];

const byId = new Map(PLACES.map((p) => [p.id, p]));

export function getPlace(pieceId: string): PlaceDef | undefined {
  return byId.get(pieceId);
}

/** Seconds to move one unit of cargo, and how fast stores fill (whole store per second). */
export const WORK = {
  unitSeconds: 0.45,
  passengerSeconds: 0.3,
  refillPerSecond: 0.5,
  /** Shortest wait at a place, and at a station. */
  minDwell: 1,
  stationDwell: 2.5,
};

export interface Job {
  action: 'refill' | 'load' | 'unload';
  what: Supply | CargoKind;
  /** Units to move; for a refill, the level to reach. */
  amount: number;
}

/** The work at one place for one train: a queue of jobs per vehicle, worked side by side. */
export interface Work {
  place: PlaceDef;
  queues: Job[][];
  /** What's being done, for a label: "2 getting off, 3 getting on". */
  summary: string;
  /** Units (and store fills, as one each) to do, and done so far. */
  total: number;
  done: number;
  elapsed: number;
  clocks: number[];
}

/** What a place would do for a train standing at it, or null if nothing. */
export function planWork(place: PlaceDef, consist: readonly ConsistEntry[], rand: () => number = Math.random): Work | null {
  if (place.pass) return null;
  const queues: Job[][] = consist.map(() => []);
  const tally = new Map<string, number>();
  const add = (key: string, n: number) => tally.set(key, (tally.get(key) ?? 0) + n);
  consist.forEach((entry, i) => {
    const def = getStock(entry.stockId);
    for (const supply of def.supplies ?? []) {
      if (place.refills?.includes(supply) && supplyLevel(entry, supply) < 0.97) {
        queues[i].push({ action: 'refill', what: supply, amount: 1 });
        add(`refill:${supply}`, 1);
      }
    }
    const cargo = def.cargo;
    if (!cargo) return;
    const load = entry.units ?? 0;
    if (place.swaps?.includes(cargo.kind)) {
      if (cargo.kind === 'passengers') {
        const off = load ? 1 + Math.floor(rand() * load) : 0;
        const on = Math.min(cargo.capacity - (load - off), 1 + Math.floor(rand() * cargo.capacity));
        if (off) queues[i].push({ action: 'unload', what: cargo.kind, amount: off });
        if (on) queues[i].push({ action: 'load', what: cargo.kind, amount: on });
        add('off:passengers', off);
        add('on:passengers', on);
      } else {
        if (load) queues[i].push({ action: 'unload', what: cargo.kind, amount: load });
        queues[i].push({ action: 'load', what: cargo.kind, amount: cargo.capacity });
        add(`swap:${cargo.kind}`, cargo.capacity);
      }
      return;
    }
    if (place.unloads?.includes(cargo.kind) && load > 0) {
      queues[i].push({ action: 'unload', what: cargo.kind, amount: load });
      add(`unload:${cargo.kind}`, load);
    }
    // A sawmill takes logs off and puts crates on: one car does one or the other.
    if (place.loads?.includes(cargo.kind) && load < cargo.capacity && !queues[i].length) {
      queues[i].push({ action: 'load', what: cargo.kind, amount: cargo.capacity - load });
      add(`load:${cargo.kind}`, cargo.capacity - load);
    }
  });
  const total = queues.flat().reduce((s, j) => s + (j.action === 'refill' ? 1 : j.amount), 0);
  if (!total && !place.alwaysStop) return null;
  return { place, queues, summary: summarize(tally), total, done: 0, elapsed: 0, clocks: queues.map(() => 0) };
}

const SUPPLY_WORDS: Record<Supply, string> = { water: 'filling the boiler', coal: 'loading coal into the bunker', charge: 'charging the battery' };

function summarize(tally: Map<string, number>): string {
  const parts: string[] = [];
  const off = tally.get('off:passengers') ?? 0;
  const on = tally.get('on:passengers') ?? 0;
  if (off || on) parts.push([off && `${off} getting off`, on && `${on} getting on`].filter(Boolean).join(', '));
  for (const [key, n] of tally) {
    const [action, what] = key.split(':');
    if (what === 'passengers' || !n) continue;
    if (action === 'refill') parts.push(SUPPLY_WORDS[what as Supply]);
    else if (action === 'load') parts.push(`loading ${cargoCount(what as CargoKind, n)}`);
    else if (action === 'unload') parts.push(`unloading ${cargoCount(what as CargoKind, n)}`);
    else parts.push(`swapping ${cargoCount(what as CargoKind, n)}`);
  }
  return parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'All aboard!';
}

/** How long the work will take, seconds, with every vehicle worked at once. */
export function workSeconds(work: Work): number {
  return Math.max(0, ...work.queues.map((q) => q.reduce((t, j) => t + (j.action === 'refill' ? 1 / WORK.refillPerSecond : j.amount * (j.what === 'passengers' ? WORK.passengerSeconds : WORK.unitSeconds)), 0)));
}

/** The vehicles that have work to do, first and last, to line them up with the place. */
export function workSpan(work: Work): [number, number] | null {
  const busy = work.queues.flatMap((q, i) => (q.length ? [i] : []));
  // Topping up an engine: the engine goes under the spout.
  const refill = work.queues.findIndex((q) => q.some((j) => j.action === 'refill'));
  if (refill >= 0) return [refill, refill];
  return busy.length ? [busy[0], busy[busy.length - 1]] : null;
}

/**
 * Do `dt` seconds of work, changing the cars' loads and stores. Calls
 * `delivered` for each unit unloaded. Returns true once everything is done
 * and the train has stood long enough.
 */
export function doWork(work: Work, consist: ConsistEntry[], dt: number, delivered: (kind: CargoKind, n: number) => void): boolean {
  work.elapsed += dt;
  work.queues.forEach((queue, i) => {
    const job = queue[0];
    if (!job) return;
    const entry = consist[i];
    if (!entry) {
      queue.length = 0;
      return;
    }
    if (job.action === 'refill') {
      const supply = job.what as Supply;
      const level = Math.min(1, supplyLevel(entry, supply) + WORK.refillPerSecond * dt);
      entry[supply] = level;
      if (level >= 1) {
        queue.shift();
        work.done++;
      }
      return;
    }
    const per = job.what === 'passengers' ? WORK.passengerSeconds : WORK.unitSeconds;
    work.clocks[i] += dt;
    while (work.clocks[i] >= per && queue[0] === job && job.amount > 0) {
      work.clocks[i] -= per;
      job.amount--;
      work.done++;
      const load = entry.units ?? 0;
      if (job.action === 'load') entry.units = load + 1;
      else {
        entry.units = Math.max(0, load - 1);
        delivered(job.what as CargoKind, 1);
      }
      if (job.amount <= 0) {
        queue.shift();
        work.clocks[i] = 0;
      }
    }
  });
  const min = work.place.alwaysStop ? WORK.stationDwell : WORK.minDwell;
  return work.queues.every((q) => !q.length) && work.elapsed >= min;
}
