import { describe, expect, it } from 'vitest';
import { canMate } from '../geometry/joint';
import { IDENTITY } from '../geometry/pose';
import { checkLayout } from '../planning/check';
import { findFills, NEAR_PIECES } from './fill';
import { addPiece, EMPTY_LAYOUT, extendFrom, findJoints, openEnds, removePieces, worldEnd, type EndRef, type Extension, type Layout } from './layout';

/** Keep adding pieces from the open end the last one left. */
function build(start: string, rest: string[]): Layout {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, start, IDENTITY);
  let end: EndRef | null = { uid, connectorId: 'b' };
  for (const id of rest) {
    const ext: Extension = extendFrom(layout, end!, id)!;
    layout = ext.layout;
    end = ext.next;
  }
  return layout;
}

const ref = (e: EndRef): EndRef => ({ uid: e.uid, connectorId: e.connectorId });

/** The two open ends of a layout with exactly two. */
function gap(layout: Layout): [EndRef, EndRef] {
  const open = openEnds(layout);
  expect(open).toHaveLength(2);
  return [ref(open[0]), ref(open[1])];
}

/** A fill joins the two ends: only the far ends of the end pieces left open, nothing else the check objects to. */
function expectJoined(layout: Layout): void {
  expect(openEnds(layout)).toHaveLength(2);
  expect(checkLayout(layout).filter((i) => i.kind !== 'open-end')).toEqual([]);
}

/** A fill closes the gap: no open ends left, nothing the check objects to, every joint seated. */
function expectClosed(layout: Layout): void {
  expect(openEnds(layout)).toHaveLength(0);
  expect(checkLayout(layout)).toEqual([]);
}

