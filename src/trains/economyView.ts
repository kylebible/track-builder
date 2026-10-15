import * as THREE from 'three';
import { toWorld } from '../render/pieceMesh';
import { ECONOMY, manning, staffOf, type Site } from './economy';
import { getJob, ICONS, JOB_TRAIN, JOBS, needs, WORDS, type JobId, type Need } from './jobs';
import type { TrainSim } from './sim';
import type { CargoKind } from './stock';

// What every place has and needs, shown over it, and the Jobs part of the
// Trains panel. The look is the same everywhere:
// - a bar per good: green, amber when low, red when empty (or full with
//   nothing collecting);
// - a dot per worker: green at work (fading as they tire), hollow for an
//   empty place, and a sleepy face for each tired worker waiting for a ride;
// - a red outline and a tag with the train it needs when nothing is on it,
//   amber when a train for it is running and it's just low.

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) => {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
};

/** How often the needs list and badges' contents are worked out, ms. */
const REFRESH_MS = 400;

export interface EconomyHost {
  /** Put a standard train for a job on the track. */
  addJobTrain(job: JobId): void;
  /** Switch hands-off running on or off. */
  runByItself(on: boolean): void;
}

export class EconomyView {
  /** The Jobs part of the Trains panel. */
  readonly section: HTMLElement;
  private readonly needList: HTMLElement;
  private readonly badges = new Map<string, { el: HTMLElement; key: string }>();
  private info: { uid: string; el: HTMLElement } | null = null;
  private lastRefresh = 0;
  private current: Need[] = [];
  private needsKey: string | null = null;
  private readonly carsInput: HTMLInputElement;

  constructor(
    private readonly sim: TrainSim,
    private readonly hud: HTMLElement,
    private readonly camera: THREE.Camera,
    private readonly container: HTMLElement,
    private readonly host: EconomyHost,
  ) {
    const on = el('input', { type: 'checkbox', checked: sim.useEconomy, onchange: () => (sim.useEconomy = on.checked) });
    const auto = el('input', { type: 'checkbox', checked: sim.operator.on, onchange: () => host.runByItself(auto.checked) });
    this.carsInput = el('input', {
      type: 'number', min: '1', max: '8', value: String(JOB_TRAIN.cars), class: 'ec-cars',
      onchange: () => (JOB_TRAIN.cars = Math.max(1, Math.min(8, Math.round(Number(this.carsInput.value)) || 3))),
    });
    this.needList = el('ul', { class: 'ec-needs' });
    const add = (job: (typeof JOBS)[number]) =>
      el('button', { type: 'button', class: 'ec-job', title: `Add a ${job.name.toLowerCase()} train. ${job.blurb}`, onclick: () => host.addJobTrain(job.id) }, el('span', { textContent: job.icon }), job.name);
    this.section = el(
      'div',
      { class: 'ec' },
      el('h3', { textContent: 'Jobs' }),
      el('p', { class: 'tr-lead', textContent: 'A train with a job carries its own goods, picks its next stop by what places need, and throws the switches to get there. Pick one on a train’s card, or add a ready-made one:' }),
      el('div', { class: 'ec-jobs' }, ...JOBS.filter((j) => j.id !== 'free').map(add)),
      el('label', { class: 'ec-row' }, 'Engine, tender and ', this.carsInput, ' cars'),
      el('label', { class: 'tr-check', title: 'Places make goods only while staffed, and keep what trains bring. Off, every place has everything and needs nobody.' }, on, ' Places need goods and workers'),
      el('label', {
        class: 'tr-check',
        title: 'Puts on job trains for whatever places need, as many as the track has room for. Couples on another engine when one stalls, lifts off trains that come off the rails or jam, and tops up any that run dry. Workers stay longer on big layouts.',
      }, auto, ' Run the jobs by themselves'),
      el('h3', { textContent: 'Needs' }),
      this.needList,
      el('details', { class: 'ec-how' },
        el('summary', { textContent: 'How stops work' }),
        el('ul', { class: 'tr-hint' },
          el('li', { innerHTML: 'Each place keeps a store. Mines, farms, camps and the pump house <b>make</b> goods; towers, stages, markets and sheds <b>take</b> them in. Tap a place’s badge for what it does.' }),
          el('li', { innerHTML: 'Places need <b>workers</b>. They tire after a few minutes and wait to go home; a <b>workers train</b> takes them to the station and brings fresh ones.' }),
          el('li', { innerHTML: 'Steam engines refill at a <b>water tower</b> and <b>coaling stage</b>, which can run dry. Charging posts need a <b>power station</b> with coal.' }),
          el('li', { innerHTML: 'Badges: <span class="ec-key ok"></span> fine, <span class="ec-key low"></span> low with a train on it, <span class="ec-key need"></span> needs a train you haven’t got. <span class="ec-dot"></span> worker at work, <span class="ec-dot empty"></span> empty place, 😴 tired and waiting.' }),
        ),
      ),
    );
    window.addEventListener('pointerdown', (e) => {
      if (this.info && !(e.target as Element).closest?.('.ec-info, .ec-badge')) this.closeInfo();
    });
  }

