import { ECONOMY, roomFor, staffOf, unitsOf, type Economy, type Site } from './economy';
import { getStock, supplyLevel, type CargoKind, type ConsistEntry } from './stock';

// A train's job decides what it carries and where it goes next. A coal
// train fetches coal from a mine and takes it wherever coal is running low;
// a workers train brings fresh people from the station to places short of
// staff and takes tired ones home. A free train does what it always did:
// runs where the levers send it and stops wherever there's work for it.

export type JobId = 'free' | 'coal' | 'water' | 'farm' | 'timber' | 'goods' | 'mail' | 'workers';

export interface JobDef {
  id: JobId;
  name: string;
  /** What it carries. Workers ride in coaches. */
  goods: CargoKind[];
  /** The cars a new train for this job gets, in turn. */
  cars: string[];
  /** A small picture for badges and the needs list. */
  icon: string;
  blurb: string;
}

export const JOBS: readonly JobDef[] = [
  { id: 'free', name: 'Free', goods: [], cars: [], icon: '🚂', blurb: 'Goes where the levers send it and stops wherever there’s work.' },
  { id: 'coal', name: 'Coal', goods: ['coal'], cars: ['hopper'], icon: '⛏️', blurb: 'Takes coal from coal mines to coaling stages and power stations.' },
  { id: 'water', name: 'Water', goods: ['water'], cars: ['water-tank'], icon: '💧', blurb: 'Takes water from pump houses to water towers.' },
  { id: 'farm', name: 'Farm', goods: ['milk', 'animals'], cars: ['milk-tank', 'livestock'], icon: '🐄', blurb: 'Takes milk and cows from farms to the market.' },
  { id: 'timber', name: 'Timber', goods: ['logs'], cars: ['timber'], icon: '🪵', blurb: 'Takes logs from lumber camps to sawmills.' },
  { id: 'goods', name: 'Goods', goods: ['crates', 'cars'], cars: ['flat-car', 'car-carrier'], icon: '📦', blurb: 'Takes planks to the toy factory, and planks and toy cars to goods sheds.' },
  { id: 'mail', name: 'Mail', goods: ['mail'], cars: ['mail-van'], icon: '✉️', blurb: 'Swaps mail bags between post offices.' },
  { id: 'workers', name: 'Workers', goods: ['passengers'], cars: ['coach'], icon: '👷', blurb: 'Brings fresh workers from the station and takes tired ones home.' },
];

const byId = new Map(JOBS.map((j) => [j.id, j]));
export const getJob = (id: JobId): JobDef => byId.get(id)!;

/** The job that carries a cargo. */
export const JOB_FOR: Record<CargoKind, JobId> = {
  coal: 'coal', water: 'water', milk: 'farm', animals: 'farm', logs: 'timber', crates: 'goods', cars: 'goods', mail: 'mail', passengers: 'workers',
};

/** Standard trains: an engine and tender, then this many cars. Tunable. */
export const JOB_TRAIN = { cars: 3, engine: 'steam-engine', tender: 'tender' };

/** A new train for a job: engine and tender (two of each when double-headed), and its cars. */
export function jobConsist(job: JobId, cars = JOB_TRAIN.cars, engines = 1): ConsistEntry[] {
  const def = getJob(job);
  const out: ConsistEntry[] = [];
  for (let i = 0; i < engines; i++) out.push({ stockId: JOB_TRAIN.engine, reversed: false }, { stockId: JOB_TRAIN.tender, reversed: false });
  const kinds = def.cars.length ? def.cars : ['coach'];
  for (let i = 0; i < cars; i++) out.push({ stockId: kinds[i % kinds.length], reversed: false });
  return out;
}

