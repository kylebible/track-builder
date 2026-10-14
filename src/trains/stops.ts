import { ECONOMY, roomFor, unitsOf, type Economy, type Site } from './economy';
import { getJob, type JobId } from './jobs';
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
  /** Fills cars that carry these: what it makes and sends out. */
  loads?: CargoKind[];
  /** Empties cars that carry these: what it takes in. */
  unloads?: CargoKind[];
  /** Empties and refills cars that carry these; passengers, some get off and some get on. */
  swaps?: CargoKind[];
  /** Trains stop here even with nothing to do. */
  alwaysStop?: boolean;
  /** Not a stop: something a train does as it goes by. */
  pass?: PassEffect;
  /** One line for the palette. */
  blurb: string;
  // ---- the economy (see economy.ts) ----
  /** People it needs to work. With fewer it works slower; with nobody it stops. */
  staff?: number;
  /** What it makes (a `loads` cargo) or uses up (an `unloads` cargo), units a minute with everyone at work. */
  perMinute?: Partial<Record<CargoKind, number>>;
  /** Makes its goods out of this, `per` of it for each unit made (the sawmill's logs). */
  from?: { kind: CargoKind; per: number };
  /** The most it keeps of each cargo. */
  holds?: Partial<Record<CargoKind, number>>;
  /** How it works, a sentence or two for its info card. */
  explain?: string;
}

export const PLACES: readonly PlaceDef[] = [
  {
    id: 'station', name: 'Station', swaps: ['passengers'], alwaysStop: true, blurb: 'Trains stop. Passengers get off and on the coaches.',
    explain: 'Where workers live. A workers train takes fresh people from here to places short of staff, and brings tired ones home. Passenger coaches on other trains swap passengers.',
  },
  {
    id: 'water-tower', name: 'Water tower', refills: ['water'], unloads: ['water'], staff: 1, holds: { water: 16 }, blurb: 'Fills steam engines’ boilers from its tank.',
    explain: 'Fills steam engines’ boilers from its tank. A water train brings the water from a pump house.',
  },
  {
    id: 'pump-house', name: 'Pump house', loads: ['water'], staff: 1, perMinute: { water: 8 }, holds: { water: 16 }, blurb: 'Pumps water from a river or lake into water tank cars.',
    explain: 'Pumps water into its tank for water trains to collect. In a scene with a river or lake it has to stand within 30 cm of the water; anywhere else it has a well.',
  },
  {
    id: 'coaling-stage', name: 'Coaling stage', refills: ['coal'], unloads: ['coal'], staff: 1, holds: { coal: 12 }, blurb: 'Tops up steam engines and tenders with coal from its pile.',
    explain: 'Tops up steam engines and tenders from its coal pile. A coal train brings coal from a coal mine.',
  },
  {
    id: 'charging-post', name: 'Charging post', refills: ['charge'], blurb: 'Charges battery engines.',
    explain: 'Charges battery engines while a power station is running. With no power station on the layout it runs off the mains.',
  },
  {
    id: 'coal-mine', name: 'Coal mine', loads: ['coal'], staff: 2, perMinute: { coal: 6 }, holds: { coal: 12 }, blurb: 'Digs coal and fills coal hoppers.',
    explain: 'Miners dig coal for coal trains to collect. Coal trains take it to coaling stages and power stations.',
  },
  {
    id: 'power-station', name: 'Power station', unloads: ['coal'], staff: 2, perMinute: { coal: 2 }, holds: { coal: 12 }, blurb: 'Burns coal to power the charging posts.',
    explain: 'Burns coal to make electricity for the charging posts. A coal train keeps it supplied.',
  },
  {
    id: 'farm', name: 'Farm', loads: ['animals', 'milk'], staff: 2, perMinute: { milk: 4, animals: 2 }, holds: { milk: 8, animals: 4 }, blurb: 'Loads cows into cattle cars and milk into milk cars.',
    explain: 'Raises cows and milks them. A farm train takes both to the market.',
  },
  {
    id: 'market', name: 'Market', unloads: ['animals', 'milk'], staff: 1, perMinute: { milk: 3, animals: 1.5 }, holds: { milk: 12, animals: 8 }, blurb: 'Unloads cows and milk.',
    explain: 'Sells milk and cows as fast as farm trains bring them.',
  },
  {
    id: 'post-office', name: 'Post office', swaps: ['mail'], staff: 1, perMinute: { mail: 3 }, holds: { mail: 12 }, blurb: 'Swaps the mail van’s bags for new ones.',
    explain: 'Sorts letters into bags. A mail train takes the bags from one post office to the next, swapping them for new ones.',
  },
  {
    id: 'lumber-camp', name: 'Lumber camp', loads: ['logs'], staff: 2, perMinute: { logs: 3 }, holds: { logs: 6 }, blurb: 'Fells trees and loads logs onto timber cars.',
    explain: 'Fells trees for timber trains to take to the sawmill.',
  },
  {
    id: 'sawmill', name: 'Sawmill', unloads: ['logs'], loads: ['crates'], staff: 2, perMinute: { crates: 4 }, from: { kind: 'logs', per: 0.5 }, holds: { logs: 6, crates: 8 }, blurb: 'Takes logs and sends out crates of planks.',
    explain: 'Saws each log into two crates of planks. A timber train brings the logs; a goods train takes the planks to the toy factory or a goods shed.',
  },
  {
    id: 'toy-factory', name: 'Toy factory', unloads: ['crates'], loads: ['cars'], staff: 2, perMinute: { cars: 2 }, from: { kind: 'crates', per: 1 }, holds: { crates: 8, cars: 6 }, blurb: 'Makes toy cars out of crates of planks.',
    explain: 'Makes a toy car from each crate of planks. A goods train brings the planks and takes the toy cars to a goods shed.',
  },
  {
    id: 'goods-shed', name: 'Goods shed', unloads: ['crates', 'cars'], staff: 1, perMinute: { crates: 2, cars: 1.5 }, holds: { crates: 12, cars: 9 }, blurb: 'Unloads crates and toy cars.',
    explain: 'Sends crates and toy cars on to the shops. Goods trains keep it supplied.',
  },
  { id: 'whistle-board', name: 'Whistle board', pass: 'whistle', blurb: 'Engines whistle as they pass.', explain: 'Engines whistle as they pass. No train needs to stop.' },
  { id: 'slow-board', name: 'Slow board', pass: 'slow', blurb: 'Trains slow down past it.', explain: 'Trains slow down past it. No train needs to stop.' },
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
  /** Workers getting on or off a coach, fresh or tired, rather than passengers. */
  rider?: 'fresh' | 'tired';
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
  /** The place's stock and staff, when the economy is running. */
  site?: Site;
  economy?: Economy;
}

