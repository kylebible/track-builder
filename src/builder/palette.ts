import { pathLength, poseAt } from '../geometry/path';
import { getPiece } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import type { PieceCategory, PieceDef } from '../pieces/types';
import { hasEndsChoice, iconPiece, SHAPES, variantFor, type Ends, type Hand, type Shape } from './variants';

// The parts palette: one tile per piece shape, with a plan-view drawing
// made from the same path and connector data the 3D pieces use, plus the
// Turn and Ends settings that decide which version a tap puts down.
// A tile can also be dragged out onto the floor.

const CATEGORY_NAMES: Record<PieceCategory, string> = {
  straight: 'Straights',
  curve: 'Curves',
  switch: 'Switches',
  crossing: 'Crossings',
  buffer: 'Buffer stops',
};

const ENDS_LABELS: Record<Ends, string> = { mixed: 'Peg + hole', pegs: '2 pegs', holes: '2 holes' };

/** Pointer travel, in pixels, before a press on a tile becomes a drag. */
const DRAG_THRESHOLD_PX = 6;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Plan-view drawing of a piece, plan y up, entered from the left. */
export function pieceIcon(piece: PieceDef): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
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
  const size = Math.max(w, h, 250);
  svg.setAttribute('viewBox', `${minX - (size - w) / 2} ${minY - (size - h) / 2} ${size} ${size}`);

  const add = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  };
  for (const d of lines) add('path', { d, class: 'icon-edge', 'stroke-width': D.TRACK_WIDTH + 5 });
  for (const d of lines) add('path', { d, class: 'icon-wood', 'stroke-width': D.TRACK_WIDTH });
  for (const d of lines) add('path', { d, class: 'icon-groove', 'stroke-width': D.GROOVE_SPACING + D.GROOVE_WIDTH });
  for (const d of lines) add('path', { d, class: 'icon-wood', 'stroke-width': D.GROOVE_SPACING - D.GROOVE_WIDTH });
  for (const c of piece.connectors) {
    const { x, y, angle } = c.pose;
    if (c.gender === 'peg') {
      const r = D.PEG_NECK_LENGTH + D.PEG_DIAMETER / 2;
      add('circle', { cx: x + r * Math.cos(angle), cy: -(y + r * Math.sin(angle)), r: D.PEG_DIAMETER / 2 + 2, class: 'icon-peg' });
    } else {
      const r = 5 + D.HOLE_DIAMETER / 2;
      add('circle', { cx: x - r * Math.cos(angle), cy: -(y - r * Math.sin(angle)), r: D.HOLE_DIAMETER / 2 + 1, class: 'icon-hole' });
    }
  }
  return svg;
}

/** Brio letters for the version shown, and a length where it helps. */
function detail(shape: Shape, piece: PieceDef): string {
  const letters = hasEndsChoice(shape) ? piece.brioIds : shape.ids.flatMap((id) => getPiece(id).brioIds);
  const parts = [letters.join(' / ')];
  if (shape.category === 'straight') parts.push(`${Math.round(pathLength(piece.paths[0]))} mm`);
  return parts.filter(Boolean).join(' · ');
}

function segmented<T extends string>(label: string, options: [T, string][], onPick: (value: T) => void): { el: HTMLElement; set: (value: T) => void } {
  const el = document.createElement('div');
  el.className = 'setting';
  const name = document.createElement('span');
  name.className = 'setting-label';
  name.textContent = label;
  const group = document.createElement('div');
  group.className = 'seg';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const buttons = options.map(([value, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = text;
    b.dataset.value = value;
    b.addEventListener('click', () => onPick(value));
    group.appendChild(b);
    return b;
  });
  el.append(name, group);
  return {
    el,
    set: (value) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value))),
  };
}

