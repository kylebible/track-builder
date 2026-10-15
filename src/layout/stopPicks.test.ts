import { describe, expect, it } from 'vitest';
import { STOPS } from './generate';
import { addPiece, EMPTY_LAYOUT, type Layout } from './layout';
import { pickStops } from './stopPicks';

/** Random numbers from a seed. */
function random(seed: number): () => number {
  let a = seed;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const tally = (layout: Layout, n: number, seeds = 40, at = { x: 0, y: 0 }) => {
  const counts = new Map<string, number>();
  for (let seed = 1; seed <= seeds; seed++) for (const s of pickStops(layout, STOPS, n, at, random(seed))) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  return (id: string) => counts.get(id) ?? 0;
};

describe('picking stops for a generated section', () => {
  it('answers a place making goods with one that takes them in', () => {
    let farm = addPiece(EMPTY_LAYOUT, 'farm', { x: 3000, y: 0, angle: 0 }).layout;
    // With a station for its workers, so that isn't wanted too.
    farm = addPiece(farm, 'station', { x: 3000, y: 600, angle: 0 }).layout;
    const picked = tally(farm, 1);
    // A market most of the time: nothing else on the layout is wanted as much.
    expect(picked('market')).toBeGreaterThan(16);
  });

  it('gives a layout with people at work a station when it has none', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'coal-mine', { x: 3000, y: 0, angle: 0 }).layout;
    layout = addPiece(layout, 'coaling-stage', { x: 3000, y: 600, angle: 0 }).layout;
    expect(tally(layout, 1)('station')).toBeGreaterThan(16);
  });

  it('seldom puts another of a place right beside one already there', () => {
    const near = addPiece(EMPTY_LAYOUT, 'station', { x: 200, y: 0, angle: 0 }).layout;
    const far = addPiece(EMPTY_LAYOUT, 'station', { x: 5000, y: 0, angle: 0 }).layout;
    expect(tally(near, 3)('station')).toBeLessThan(tally(far, 3)('station'));
  });

  it('gives any number asked for, as varied as it can', () => {
    const picks = pickStops(EMPTY_LAYOUT, STOPS, 40, null, random(7));
    expect(picks).toHaveLength(40);
    // Every kind out before many repeats of any one.
    expect(new Set(picks.map((s) => s.id)).size).toBeGreaterThan(STOPS.length * 0.7);
  });
});
