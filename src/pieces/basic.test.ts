import { afterEach, describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { trackMoves } from '../layout/fill';
import { addPiece, EMPTY_LAYOUT } from '../layout/layout';
import { notBrio } from '../planning/check';
import { SHAPES, isOffered, variantFor } from '../builder/variants';
import { isBrio, MODE, setBasicMode } from './basic';
import { CATALOG, getPiece } from './catalog';

afterEach(() => setBasicMode(false));

const shape = (key: string) => SHAPES.find((s) => s.key === key)!;

describe('Basic mode', () => {
  it('counts lettered track and the accessories Brio sells, not our own pieces', () => {
    for (const id of ['straight-long', 'curve-large', 'switch-curved-peg', 'ramp-pp', 'buffer', 'tunnel', 'lift-bridge', 'turntable']) expect(isBrio(getPiece(id)), id).toBe(true);
    for (const id of ['bendy', 'bendy-b3', 'bumpy', 'curve-large-pp', 'curve-short-half', 'helix', 'arch-bridge', 'bridge-truss', 'cargo-loader', 'switch-t-peg']) expect(isBrio(getPiece(id)), id).toBe(false);
  });

  it('keeps trees, houses and trackside places', () => {
    expect(CATALOG.filter((p) => p.category === 'trackside').every(isBrio)).toBe(true);
    expect(isBrio(getPiece('pine-tree'))).toBe(true);
  });

  it('hides shapes Brio does not sell and picks only Brio versions', () => {
    setBasicMode(true);
    expect(MODE.basic).toBe(true);
    expect(isOffered(shape('bendy'))).toBe(false);
    expect(isOffered(shape('curve-large'))).toBe(true);
    // Two-peg curves aren't Brio: the plain curve goes down instead.
    expect(variantFor(shape('curve-large'), 'pegs', null)).toBe('curve-large');
    // The T switch only comes with a hole on its trunk.
    expect(variantFor(shape('switch-t'), 'mixed', 'hole')).toBe('switch-t');
    setBasicMode(false);
    expect(isOffered(shape('bendy'))).toBe(true);
    expect(variantFor(shape('curve-large'), 'pegs', null)).toBe('curve-large-pp');
  });

  it('fills gaps with Brio pieces only', () => {
    const all = trackMoves().flatMap((m) => m.ways.map((w) => w.pieceId));
    expect(all).toContain('curve-large-pp');
    setBasicMode(true);
    const basic = trackMoves().flatMap((m) => m.ways.map((w) => w.pieceId));
    expect(basic.length).toBeGreaterThan(0);
    expect(basic.every((id) => isBrio(getPiece(id)))).toBe(true);
  });

  it('the check lists pieces Brio does not sell, one line per kind', () => {
    let layout = EMPTY_LAYOUT;
    for (const id of ['straight-long', 'bendy', 'bendy-b2', 'helix']) layout = addPiece(layout, id, IDENTITY).layout;
    const issues = notBrio(layout);
    expect(issues.map((i) => i.message)).toEqual(["2 × Bendy track: Brio doesn't sell this piece.", "Helix tower: Brio doesn't sell this piece."]);
    expect(issues[0].uids).toHaveLength(2);
  });
});
