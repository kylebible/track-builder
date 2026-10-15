// The first-run walkthrough: a few cards that point at the palette and
// toolbar and say what to do with them, shown once to a new visitor and
// again from Help. It only points; nothing is built for you.
//
// Steps name their target by a list of selectors and use the first one
// that is on screen, so a button that moves or goes away just drops the
// highlight and the card sits in the middle instead.

export interface TourStep {
  title: string;
  body: string;
  /** What to point at; the first that is showing wins. None: a card in the middle. */
  anchor?: string[];
}

export const STEPS: TourStep[] = [
  {
    title: 'Plan it before you build it',
    body: 'Every piece here is the size of the real wooden one, so a layout that fits here fits on the floor. Here are the essentials.',
  },
  {
    title: 'Put a piece down',
    body: 'Tap a piece, or drag it onto the floor. The Curves setting decides whether new curves and switches turn left or right.',
    anchor: ['#palette', '#sidebar'],
  },
  {
    title: 'Keep building',
    body: 'Tap the dot on an open end, then keep tapping pieces to add them there. Blue dots are pegs and orange are holes; a peg only goes in a hole.',
  },
  {
    title: 'Close the loop',
    body: 'Bring the track round to meet where it started. If the ends don’t quite meet, tap one end, press Fill gap, then tap the other and pick a run of track that fits.',
    anchor: ['#fill'],
  },
  {
    title: 'Run a train',
    body: 'Open Trains and drag an engine onto the track. Tap a switch’s lever to send it the other way.',
    anchor: ['#trains-button'],
  },
  {
    title: 'Check it',
    body: 'The check lists open ends, joints that won’t go together and track that runs off the table. Tap a problem to fly to it.',
    anchor: ['#check-button'],
  },
  {
    title: 'Save and share',
    body: 'Your layout saves itself in this browser. Save & share copies a link or exports a file, and Parts lists what to get out of the box.',
    anchor: ['#share-button', '.group.planning'],
  },
  {
    title: 'Off you go',
    body: 'Templates are a quick way to start, and this tour is under Help whenever you want it again.',
    anchor: ['#help-button'],
  },
];

const SEEN_KEY = 'track-builder:tour-seen';

/** Whether this browser has already been shown the tour. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // No storage: better to skip it than show it on every visit.
    return true;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Nothing to do; it just shows again next time.
  }
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 12;
const EDGE = 8;

/**
 * Where the card goes: below what it points at if it fits, then above, then
 * beside it, otherwise over it at the bottom of the screen. Always kept on
 * screen. With nothing to point at, in the middle.
 */
export function placeCard(anchor: Rect | null, card: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const fitX = (x: number) => clamp(x, EDGE, view.width - card.width - EDGE);
  const fitY = (y: number) => clamp(y, EDGE, view.height - card.height - EDGE);
  if (!anchor) return { left: fitX((view.width - card.width) / 2), top: fitY((view.height - card.height) / 2) };
  const centerX = anchor.left + anchor.width / 2 - card.width / 2;
  const centerY = anchor.top + anchor.height / 2 - card.height / 2;
  const below = anchor.top + anchor.height + GAP;
  if (below + card.height <= view.height - EDGE) return { left: fitX(centerX), top: below };
  const above = anchor.top - GAP - card.height;
  if (above >= EDGE) return { left: fitX(centerX), top: above };
  const right = anchor.left + anchor.width + GAP;
  if (right + card.width <= view.width - EDGE) return { left: right, top: fitY(centerY) };
  const left = anchor.left - GAP - card.width;
  if (left >= EDGE) return { left, top: fitY(centerY) };
  return { left: fitX(centerX), top: fitY(view.height - card.height - EDGE) };
}

function visibleRect(selectors: string[] | undefined): DOMRect | null {
  for (const selector of selectors ?? []) {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export class Tour {
  private readonly root = el('div');
  private readonly ring = el('div', 'tour-ring');
  private readonly card = el('div', 'tour-card');
  private readonly count = el('p', 'tour-count');
  private readonly title = el('h2');
  private readonly body = el('p', 'tour-body');
  private readonly back = el('button', 'action compact', 'Back');
  private readonly next = el('button', 'action compact primary', 'Next');
  private index = 0;

  constructor(host: HTMLElement = document.body) {
    this.root.id = 'tour';
    // Manual, so it sits above any open panel and only closes when told.
    this.root.popover = 'manual';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'tour-title');
    this.title.id = 'tour-title';
    const close = el('button', 'tour-skip', 'Skip tour');
    close.type = this.back.type = this.next.type = 'button';
    close.onclick = () => this.stop();
    this.back.onclick = () => this.go(this.index - 1);
    this.next.onclick = () => (this.index === STEPS.length - 1 ? this.stop() : this.go(this.index + 1));
    const head = el('div', 'tour-head');
    head.append(this.count, close);
    const foot = el('div', 'tour-foot');
    foot.append(this.back, this.next);
    this.card.append(head, this.title, this.body, foot);
    this.root.append(this.ring, this.card);
    host.append(this.root);

    // Caught before the editor's shortcuts, so R or Delete can't change the
    // layout behind the tour.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.open) return;
        if (e.key === 'Tab') return this.trapFocus(e);
        e.stopPropagation();
        if (e.key === 'Escape') this.stop();
        else if (e.key === 'ArrowRight' && this.index < STEPS.length - 1) this.go(this.index + 1);
        else if (e.key === 'ArrowLeft' && this.index > 0) this.go(this.index - 1);
        else return;
        e.preventDefault();
      },
      true,
    );
    window.addEventListener('resize', () => this.open && this.position());
  }

  get open(): boolean {
    return this.root.matches(':popover-open');
  }

  start(): void {
    markTourSeen();
    if (!this.open) this.root.showPopover();
    document.body.classList.add('touring');
    this.go(0);
  }

  stop(): void {
    if (this.open) this.root.hidePopover();
    document.body.classList.remove('touring');
  }

  private go(i: number): void {
    this.index = i;
    const step = STEPS[i];
    this.count.textContent = `${i + 1} of ${STEPS.length}`;
    this.title.textContent = step.title;
    this.body.textContent = step.body;
    this.back.hidden = i === 0;
    this.next.textContent = i === 0 ? 'Show me' : i === STEPS.length - 1 ? 'Start building' : 'Next';
    this.position();
    this.next.focus();
  }

  /** Point at this step's target, if it's showing, and put the card beside it. */
  private position(): void {
    const target = visibleRect(STEPS[this.index].anchor);
    const pad = 4;
    this.ring.hidden = !target;
    if (target) {
      Object.assign(this.ring.style, {
        left: `${target.left - pad}px`,
        top: `${target.top - pad}px`,
        width: `${target.width + pad * 2}px`,
        height: `${target.height + pad * 2}px`,
      });
    }
    const at = placeCard(
      target && { left: target.left - pad, top: target.top - pad, width: target.width + pad * 2, height: target.height + pad * 2 },
      { width: this.card.offsetWidth, height: this.card.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.card.style.left = `${at.left}px`;
    this.card.style.top = `${at.top}px`;
    this.root.classList.toggle('dim', !target);
  }

  private trapFocus(e: KeyboardEvent): void {
    const stops = [...this.card.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
    const i = stops.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : (i + 1) % stops.length;
    e.preventDefault();
    stops[to]?.focus();
  }
}
