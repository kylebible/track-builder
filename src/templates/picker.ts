import { pathLength, poseAt } from '../geometry/path';
import { applyPose } from '../geometry/pose';
import { defOf, type Layout } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { TEMPLATES, type Template } from './templates';

// The Templates panel: a plan drawing of each ready-made layout. Picking
// one replaces the layout, as one step undo can take back.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Plan view of a whole layout, plan y up, drawn like the palette's piece icons. */
export function layoutIcon(layout: Layout): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const xs: number[] = [];
  const ys: number[] = [];
  const lines = layout.pieces.flatMap((piece) =>
    defOf(piece).paths.map((path) => {
      const length = pathLength(path);
      const steps = path.kind === 'straight' ? 1 : 12;
      const pts = Array.from({ length: steps + 1 }, (_, i) => applyPose(piece.pose, poseAt(path, (length * i) / steps)));
      pts.forEach((p) => (xs.push(p.x), ys.push(-p.y)));
      return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${(-p.y).toFixed(1)}`).join(' ');
    }),
  );
  const pad = D.TRACK_WIDTH;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(...xs) + pad - minX} ${Math.max(...ys) + pad - minY}`);
  // Raised track drawn last, so it passes over what runs under it.
  const order = layout.pieces.flatMap((piece) => defOf(piece).paths.map(() => piece.z ?? 0));
  const sorted = lines.map((d, i) => ({ d, z: order[i] })).sort((a, b) => a.z - b.z);
  for (const { d } of sorted) {
    for (const [cls, width] of [
      ['icon-edge', D.TRACK_WIDTH + 8],
      ['icon-wood', D.TRACK_WIDTH],
      ['icon-groove', D.GROOVE_SPACING + D.GROOVE_WIDTH],
      ['icon-wood', D.GROOVE_SPACING - D.GROOVE_WIDTH],
    ] as const) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      path.setAttribute('stroke-width', String(width));
      svg.append(path);
    }
  }
  return svg;
}

export class TemplatePicker {
  constructor(panel: HTMLElement, onPick: (template: Template) => void) {
    const head = document.createElement('header');
    head.className = 'panel-head';
    const title = document.createElement('div');
    const h = document.createElement('h2');
    h.textContent = 'Templates';
    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    sub.textContent = 'Start from a classic layout. Each one fits on a play table.';
    title.append(h, sub);
    head.append(title);

    const list = document.createElement('div');
    list.className = 'templates';
    for (const template of TEMPLATES) {
      const layout = template.build();
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'template';
      const plan = document.createElement('span');
      plan.className = 'template-plan';
      plan.append(layoutIcon(layout));
      const text = document.createElement('span');
      text.className = 'scene-text';
      const name = document.createElement('b');
      name.textContent = template.name;
      const detail = document.createElement('small');
      detail.textContent = `${template.detail} · ${layout.pieces.length} pieces`;
      text.append(name, detail);
      b.append(plan, text);
      b.addEventListener('click', () => onPick(template));
      list.append(b);
    }
    const foot = document.createElement('p');
    foot.className = 'panel-foot';
    foot.textContent = 'This replaces the layout you have. Undo brings it back.';
    panel.append(head, list, foot);
  }
}
