import { MAX_SECTION_PIECES, type Climb, type Section, type SectionOptions } from '../layout/generate';

// The Generate panel: settings for a new section of track, a line on what
// came out, and buttons to roll another, use it, or stop. The editor owns
// the section and its preview; this only draws the controls.

export interface GeneratePanelState {
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

const counts = (n: number): [string, number][] => Array.from({ length: n + 1 }, (_, i) => [String(i), i]);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  title.innerHTML = '<h2>Generate a section</h2><p class="panel-sub"></p>';
  title.querySelector('p')!.textContent = o.loop
    ? 'A loop stands on its own.'
    : state.pickingEnd
      ? 'Tap the open end it should finish at.'
      : state.fromEnd
      ? 'Builds on from the selected end.'
      : 'Starts loose. Tap an open end first to build on from it.';
  head.append(title);

  const form = document.createElement('div');
  form.className = 'generate-form';

  const pieces = document.createElement('label');
  pieces.className = 'setting';
  const label = document.createElement('span');
  label.className = 'setting-label';
  label.textContent = 'Pieces';
  const out = document.createElement('output');
  out.textContent = String(o.pieces);
  label.append(' ', out);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '4';
  range.max = String(MAX_SECTION_PIECES);
  range.value = String(o.pieces);
  range.addEventListener('input', () => {
    out.textContent = range.value;
  });
  range.addEventListener('change', () => act.change({ pieces: Number(range.value) }));
  pieces.append(label, range);

  form.append(
    seg('Shape', [['Run', false], ['Loop', true]], o.loop, (loop) => act.change({ loop })),
    pieces,
    seg('Finish at', [['Anywhere', false], [state.toEnd ? 'The end picked' : 'An end…', true]], state.toEnd || state.pickingEnd, (end) => act.finishAt(end), o.loop),
    seg('Curves', CURVES, CURVES.reduce((best, c) => (Math.abs(c[1] - o.curves) < Math.abs(best[1] - o.curves) ? c : best))[1], (curves) => act.change({ curves })),
    seg('Switches', counts(4), o.switches, (switches) => act.change({ switches })),
    seg('Sidings end', [['Buffer stop', 'buffer'], ['Open', 'open']] as [string, SectionOptions['sidings']][], o.sidings, (sidings) => act.change({ sidings }), o.switches === 0),
    seg('Height', CLIMBS.map(([v, t]) => [t, v] as [string, Climb]), o.climb, (climb) => act.change({ climb })),
    seg('Stops & accessories', counts(5), o.stops, (stops) => act.change({ stops })),
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
    else if (lacking) text += '. Not everything asked for fit.';
    result.textContent = text;
    if (short || missed || (o.loop && !s.closed)) result.dataset.state = 'problem';
  }

  const actions = document.createElement('div');
  actions.className = 'fill-actions';
  const button = (text: string, cls: string, onClick: () => void, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `action compact ${cls}`;
    b.textContent = text;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };
  actions.append(
    button('Another', '', act.another, state.busy),
    button('Use this', 'primary', act.use, state.busy || !s),
    button('Cancel', '', act.cancel),
  );
  panel.replaceChildren(head, form, result, actions);
}
