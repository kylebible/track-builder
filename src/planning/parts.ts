import { CATALOG, getPiece } from '../pieces/catalog';
import type { PieceCategory, PieceDef } from '../pieces/types';
import type { Layout } from '../layout/layout';
import { supportsOf } from '../layout/supports';
import { LEVEL_HEIGHT } from '../pieces/dimensions';

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
  /** Track pieces. */
  total: number;
  /** Support blocks holding up raised track. */
  supports: number;
  /** Beams across the tops of arch supports, by length (mm, rounded up to 10), shortest first. */
  beams: { length: number; count: number }[];
}

/** Shape name and variant label from a catalog name like "Large curve, two pegs". */
export function splitName(piece: PieceDef): { name: string; variant: string } {
  const [name, ...rest] = piece.name.split(', ');
  if (rest.length) return { name, variant: rest.join(', ') };
  const genders = new Set(piece.connectors.map((c) => c.gender));
  const twoEnded = piece.connectors.length === 2 && (piece.category === 'straight' || piece.category === 'curve' || piece.category === 'ramp');
  return { name, variant: twoEnded && genders.size === 2 ? 'peg + hole' : '' };
}

/** Lines in catalog order, so straights come before curves before switches. */
export function partsList(layout: Layout): PartsList {
  const counts = new Map<string, number>();
  for (const p of layout.pieces) {
    // Every shape of a bendy track is the one piece.
    const id = getPiece(p.pieceId).partOf ?? p.pieceId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const lines = CATALOG.filter((p) => counts.has(p.id)).map((p) => {
    const piece = getPiece(p.id);
    return { pieceId: p.id, ...splitName(piece), brioIds: piece.brioIds, category: piece.category, count: counts.get(p.id)! };
  });
  const all = supportsOf(layout);
  const supports = all.reduce((n, s) => n + s.blocks, 0);
  const beams = new Map<number, number>();
  for (const { arch } of all) {
    if (!arch) continue;
    const length = Math.ceil(arch.span / 10) * 10;
    beams.set(length, (beams.get(length) ?? 0) + 1);
  }
  return {
    lines,
    total: layout.pieces.length,
    supports,
    beams: [...beams].sort(([a], [b]) => a - b).map(([length, count]) => ({ length, count })),
  };
}

export const SUPPORT_NAME = `Support block (${LEVEL_HEIGHT} mm)`;
/** A flat plank laid across two stacks of blocks, for an arch over lower track. */
export const beamName = (length: number): string => `Arch beam (${length} mm plank)`;

/** The list as plain text, one line per piece, for pasting into notes. */
export function partsText(list: PartsList): string {
  const rows = list.lines.map((l) => {
    const letters = l.brioIds.length ? ` (${l.brioIds.join('/')})` : '';
    const variant = l.variant ? `, ${l.variant}` : '';
    return `${l.count} × ${l.name}${variant}${letters}`;
  });
  if (list.supports) rows.push(`${list.supports} × ${SUPPORT_NAME}`);
  for (const b of list.beams) rows.push(`${b.count} × ${beamName(b.length)}`);
  return [...rows, `${list.total} pieces in all`].join('\n');
}
