import { normalizeAngle } from '../geometry/pose';
import { offered } from '../pieces/basic';
import { CATALOG, getPiece, mirrorPiece } from '../pieces/catalog';
import type { Gender, PieceCategory, PieceDef } from '../pieces/types';

// The palette shows one tile per shape. Which catalog variant a tap places
// (peg and hole pattern, flipped or not) is worked out here from the
// palette's Turn and Ends settings and the end being built from.

export type Hand = 'left' | 'right';
/** Ends of a two-ended straight or curve: one of each, or two the same. */
export type Ends = 'mixed' | 'pegs' | 'holes';

export interface Shape {
  key: string;
  name: string;
  category: PieceCategory;
  /** Every catalog variant of this shape; the first is the usual one. */
  ids: string[];
}

const VARIANT_SUFFIX = /-(pp|hh|peg|b\d+)$/;

/** Catalog pieces grouped by shape, in catalog order. */
export const SHAPES: readonly Shape[] = (() => {
  const shapes = new Map<string, Shape>();
  for (const piece of CATALOG) {
    const key = piece.id.replace(VARIANT_SUFFIX, '');
    let shape = shapes.get(key);
    if (!shape) {
      // Variant names add ", two pegs" and the like; the first is the plain shape.
      const name = piece.name.split(',')[0];
      shapes.set(key, (shape = { key, name, category: piece.category, ids: [] }));
    }
    shape.ids.push(piece.id);
  }
  return [...shapes.values()];
})();

export function endsOf(piece: PieceDef): Ends {
  const genders = new Set(piece.connectors.map((c) => c.gender));
  if (genders.size === 2) return 'mixed';
  return genders.has('peg') ? 'pegs' : 'holes';
}

/** Scenery that isn't track: no ends, so it never joins anything. */
export const isLoose = (shape: Shape): boolean => getPiece(shape.ids[0]).connectors.length === 0;

/** Whether a shape comes in two-peg and two-hole versions. */
export const hasEndsChoice = (shape: Shape): boolean => shape.category === 'straight' || shape.category === 'curve';

/**
 * The catalog piece a palette tap should place. `target` is the gender of
 * the end being built from, if any. Switches go on trunk first and buffer
 * stops take whichever version fits; straights and curves follow `ends`.
 */
export function variantFor(shape: Shape, ends: Ends, target: Gender | null): string {
  const ids = offeredIds(shape);
  if (hasEndsChoice(shape)) {
    return ids.find((id) => endsOf(getPiece(id)) === ends) ?? ids[0];
  }
  // A ramp goes on by its low end, so it climbs away from the end built from.
  if (target && (shape.category === 'switch' || shape.category === 'buffer' || shape.category === 'ramp')) {
    const first = ids.find((id) => getPiece(id).connectors[0].gender !== target);
    if (first) return first;
  }
  return ids[0];
}

/** The versions of a shape the current mode offers (Basic mode: real Brio ones); all of them if none is. */
export function offeredIds(shape: Shape): string[] {
  const ids = shape.ids.filter((id) => offered(getPiece(id)));
  return ids.length ? ids : shape.ids;
}

/** Whether the current mode offers any version of a shape. */
export const isOffered = (shape: Shape): boolean => shape.ids.some((id) => offered(getPiece(id)));

/** Whether a shape offers the `ends` choice in the current mode. */
export const offersEnds = (shape: Shape, ends: Ends): boolean => offeredIds(shape).some((id) => endsOf(getPiece(id)) === ends);

/**
 * How far the piece turns, summed over its other ends, when a train enters
 * by `attachId`. Positive is left. Zero for straights, crossings and
 * three-way switches. Ends facing the same way as the one entered by (the
 * other track's start, on double track) don't count.
 */
export function turnFrom(piece: PieceDef, attachId: string): number {
  const attach = piece.connectors.find((c) => c.id === attachId)!;
  const heading = attach.pose.angle + Math.PI;
  return piece.connectors
    .filter((c) => c !== attach && Math.abs(normalizeAngle(c.pose.angle - attach.pose.angle)) > 1e-6)
    .reduce((sum, c) => sum + normalizeAngle(c.pose.angle - heading), 0);
}

/** Whether to flip `pieceId`, entered by `attachId`, so it turns towards `hand`. */
export function flipFor(pieceId: string, attachId: string, hand: Hand): boolean {
  const turn = turnFrom(getPiece(pieceId), attachId);
  if (Math.abs(turn) < 1e-6) return false;
  return hand === 'left' ? turn < 0 : turn > 0;
}

/**
 * The end a piece goes on by: the first one that mates with `target`, `height`
 * mm above the floor, without the piece going below the floor; else its first end.
 */
export function attachEnd(pieceId: string, target: Gender | null, height = 0): string {
  const connectors = getPiece(pieceId).connectors;
  const fits = target ? connectors.find((c) => c.gender !== target && height - (c.z ?? 0) > -1e-6) : undefined;
  return fits?.id ?? connectors[0].id;
}

const mirrored = new Map<string, PieceDef>();

/** The piece as the palette should draw it for `hand`, entered by its first end. */
export function iconPiece(pieceId: string, hand: Hand): PieceDef {
  const piece = getPiece(pieceId);
  if (!flipFor(pieceId, piece.connectors[0].id, hand)) return piece;
  let m = mirrored.get(pieceId);
  if (!m) mirrored.set(pieceId, (m = mirrorPiece(piece)));
  return m;
}
