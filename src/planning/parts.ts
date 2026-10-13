import { CATALOG, getPiece } from '../pieces/catalog';
import type { PieceCategory, PieceDef } from '../pieces/types';
import type { Layout } from '../layout/layout';

// The shopping list for a layout: how many of each catalog piece it uses.
// Pegs and holes matter on the floor, so every peg and hole variant is its
// own line. Left and right don't: a right-hand curve is a left-hand one
// turned over, so both count as the same piece.

export interface PartsLine {
  pieceId: string;
  /** The shape, such as "Large curve". */
  name: string;
  /** Which peg and hole version, such as "two pegs" or "peg + hole". */
  variant: string;
  brioIds: string[];
  category: PieceCategory;
  count: number;
}

export interface PartsList {
  lines: PartsLine[];
  total: number;
}

/** Shape name and variant label from a catalog name like "Large curve, two pegs". */
export function splitName(piece: PieceDef): { name: string; variant: string } {
  const [name, ...rest] = piece.name.split(', ');
  if (rest.length) return { name, variant: rest.join(', ') };
  const genders = new Set(piece.connectors.map((c) => c.gender));
  const twoEnded = piece.connectors.length === 2 && (piece.category === 'straight' || piece.category === 'curve');
  return { name, variant: twoEnded && genders.size === 2 ? 'peg + hole' : '' };
}

/** Lines in catalog order, so straights come before curves before switches. */
export function partsList(layout: Layout): PartsList {
  const counts = new Map<string, number>();
  for (const p of layout.pieces) counts.set(p.pieceId, (counts.get(p.pieceId) ?? 0) + 1);
  const lines = CATALOG.filter((p) => counts.has(p.id)).map((p) => {
    const piece = getPiece(p.id);
    return { pieceId: p.id, ...splitName(piece), brioIds: piece.brioIds, category: piece.category, count: counts.get(p.id)! };
  });
  return { lines, total: layout.pieces.length };
}

/** The list as plain text, one line per piece, for pasting into notes. */
export function partsText(list: PartsList): string {
  const rows = list.lines.map((l) => {
    const letters = l.brioIds.length ? ` (${l.brioIds.join('/')})` : '';
    const variant = l.variant ? `, ${l.variant}` : '';
    return `${l.count} × ${l.name}${variant}${letters}`;
  });
  return [...rows, `${list.total} pieces in all`].join('\n');
}
