import type { Vec2 } from '../geometry/pose';
import type { CargoKind } from './stock';
import type { PlaceDef } from './stops';

// What each place beside the track has in stock, and who works there. A
// mine digs coal into its pile while miners are at work; a coal train
// carries it to the coaling stage, whose pile tops up engines. Every place
// with staff needs people to run it: they tire as they work, stop, and wait
// for a workers train to take them home to the station and bring fresh
// people out. With nobody at work a place makes nothing and nobody loads
// or unloads trains there.

/** Tunable estimates for the play table, not anything measured. */
export const ECONOMY = {
  /** Seconds a worker works before they're tired and want to go home. */
  shiftSeconds: 300,
  /** How full each place starts, of what it holds. */
  startFull: 0.5,
  /** A store this empty, of what a place takes in, counts as running low. */
  low: 0.25,
  /** Units of coal or water it takes to fill an engine's store from empty. */
  unitsPerStore: 2,
  /** A pump house in a scene with water has to be this close to it, mm. */
  pumpReachMm: 300,
};

export interface Site {
  uid: string;
  place: PlaceDef;
  at: Vec2;
  /** What it has, by cargo; fractions while something is being made. */
  stock: Partial<Record<CargoKind, number>>;
  /** Each worker at work, how much energy they have left (1 fresh, 0 tired). */
  crew: number[];
  /** Tired workers waiting for a ride home. */
  tired: number;
  /** A pump house that can't reach water, or a charging post with no power. */
  blocked: string | null;
}

export const staffOf = (site: Site): number => site.place.staff ?? 0;

/** Share of the work it can do with the people it has, 0 to 1. */
export function manning(site: Site): number {
  const staff = staffOf(site);
  return staff ? site.crew.length / staff : 1;
}

/** Room left for `kind`, in whole units. */
export const roomFor = (site: Site, kind: CargoKind): number => Math.max(0, Math.floor((site.place.holds?.[kind] ?? 0) - (site.stock[kind] ?? 0) + 1e-9));
/** Whole units of `kind` ready to load. */
export const unitsOf = (site: Site, kind: CargoKind): number => Math.floor((site.stock[kind] ?? 0) + 1e-9);

export class Economy {
  readonly sites = new Map<string, Site>();
  /** Whether a pump house at a spot can reach water: null where the scene has no water at all. */
  waterNear: ((at: Vec2, reach: number) => boolean | null) | null = null;
  /** Shifts last this many times ECONOMY.shiftSeconds: longer on big layouts, so trains can get round in time. */
  shiftScale = 1;
  /** A seed for staggering shifts, so everyone doesn't leave at once. */
  private seed = 7;

  /** Match the places on the layout, keeping what each already has. */
  sync(points: readonly { uid: string; place: PlaceDef; at: Vec2 }[]): void {
    const keep = new Set<string>();
    for (const p of points) {
      if (p.place.pass) continue;
      keep.add(p.uid);
      const old = this.sites.get(p.uid);
      if (old && old.place.id === p.place.id) {
        old.at = p.at;
        continue;
      }
      this.sites.set(p.uid, this.fresh(p.uid, p.place, p.at));
    }
    for (const uid of this.sites.keys()) if (!keep.has(uid)) this.sites.delete(uid);
    this.updateBlocked();
  }

  /** Back to how everything starts: half stocked, fully staffed. */
  reset(): void {
    for (const [uid, site] of this.sites) this.sites.set(uid, this.fresh(uid, site.place, site.at));
    this.updateBlocked();
  }

  private fresh(uid: string, place: PlaceDef, at: Vec2): Site {
    const stock: Partial<Record<CargoKind, number>> = {};
    for (const [kind, n] of Object.entries(place.holds ?? {}) as [CargoKind, number][]) stock[kind] = Math.floor(n * ECONOMY.startFull);
    // Staggered, so the first ones get tired after a while and not all together.
    const crew = Array.from({ length: place.staff ?? 0 }, () => 0.45 + 0.55 * this.rand());
    return { uid, place, at, stock, crew, tired: 0, blocked: null };
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  site(uid: string): Site | undefined {
    return this.sites.get(uid);
  }

  /** Every site of a kind of place. */
  all(placeId: string): Site[] {
    return [...this.sites.values()].filter((s) => s.place.id === placeId);
  }

  /** Whether a power station is running, or there's none and the posts run off the mains. */
  get powered(): boolean {
    const stations = this.all('power-station');
    return !stations.length || stations.some((s) => s.crew.length > 0 && (s.stock.coal ?? 0) > 0);
  }

  private updateBlocked(): void {
    const powered = this.powered;
    for (const site of this.sites.values()) {
      if (site.place.id === 'charging-post') site.blocked = powered ? null : 'No power: the power station has no coal or nobody working';
      else if (site.place.id === 'pump-house') site.blocked = this.waterNear?.(site.at, ECONOMY.pumpReachMm) === false ? 'Too far from the water to pump' : null;
    }
  }

  /** Run every place on by `dt` seconds: make and use goods, and tire the workers. */
  tick(dt: number): void {
    for (const site of this.sites.values()) {
      const place = site.place;
      // Workers tire whether or not there's work, and stop when they're spent.
      for (let i = site.crew.length - 1; i >= 0; i--) {
        site.crew[i] -= dt / (ECONOMY.shiftSeconds * this.shiftScale);
        if (site.crew[i] <= 0) {
          site.crew.splice(i, 1);
          site.tired++;
        }
      }
      if (site.blocked) continue;
      const work = manning(site) * dt / 60;
      if (!work || !place.perMinute) continue;
      for (const [kind, rate] of Object.entries(place.perMinute) as [CargoKind, number][]) {
        const have = site.stock[kind] ?? 0;
        if (place.loads?.includes(kind) || place.swaps?.includes(kind)) {
          // Making it, up to what it holds, out of what it has.
          let make = Math.min(rate * work, (place.holds?.[kind] ?? Infinity) - have);
          if (place.from) make = Math.min(make, (site.stock[place.from.kind] ?? 0) / place.from.per);
          if (make <= 0) continue;
          site.stock[kind] = have + make;
          if (place.from) site.stock[place.from.kind] = Math.max(0, (site.stock[place.from.kind] ?? 0) - make * place.from.per);
        } else {
          // Using it up: burnt, sold or sent on.
          site.stock[kind] = Math.max(0, have - rate * work);
        }
      }
    }
    this.updateBlocked();
  }

  /** Take one unit of `kind` from a site's stock; false if there's none. */
  take(site: Site, kind: CargoKind, n = 1): boolean {
    if ((site.stock[kind] ?? 0) + 1e-9 < n) return false;
    site.stock[kind] = Math.max(0, (site.stock[kind] ?? 0) - n);
    return true;
  }

  put(site: Site, kind: CargoKind, n = 1): void {
    site.stock[kind] = Math.min(site.place.holds?.[kind] ?? Infinity, (site.stock[kind] ?? 0) + n);
  }

  /** Places short of workers, and how many they need, counting fresh workers already on their way. */
  openSlots(): number {
    let n = 0;
    for (const site of this.sites.values()) n += Math.max(0, staffOf(site) - site.crew.length);
    return n;
  }
}