/** What a train is carrying for its job, by cargo. */
export function carrying(consist: readonly ConsistEntry[], goods: readonly CargoKind[]): Map<CargoKind, number> {
  const out = new Map<CargoKind, number>();
  for (const entry of consist) {
    const kind = getStock(entry.stockId).cargo?.kind;
    if (kind && goods.includes(kind) && (entry.units ?? 0) > 0) out.set(kind, (out.get(kind) ?? 0) + (entry.units ?? 0));
  }
  return out;
}

/** Room left in a train's cars for each of its goods. */
function space(consist: readonly ConsistEntry[], goods: readonly CargoKind[]): Map<CargoKind, number> {
  const out = new Map<CargoKind, number>();
  for (const entry of consist) {
    const cargo = getStock(entry.stockId).cargo;
    if (cargo && goods.includes(cargo.kind)) out.set(cargo.kind, (out.get(cargo.kind) ?? 0) + cargo.capacity - (entry.units ?? 0));
  }
  return out;
}

export const freshAboard = (consist: readonly ConsistEntry[]): number => consist.reduce((s, c) => s + (c.crew ?? 0), 0);
export const tiredAboard = (consist: readonly ConsistEntry[]): number => consist.reduce((s, c) => s + (c.tired ?? 0), 0);
export const seats = (consist: readonly ConsistEntry[]): number =>
  consist.reduce((s, c) => {
    const cargo = getStock(c.stockId).cargo;
    return s + (cargo?.kind === 'passengers' ? cargo.capacity - (c.units ?? 0) : 0);
  }, 0);

export interface Candidate {
  uid: string;
  /** Lower is better. */
  score: number;
}

/** How low an engine's stores have to be before a job train goes for more. */
const REFUEL_BELOW = 0.5;

/**
 * Where a train on a job should head next, given the places it could
 * reach and how far each is. Null when there's nothing useful to do.
 */
export function nextStop(
  job: JobId,
  consist: readonly ConsistEntry[],
  economy: Economy,
  stations: readonly Site[],
  far: (uid: string) => number | null,
  last: string | null,
): string | null {
  if (job === 'free') return null;
  const reach = (site: Site) => far(site.uid);
  const best = (cands: Candidate[]) => (cands.length ? cands.reduce((a, b) => (b.score < a.score ? b : a)).uid : null);
  /** A stop's distance as part of its score: a metre counts like a fifth of a store. */
  const scoreOf = (need: number, d: number) => need + d / 5000;
  const sites = [...economy.sites.values()];

  // Its own engine first: no point running dry halfway.
  const fuel = refuelStop(consist, economy, reach, scoreOf);
  if (fuel) return fuel;

  if (job === 'workers') return workersStop(consist, economy, stations, reach, scoreOf);

  const goods = getJob(job).goods;
  const loaded = carrying(consist, goods);
  if (job === 'mail') {
    // Bags aboard go to another post office; empty vans fetch from the fullest.
    const offices = sites.filter((s) => s.place.id === 'post-office' && staffOf(s) && s.crew.length);
    const cands: Candidate[] = [];
    for (const s of offices) {
      const d = reach(s);
      if (d === null) continue;
      if (loaded.size && s.uid === last && offices.length > 1) continue;
      cands.push({ uid: s.uid, score: scoreOf(1 - (s.stock.mail ?? 0) / (s.place.holds?.mail ?? 1), d) });
    }
    return best(cands);
  }
  if (loaded.size) {
    // Deliver to where it's needed most.
    const cands: Candidate[] = [];
    for (const s of sites) {
      if (!s.crew.length && staffOf(s)) continue;
      for (const kind of loaded.keys()) {
        if (!s.place.unloads?.includes(kind) || roomFor(s, kind) < 1 || s.uid === last) continue;
        const d = reach(s);
        if (d === null) continue;
        cands.push({ uid: s.uid, score: scoreOf((s.stock[kind] ?? 0) / (s.place.holds?.[kind] ?? 1), d) });
      }
    }
    const to = best(cands);
    if (to) return to;
  }
  const room = space(consist, goods);
  const cands: Candidate[] = [];
  for (const s of sites) {
    if (!s.crew.length && staffOf(s)) continue;
    for (const kind of goods) {
      // Not straight back where it has just been: whatever was there to load, it took.
      if (!s.place.loads?.includes(kind) || !(room.get(kind) ?? 0) || unitsOf(s, kind) < 1 || s.uid === last) continue;
      const d = reach(s);
      if (d === null) continue;
      cands.push({ uid: s.uid, score: scoreOf(1 - (s.stock[kind] ?? 0) / (s.place.holds?.[kind] ?? 1), d) });
    }
  }
  return best(cands);
}

