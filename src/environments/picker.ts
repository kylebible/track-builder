import { ENVIRONMENTS, type EnvironmentId } from './environments';

// The toolbar's Scene panel: one row per environment, the current one ticked.

const SWATCHES: Record<EnvironmentId, string> = {
  table: '#e6cfa6',
  rug: 'radial-gradient(circle, #f3e9d6 0 38%, #d8a64a 38% 44%, #2f4a6b 44% 62%, #b8573a 62%)',
  floor: 'repeating-linear-gradient(90deg, #c4966a 0 9px, #b4875c 9px 10px, #cfa477 10px 19px, #8a6440 19px 20px)',
  grass: 'radial-gradient(circle at 30% 30%, #9cc070, transparent 50%), radial-gradient(circle at 70% 70%, #5d8a3a, transparent 55%), #6f9a45',
  grid: 'linear-gradient(#bcc6ac 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(90deg, #bcc6ac 1px, transparent 1px) 0 0 / 8px 8px, #e6eadc',
};

export class EnvironmentPicker {
  private readonly rows = new Map<EnvironmentId, HTMLButtonElement>();

  constructor(
    panel: HTMLElement,
    private readonly onPick: (id: EnvironmentId) => void,
  ) {
    const head = document.createElement('header');
    head.className = 'panel-head';
    const title = document.createElement('div');
    const h = document.createElement('h2');
    h.textContent = 'Scene';
    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    sub.textContent = 'What the track sits on. Saved with the layout.';
    title.append(h, sub);
    head.append(title);

    const list = document.createElement('div');
    list.className = 'scenes';
    for (const env of ENVIRONMENTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scene';
      const swatch = document.createElement('span');
      swatch.className = 'scene-swatch';
      swatch.style.background = SWATCHES[env.id];
      if (env.id === 'table') swatch.classList.add('table');
      const text = document.createElement('span');
      text.className = 'scene-text';
      const name = document.createElement('b');
      name.textContent = env.name;
      const detail = document.createElement('small');
      detail.textContent = env.detail;
      text.append(name, detail);
      b.append(swatch, text);
      b.addEventListener('click', () => this.onPick(env.id));
      this.rows.set(env.id, b);
      list.append(b);
    }
    panel.append(head, list);
  }

  /** Tick the environment in use. */
  set(id: EnvironmentId): void {
    for (const [rowId, b] of this.rows) b.setAttribute('aria-pressed', String(rowId === id));
  }
}