describe('auto-fill between two open ends', () => {
  it('finds the two missing curves of a circle first', () => {
    const circle = build('curve-large', Array(7).fill('curve-large'));
    const broken = removePieces(circle, new Set(['p4', 'p5']));
    const [a, b] = gap(broken);
    const fills = findFills(broken, a, b);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].uids).toHaveLength(2);
    expect(fills[0].odd).toBe(0);
    for (const fill of fills) expectClosed(fill.layout);
  });

  it('offers several different ways, fewest pieces first', () => {
    const oval = build('straight-long', ['curve-large', 'curve-large', 'curve-large', 'curve-large', 'straight-long', 'curve-large', 'curve-large', 'curve-large', 'curve-large']);
    const broken = removePieces(oval, new Set(['p6', 'p7', 'p8']));
    const [a, b] = gap(broken);
    const fills = findFills(broken, a, b);
    expect(fills.length).toBeGreaterThan(1);
    const sizes = fills.map((f) => f.uids.length);
    expect(sizes).toEqual([...sizes].sort((x, y) => x - y));
    for (const fill of fills) expectClosed(fill.layout);
  });

  it('takes up a small misfit in the joint play', () => {
    const circle = build('curve-large', Array(7).fill('curve-large'));
    // Two arcs of the circle with a two-curve gap between them, one knocked 4 mm out:
    // more than one joint gives, but not more than three share.
    const broken = removePieces(circle, new Set(['p4', 'p5', 'p8']));
    const nudged = { pieces: broken.pieces.map((p) => (['p6', 'p7'].includes(p.uid) ? { ...p, pose: { ...p.pose, x: p.pose.x + 4 } } : p)) };
    const fills = findFills(nudged, { uid: 'p3', connectorId: 'b' }, { uid: 'p6', connectorId: 'a' });
    expect(fills.length).toBeGreaterThan(0);
    const best = fills[0];
    expect(best.uids).toHaveLength(2);
    expect(best.flex).toBeGreaterThan(0.3);
    expect(best.flex).toBeLessThanOrEqual(0.85);
    expect(openEnds(best.layout).map((e) => e.uid).sort()).toEqual(['p1', 'p7']);
  });

  it('uses a two-peg or two-hole piece when both ends are the same', () => {
    // Two straights pointing at each other, peg facing peg.
    const first = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const second = addPiece(first.layout, 'straight-medium', { x: 144 + 432 + 144, y: 0, angle: Math.PI });
    const layout = second.layout;
    const pegs = openEnds(layout).filter((e) => e.connector.gender === 'peg');
    expect(pegs).toHaveLength(2);
    const fills = findFills(layout, ref(pegs[0]), ref(pegs[1]));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].odd).toBe(1);
    const open = openEnds(fills[0].layout);
    expect(open.every((e) => e.connector.gender === 'hole')).toBe(true);
  });

  it('climbs with a ramp when the ends are at different heights', () => {
    const low = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    const high = addPiece(low.layout, 'straight-long', { x: 216 + 216 + 216, y: 0, angle: 0 }, false, 64);
    const layout = high.layout;
    const a = openEnds(layout).find((e) => e.uid === low.uid && e.connector.gender === 'peg')!;
    const b = openEnds(layout).find((e) => e.uid === high.uid && e.connector.gender === 'hole')!;
    const fills = findFills(layout, ref(a), ref(b));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].layout.pieces.filter((p) => fills[0].uids.includes(p.uid)).some((p) => p.pieceId.startsWith('ramp'))).toBe(true);
    const end = openEnds(fills[0].layout);
    expect(end.some((e) => e.uid === high.uid && e.connectorId === b.connectorId)).toBe(false);
  });

  it('never runs a fill through other track', () => {
    const circle = build('curve-large', Array(7).fill('curve-large'));
    const broken = removePieces(circle, new Set(['p4', 'p5']));
    // A straight lying across where the missing curves would go.
    const [a, b] = gap(broken);
    const blocker = addPiece(broken, 'straight-long', { x: 120, y: 330, angle: -Math.PI / 4 }).layout;
    for (const fill of findFills(blocker, a, b, { budgetMs: 800 })) {
      expect(checkLayout(fill.layout).filter((i) => i.kind === 'overlap')).toEqual([]);
    }
  });

  it('has no limit on pieces: joins ends far apart', () => {
    const first = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const second = addPiece(first.layout, 'straight-medium', { x: 216 * 14 + 144, y: 0, angle: 0 });
    const open = openEnds(second.layout);
    const a = open.find((e) => e.uid === first.uid && e.connector.gender === 'peg')!;
    const b = open.find((e) => e.uid === second.uid && e.connector.gender === 'hole')!;
    const fills = findFills(second.layout, ref(a), ref(b), { wanted: 1, budgetMs: 8000 });
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].uids.length).toBeGreaterThan(NEAR_PIECES);
    expectJoined(fills[0].layout);
  });

  it('finds long runs that have to turn round', () => {
    // Two ends side by side a metre apart, both facing the same way: the run has to go out and come back.
    const first = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const second = addPiece(first.layout, 'straight-medium', { x: 144, y: 1000, angle: Math.PI });
    const open = openEnds(second.layout);
    const a = open.find((e) => e.uid === first.uid && e.connector.gender === 'peg')!;
    const b = open.find((e) => e.uid === second.uid && e.connector.gender === 'hole')!;
    const fills = findFills(second.layout, ref(a), ref(b), { wanted: 1, budgetMs: 8000 });
    expect(fills.length).toBeGreaterThan(0);
    expectJoined(fills[0].layout);
  });

  it('finds a way round track in the way', () => {
    // Two ends a metre and a bit apart, with a wall of track across the middle.
    let layout = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY).layout;
    layout = addPiece(layout, 'straight-medium', { x: 1400, y: 0, angle: 0 }).layout;
    for (let i = 0; i < 4; i++) layout = addPiece(layout, 'straight-long', { x: 700, y: -432 + i * 216, angle: Math.PI / 2 }).layout;
    const open = openEnds(layout);
    const a = open.find((e) => e.uid === 'p1' && e.connector.gender === 'peg')!;
    const b = open.find((e) => e.uid === 'p2' && e.connector.gender === 'hole')!;
    const fills = findFills(layout, ref(a), ref(b), { wanted: 1 });
    expect(fills.length).toBeGreaterThan(0);
    expect(openEnds(fills[0].layout)).toHaveLength(4);
    expect(checkLayout(fills[0].layout).filter((i) => i.kind !== 'open-end')).toEqual([]);
  });

  it('gives up when it runs out of time', () => {
    const first = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const second = addPiece(first.layout, 'straight-medium', { x: 20000, y: 0, angle: 0 });
    const open = openEnds(second.layout);
    const a = open.find((e) => e.uid === first.uid && e.connector.gender === 'peg')!;
    const b = open.find((e) => e.uid === second.uid && e.connector.gender === 'hole')!;
    expect(findFills(second.layout, ref(a), ref(b), { budgetMs: 50 })).toEqual([]);
  });

  it('every joint a fill makes is peg into hole and within play', () => {
    const circle = build('curve-large', Array(7).fill('curve-large'));
    const broken = removePieces(circle, new Set(['p2', 'p3', 'p4']));
    const [a, b] = gap(broken);
    for (const fill of findFills(broken, a, b)) {
      const joints = findJoints(fill.layout);
      expect(joints).toHaveLength(fill.layout.pieces.length);
      for (const j of joints) expect(canMate(worldEnd(fill.layout, j.a).connector, worldEnd(fill.layout, j.b).connector)).toBe(true);
    }
  });
});
