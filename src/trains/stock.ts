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
  look: 'engine' | 'steam' | 'tender' | 'wagon' | 'coach' | 'timber';
}

export const WHEEL_RADIUS = 7.5;
/** Magnets stand this far proud of the body at each end. */
export const MAGNET_DEPTH = 5;

const BATTERY_MOTOR: Motor = { stallForceN: 0.6, freeSpeedMm: 180, grip: 0.5 };

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
  },
  { id: 'tender', name: 'Tender', length: 72, wheelbase: 36, width: 34, height: 40, massKg: 0.04, color: 0x2b8a4b, look: 'tender' },
  { id: 'wagon', name: 'Open wagon', length: 78, wheelbase: 40, width: 34, height: 30, massKg: 0.045, color: 0xd9a441, look: 'wagon' },
  { id: 'coach', name: 'Passenger coach', length: 96, wheelbase: 52, width: 34, height: 52, massKg: 0.055, color: 0xc8352b, look: 'coach' },
  { id: 'timber', name: 'Long timber car', length: 130, wheelbase: 84, width: 34, height: 34, massKg: 0.07, color: 0x7a5a3a, look: 'timber' },
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
}

/** The pole on a vehicle's front (leading, in train order) and back. */
export function polesOf(entry: Pick<ConsistEntry, 'reversed'>): { front: Pole; back: Pole } {
  return entry.reversed ? { front: 'S', back: 'N' } : { front: 'N', back: 'S' };
}

/** Whether `ahead` and `behind`, touching, hold together: N to S. */
export function attracts(ahead: ConsistEntry, behind: ConsistEntry): boolean {
  return polesOf(ahead).back !== polesOf(behind).front;
}