const TURN_ICON = (d: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export class Palette {
  private readonly tiles = new Map<string, { button: HTMLButtonElement; shape: Shape }>();
  private readonly turn;
  private readonly endsControl;
  hand: Hand = 'left';
  ends: Ends = 'mixed';

  constructor(
    container: HTMLElement,
    private readonly onPick: (shape: Shape) => void,
    private readonly onChange: () => void,
    /** A tile was dragged out: the move that started it, to keep following that pointer. */
    private readonly onDrag: (shape: Shape, e: PointerEvent) => void = () => {},
  ) {
    const settings = document.createElement('div');
    settings.className = 'settings';
    this.turn = segmented<Hand>(
      'Curves turn',
      [
        ['left', `${TURN_ICON('M18 20v-7a5 5 0 0 0-5-5H5M9 4 5 8l4 4')}Left`],
        ['right', `Right${TURN_ICON('M6 20v-7a5 5 0 0 1 5-5h8M15 4l4 4-4 4')}`],
      ],
      (h) => this.setHand(h),
    );
    this.turn.el.title = 'Which way curves and switches turn as you build outward (T)';
    this.endsControl = segmented<Ends>(
      'Ends',
      (Object.keys(ENDS_LABELS) as Ends[]).map((e) => [e, ENDS_LABELS[e]]),
      (e) => this.setEnds(e),
    );
    this.endsControl.el.title = 'Straights and curves also come with two pegs or two holes, for closing loops';
    settings.append(this.turn.el, this.endsControl.el);
    container.appendChild(settings);

    const pieces = document.createElement('div');
    pieces.className = 'pieces';
    const categories = [...new Set(SHAPES.map((s) => s.category))];
    for (const category of categories) {
      const section = document.createElement('section');
      const heading = document.createElement('h2');
      heading.textContent = CATEGORY_NAMES[category];
      const grid = document.createElement('div');
      grid.className = 'palette-grid';
      for (const shape of SHAPES.filter((s) => s.category === category)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tile';
        button.addEventListener('click', () => {
          // A drag that ends back on its tile still clicks it; it isn't a tap.
          if (this.dragged) this.dragged = false;
          else this.onPick(shape);
        });
        button.addEventListener('pointerdown', (e) => this.press(e, shape));
        this.tiles.set(shape.key, { button, shape });
        grid.appendChild(button);
      }
      section.append(heading, grid);
      pieces.appendChild(section);
    }
    container.appendChild(pieces);
    this.render();
  }

  private dragged = false;

  /**
   * Follow a press on a tile until it moves far enough to be a drag. Touch
   * scrolls the palette along its own length (see style.css), and the
   * browser cancels the press when it does.
   */
  private press(down: PointerEvent, shape: Shape): void {
    if (down.button !== 0) return;
    this.dragged = false;
    // Stops a mouse drag selecting text on the way out.
    if (down.pointerType === 'mouse') down.preventDefault();
    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD_PX) return;
      stop();
      this.dragged = true;
      // Forget the drag once its click, if any, has gone by.
      const clear = (up: PointerEvent) => {
        if (up.pointerId !== down.pointerId) return;
        window.removeEventListener('pointerup', clear);
        window.removeEventListener('pointercancel', clear);
        setTimeout(() => (this.dragged = false));
      };
      window.addEventListener('pointerup', clear);
      window.addEventListener('pointercancel', clear);
      this.onDrag(shape, e);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId === down.pointerId) stop();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  setHand(hand: Hand): void {
    this.hand = hand;
    this.render();
    this.onChange();
  }

  setEnds(ends: Ends): void {
    this.ends = ends;
    this.render();
    this.onChange();
  }

  private render(): void {
    this.turn.set(this.hand);
    this.endsControl.set(this.ends);
    for (const { button, shape } of this.tiles.values()) {
      const id = variantFor(shape, this.ends, null);
      const piece = getPiece(id);
      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = shape.name;
      const info = document.createElement('span');
      info.className = 'tile-detail';
      info.textContent = detail(shape, piece);
      button.replaceChildren(pieceIcon(iconPiece(id, this.hand)), name, info);
      button.title = piece.name;
    }
  }

  /** Grey out shapes that can't go on the selected end. */
  setEnabled(isEnabled: (shape: Shape) => boolean): void {
    for (const { button, shape } of this.tiles.values()) {
      const enabled = isEnabled(shape);
      button.classList.toggle('disabled', !enabled);
      button.setAttribute('aria-disabled', String(!enabled));
    }
  }
}
