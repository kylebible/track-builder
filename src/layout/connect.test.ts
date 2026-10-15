import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { checkLayout } from '../planning/check';
import { connectOpenEnds, searchConnections } from './connect';
import { addPiece, EMPTY_LAYOUT, extendFrom, openEnds, removePieces, type Layout } from './layout';

function gaps(...missing: string[]): Layout {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, 'curve-large', IDENTITY);
  for (let i = 1; i < 8; i++) {
    const next = extendFrom(layout, { uid, connectorId: 'b' }, 'curve-large')!;
    layout = next.layout;
    uid = next.uid;
  }
  return removePieces(layout, new Set(missing));
}

describe('connecting all open ends', () => {
  it('closes multiple gaps without moving existing track, leaving no loose ends or collisions', () => {
    const base = gaps('p2', 'p6');
    const original = structuredClone(base);
    expect(openEnds(base)).toHaveLength(4);
    const result = connectOpenEnds(base, { budgetMs: 4000 });
    expect(result.pairs).toHaveLength(2);
    expect(result.remaining).toEqual([]);
    expect(openEnds(result.layout)).toEqual([]);
    expect(result.uids.length).toBeGreaterThanOrEqual(2);
    expect(result.trapped).toBe(false);
    expect(checkLayout(result.layout)).toEqual([]);
    expect(base).toEqual(original);
    expect(result.layout.pieces.filter((p) => !result.uids.includes(p.uid))).toEqual(base.pieces);
  });

  it('reports one unpaired end when the layout has an odd number', () => {
    const base = addPiece(gaps('p3'), 'buffer', { x: 10000, y: 0, angle: 0 }).layout;
    const result = connectOpenEnds(base, { budgetMs: 4000 });
    expect(result.initialEnds).toBe(3);
    expect(result.pairs).toHaveLength(1);
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].uid).toBe(base.pieces.at(-1)!.uid);
  });

  it('routes all eight turntable connectors without overlaps or train traps', () => {
    const base = addPiece(EMPTY_LAYOUT, 'turntable', IDENTITY).layout;
    const result = connectOpenEnds(base, { budgetMs: 6000 });
    expect(result.initialEnds).toBe(8);
    expect(result.pairs).toHaveLength(4);
    expect(result.remaining).toEqual([]);
    expect(checkLayout(result.layout)).toEqual([]);
    expect(result.trapped).toBe(false);
    expect(result.layout.pieces[0]).toEqual(base.pieces[0]);
  });

  it('uses ramps to connect open ends at different heights', () => {
    const low = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    const high = addPiece(low.layout, 'straight-long', { x: 648, y: 0, angle: 0 }, false, 64);
    let base = extendFrom(high.layout, { uid: low.uid, connectorId: 'a' }, 'buffer-peg')!.layout;
    base = extendFrom(base, { uid: high.uid, connectorId: 'b' }, 'buffer')!.layout;
    expect(openEnds(base)).toHaveLength(2);
    const result = connectOpenEnds(base, { budgetMs: 4000 });
    expect(result.remaining).toEqual([]);
    expect(result.layout.pieces.some((p) => result.uids.includes(p.uid) && p.pieceId.startsWith('ramp'))).toBe(true);
    expect(checkLayout(result.layout)).toEqual([]);
  });

  it('leaves blocked ends open and reports a partial result instead of adding invalid track', () => {
    const base = gaps('p2', 'p6');
    const keep = new Set(base.pieces.map((p) => p.uid));
    const result = connectOpenEnds(base, { budgetMs: 100, pairBudgetMs: 30, blocked: (layout) => layout.pieces.filter((p) => !keep.has(p.uid)).map((p) => p.uid) });
    expect(result.layout).toBe(base);
    expect(result.uids).toEqual([]);
    expect(result.remaining).toHaveLength(4);
  });

  it('does nothing for a closed layout or one with only a single end', () => {
    expect(connectOpenEnds(gaps()).initialEnds).toBe(0);
    const single = addPiece(EMPTY_LAYOUT, 'buffer', IDENTITY).layout;
    const result = connectOpenEnds(single);
    expect(result.layout).toBe(single);
    expect(result.remaining).toHaveLength(1);
    expect(result.pairs).toEqual([]);
    expect(result.limited).toBe(false);
  });

  it('yields an unchanged preview first, so the operation can be canceled before adding anything', () => {
    const base = gaps('p2', 'p6');
    const search = searchConnections(base);
    const preview = search.next().value;
    expect(preview).toMatchObject({ layout: base, pairs: [], remaining: openEnds(base).map(({ uid, connectorId }) => ({ uid, connectorId })) });
    search.return(preview);
    expect(base.pieces).toHaveLength(6);
    const stopped = connectOpenEnds(base, { budgetMs: 0 });
    expect(stopped.layout).toBe(base);
    expect(stopped.limited).toBe(true);
  });
});