/** What the economy says about a train's visit, when it's running. */
export interface Visit {
  economy: Economy;
  site: Site;
  /** The train's job: it only handles its own goods. */
  job: JobId;
  /** At a station, how many fresh workers the places are still short of. */
  wanted?: number;
}

/** What a place would do for a train standing at it, or null if nothing. */
export function planWork(place: PlaceDef, consist: readonly ConsistEntry[], rand: () => number = Math.random, visit?: Visit): Work | null {
  if (place.pass) return null;
  const site = visit?.site;
  const job = visit ? getJob(visit.job) : null;
  // Nobody at work: nothing gets loaded, unloaded or topped up.
  const closed = !!site && ((site.place.staff ?? 0) > 0 && !site.crew.length);
  const queues: Job[][] = consist.map(() => []);
  const tally = new Map<string, number>();
  const add = (key: string, n: number) => tally.set(key, (tally.get(key) ?? 0) + n);
  // What the place can still give and take, shared out car by car.
  const stock = new Map<CargoKind, number>();
  const room = new Map<CargoKind, number>();
  if (site) {
    for (const kind of [...(place.loads ?? []), ...(place.swaps ?? [])]) stock.set(kind, unitsOf(site, kind));
    for (const kind of place.unloads ?? []) room.set(kind, roomFor(site, kind));
  }
  const supplyLeft = new Map<Supply, number>();
  if (site) for (const supply of place.refills ?? []) supplyLeft.set(supply, supply === 'charge' ? (site.blocked ? 0 : Infinity) : (site.stock[supply as CargoKind] ?? 0));
  let wanted = visit?.wanted ?? 0;
  let tiredWaiting = site?.tired ?? 0;
  let slots = site ? Math.max(0, (site.place.staff ?? 0) - site.crew.length) : 0;
  consist.forEach((entry, i) => {
    const def = getStock(entry.stockId);
    for (const supply of def.supplies ?? []) {
      if (!place.refills?.includes(supply) || supplyLevel(entry, supply) >= 0.97) continue;
      if (site) {
        const units = (1 - supplyLevel(entry, supply)) * ECONOMY.unitsPerStore;
        const left = supplyLeft.get(supply) ?? 0;
        if (closed || left <= 0.05) continue;
        supplyLeft.set(supply, left - units);
      }
      queues[i].push({ action: 'refill', what: supply, amount: 1 });
      add(`refill:${supply}`, 1);
    }
    const cargo = def.cargo;
    if (!cargo) return;
    const load = entry.units ?? 0;
    // A workers train's coaches carry workers, not passengers.
    if (visit?.job === 'workers' && cargo.kind === 'passengers') {
      const fresh = entry.crew ?? 0;
      const tired = entry.tired ?? 0;
      const free = cargo.capacity - load;
      if (place.id === 'station') {
        if (tired) queues[i].push({ action: 'unload', what: 'passengers', amount: tired, rider: 'tired' });
        const on = Math.min(free + tired, wanted);
        wanted -= on;
        if (on) queues[i].push({ action: 'load', what: 'passengers', amount: on, rider: 'fresh' });
        add('home:tired', tired);
        add('on:fresh', on);
      } else {
        const off = Math.min(fresh, slots);
        slots -= off;
        const on = Math.min(free + off, tiredWaiting);
        tiredWaiting -= on;
        if (off) queues[i].push({ action: 'unload', what: 'passengers', amount: off, rider: 'fresh' });
        if (on) queues[i].push({ action: 'load', what: 'passengers', amount: on, rider: 'tired' });
        add('off:fresh', off);
        add('on:tired', on);
      }
      return;
    }
    if (job && job.id !== 'free' && !job.goods.includes(cargo.kind)) return;
    if (closed) return;
    if (place.swaps?.includes(cargo.kind)) {
      if (cargo.kind === 'passengers') {
        const off = load ? 1 + Math.floor(rand() * load) : 0;
        const on = Math.min(cargo.capacity - (load - off), 1 + Math.floor(rand() * cargo.capacity));
        if (off) queues[i].push({ action: 'unload', what: cargo.kind, amount: off });
        if (on) queues[i].push({ action: 'load', what: cargo.kind, amount: on });
        add('off:passengers', off);
        add('on:passengers', on);
      } else {
        let on = cargo.capacity;
        if (site) {
          on = Math.min(on, stock.get(cargo.kind) ?? 0);
          stock.set(cargo.kind, (stock.get(cargo.kind) ?? 0) - on);
        }
        if (load) queues[i].push({ action: 'unload', what: cargo.kind, amount: load });
        if (on) queues[i].push({ action: 'load', what: cargo.kind, amount: on });
        add(`swap:${cargo.kind}`, Math.max(load, on));
      }
      return;
    }
    if (place.unloads?.includes(cargo.kind) && load > 0) {
      let off = load;
      if (site) {
        off = Math.min(off, room.get(cargo.kind) ?? 0);
        room.set(cargo.kind, (room.get(cargo.kind) ?? 0) - off);
      }
      if (off) {
        queues[i].push({ action: 'unload', what: cargo.kind, amount: off });
        add(`unload:${cargo.kind}`, off);
      }
    }
    // A sawmill takes logs off and puts crates on: one car does one or the other.
    if (place.loads?.includes(cargo.kind) && load < cargo.capacity && !queues[i].length) {
      let on = cargo.capacity - load;
      if (site) {
        on = Math.min(on, stock.get(cargo.kind) ?? 0);
        stock.set(cargo.kind, (stock.get(cargo.kind) ?? 0) - on);
      }
      if (on) {
        queues[i].push({ action: 'load', what: cargo.kind, amount: on });
        add(`load:${cargo.kind}`, on);
      }
    }
  });
  const total = queues.flat().reduce((s, j) => s + (j.action === 'refill' ? 1 : j.amount), 0);
  if (!total && !place.alwaysStop) return null;
  return { place, queues, summary: summarize(tally), total, done: 0, elapsed: 0, clocks: queues.map(() => 0), site, economy: visit?.economy };
}