  /** Redraw the badges over every place, and the needs list. */
  update(time: number, visible: boolean): void {
    if (time - this.lastRefresh > REFRESH_MS) {
      this.lastRefresh = time;
      const jobs = new Set(this.sim.trains.map((t) => t.job));
      this.current = this.sim.useEconomy ? needs(this.sim.economy, (j) => jobs.has(j), this.sim.stations.length > 0) : [];
      this.drawNeeds();
    }
    const show = visible && this.sim.useEconomy;
    const rect = this.container.getBoundingClientRect();
    const seen = new Set<string>();
    for (const site of this.sim.economy.sites.values()) {
      if (site.place.id === 'station') continue;
      seen.add(site.uid);
      let entry = this.badges.get(site.uid);
      if (!entry) {
        const badge = el('div', { class: 'ec-badge', onclick: () => this.openInfo(site.uid) });
        badge.addEventListener('pointerdown', (e) => e.stopPropagation(), { capture: false });
        this.hud.append(badge);
        entry = { el: badge, key: '' };
        this.badges.set(site.uid, entry);
      }
      const p = this.anchor(site).project(this.camera);
      const onScreen = show && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      entry.el.hidden = !onScreen;
      if (!onScreen) continue;
      entry.el.style.transform = `translate(${((p.x + 1) / 2) * rect.width}px, ${((1 - p.y) / 2) * rect.height}px) translate(-50%, -100%)`;
      const mine = this.current.filter((n) => n.uid === site.uid);
      const key = this.badgeKey(site, mine);
      if (key !== entry.key) {
        entry.key = key;
        this.fillBadge(entry.el, site, mine);
      }
    }
    for (const [uid, entry] of this.badges) {
      if (!seen.has(uid)) {
        entry.el.remove();
        this.badges.delete(uid);
      }
    }
    if (this.info) {
      const site = this.sim.economy.site(this.info.uid);
      const badge = this.badges.get(this.info.uid)?.el;
      if (!site || !badge || badge.hidden) this.closeInfo();
      else {
        this.info.el.style.transform = badge.style.transform;
        if (time - this.lastRefresh < 20) this.fillInfo(this.info.el, site);
      }
    }
  }

  /** Over the place, a little above its roof. */
  private anchor(site: Site): THREE.Vector3 {
    const point = this.sim.places.find((p) => p.uid === site.uid);
    const z = point?.z ?? 0;
    return toWorld(site.at.x, site.at.y, z + 150);
  }

  private badgeKey(site: Site, mine: Need[]): string {
    const goods = Object.entries(site.stock).map(([k, n]) => `${k}${Math.round((n ?? 0) * 4)}`).join();
    const crew = site.crew.map((e) => Math.ceil(e * 3)).join('');
    return `${goods}|${crew}|${site.tired}|${site.blocked}|${mine.map((n) => `${n.what}${n.urgent}`).join()}`;
  }

  private fillBadge(badge: HTMLElement, site: Site, mine: Need[]): void {
    const urgent = mine.some((n) => n.urgent);
    badge.className = `ec-badge ${urgent ? 'need' : mine.length ? 'low' : 'ok'}`;
    badge.title = `${site.place.name}${mine.length ? `: ${mine.map((n) => n.message).join(' ')}` : ''}. Tap for more.`;
    const parts: Node[] = [];
    for (const [kind, hold] of Object.entries(site.place.holds ?? {}) as [CargoKind, number][]) {
      const have = site.stock[kind] ?? 0;
      const share = Math.min(1, have / hold);
      const takes = site.place.unloads?.includes(kind);
      // Empty where it's wanted, or full with nobody collecting, is bad.
      const state = takes ? (have < 1 ? 'bad' : share <= ECONOMY.low ? 'warn' : '') : share >= 1 ? 'bad' : '';
      const bar = el('i', { class: `ec-bar ${state}` }, el('i'));
      (bar.firstChild as HTMLElement).style.width = `${Math.round(share * 100)}%`;
      parts.push(el('span', { class: 'ec-good', title: `${Math.floor(have)} of ${hold} ${WORDS[kind]}` }, el('b', { textContent: ICONS[kind] }), bar));
    }
    if (site.place.id === 'charging-post') parts.push(el('span', { class: `ec-good ${site.blocked ? 'off' : ''}`, textContent: ICONS.power }));
    const staff = staffOf(site);
    if (staff || site.tired) {
      const dots = el('span', { class: 'ec-crew' });
      for (const energy of site.crew) {
        const dot = el('i', { class: 'ec-dot' });
        dot.style.opacity = String(0.35 + 0.65 * energy);
        dots.append(dot);
      }
      for (let i = site.crew.length; i < staff; i++) dots.append(el('i', { class: 'ec-dot empty' }));
      if (site.tired) dots.append(el('span', { class: 'ec-tired', textContent: `😴${site.tired > 1 ? site.tired : ''}` }));
      parts.push(dots);
    }
    // The trains it needs and hasn't got.
    const jobs = [...new Set(mine.filter((n) => n.urgent && n.job).map((n) => n.job!))];
    if (jobs.length) parts.push(el('span', { class: 'ec-tag' }, ...jobs.map((j) => el('span', { textContent: getJob(j).icon, title: `Needs a ${getJob(j).name.toLowerCase()} train` }))));
    else if (mine.some((n) => n.urgent)) parts.push(el('span', { class: 'ec-tag', textContent: '!' }));
    badge.replaceChildren(...parts);
  }

