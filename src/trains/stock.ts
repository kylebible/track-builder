// Engines and cars, sized like Brio's. Every vehicle is a rigid body on two
// axles, so its wheelbase decides how it sits on a curve. Each end has a
// magnet: north at the front, south at the back, so a train couples only
// when the cars all face the same way, like the real ones.
//
// Sizes are estimates from photos and catalog listings, not measurements.

export type Pole = 'N' | 'S';

export interface Motor {
  /** Push at a standstill, newtons. */
  stallForceN: number;
  /** Top speed with no load, mm/s. */
  freeSpeedMm: number;
  /** Grip of the driving wheels (rubber tyres) on wood. */
  grip: number;
}

/** What a car carries, loaded and unloaded at places beside the track. */
export type CargoKind = 'passengers' | 'coal' | 'water' | 'milk' | 'animals' | 'mail' | 'logs' | 'crates' | 'cars';

/** What an engine burns or uses up as it runs, topped up beside the track. */
export type Supply = 'water' | 'coal' | 'charge';

export interface StockDef {
  id: string;
  name: string;
  /** Magnet face to magnet face, mm. */
  length: number;
  wheelbase: number;
  width: number;
  /** Roof height above the track top, mm. Used for the model only. */
  height: number;
  massKg: number;
  motor?: Motor;
  /** Main body colour. */
  color: number;
  look: 'engine' | 'steam' | 'tender' | 'wagon' | 'coach' | 'timber' | 'hopper' | 'tank' | 'livestock' | 'van' | 'carrier' | 'flat' | 'brake';
  /** Takes a crate from the cargo loader, for a crane to lift off. */
  carries?: boolean;
  /** What it carries at places beside the track, and how many fit. */
  cargo?: { kind: CargoKind; capacity: number };
  /** What an engine runs on (a tender's own store of coal, too). */
  supplies?: Supply[];
}

export const WHEEL_RADIUS = 7.5;

// Strong enough to climb an N ramp pulling one car, as the real ones do,
// but not a long train.
const BATTERY_MOTOR: Motor = { stallForceN: 0.95, freeSpeedMm: 180, grip: 0.65 };

export const STOCK: readonly StockDef[] = [
  {
    id: 'battery-engine',
    name: 'Battery engine',
    length: 112,
    wheelbase: 56,
    width: 34,
    height: 58,
    massKg: 0.16,
    motor: BATTERY_MOTOR,
    color: 0x2f6fd6,
    look: 'engine',
    supplies: ['charge'],
  },
  {
    id: 'steam-engine',
    name: 'Big steam engine',
    length: 140,
    wheelbase: 80,
    width: 36,
    height: 66,
    massKg: 0.24,
    motor: { stallForceN: 0.9, freeSpeedMm: 160, grip: 0.5 },
    color: 0x2b8a4b,
    look: 'steam',
    supplies: ['water', 'coal'],
  },
  { id: 'tender', name: 'Tender', length: 72, wheelbase: 36, width: 34, height: 40, massKg: 0.04, color: 0x2b8a4b, look: 'tender', supplies: ['coal'] },
  { id: 'wagon', name: 'Open wagon', length: 78, wheelbase: 40, width: 34, height: 30, massKg: 0.045, color: 0xd9a441, look: 'wagon', carries: true },
  { id: 'coach', name: 'Passenger coach', length: 96, wheelbase: 52, width: 34, height: 52, massKg: 0.055, color: 0xc8352b, look: 'coach', cargo: { kind: 'passengers', capacity: 8 } },
  { id: 'timber', name: 'Long timber car', length: 130, wheelbase: 84, width: 34, height: 34, massKg: 0.07, color: 0x7a5a3a, look: 'timber', cargo: { kind: 'logs', capacity: 3 } },
  { id: 'hopper', name: 'Coal hopper', length: 78, wheelbase: 40, width: 34, height: 34, massKg: 0.05, color: 0x3d3f45, look: 'hopper', cargo: { kind: 'coal', capacity: 6 } },
  { id: 'water-tank', name: 'Water tank car', length: 84, wheelbase: 44, width: 34, height: 40, massKg: 0.05, color: 0x2f7fb8, look: 'tank', cargo: { kind: 'water', capacity: 8 } },
  { id: 'milk-tank', name: 'Milk car', length: 84, wheelbase: 44, width: 34, height: 40, massKg: 0.05, color: 0xf2efe6, look: 'tank', cargo: { kind: 'milk', capacity: 6 } },
  { id: 'livestock', name: 'Cattle car', length: 90, wheelbase: 48, width: 34, height: 46, massKg: 0.05, color: 0xa8452f, look: 'livestock', cargo: { kind: 'animals', capacity: 4 } },
  { id: 'mail-van', name: 'Mail van', length: 90, wheelbase: 48, width: 34, height: 48, massKg: 0.05, color: 0xb8262c, look: 'van', cargo: { kind: 'mail', capacity: 6 } },
  { id: 'flat-car', name: 'Flat car', length: 90, wheelbase: 48, width: 34, height: 30, massKg: 0.045, color: 0x2f6fd6, look: 'flat', cargo: { kind: 'crates', capacity: 4 } },
  { id: 'car-carrier', name: 'Car carrier', length: 130, wheelbase: 84, width: 34, height: 30, massKg: 0.06, color: 0x6c7a89, look: 'carrier', cargo: { kind: 'cars', capacity: 3 } },
  { id: 'brake-van', name: 'Brake van', length: 76, wheelbase: 40, width: 34, height: 50, massKg: 0.05, color: 0x8a5a33, look: 'brake' },
];

