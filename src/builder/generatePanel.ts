import { LOOP_STOPS, MAX_SECTION_PIECES, MAX_SECTION_STOPS, type Climb, type Section, type SectionOptions, type Variety } from '../layout/generate';
import { offered } from '../pieces/basic';
import { getPiece } from '../pieces/catalog';
import { getPlace } from '../trains/stops';
import type { Connections } from '../layout/connect';

// The Generate panel: settings for a new section of track, a line on what
// came out, and buttons to roll another, use it, or stop. The editor owns
// the section and its preview; this only draws the controls.

export interface GeneratePanelState {
  mode: 'section' | 'connect';
  connections: Connections | null;
  openEnds: number;
  options: SectionOptions;
  section: Section | null;
  /** Building on from a selected end, rather than starting loose. */
  fromEnd: boolean;
  /** Still working one out. */
  busy: boolean;
  /** Finishing at an open end picked for it, joined on with Fill gap. */
  toEnd: boolean;
  /** Waiting for that end to be tapped. */
  pickingEnd: boolean;
}

export interface GeneratePanelActions {
  mode: (mode: GeneratePanelState['mode']) => void;
  change: (options: Partial<SectionOptions>) => void;
  another: () => void;
  /** Finish at an end tapped next, or anywhere. */
  finishAt: (end: boolean) => void;
  use: () => void;
  cancel: () => void;
}

const CURVES: [string, number][] = [
  ['None', 0],
  ['Few', 0.2],
  ['Some', 0.4],
  ['Lots', 0.65],
];

const CLIMBS: [Climb, string][] = [
  ['none', 'Stay low'],
  ['over', 'Up and down'],
  ['up', 'End up high'],
];

function seg<T>(label: string, options: [string, T][], value: T, onPick: (v: T) => void, disabled = false): HTMLElement {
  const el = document.createElement('div');
  el.className = 'setting';
  const name = document.createElement('span');
  name.className = 'setting-label';
  name.textContent = label;
  const group = document.createElement('div');
  group.className = 'seg';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const [text, v] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.disabled = disabled;
    b.setAttribute('aria-pressed', String(v === value));
    b.addEventListener('click', () => onPick(v));
    group.append(b);
  }
  el.append(name, group);
  return el;
}

const VARIETIES: [string, Variety][] = [
  ['Plain', 'plain'],
  ['Mixed', 'mixed'],
  ['Lots of kinds', 'lots'],
];

/** A slider with its value shown by its name, changed when let go. */
function slider(name: string, min: number, max: number, value: number, onChange: (v: number) => void): HTMLElement {
  const el = document.createElement('label');
  el.className = 'setting';
  const label = document.createElement('span');
  label.className = 'setting-label';
  label.textContent = name;
  const out = document.createElement('output');
  out.textContent = String(value);
  label.append(' ', out);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(min);
  range.max = String(max);
  range.value = String(value);
  range.addEventListener('input', () => {
    out.textContent = range.value;
  });
  range.addEventListener('change', () => onChange(Number(range.value)));
  el.append(label, range);
  return el;
}

/** Where one loop goes out to: just round, or by a job stop picked from the list. */
function loopTo(index: number, value: string, onPick: (id: string) => void): HTMLElement {
  const el = document.createElement('label');
  el.className = 'setting setting-inline';
  const name = document.createElement('span');
  name.className = 'setting-label';
  name.textContent = `Loop ${index + 1} goes out to`;
  const select = document.createElement('select');
  const option = (text: string, id: string) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = text;
    o.selected = id === value;
    return o;
  };
  select.append(option('Just a loop', ''));
  const stores = LOOP_STOPS.filter((id) => getPlace(id)?.store);
  for (const [label, ids] of [['Job stops', LOOP_STOPS.filter((id) => !stores.includes(id))], ['Yards', stores]] as const) {
    const shown = ids.filter((id) => offered(getPiece(id)));
    if (!shown.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    group.append(...shown.map((id) => option(getPlace(id)!.name, id)));
    select.append(group);
  }
  select.addEventListener('change', () => onPick(select.value));
  el.append(name, select);
  return el;
}

