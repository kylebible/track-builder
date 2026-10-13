import { describe, expect, it } from 'vitest';
import { pathEnd } from './path';
import { applyPose, deg, distance, IDENTITY, type Pose } from './pose';
import { canMate, jointError, placeToMate, worldConnector } from './joint';
import { CATALOG, getPiece, mirrorPiece } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import type { Connector, PieceDef } from '../pieces/types';

const connector = (piece: PieceDef, id: string): Connector => {
  const c = piece.connectors.find((k) => k.id === id);
  if (!c) throw new Error(`${piece.id} has no ${id}`);
  return c;
};

/**
 * Lay pieces end to end, joining each piece's `a` end to the previous
 * piece's `b` end. Returns the first piece's open `a` end and the last
 * piece's open `b` end, in world coordinates.
 */
function chain(pieces: PieceDef[]): { first: Connector; last: Connector } {
  let placement: Pose = IDENTITY;
  const first = worldConnector(placement, connector(pieces[0], 'a'));
  let last = worldConnector(placement, connector(pieces[0], 'b'));
  for (const piece of pieces.slice(1)) {
    placement = placeToMate(last.pose, piece, 'a');
    expect(canMate(last, worldConnector(placement, connector(piece, 'a')))).toBe(true);
    last = worldConnector(placement, connector(piece, 'b'));
  }
  return { first, last };
}

const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

describe('loops close', () => {
  it('eight large curves make a circle', () => {
    const { first, last } = chain(repeat(8, getPiece('curve-large')));
    expect(canMate(first, last)).toBe(true);
    expect(jointError(first.pose, last.pose).gapMm).toBeLessThan(1e-9);
  });

  it('eight short curves make a circle', () => {
    const { first, last } = chain(repeat(8, getPiece('curve-short')));
    expect(canMate(first, last)).toBe(true);
  });

  it('an oval of eight large curves and two long straights closes', () => {
    const curve = getPiece('curve-large');
    const straight = getPiece('straight-long');
    const { first, last } = chain([...repeat(4, curve), straight, ...repeat(4, curve), straight]);
    expect(canMate(first, last)).toBe(true);
  });

  it('seven large curves leave a gap', () => {
    const { first, last } = chain(repeat(7, getPiece('curve-large')));
    expect(canMate(first, last)).toBe(false);
  });

  it('an oval with one side a short straight longer does not close', () => {
    const curve = getPiece('curve-large');
    const { first, last } = chain([
      ...repeat(4, curve),
      getPiece('straight-long'),
      ...repeat(4, curve),
      getPiece('straight-medium'),
    ]);
    expect(jointError(first.pose, last.pose).gapMm).toBeCloseTo(D.LONG_STRAIGHT - D.MEDIUM_STRAIGHT, 6);
    expect(canMate(first, last)).toBe(false);
  });
});

describe('piece dimensions', () => {
  it.each([
    ['straight-mini', 54],
    ['straight-short', 108],
    ['straight-medium', 144],
    ['straight-long', 216],
  ])('%s is %i mm between its ends', (id, length) => {
    const p = getPiece(id);
    expect(distance(connector(p, 'a').pose, connector(p, 'b').pose)).toBeCloseTo(length, 9);
  });

  it('A, B and C straights are peg and hole, two pegs, two holes', () => {
    const genders = (id: string) => getPiece(id).connectors.map((c) => c.gender).sort();
    expect(genders('straight-medium')).toEqual(['hole', 'peg']);
    expect(genders('straight-medium-pp')).toEqual(['peg', 'peg']);
    expect(genders('straight-medium-hh')).toEqual(['hole', 'hole']);
    expect(getPiece('straight-medium-pp').brioIds).toEqual(['B']);
    expect(getPiece('straight-medium-hh').brioIds).toEqual(['C']);
  });

  it('curve radii follow the single inner-edge assumption', () => {
    const offset = D.CURVE_RADII_ARE_INNER_EDGE ? D.TRACK_WIDTH / 2 : 0;
    expect(D.LARGE_CURVE_RADIUS).toBe(182 + offset);
    expect(D.SHORT_CURVE_RADIUS).toBe(90 + offset);
  });

  it('a large curve turns 45 degrees left along its centerline radius', () => {
    const end = connector(getPiece('curve-large'), 'b').pose;
    const r = D.LARGE_CURVE_RADIUS;
    expect(end.x).toBeCloseTo(r * Math.sin(deg(45)), 9);
    expect(end.y).toBeCloseTo(r * (1 - Math.cos(deg(45))), 9);
    expect(end.angle).toBeCloseTo(deg(45), 12);
  });
});