function refuelStop(consist: readonly ConsistEntry[], economy: Economy, reach: (s: Site) => number | null, scoreOf: (n: number, d: number) => number): string | null {
  const wants: [string, 'water' | 'coal' | 'charge'][] = [];
  const level = (supply: 'water' | 'coal' | 'charge') =>
    Math.max(-1, ...consist.filter((c) => getStock(c.stockId).supplies?.includes(supply)).map((c) => supplyLevel(c, supply)));
  if (level('water') >= 0 && level('water') < REFUEL_BELOW) wants.push(['water-tower', 'water']);
  if (level('coal') >= 0 && level('coal') < REFUEL_BELOW) wants.push(['coaling-stage', 'coal']);
  if (level('charge') >= 0 && level('charge') < REFUEL_BELOW) wants.push(['charging-post', 'charge']);
  const cands: Candidate[] = [];
  for (const [placeId, supply] of wants) {
    for (const s of economy.all(placeId)) {
      if (s.blocked || (staffOf(s) && !s.crew.length)) continue;
      if (supply !== 'charge' && (s.stock[supply] ?? 0) < 1 / ECONOMY.unitsPerStore) continue;
      const d = reach(s);
      if (d !== null) cands.push({ uid: s.uid, score: scoreOf(level(supply), d) });
    }
  }
  return cands.length ? cands.reduce((a, b) => (b.score < a.score ? b : a)).uid : null;
}

function workersStop(consist: readonly ConsistEntry[], economy: Economy, stations: readonly Site[], reach: (s: Site) => number | null, scoreOf: (n: number, d: number) => number): string | null {
  const fresh = freshAboard(consist);
  const tired = tiredAboard(consist);
  const free = seats(consist);
  const sites = [...economy.sites.values()].filter((s) => staffOf(s));
  const pick = (list: Site[], need: (s: Site) => number) => {
    const cands: Candidate[] = [];
    for (const s of list) {
      const n = need(s);
      if (n <= 0) continue;
      const d = reach(s);
      if (d !== null) cands.push({ uid: s.uid, score: scoreOf(-n, d) });
    }
    return cands.length ? cands.reduce((a, b) => (b.score < a.score ? b : a)).uid : null;
  };
  const home = () => pick([...stations], () => 1);
  // Fresh people aboard go where they're short-handed, picking up anyone tired there.
  if (fresh) {
    const to = pick(sites, (s) => staffOf(s) - s.crew.length);
    if (to) return to;
  }
  // Room aboard and people waiting to go home: fetch them.
  if (free > 0) {
    const to = pick(sites, (s) => s.tired);
    if (to) return to;
  }
  // Otherwise home: drop the tired, collect fresh people if anyone needs them.
  if (tired || (!fresh && economy.openSlots() > 0)) return home();
  return null;
}

/** Something a place needs, for its badge and the needs list. */
export interface Need {
  uid: string;
  /** What's short or stuck: a cargo, workers, or power/water. */
  what: CargoKind | 'workers' | 'tired' | 'power' | 'water-source' | 'source';
  /** The job that sorts it out, if a train can. */
  job: JobId | null;
  message: string;
  /** Bad (nothing is on it) or just low (a train for it is running). */
  urgent: boolean;
}