const counts = (n: number): [string, number][] => Array.from({ length: n + 1 }, (_, i) => [String(i), i]);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function action(text: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `action compact ${cls}`;
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

export function renderGeneratePanel(panel: HTMLElement, state: GeneratePanelState | null, act: GeneratePanelActions): void {
  if (!state) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const o = state.options;
  panel.hidden = false;

  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('div');
  title.innerHTML = '<h2></h2><p class="panel-sub"></p>';
  title.querySelector('h2')!.textContent = state.mode === 'connect' ? 'Connect all open ends' : 'Generate a section';
  title.querySelector('p')!.textContent = state.mode === 'connect'
    ? 'Adds paths between the open ends on your layout.'
    : o.loop
    ? 'A loop stands on its own.'
    : state.pickingEnd
      ? 'Tap the open end it should finish at.'
      : state.fromEnd
      ? 'Builds on from the selected end.'
      : 'Starts loose. Tap an open end first to build on from it.';
  head.append(title);

  const form = document.createElement('div');
  form.className = 'generate-form';
  form.append(seg('Generate', [['A section', 'section'], ['Connect all open ends', 'connect']], state.mode, act.mode));

  if (state.mode === 'connect') {
    const hint = document.createElement('p');
    hint.className = 'panel-sub';
    hint.textContent = 'Pairs open ends with paths that fit around the track already down. Preview the result, then use the connections together.';
    form.append(hint);
    const result = document.createElement('p');
    result.className = 'generate-result';
    result.setAttribute('role', 'status');
    const plan = state.connections;
    if (state.openEnds === 0) result.textContent = 'There are no open ends to connect.';
    else if (state.openEnds === 1) result.textContent = 'There is one open end. Add another open end to connect it to.';
    else if (state.busy) result.textContent = `Finding paths… ${plan ? plan.initialEnds - plan.remaining.length : 0} of ${state.openEnds} ends connected so far.`;
    else if (!plan?.uids.length) {
      result.textContent = `No paths found. ${plural(state.openEnds, 'open end')} left. Try again, move track, or use Fill gap for a pair.`;
      result.dataset.state = 'problem';
    } else {
      const connected = plan.initialEnds - plan.remaining.length;
      result.textContent = `${connected} of ${plan.initialEnds} ends connected · ${plural(plan.pairs.length, 'path')} · ${plural(plan.uids.length, 'piece')}.`;
      if (plan.remaining.length) {
        result.textContent += ` ${plural(plan.remaining.length, 'end')} left open, marked in red.`;
        if (plan.remaining.length === 1) result.textContent += ' An odd number of ends leaves one without a partner.';
        else result.textContent += ' Try again for another pairing, or move track to make room.';
        result.dataset.state = 'problem';
      }
      if (plan.trapped) {
        result.textContent += ' These connections make a train trap: the layout check shows how to fix it.';
        result.dataset.state = 'problem';
      }
    }
    const actions = document.createElement('div');
    actions.className = 'fill-actions';
    actions.append(
      action('Try again', '', act.another, state.busy || state.openEnds < 2),
      action('Use connections', 'primary', act.use, state.busy || !plan?.uids.length),
      action('Cancel', '', act.cancel),
    );
    panel.replaceChildren(head, form, result, actions);
    return;
  }

  const pieces = slider('Pieces', 4, MAX_SECTION_PIECES, o.pieces, (pieces) => act.change({ pieces }));
  const stops = slider('Stops & accessories', 0, MAX_SECTION_STOPS, o.stops, (stops) => act.change({ stops }));

  form.append(
    seg('Shape', [['Run', false], ['Loop', true]], o.loop, (loop) => act.change({ loop })),
    pieces,
    seg('Finish at', [['Anywhere', false], [state.toEnd ? 'The end picked' : 'An end…', true]], state.toEnd || state.pickingEnd, (end) => act.finishAt(end), o.loop),
    seg('Curves', CURVES, CURVES.reduce((best, c) => (Math.abs(c[1] - o.curves) < Math.abs(best[1] - o.curves) ? c : best))[1], (curves) => act.change({ curves })),
    seg('Track', VARIETIES, o.variety, (variety) => act.change({ variety })),
    seg('Switches', counts(4), o.switches, (switches) => act.change({ switches, closed: Math.min(o.closed, switches) })),
    // A loop's switches can't lead off to loops of their own: it is planned to close by itself.
    seg('Looped back', counts(o.switches), Math.min(o.closed, o.switches), (closed) => act.change({ closed }), o.switches === 0 || o.loop),
    ...Array.from({ length: o.loop ? 0 : Math.min(o.closed, o.switches) }, (_, i) =>
      loopTo(i, o.loopTo?.[i] ?? '', (id) => {
        const to = [...(o.loopTo ?? [])];
        to[i] = id;
        act.change({ loopTo: to });
      }),
    ),
    seg('Sidings end', [['Buffer stop', 'buffer'], ['Open', 'open']] as [string, SectionOptions['sidings']][], o.sidings, (sidings) => act.change({ sidings }), o.switches === 0 || (o.closed >= o.switches && !o.loop)),
    seg('Height', CLIMBS.map(([v, t]) => [t, v] as [string, Climb]), o.climb, (climb) => act.change({ climb })),
    stops,
  );

  const result = document.createElement('p');
  result.className = 'generate-result';
  const s = state.section;
  if (state.busy) {
    result.textContent = 'Laying track…';
  } else if (!s) {
    result.textContent = 'Nothing fits here. Try another spot, or fewer pieces.';
    result.dataset.state = 'problem';
  } else {
    const parts = [plural(s.uids.length, 'piece')];
    if (s.switches) parts.push(plural(s.switches, 'switch').replace('switchs', 'switches'));
    if (s.loops) parts.push(plural(s.loops, 'loop') + (s.visits ? ` out to ${plural(s.visits, 'job stop')}` : ''));
    const toVisit = o.loop ? 0 : (o.loopTo ?? []).slice(0, Math.min(o.closed, o.switches)).filter((id) => id).length;
    if (s.stops) parts.push(plural(s.stops, 'stop'));
    let text = parts.join(' · ');
    const toEnd = state.toEnd && !o.loop;
    const short = !o.loop && !toEnd && s.laid < o.pieces;
    const missed = toEnd && !s.closed;
    const lacking = s.stops < o.stops || s.switches < o.switches;
    if (missed) text += '. It couldn’t reach the end picked, so it’s left open.';
    else if (toEnd) {
      text += Math.abs(s.laid - o.pieces) > Math.max(1, Math.round(o.pieces * 0.1)) ? `. Reaching the end picked took ${s.laid} along the line.` : '. Joined to the end picked.';
      if (lacking) text += ' Not everything asked for fit on the way.';
    } else if (short) text += `. Only ${s.laid} of ${o.pieces} fit here.`;
    else if (o.loop && !s.closed) text += '. It couldn’t be closed here, so it’s left open.';
    else if (o.loop && s.uids.length < o.pieces * 0.85) text += `. A loop of ${o.pieces} doesn’t fit here; this is the biggest that did.`;
    else if (s.stops < o.stops && s.stops >= Math.floor(o.pieces / 3)) text += `. Room for ${s.stops} of ${o.stops} stops along ${o.pieces} pieces; more pieces make room for more.`;
    else if (!o.loop && s.loops >= Math.min(o.closed, o.switches) && s.visits < toVisit) text += `. Only ${s.visits} of ${toVisit} job stops fit out along the loops.`;
    else if (!o.loop && s.loops < Math.min(o.closed, o.switches)) text += `. ${o.closed - s.loops === 1 ? 'A loop' : 'Some loops'} couldn’t be joined back up here, so ${o.closed - s.loops === 1 ? 'it ends' : 'they end'} in sidings.`;
    else if (lacking) text += '. Not everything asked for fit.';
    if (s.trapped) text += ' Every way that joins up makes a train trap: the layout check shows how to fix it.';
    result.textContent = text;
    if (short || missed || (o.loop && !s.closed) || s.trapped) result.dataset.state = 'problem';
  }

  const actions = document.createElement('div');
  actions.className = 'fill-actions';
  actions.append(
    action('Another', '', act.another, state.busy),
    action('Use this', 'primary', act.use, state.busy || !s),
    action('Cancel', '', act.cancel),
  );
  panel.replaceChildren(head, form, result, actions);
}