  private drawNeeds(): void {
    const key = `${this.sim.useEconomy}/${this.sim.economy.sites.size}/${this.current.map((n) => `${n.message}${n.urgent}`).join('|')}`;
    if (key === this.needsKey) return;
    this.needsKey = key;
    if (!this.sim.useEconomy) {
      this.needList.replaceChildren(el('li', { class: 'ec-none', textContent: 'Places have everything they need while this is off.' }));
      return;
    }
    if (!this.sim.economy.sites.size) {
      this.needList.replaceChildren(el('li', { class: 'ec-none', textContent: 'Put trackside places from the parts palette over the track to give trains work.' }));
      return;
    }
    const sorted = [...this.current].sort((a, b) => Number(b.urgent) - Number(a.urgent));
    if (!sorted.length) {
      this.needList.replaceChildren(el('li', { class: 'ec-none', textContent: 'Everything’s running.' }));
      return;
    }
    this.needList.replaceChildren(
      ...sorted.slice(0, 8).map((n) =>
        el('li', { class: n.urgent ? 'urgent' : '' },
          el('span', { class: 'ec-icon', textContent: ICONS[n.what] }),
          el('span', { textContent: n.message }),
          n.urgent && n.job ? el('button', { type: 'button', class: 'tr-btn', textContent: `Add ${getJob(n.job).icon}`, title: `Add a ${getJob(n.job).name.toLowerCase()} train`, onclick: () => this.host.addJobTrain(n.job!) }) : '',
        ),
      ),
      ...(sorted.length > 8 ? [el('li', { class: 'ec-none', textContent: `And ${sorted.length - 8} more.` })] : []),
    );
  }

  private openInfo(uid: string): void {
    if (this.info?.uid === uid) {
      this.closeInfo();
      return;
    }
    this.closeInfo();
    const site = this.sim.economy.site(uid);
    if (!site) return;
    const card = el('div', { class: 'ec-info' });
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.hud.append(card);
    this.info = { uid, el: card };
    this.fillInfo(card, site);
    card.style.transform = this.badges.get(uid)?.el.style.transform ?? '';
  }

  private closeInfo(): void {
    this.info?.el.remove();
    this.info = null;
  }

  private fillInfo(card: HTMLElement, site: Site): void {
    const place = site.place;
    const rows: Node[] = [el('div', { class: 'ec-info-head' }, el('b', { textContent: place.name }), el('button', { type: 'button', class: 'tr-close', textContent: '×', title: 'Close', onclick: () => this.closeInfo() }))];
    rows.push(el('p', { textContent: place.explain ?? place.blurb }));
    const stock = (Object.entries(place.holds ?? {}) as [CargoKind, number][]).map(([kind, hold]) => `${Math.floor(site.stock[kind] ?? 0)} of ${hold} ${WORDS[kind]}`);
    if (stock.length) rows.push(el('p', {}, el('b', { textContent: 'Has: ' }), stock.join(', ')));
    const staff = staffOf(site);
    if (staff) {
      const working = `${site.crew.length} of ${staff} at work${site.crew.length < staff ? ` (${Math.round(manning(site) * 100)}% speed)` : ''}`;
      rows.push(el('p', {}, el('b', { textContent: 'Workers: ' }), working, site.tired ? `, ${site.tired} tired and waiting for a ride` : ''));
    }
    const jobs = new Set<JobId>();
    for (const kind of [...(place.loads ?? []), ...(place.unloads ?? []), ...(place.swaps ?? [])]) {
      const job = JOBS.find((j) => j.goods.includes(kind) && j.id !== 'free');
      if (job) jobs.add(job.id);
    }
    if (staff) jobs.add('workers');
    if (place.id === 'charging-post') jobs.add('coal');
    if (jobs.size) {
      rows.push(el('p', {}, el('b', { textContent: 'Served by: ' }), [...jobs].map((j) => `${getJob(j).icon} ${getJob(j).name.toLowerCase()} trains`).join(', ')));
    }
    if (site.blocked) rows.push(el('p', { class: 'ec-warn', textContent: site.blocked }));
    const mine = this.current.filter((n) => n.uid === site.uid);
    for (const n of mine) rows.push(el('p', { class: n.urgent ? 'ec-warn' : '', textContent: n.message }));
    const add = [...new Set(mine.filter((n) => n.urgent && n.job).map((n) => n.job!))];
    if (add.length) {
      rows.push(el('div', { class: 'tr-row' }, ...add.map((j) => el('button', { type: 'button', class: 'tr-btn primary', textContent: `Add ${getJob(j).icon} ${getJob(j).name.toLowerCase()} train`, onclick: () => this.host.addJobTrain(j) }))));
    }
    card.replaceChildren(...rows);
  }
}