describe('switches and crossings', () => {
  it('the curved switch branches match a medium straight and a large curve', () => {
    const sw = getPiece('switch-curved');
    expect(jointError(connector(sw, 'branch0').pose, connector(getPiece('straight-medium'), 'b').pose).gapMm).toBe(0);
    const curveEnd = connector(getPiece('curve-large'), 'b').pose;
    const branch = connector(sw, 'branch1').pose;
    expect(distance(branch, curveEnd)).toBeLessThan(1e-9);
    expect(branch.angle).toBeCloseTo(curveEnd.angle, 12);
  });

  it('a curved switch trunk mates with a curve', () => {
    const sw = getPiece('switch-curved');
    const curve = getPiece('curve-large');
    const placement = placeToMate(connector(curve, 'b').pose, sw, 'trunk');
    expect(canMate(connector(curve, 'b'), worldConnector(placement, connector(sw, 'trunk')))).toBe(true);
  });

  it('the parallel switch ends in two parallel tracks', () => {
    const sw = getPiece('switch-parallel');
    const straight = connector(sw, 'branch0').pose;
    const offset = connector(sw, 'branch1').pose;
    expect(offset.angle).toBeCloseTo(0, 12);
    expect(offset.x).toBeCloseTo(D.PARALLEL_SWITCH_LENGTH, 9);
    expect(offset.y - straight.y).toBeCloseTo(D.PARALLEL_SWITCH_OFFSET, 9);
  });

  it('switch pairs differ only in which end has the pegs', () => {
    const hole = getPiece('switch-three-way');
    const peg = getPiece('switch-three-way-peg');
    expect(hole.connectors.map((c) => c.gender)).toEqual(['hole', 'peg', 'peg', 'peg']);
    expect(peg.connectors.map((c) => c.gender)).toEqual(['peg', 'hole', 'hole', 'hole']);
    expect(peg.connectors.map((c) => c.pose)).toEqual(hole.connectors.map((c) => c.pose));
  });

  it('crossing tracks cross at their midpoints at the right angle', () => {
    for (const [id, angle] of [
      ['cross', 90],
      ['criss-cross', 45],
    ] as const) {
      const p = getPiece(id);
      const mid = (x: string, y: string) => {
        const a = connector(p, x).pose;
        const b = connector(p, y).pose;
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      };
      expect(distance(mid('a', 'b'), mid('c', 'd'))).toBeLessThan(1e-9);
      expect(connector(p, 'd').pose.angle).toBeCloseTo(deg(angle), 12);
    }
  });
});

describe('flipping', () => {
  it('a flipped curve turns right', () => {
    const end = connector(mirrorPiece(getPiece('curve-large')), 'b').pose;
    expect(end.y).toBeLessThan(0);
    expect(end.angle).toBeCloseTo(deg(-45), 12);
  });

  it('flipping twice gives back the same piece', () => {
    for (const p of CATALOG) expect(mirrorPiece(mirrorPiece(p)).connectors).toEqual(p.connectors);
  });

  it('flipped right curves close a circle too', () => {
    const { first, last } = chain(repeat(8, mirrorPiece(getPiece('curve-large'))));
    expect(canMate(first, last)).toBe(true);
  });
});

describe('joint play', () => {
  const peg: Connector = { id: 'p', gender: 'peg', pose: { x: 0, y: 0, angle: 0 } };
  const hole = (x: number, angleDeg: number): Connector => ({
    id: 'h',
    gender: 'hole',
    pose: { x, y: 0, angle: Math.PI + deg(angleDeg) },
  });

  it('accepts a joint within 2 mm and 2 degrees', () => {
    expect(canMate(peg, hole(1.9, 1.9))).toBe(true);
  });

  it('rejects a joint outside the play', () => {
    expect(canMate(peg, hole(2.5, 0))).toBe(false);
    expect(canMate(peg, hole(0, 2.5))).toBe(false);
  });

  it('rejects peg into peg', () => {
    expect(canMate(peg, { ...peg, pose: { x: 0, y: 0, angle: Math.PI } })).toBe(false);
  });
});

describe('catalog', () => {
  it('has unique piece ids and unique connector ids per piece', () => {
    expect(new Set(CATALOG.map((p) => p.id)).size).toBe(CATALOG.length);
    for (const p of CATALOG) expect(new Set(p.connectors.map((c) => c.id)).size).toBe(p.connectors.length);
  });

  it('puts every connector on the end of a running path', () => {
    for (const p of CATALOG) {
      const ends: Pose[] = p.paths.flatMap((path) => [path.from, pathEnd(path)]);
      for (const c of p.connectors) {
        expect(Math.min(...ends.map((e) => distance(e, c.pose))), `${p.id}:${c.id}`).toBeLessThan(1e-9);
      }
    }
  });

  it('covers every launch piece', () => {
    const letters = new Set(CATALOG.flatMap((p) => p.brioIds));
    for (const id of ['A', 'A1', 'A2', 'B', 'B1', 'B2', 'C', 'C1', 'C2', 'D', 'E', 'E1', 'F', 'G', 'H1', 'H2', 'I', 'J', 'L', 'M', 'O1', 'P1', 'R', 'S']) {
      expect(letters, id).toContain(id);
    }
  });

  it('applyPose composes', () => {
    const p = applyPose({ x: 10, y: 0, angle: deg(90) }, { x: 5, y: 0, angle: 0 });
    expect(p.x).toBeCloseTo(10, 12);
    expect(p.y).toBeCloseTo(5, 12);
  });
});
