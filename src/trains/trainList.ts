import { getJob } from './jobs';
import type { Train } from './sim';

/** What the Trains tab shows: the trains on the track, adding trains, or settings. */
export type TrainView = 'list' | 'add' | 'settings';

/** What the tab needs from the trains view. */
export interface TrainListHost {
  readonly trains: readonly Train[];
  statusText(t: Train): string;
  /** A line on where it's going and what it's carrying, short enough for a row. */
  briefText(t: Train): string;
  /** The train being followed, if any. */
  readonly following: number | null;
  /** The train whose controls are open in the list, if any. */
  readonly selected: number | null;
  /** Open a train's controls (and go to it), or close them. */
  select(id: number | null): void;
  /** Light a train up on the map, or none. */
  highlight(id: number | null): void;
  setThrottle(id: number, throttle: 1 | 0 | -1): void;
  /** How many places need a train nobody has put on. */
  readonly urgentNeeds: number;
  /** Told when the tab switches view. */
  onView(view: TrainView): void;
}

const svg = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
export const ICON = {
  play: svg('<path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  ride: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  back: svg('<path d="M17 4.5v15L5 12l12-7.5Z" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  chevron: svg('<path d="m15 18-6-6 6-6"/>'),
  follow: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>'),
  turn: svg('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'),
  whistle: svg('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  remove: svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
};

/**
 * The sidebar's Trains tab, the one place for everything about trains:
 * - the run controls along the top (pause, speed, reset, settings);
 * - every train with what it's doing. Hover a row to light the train up on
 *   the map; tap it to go there, follow it, and open its controls;
 * - Add a train: ready-made job trains, what places need, and engines and
 *   cars to drag onto the track;
 * - Settings: how the trains and places behave, and tips.
 */
export class TrainList {
  readonly el: HTMLElement;
  /** Where the run controls go, before the settings button. */
  readonly bar: HTMLElement;
  /** Where the Add a train view's contents go. */
  readonly addBody: HTMLElement;
  /** Where the settings view's contents go. */
  readonly settingsBody: HTMLElement;
  view: TrainView = 'list';
  private readonly views: Record<TrainView, HTMLElement>;
  private readonly gear: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly alert: HTMLButtonElement;
  private readonly rows = new Map<number, { row: HTMLElement; key: string; status: HTMLElement; detail: HTMLElement; run: HTMLButtonElement; more: HTMLElement }>();
  private hovered: number | null = null;

  constructor(private readonly host: TrainListHost) {
    const button = (cls: string, html: string, title: string, onclick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.innerHTML = html;
      b.title = title;
      b.onclick = onclick;
      return b;
    };
    this.bar = document.createElement('div');
    this.bar.className = 'tp-bar';
    this.gear = button('tp-icon-btn', ICON.gear, 'Settings and tips', () => this.show(this.view === 'settings' ? 'list' : 'settings'));
    this.gear.setAttribute('aria-pressed', 'false');
    const barEnd = document.createElement('div');
    barEnd.className = 'tp-bar-end';
    barEnd.append(this.gear);
    this.bar.append(barEnd);

    // The trains on the track.
    this.heading = document.createElement('div');
    this.heading.className = 'tp-heading';
    const addTop = button('tp-add', `${ICON.plus}<span>Add</span>`, 'Add a train: a ready-made job train, or engines and cars to drag on', () => this.show('add'));
    const title = document.createElement('h2');
    title.textContent = 'On the track';
    this.heading.append(title, addTop);
    this.alert = button('tp-alert', '', 'See what places need', () => this.show('add'));
    this.alert.hidden = true;
    this.list = document.createElement('div');
    this.list.className = 'tl-list';
    this.empty = document.createElement('div');
    this.empty.className = 'tl-empty';
    const p = document.createElement('p');
    p.innerHTML = '<b>No trains yet.</b> Put on a ready-made train that finds its own work, or drag engines and cars onto the track.';
    this.empty.append(p, button('tp-cta', `${ICON.plus}<span>Add a train</span>`, 'Add a train', () => this.show('add')));
    const listView = this.makeView('list', this.heading, this.alert, this.empty, this.list);

    this.addBody = document.createElement('div');
    this.settingsBody = document.createElement('div');
    this.views = {
      list: listView,
      add: this.makeView('add', this.backHeader('Add a train'), this.addBody),
      settings: this.makeView('settings', this.backHeader('Settings'), this.settingsBody),
    };
    const body = document.createElement('div');
    body.className = 'tp-body';
    body.append(...Object.values(this.views));
    this.el = document.createElement('div');
    this.el.className = 'train-list';
    this.el.append(this.bar, body);
    this.show('list');
  }

  private makeView(view: TrainView, ...children: HTMLElement[]): HTMLElement {
    const v = document.createElement('section');
    v.className = `tp-view tp-view-${view}`;
    v.append(...children);
    return v;
  }

  private backHeader(text: string): HTMLElement {
    const head = document.createElement('div');
    head.className = 'tp-back';
    const back = document.createElement('button');
    back.type = 'button';
    back.innerHTML = `${ICON.chevron}<span>Trains</span>`;
    back.title = 'Back to the trains';
    back.onclick = () => this.show('list');
    const h = document.createElement('h2');
    h.textContent = text;
    head.append(back, h);
    return head;
  }

  /** Switch the tab to the list, adding trains, or settings. */
  show(view: TrainView): void {
    this.view = view;
    for (const [name, v] of Object.entries(this.views)) v.hidden = name !== view;
    this.gear.setAttribute('aria-pressed', String(view === 'settings'));
    this.views[view].parentElement?.scrollTo({ top: 0 });
    this.host.onView(view);
    if (view === 'list') this.update();
  }

  /** How many trains there are, for the tab's count. */
  get count(): number {
    return this.host.trains.length;
  }

  /** Bring the rows up to date; cheap enough to call every frame while shown. */
  update(): void {
    const trains = this.host.trains;
    this.empty.hidden = trains.length > 0;
    this.heading.hidden = trains.length === 0;
    const urgent = this.host.urgentNeeds;
    this.alert.hidden = urgent === 0;
    const alertText = `${ICON.alert}<span>${urgent === 1 ? 'A place needs' : `${urgent} places need`} a train</span><b>Add</b>`;
    if (this.alert.dataset.n !== String(urgent)) {
      this.alert.dataset.n = String(urgent);
      this.alert.innerHTML = alertText;
    }
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
      const detail = this.host.briefText(t);
      if (entry.detail.textContent !== detail) entry.detail.textContent = detail;
      const stuck = t.status.kind === 'stuck' || t.wrecked;
      entry.row.classList.toggle('stuck', stuck);
      entry.row.classList.toggle('waiting', t.status.kind === 'waiting');
      entry.row.classList.toggle('running', t.status.kind === 'running');
      entry.row.classList.toggle('following', this.host.following === t.id);
      entry.status.title = t.status.kind === 'stuck' ? t.status.message : '';
      const open = this.host.selected === t.id;
      entry.row.classList.toggle('selected', open);
      entry.row.setAttribute('aria-expanded', String(open));
      entry.more.hidden = !open;
      const running = t.throttle !== 0;
      if (entry.run.dataset.on !== String(running)) {
        entry.run.dataset.on = String(running);
        entry.run.innerHTML = running ? ICON.stop : ICON.play;
        entry.run.title = running ? 'Stop' : 'Go';
        entry.run.setAttribute('aria-label', running ? `Stop ${t.name}` : `Start ${t.name}`);
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
    row.dataset.job = t.job;
    const top = document.createElement('div');
    top.className = 'tl-top';
    top.tabIndex = 0;
    top.setAttribute('role', 'button');
    top.title = 'Go to this train, follow it, and open its controls';
    const icon = document.createElement('span');
    icon.className = 'tl-icon';
    icon.textContent = job.icon;
    icon.title = `${job.name} train`;
    const text = document.createElement('div');
    text.className = 'tl-text';
    const name = document.createElement('b');
    name.className = 'tl-name';
    name.textContent = t.name;
    // What it's doing, then where it's going and what it carries.
    const sub = document.createElement('div');
    sub.className = 'tl-sub';
    const status = document.createElement('span');
    status.className = 'tl-status';
    const detail = document.createElement('span');
    detail.className = 'tl-detail';
    sub.append(status, detail);
    text.append(name, sub);
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'tl-run';
    const id = t.id;
    run.onclick = (e) => {
      e.stopPropagation();
      const train = this.host.trains.find((x) => x.id === id);
      if (train) this.host.setThrottle(id, train.throttle ? 0 : 1);
    };
    run.onkeydown = (e) => e.stopPropagation();
    // The train's own controls, open while it's selected.
    const more = document.createElement('div');
    more.className = 'tl-more';
    more.hidden = true;
    top.append(icon, text, run);
    row.append(top, more);
    const toggle = () => this.host.select(this.host.selected === id ? null : id);
    top.onclick = toggle;
    top.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    };
    row.onpointerenter = () => this.hover(id);
    row.onpointerleave = () => this.hover(null);
    row.addEventListener('focusin', () => this.hover(id));
    row.addEventListener('focusout', () => this.hover(null));
    return { row, key, status, detail, run, more };
  }

  /** Where the selected train's controls go: inside its row. */
  slot(id: number): HTMLElement | null {
    return this.rows.get(id)?.more ?? null;
  }

  /** Bring a train's row into view. */
  reveal(id: number): void {
    this.rows.get(id)?.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private hover(id: number | null): void {
    this.hovered = id;
    this.host.highlight(id);
  }
}
