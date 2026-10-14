import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import { LEVEL_HEIGHT } from '../pieces/dimensions';
import { checkLayout } from '../planning/check';
import { generateSection, STOPS, type SectionOptions } from './generate';
import { getEnvironment, offArea } from '../environments/environments';
import { addPiece, baseOf, EMPTY_LAYOUT, findJoints, openEnds, worldEnds, type Layout } from './layout';

const plainRun: Partial<SectionOptions> = { switches: 0, stops: 0, climb: 'none' };

/** Nothing the layout check objects to, other than ends left open. */
function expectSound(layout: Layout): void {
  expect(checkLayout(layout).filter((i) => i.kind !== 'open-end')).toEqual([]);
}

const added = (layout: Layout, uids: string[]) => layout.pieces.filter((p) => uids.includes(p.uid));

describe('generating a section', () => {
  it('lays an open run of as many pieces as asked', () => {
    const section = generateSection(EMPTY_LAYOUT, { ...plainRun, pieces: 20, seed: 3 })!;
    expect(section.laid).toBe(20);
    expect(section.uids).toHaveLength(20);
    expect(openEnds(section.layout)).toHaveLength(2);
    expectSound(section.layout);
  });

  it('gives the same section for the same seed, and another for another', () => {
    const a = generateSection(EMPTY_LAYOUT, { pieces: 16, seed: 7 })!;
    const b = generateSection(EMPTY_LAYOUT, { pieces: 16, seed: 7 })!;
    const c = generateSection(EMPTY_LAYOUT, { pieces: 16, seed: 8 })!;
    expect(b.layout).toEqual(a.layout);
    expect(c.layout).not.toEqual(a.layout);
  });

  it('runs straighter or twistier as asked', () => {
    const curves = (share: number) =>
      [1, 2, 3, 4].reduce((n, seed) => {
        const s = generateSection(EMPTY_LAYOUT, { ...plainRun, pieces: 20, curves: share, seed })!;
        return n + added(s.layout, s.uids).filter((p) => getPiece(p.pieceId).category === 'curve').length;
      }, 0);
    expect(curves(0)).toBe(0);
    expect(curves(0.7)).toBeGreaterThan(curves(0.2));
  });

  it('closes a loop', () => {
    for (const seed of [1, 2, 3]) {
      const section = generateSection(EMPTY_LAYOUT, { ...plainRun, loop: true, pieces: 16, seed })!;
      expect(section.closed).toBe(true);
      expect(openEnds(section.layout)).toEqual([]);
      expectSound(section.layout);
    }
  });

  it('adds switches with sidings that end in buffer stops', () => {
    const section = generateSection(EMPTY_LAYOUT, { pieces: 20, switches: 2, stops: 0, seed: 5 })!;
    const pieces = added(section.layout, section.uids);
    expect(section.switches).toBe(2);
    expect(pieces.filter((p) => getPiece(p.pieceId).category === 'switch')).toHaveLength(2);
    expect(pieces.filter((p) => getPiece(p.pieceId).category === 'buffer')).toHaveLength(2);
    // Two ends of the main line; the sidings are closed off.
    expect(openEnds(section.layout)).toHaveLength(2);
    expectSound(section.layout);
  });

  it('can leave sidings open, to build on', () => {
    const section = generateSection(EMPTY_LAYOUT, { pieces: 16, switches: 2, stops: 0, sidings: 'open', seed: 5 })!;
    expect(openEnds(section.layout)).toHaveLength(4);
    expectSound(section.layout);
  });

  it('climbs a level and comes back down', () => {
    const section = generateSection(EMPTY_LAYOUT, { ...plainRun, pieces: 20, climb: 'over', seed: 2 })!;
    const pieces = added(section.layout, section.uids);
    expect(pieces.some((p) => baseOf(p) >= LEVEL_HEIGHT)).toBe(true);
    expect(pieces.filter((p) => p.pieceId.startsWith('ramp'))).toHaveLength(2);
    const ends = openEnds(section.layout);
    expect(ends.every((e) => (e.connector.z ?? 0) === 0)).toBe(true);
    expectSound(section.layout);
  });

  it('can finish a level up', () => {
    const section = generateSection(EMPTY_LAYOUT, { ...plainRun, pieces: 12, climb: 'up', seed: 2 })!;
    const heights = openEnds(section.layout).map((e) => e.connector.z ?? 0).sort((x, y) => x - y);
    expect(heights).toEqual([0, LEVEL_HEIGHT]);
    expectSound(section.layout);
  });

  it('puts things to stop at along it', () => {
    const section = generateSection(EMPTY_LAYOUT, { pieces: 24, switches: 0, stops: 4, seed: 11 })!;
    expect(section.stops).toBe(4);
    const ids = new Set(STOPS.map((s) => s.id));
    expect(added(section.layout, section.uids).filter((p) => ids.has(p.pieceId))).toHaveLength(4);
    expectSound(section.layout);
  });

  it('builds on from a selected end', () => {
    const start = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    const end = worldEnds(start.layout.pieces[0]).find((e) => e.connectorId === 'b')!;
    const section = generateSection(start.layout, { ...plainRun, pieces: 10, seed: 4 }, { start: end })!;
    expect(section.laid).toBe(10);
    // The old piece is joined on: one open end left on it, and one at the far end of the new run.
    expect(openEnds(section.layout)).toHaveLength(2);
    expect(findJoints(section.layout)).toHaveLength(10);
    expectSound(section.layout);
  });

  it('keeps clear of track already there', () => {
    let base = EMPTY_LAYOUT;
    for (let i = 0; i < 6; i++) base = addPiece(base, 'straight-long', { x: -650 + i * 216, y: 250, angle: 0 }).layout;
    for (const seed of [1, 2, 3, 4]) {
      const section = generateSection(base, { pieces: 16, seed }, { at: { x: 0, y: 0 } })!;
      expectSound(section.layout);
    }
  });

  it('stays inside an area, laying fewer pieces if it must', () => {
    const outside = (layout: Layout) =>
      layout.pieces.filter((p) => worldEnds(p).some((e) => Math.abs(e.connector.pose.x) > 600 || Math.abs(e.connector.pose.y) > 400)).map((p) => p.uid);
    const section = generateSection(EMPTY_LAYOUT, { ...plainRun, pieces: 40, seed: 9 }, { blocked: outside })!;
    expect(outside(section.layout)).toEqual([]);
    expect(section.laid).toBeGreaterThan(4);
    expectSound(section.layout);
  });

  it('fits loops, switches and stops on a play table', { timeout: 15000 }, () => {
    const table = getEnvironment('table');
    const blocked = (layout: Layout) => offArea(layout, table)?.uids ?? [];
    for (const seed of [1, 2, 3]) {
      const loop = generateSection(EMPTY_LAYOUT, { loop: true, pieces: 22, switches: 1, stops: 2, seed }, { blocked })!;
      expect(loop.closed).toBe(true);
      expect(loop.laid).toBeGreaterThanOrEqual(14);
      expect(blocked(loop.layout)).toEqual([]);
      expectSound(loop.layout);
      const run = generateSection(EMPTY_LAYOUT, { pieces: 24, switches: 2, stops: 2, seed }, { blocked, budgetMs: 500 })!;
      expect(run.laid).toBeGreaterThanOrEqual(18);
      expect(blocked(run.layout)).toEqual([]);
      expectSound(run.layout);
    }
  });

  it('lays long sections quickly', () => {
    const t = performance.now();
    const section = generateSection(EMPTY_LAYOUT, { pieces: 80, switches: 3, stops: 3, climb: 'over', seed: 12 })!;
    expect(section.laid).toBe(80);
    expectSound(section.layout);
    expect(performance.now() - t).toBeLessThan(4000);
  });
});
