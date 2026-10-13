import { describe, expect, it } from 'vitest';
import { deg, IDENTITY, normalizeAngle } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import { addPiece, EMPTY_LAYOUT, extendFrom, worldEnd, type EndRef } from '../layout/layout';
import { attachEnd, flipFor, SHAPES, variantFor, type Hand } from './variants';

const shape = (key: string) => SHAPES.find((s) => s.key === key)!;

describe('shapes', () => {
  it('groups peg and hole variants under one shape', () => {
    expect(shape('straight-medium').ids).toEqual(['straight-medium', 'straight-medium-pp', 'straight-medium-hh']);
    expect(shape('straight-long').ids).toEqual(['straight-long']);
    expect(shape('switch-curved').ids).toEqual(['switch-curved', 'switch-curved-peg']);
    expect(shape('buffer').ids).toEqual(['buffer', 'buffer-peg']);
    expect(shape('curve-large').name).toBe('Large curve');
  });

  it('covers every catalog piece exactly once', () => {
    const ids = SHAPES.flatMap((s) => s.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('variantFor', () => {
  it('follows the Ends choice for straights and curves', () => {
    expect(variantFor(shape('curve-large'), 'pegs', 'hole')).toBe('curve-large-pp');
    expect(variantFor(shape('straight-mini'), 'holes', null)).toBe('straight-mini-hh');
    expect(variantFor(shape('straight-long'), 'pegs', null)).toBe('straight-long');
  });

  it('puts switches on trunk first and picks the buffer stop that fits', () => {
    expect(variantFor(shape('switch-curved'), 'mixed', 'peg')).toBe('switch-curved');
    expect(variantFor(shape('switch-curved'), 'mixed', 'hole')).toBe('switch-curved-peg');
    expect(variantFor(shape('buffer'), 'mixed', 'peg')).toBe('buffer');
    expect(variantFor(shape('buffer'), 'mixed', 'hole')).toBe('buffer-peg');
  });
});

describe('flipFor', () => {
  // A straight running along +x with a peg at the far end and a hole at the start.
  const base = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
  const pegEnd: EndRef = { uid: base.uid, connectorId: 'b' };
  const holeEnd: EndRef = { uid: base.uid, connectorId: 'a' };

  /** How much the new curve turns the track, building outward from `end`. */
  function turnBuilding(end: EndRef, pieceId: string, hand: Hand): number {
    const target = worldEnd(base.layout, end).connector;
    const attach = attachEnd(pieceId, target.gender);
    const ext = extendFrom(base.layout, end, pieceId, flipFor(pieceId, attach, hand), attach)!;
    const out = worldEnd(ext.layout, ext.next!).connector.pose.angle;
    return normalizeAngle(out - target.pose.angle);
  }

  it.each([
    ['peg', pegEnd],
    ['hole', holeEnd],
  ] as const)('turns the chosen way when building from a %s end', (_, end) => {
    expect(turnBuilding(end, 'curve-large', 'left')).toBeCloseTo(deg(45));
    expect(turnBuilding(end, 'curve-large', 'right')).toBeCloseTo(deg(-45));
    expect(turnBuilding(end, 'curve-short', 'right')).toBeCloseTo(deg(-45));
  });

  it('never flips pieces that do not turn', () => {
    for (const id of ['straight-medium', 'cross', 'switch-three-way']) {
      expect(flipFor(id, getPiece(id).connectors[0].id, 'right')).toBe(false);
    }
  });

  it('turns a switch branch the chosen way', () => {
    expect(flipFor('switch-curved', 'trunk', 'left')).toBe(false);
    expect(flipFor('switch-curved', 'trunk', 'right')).toBe(true);
  });
});
