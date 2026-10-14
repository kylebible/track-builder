import type { PieceDef } from './types';

// Basic mode: only what Brio sells. Track counts when the Brio track guide
// gives it a letter (brioIds); accessories Brio sells have no letter, so
// they are listed here. Trees, houses and the trackside places stand in for
// whatever buildings you have, so they stay. Everything else (bendy and
// bumpy track, half curves, curves with two pegs or two holes, the helix,
// the arch bridge and most bridge spans, the cargo loader) is left out.

/** Accessories Brio sells, as best we know: no letters in the guide. */
const BRIO_ACCESSORIES = new Set([
  'level-crossing',
  'lift-bridge',
  'tunnel',
  'station',
  'engine-shed',
  'bridge-pier',
  'crane',
  'signal',
  'turntable',
  'bridge-suspension',
]);

/** Dressing, not track or a working accessory. */
const DRESSING = new Set(['leafy-tree', 'pine-tree', 'cottage']);

/** Whether Basic mode offers this piece. */
export function isBrio(piece: PieceDef): boolean {
  return piece.brioIds.length > 0 || BRIO_ACCESSORIES.has(piece.id) || DRESSING.has(piece.id) || piece.category === 'trackside';
}

const KEY = 'track-builder:basic';

function load(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Basic mode: real Brio pieces only, and real magnets. Kept per browser. */
export const MODE = { basic: load() };

const listeners = new Set<(basic: boolean) => void>();

export function setBasicMode(on: boolean): void {
  if (MODE.basic === on) return;
  MODE.basic = on;
  try {
    globalThis.localStorage?.setItem(KEY, on ? '1' : '0');
  } catch {
    // Private browsing: the setting just isn't kept.
  }
  for (const listener of listeners) listener(on);
}

export function onBasicMode(listener: (basic: boolean) => void): void {
  listeners.add(listener);
}

/** Whether the current mode offers this piece. */
export const offered = (piece: PieceDef): boolean => !MODE.basic || isBrio(piece);
