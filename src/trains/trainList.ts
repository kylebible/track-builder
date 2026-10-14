import { getJob } from './jobs';
import type { Train } from './sim';

/** What the list needs from the trains view. */
export interface TrainListHost {
  readonly trains: readonly Train[];
  statusText(t: Train): string;
  loadText(t: Train): string;
  destText(t: Train): string;
  /** Fly the view to a train and keep it in the middle as it runs. */
  goTo(id: number): void;
  /** The train being followed, if any. */
  readonly following: number | null;
  /** Light a train up on the map, or none. */
  highlight(id: number | null): void;
  setThrottle(id: number, throttle: 1 | 0 | -1): void;
  /** Open the trains panel, to put trains on. */
  openPanel(): void;
}

/**
 * The sidebar's Trains tab: every train with what it's doing. Hover a row to
 * light the train up on the map; tap it to go there and follow it.
 */
export class TrainList {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly rows = new Map<number, { row: HTMLElement; key: string; status: HTMLElement; detail: HTMLElement; run: HTMLButtonElement }>();
  private hovered: number | null = null;

  constructor(private readonly host: TrainListHost) {
    this.list = document.createElement('div');
    this.list.className = 'tl-list';
    this.empty = document.createElement('div');
    this.empty.className = 'tl-empty';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tl-open';
    open.textContent = 'Put trains on';
    open.onclick = () => host.openPanel();
    const p = document.createElement('p');
    p.textContent = 'No trains yet. Drag engines and cars onto the track, or add a job train.';
    this.empty.append(p, open);
    this.el = document.createElement('div');
    this.el.className = 'train-list';
    this.el.append(this.empty, this.list);
  }

  /** How many trains there are, for the tab's count. */
  get count(): number {
    return this.host.trains.length;
  }

  /** Bring the rows up to date; cheap enough to call every frame while shown. */
  update(): void {
    const trains = this.host.trains;
    this.empty.hidden = trains.length > 0;
    const seen = new Set<number>();
    for (const t of trains) {
      seen.add(t.id);
      const key = `${t.name}/${t.job}/${t.wrecked}`;
      let entry = this.rows.get(t.id);
      if (!entry || entry.key !== key) {
        const fresh = this.makeRow(t, key);
        if (entry) entry.row.replaceWith(fresh.row);
        else this.list.append(fresh.row);
        entry = fresh;
        this.rows.set(t.id, entry);
      }
      const status = this.host.statusText(t);
      if (entry.status.textContent !== status) entry.status.textContent = status;
      const detail = [this.host.destText(t), this.host.loadText(t)].filter(Boolean).join(' · ');
      if (entry.detail.textContent !== detail) entry.detail.textContent = detail;
      entry.row.classList.toggle('stuck', t.status.kind === 'stuck' || t.wrecked);
      entry.row.classList.toggle('waiting', t.status.kind === 'waiting');
      entry.row.classList.toggle('following', this.host.following === t.id);
      const running = t.throttle !== 0;
      if (entry.run.dataset.on !== String(running)) {
        entry.run.dataset.on = String(running);
        entry.run.textContent = running ? '■' : '▶';
        entry.run.title = running ? 'Stop' : 'Go';
      }
      entry.run.disabled = t.wrecked || !t.vehicles.some((v) => v.def.motor);
    }
    for (const [id, entry] of this.rows) {
      if (seen.has(id)) continue;
      entry.row.remove();
      this.rows.delete(id);
      if (this.hovered === id) this.hover(null);
    }
  }

  private makeRow(t: Train, key: string) {
    const job = getJob(t.job);
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.tabIndex = 0;
    row.title = 'Go to this train and follow it';
    const icon = document.createElement('span');
    icon.className = 'tl-icon';
    icon.textContent = job.icon;
    icon.title = `${job.name} train`;
    const text = document.createElement('div');
    text.className = 'tl-text';
    const head = document.createElement('div');
    head.className = 'tl-head';
    const name = document.createElement('b');
    name.textContent = t.name;
    const status = document.createElement('span');
    status.className = 'tl-status';
    head.append(name, status);
    const detail = document.createElement('div');
    detail.className = 'tl-detail';
    text.append(head, detail);
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'tl-run';
    const id = t.id;
    run.onclick = (e) => {
      e.stopPropagation();
      const train = this.host.trains.find((x) => x.id === id);
      if (train) this.host.setThrottle(id, train.throttle ? 0 : 1);
    };
    row.append(icon, text, run);
    row.onclick = () => this.host.goTo(id);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.host.goTo(id);
      }
    };
    row.onpointerenter = () => this.hover(id);
    row.onpointerleave = () => this.hover(null);
    row.onfocus = () => this.hover(id);
    row.onblur = () => this.hover(null);
    return { row, key, status, detail, run };
  }

  private hover(id: number | null): void {
    this.hovered = id;
    this.host.highlight(id);
  }
}
