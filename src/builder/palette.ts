import { pathLength, poseAt } from '../geometry/path';
import { CATALOG } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import type { PieceCategory, PieceDef } from '../pieces/types';
import { buildPieceObject } from '../render/pieceMesh';
import { thumbnail } from '../render/thumbnail';

// The parts palette: one tile per catalog piece, with a plan-view drawing
// made from the same path and connector data the 3D pieces use.

const CATEGORY_NAMES: Record<PieceCategory, string> = {
  straight: 'Straights',
  curve: 'Curves',
  switch: 'Switches',
  crossing: 'Crossings',
  buffer: 'Buffer stops',
  scenery: 'Scenery',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Plan-view drawing of a piece, plan y up. */
function pieceIcon(piece: PieceDef): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const points: [number, number][] = [];
  const lines = piece.paths.map((path) => {
    const length = pathLength(path);
    const steps = path.kind === 'straight' ? 1 : 24;
    const pts = Array.from({ length: steps + 1 }, (_, i) => poseAt(path, (length * i) / steps));
    pts.forEach((p) => points.push([p.x, -p.y]));
    return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${(-p.y).toFixed(1)}`).join(' ');
  });
  const pad = D.TRACK_WIDTH / 2 + D.PEG_NECK_LENGTH + D.PEG_DIAMETER;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - minX;
  const h = Math.max(...ys) + pad - minY;
  // Draw every icon at one scale so sizes compare, unless it would overflow.
  const size = Math.max(w, h, 260);
  svg.setAttribute('viewBox', `${minX - (size - w) / 2} ${minY - (size - h) / 2} ${size} ${size}`);

  const add = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  };
  for (const d of lines) add('path', { d, class: 'icon-edge', 'stroke-width': D.TRACK_WIDTH + 4 });
  for (const d of lines) add('path', { d, class: 'icon-wood', 'stroke-width': D.TRACK_WIDTH });
  for (const c of piece.connectors) {
    const { x, y, angle } = c.pose;
    if (c.gender === 'peg') {
      const r = D.PEG_NECK_LENGTH + D.PEG_DIAMETER / 2;
      add('circle', { cx: x + r * Math.cos(angle), cy: -(y + r * Math.sin(angle)), r: D.PEG_DIAMETER / 2 + 1, class: 'icon-peg' });
    } else {
      const r = 5 + D.HOLE_DIAMETER / 2;
      add('circle', { cx: x - r * Math.cos(angle), cy: -(y - r * Math.sin(angle)), r: D.HOLE_DIAMETER / 2, class: 'icon-hole' });
    }
  }
  return svg;
}

/** A rendered picture of a piece that carries a scenery model. */
function modelIcon(piece: PieceDef): HTMLImageElement {
  const img = document.createElement('img');
  img.alt = piece.name;
  img.src = thumbnail(buildPieceObject(piece));
  return img;
}

/** A Brio letter where there is one, else which variant it is. */
function shortLabel(piece: PieceDef): string {
  if (piece.brioIds.length) return piece.brioIds[0];
  if (piece.model) return piece.name;
  if (piece.id.endsWith('-pp')) return '2 pegs';
  if (piece.id.endsWith('-hh')) return '2 holes';
  return '';
}

export class Palette {
  private readonly tiles = new Map<string, HTMLButtonElement>();

  constructor(container: HTMLElement, onPick: (pieceId: string) => void) {
    const categories = [...new Set(CATALOG.map((p) => p.category))];
    for (const category of categories) {
      const heading = document.createElement('h2');
      heading.textContent = CATEGORY_NAMES[category];
      const grid = document.createElement('div');
      grid.className = 'palette-grid';
      for (const piece of CATALOG.filter((p) => p.category === category)) {
        const tile = document.createElement('button');
        tile.className = 'tile';
        tile.title = `${piece.name}${piece.brioIds.length ? ` (${piece.brioIds.join(', ')})` : ''}`;
        tile.appendChild(piece.model ? modelIcon(piece) : pieceIcon(piece));
        const label = document.createElement('span');
        label.textContent = shortLabel(piece);
        tile.appendChild(label);
        tile.addEventListener('click', () => onPick(piece.id));
        this.tiles.set(piece.id, tile);
        grid.appendChild(tile);
      }
      container.append(heading, grid);
    }
  }

  /** Grey out pieces that can't go on the selected end. */
  setEnabled(isEnabled: (pieceId: string) => boolean): void {
    for (const [id, tile] of this.tiles) tile.classList.toggle('disabled', !isEnabled(id));
  }
}