const byId = new Map(STOCK.map((s) => [s.id, s]));

export function getStock(id: string): StockDef {
  const s = byId.get(id);
  if (!s) throw new Error(`Unknown vehicle: ${id}`);
  return s;
}

/** One vehicle in a train as built: which one, and whether it's turned round. */
export interface ConsistEntry {
  stockId: string;
  /** Turned round: its south magnet leads. */
  reversed: boolean;
  /** Carrying a crate from the cargo loader (open wagons only). */
  load?: 'crate';
  /** How much of its cargo it carries now, in the cargo's units. Missing means empty. */
  units?: number;
  /** An engine's (or tender's) stores, 0 to 1. Missing means full. */
  water?: number;
  coal?: number;
  charge?: number;
}

/** What a crate adds to a wagon's weight, kg. An estimate. */
export const CRATE_KG = 0.02;

/** What each kind of cargo is called, one and many. */
export const CARGO_NAMES: Record<CargoKind, [string, string]> = {
  passengers: ['passenger', 'passengers'],
  coal: ['load of coal', 'loads of coal'],
  water: ['load of water', 'loads of water'],
  milk: ['churn of milk', 'churns of milk'],
  animals: ['cow', 'cows'],
  mail: ['bag of mail', 'bags of mail'],
  logs: ['log', 'logs'],
  crates: ['crate', 'crates'],
  cars: ['toy car', 'toy cars'],
};

export const cargoCount = (kind: CargoKind, n: number): string => `${n} ${CARGO_NAMES[kind][n === 1 ? 0 : 1]}`;

/** How full an engine or tender's store is, 0 to 1. */
export const supplyLevel = (entry: ConsistEntry, supply: Supply): number => entry[supply] ?? 1;

/** The pole on a vehicle's front (leading, in train order) and back. */
export function polesOf(entry: Pick<ConsistEntry, 'reversed'>): { front: Pole; back: Pole } {
  return entry.reversed ? { front: 'S', back: 'N' } : { front: 'N', back: 'S' };
}

/** Whether `ahead` and `behind`, touching, hold together: N to S. */
export function attracts(ahead: ConsistEntry, behind: ConsistEntry): boolean {
  return polesOf(ahead).back !== polesOf(behind).front;
}