/** What every place needs, given which jobs have trains on them. */
export function needs(economy: Economy, haveJob: (job: JobId) => boolean, hasStation: boolean): Need[] {
  const out: Need[] = [];
  const sites = [...economy.sites.values()];
  const makers = (kind: CargoKind) => sites.some((s) => s.place.loads?.includes(kind) || (kind === 'mail' && s.place.id === 'post-office'));
  const PLACE_FOR: Partial<Record<CargoKind, string>> = { coal: 'coal mine', water: 'pump house', milk: 'farm', animals: 'farm', logs: 'lumber camp', crates: 'sawmill' , cars: 'toy factory' };
  for (const s of sites) {
    const name = s.place.name;
    const staff = staffOf(s);
    if (s.blocked) {
      out.push({ uid: s.uid, what: s.place.id === 'pump-house' ? 'water-source' : 'power', job: s.place.id === 'charging-post' ? 'coal' : null, message: `${name}: ${s.blocked.toLowerCase()}.`, urgent: true });
    }
    if (staff && s.crew.length < staff) {
      const short = staff - s.crew.length;
      const job: JobId = 'workers';
      const why = !hasStation ? ' Add a station for them to come from.' : '';
      out.push({ uid: s.uid, what: 'workers', job, message: `${name} needs ${short} worker${short > 1 ? 's' : ''}${s.crew.length ? '' : ': it has stopped'}.${why}`, urgent: !haveJob(job) });
    }
    if (s.tired) out.push({ uid: s.uid, what: 'tired', job: 'workers', message: `${s.tired} tired worker${s.tired > 1 ? 's' : ''} at the ${name.toLowerCase()} want${s.tired > 1 ? '' : 's'} a ride home.`, urgent: !haveJob('workers') });
    for (const kind of s.place.unloads ?? []) {
      if (s.place.from && kind === s.place.from.kind && s.place.loads?.some((k) => (s.stock[k] ?? 0) >= (s.place.holds?.[k] ?? 0))) continue;
      const hold = s.place.holds?.[kind] ?? 0;
      if (!hold || (s.stock[kind] ?? 0) > hold * ECONOMY.low) continue;
      const job = JOB_FOR[kind];
      const empty = (s.stock[kind] ?? 0) < 1;
      const source = makers(kind) ? '' : ` There's no ${PLACE_FOR[kind] ?? 'place making it'} yet.`;
      out.push({ uid: s.uid, what: kind, job, message: `${name} is ${empty ? 'out of' : 'low on'} ${WORDS[kind]}.${source}`, urgent: !haveJob(job) || !makers(kind) });
    }
    for (const kind of s.place.loads ?? []) {
      const hold = s.place.holds?.[kind] ?? 0;
      if (!hold || (s.stock[kind] ?? 0) < hold) continue;
      const job = JOB_FOR[kind];
      out.push({ uid: s.uid, what: kind, job, message: `${name} is full of ${WORDS[kind]} and has stopped: nothing is collecting it.`, urgent: !haveJob(job) });
    }
    if (s.place.id === 'post-office' && (s.stock.mail ?? 0) >= (s.place.holds?.mail ?? Infinity)) {
      out.push({ uid: s.uid, what: 'mail', job: 'mail', message: `${name} is full of mail: nothing is collecting it.`, urgent: !haveJob('mail') });
    }
  }
  return out;
}

export const WORDS: Record<CargoKind, string> = {
  passengers: 'passengers', coal: 'coal', water: 'water', milk: 'milk', animals: 'cows', mail: 'mail', logs: 'logs', crates: 'planks', cars: 'toy cars',
};

export const ICONS: Record<CargoKind | 'workers' | 'tired' | 'power' | 'water-source' | 'source', string> = {
  passengers: '🧍', coal: '⛏️', water: '💧', milk: '🥛', animals: '🐄', mail: '✉️', logs: '🪵', crates: '📦', cars: '🚗',
  workers: '👷', tired: '😴', power: '⚡', 'water-source': '🌊', source: '❓',
};