const SUPPLY_WORDS: Record<Supply, string> = { water: 'filling the boiler', coal: 'loading coal into the bunker', charge: 'charging the battery' };

const worker = (n: number, tired = false) => `${n} ${tired ? 'tired ' : ''}worker${n === 1 ? '' : 's'}`;

function summarize(tally: Map<string, number>): string {
  const parts: string[] = [];
  const off = tally.get('off:passengers') ?? 0;
  const on = tally.get('on:passengers') ?? 0;
  if (off || on) parts.push([off && `${off} getting off`, on && `${on} getting on`].filter(Boolean).join(', '));
  const people: [string, (n: number) => string][] = [
    ['off:fresh', (n) => `${worker(n)} off to work`],
    ['on:tired', (n) => `${worker(n, true)} getting on`],
    ['home:tired', (n) => `${worker(n, true)} going home`],
    ['on:fresh', (n) => `${worker(n)} getting on`],
  ];
  for (const [key, say] of people) if (tally.get(key)) parts.push(say(tally.get(key)!));
  for (const [key, n] of tally) {
    const [action, what] = key.split(':');
    if (what === 'passengers' || what === 'fresh' || what === 'tired' || !n) continue;
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
 * Do `dt` seconds of work, changing the cars' loads and stores, and the
 * place's stock and staff when the economy is running. Calls `delivered`
 * for each unit unloaded. Returns true once everything is done and the
 * train has stood long enough.
 */
export function doWork(work: Work, consist: ConsistEntry[], dt: number, delivered: (kind: CargoKind, n: number) => void): boolean {
  work.elapsed += dt;
  const { site, economy } = work;
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
      const before = supplyLevel(entry, supply);
      let level = Math.min(1, before + WORK.refillPerSecond * dt);
      if (site && supply !== 'charge') {
        // Drawn from the place's pile or tank, as far as it goes.
        const have = site.stock[supply as CargoKind] ?? 0;
        const units = Math.min(have, (level - before) * ECONOMY.unitsPerStore);
        level = before + units / ECONOMY.unitsPerStore;
        site.stock[supply as CargoKind] = have - units;
        if (have - units <= 1e-6 && level < 1) {
          entry[supply] = level;
          queue.shift();
          work.done++;
          return;
        }
      }
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
      const kind = job.what as CargoKind;
      // The place ran out (another train took the last), or filled up.
      if (site && economy && !job.rider) {
        if (job.action === 'load' && !economy.take(site, kind)) {
          work.done += job.amount;
          job.amount = 0;
          queue.shift();
          work.clocks[i] = 0;
          break;
        }
        if (job.action === 'unload' && !site.place.swaps?.includes(kind) && (site.stock[kind] ?? 0) + 1 > (site.place.holds?.[kind] ?? Infinity) + 1e-9) {
          work.done += job.amount;
          job.amount = 0;
          queue.shift();
          work.clocks[i] = 0;
          break;
        }
      }
      work.clocks[i] -= per;
      job.amount--;
      work.done++;
      const load = entry.units ?? 0;
      if (job.action === 'load') {
        entry.units = load + 1;
        if (job.rider === 'fresh') entry.crew = (entry.crew ?? 0) + 1;
        if (job.rider === 'tired') {
          entry.tired = (entry.tired ?? 0) + 1;
          if (site) site.tired = Math.max(0, site.tired - 1);
        }
      } else {
        entry.units = Math.max(0, load - 1);
        if (job.rider === 'fresh') {
          entry.crew = Math.max(0, (entry.crew ?? 0) - 1);
          if (site) site.crew.push(1);
        } else if (job.rider === 'tired') {
          entry.tired = Math.max(0, (entry.tired ?? 0) - 1);
        } else {
          // Mail bags are delivered, not kept; everything else goes in the place's store.
          if (site && economy && !site.place.swaps?.includes(kind)) economy.put(site, kind);
          delivered(kind, 1);
        }
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
