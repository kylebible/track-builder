import type { Editor } from '../builder/editor';
import { pieceIcon } from '../builder/palette';
import { DEFAULT_PLAY } from '../geometry/joint';
import type { Vec2 } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import type { PieceCategory } from '../pieces/types';
import type { Layout } from '../layout/layout';
import { checkLayout, summarize, type Issue } from './check';
import { layoutFromJson, layoutToJson, LayoutFileError, shareUrl } from './file';
import { partsList, partsText } from './parts';

// The planning panels behind the toolbar's Parts, Check and Save buttons.
// Each one redraws from the layout whenever it changes.

export interface PlanningDom {
  partsButton: HTMLButtonElement;
  partsPanel: HTMLElement;
  checkButton: HTMLButtonElement;
  checkPanel: HTMLElement;
  sharePanel: HTMLElement;
  /** Fly the camera to a spot on the floor. */
  onFocus: (at: Vec2) => void;
  /** Whether the browser is keeping the autosave. */
  saved: () => boolean;
}

const CATEGORY_NAMES: Record<PieceCategory, string> = {
  straight: 'Straights',
  curve: 'Curves',
  switch: 'Switches',
  crossing: 'Crossings',
  buffer: 'Buffer stops',
};

const ICONS = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  problem: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  open: '<circle cx="12" cy="12" r="4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  fresh: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function actionButton(name: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'action');
  b.type = 'button';
  b.innerHTML = `${icon(name)}<span></span>`;
  b.querySelector('span')!.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Briefly swap a button's label, as feedback for an action. */
function confirm(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector('span')!;
  const original = label.dataset.original ?? label.textContent ?? '';
  label.dataset.original = original;
  label.textContent = text;
  window.setTimeout(() => (label.textContent = original), 1800);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export class PlanningPanel {
  private issues: Issue[] = [];
  private focused: Issue | null = null;
  private checkOpen = false;
  /** Set while the check closes itself to show an issue on a small screen. */
  private keepFocus = false;
  private readonly partsBody = el('div', 'panel-body');
  private readonly partsTotal = el('p', 'panel-sub');
  private readonly checkBody = el('div', 'panel-body');
  private readonly checkSummary = el('p', 'panel-summary');
  private readonly savedNote = el('p', 'panel-sub');
  private readonly linkField = el('input', 'link-field');
  private readonly fileInput = el('input');

  constructor(
    private readonly editor: Editor,
    private readonly dom: PlanningDom,
  ) {
    this.buildParts();
    this.buildCheck();
    this.buildShare();
    dom.checkPanel.addEventListener('toggle', (e) => {
      this.checkOpen = (e as ToggleEvent).newState === 'open';
      if (!this.checkOpen && !this.keepFocus) this.focused = null;
      this.keepFocus = false;
      this.updateMarks();
    });
  }

  /** Redraw everything from a changed layout. */
  update(layout: Layout): void {
    this.issues = checkLayout(layout);
    this.focused = null;
    this.renderParts(layout);
    this.renderCheck(layout);
    this.updateMarks();
    this.savedNote.textContent = this.dom.saved()
      ? 'Your layout is saved in this browser as you build.'
      : "This browser isn't keeping a copy, so download a file to keep your layout.";
  }

  // ---- parts -------------------------------------------------------------

  private buildParts(): void {
    const head = el('header', 'panel-head');
    const title = el('div');
    title.append(el('h2', '', 'Parts list'), this.partsTotal);
    const copy = actionButton('copy', 'Copy', async () => {
      confirm(copy, (await copyText(partsText(partsList(this.editor.layout)))) ? 'Copied' : "Couldn't copy");
    });
    copy.classList.add('compact');
    head.append(title, copy);
    this.dom.partsPanel.append(head, this.partsBody);
  }

  private renderParts(layout: Layout): void {
    const list = partsList(layout);
    this.dom.partsButton.querySelector('.count')!.textContent = list.total ? String(list.total) : '';
    this.partsTotal.textContent = list.total ? `${list.total} piece${list.total === 1 ? '' : 's'} in all` : 'Nothing placed yet';
    const sections = [...new Set(list.lines.map((l) => l.category))].map((category) => {
      const section = el('section');
      section.append(el('h3', '', CATEGORY_NAMES[category]));
      const rows = el('ul', 'parts');
      for (const line of list.lines.filter((l) => l.category === category)) {
        const row = el('li');
        const text = el('div', 'part-text');
        const detail = [line.variant, line.brioIds.join(' / ')].filter(Boolean).join(' · ');
        text.append(el('span', 'part-name', line.name), el('span', 'part-detail', detail));
        row.append(pieceIcon(getPiece(line.pieceId)), text, el('span', 'part-count', `×${line.count}`));
        rows.append(row);
      }
      section.append(rows);
      return section;
    });
    this.partsBody.replaceChildren(...sections);
  }

  // ---- check -------------------------------------------------------------

  private buildCheck(): void {
    const head = el('header', 'panel-head');
    const title = el('div');
    title.append(el('h2', '', 'Layout check'), this.checkSummary);
    head.append(title);
    const foot = el('p', 'panel-foot', `Ends count as joined when they meet within ${DEFAULT_PLAY.mm} mm and ${DEFAULT_PLAY.deg}°, about the play in a real joint.`);
    this.dom.checkPanel.append(head, this.checkBody, foot);
  }

  private renderCheck(layout: Layout): void {
    const problems = this.issues.filter((i) => i.kind !== 'open-end');
    const badge = this.dom.checkButton.querySelector('.badge') as HTMLElement;
    const state = !layout.pieces.length ? 'none' : problems.length ? 'problem' : this.issues.length ? 'open' : 'ok';
    badge.dataset.state = state;
    badge.innerHTML = state === 'ok' ? icon('ok') : state === 'none' ? '' : String(problems.length || this.issues.length);
    this.dom.checkButton.title = layout.pieces.length ? `Layout check: ${summarize(this.issues)}` : 'Layout check';

    this.checkSummary.dataset.state = state;
    this.checkSummary.innerHTML = state === 'ok' ? icon('ok') : state === 'problem' ? icon('problem') : '';
    this.checkSummary.append(layout.pieces.length ? summarize(this.issues) : 'Nothing placed yet');
    if (state === 'ok') this.checkSummary.append(el('span', 'panel-sub', ' Ready to build.'));

    const list = el('ul', 'issues');
    for (const issue of this.issues) {
      const item = el('li');
      const b = el('button', `issue ${issue.kind === 'open-end' ? 'open' : 'problem'}`);
      b.type = 'button';
      b.innerHTML = icon(issue.kind === 'open-end' ? 'open' : 'problem');
      b.append(el('span', '', issue.message));
      b.addEventListener('click', () => this.focus(issue, b));
      item.append(b);
      list.append(item);
    }
    this.checkBody.replaceChildren(...(this.issues.length ? [list] : []));
  }

  /** Look at one issue: fly there and select what it's about. */
  private focus(issue: Issue, button: HTMLButtonElement): void {
    this.focused = issue;
    for (const b of this.checkBody.querySelectorAll('.issue')) b.classList.toggle('focused', b === button);
    if (issue.end) this.editor.selectEnd(issue.end);
    else this.editor.selectPieces(issue.uids);
    this.updateMarks();
    this.dom.onFocus(issue.at);
    // On a phone the panel covers the track, so get out of the way.
    if (window.matchMedia('(max-width: 760px)').matches) {
      this.keepFocus = true;
      this.dom.checkPanel.hidePopover();
    }
  }

  /** Rings on the track for every problem while the check is open, or just the one being looked at. */
  private updateMarks(): void {
    const shown = this.checkOpen ? this.issues : this.focused ? [this.focused] : [];
    const marks = shown.filter((i) => i.kind !== 'open-end').map((i) => ({ at: i.at, focused: i === this.focused }));
    this.editor.setMarks(marks);
  }

  // ---- save and share ------------------------------------------------------

  private buildShare(): void {
    const head = el('header', 'panel-head');
    const title = el('div');
    title.append(el('h2', '', 'Save & share'), this.savedNote);
    head.append(title);

    this.linkField.readOnly = true;
    this.linkField.hidden = true;
    this.linkField.setAttribute('aria-label', 'Share link');
    this.linkField.addEventListener('focus', () => this.linkField.select());

    const link = actionButton('link', 'Copy share link', async () => {
      if (!this.editor.layout.pieces.length) {
        confirm(link, 'Place some track first');
        return;
      }
      const url = await shareUrl(this.editor.layout, location.href);
      this.linkField.value = url;
      this.linkField.hidden = false;
      if (await copyText(url)) {
        confirm(link, 'Link copied');
      } else {
        this.linkField.focus();
        confirm(link, 'Copy the link below');
      }
    });

    const download = actionButton('download', 'Download layout file', () => {
      const blob = new Blob([layoutToJson(this.editor.layout)], { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `track-layout-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => this.openFile());
    const open = actionButton('upload', 'Open layout file…', () => this.fileInput.click());

    const fresh = actionButton('fresh', 'Start a new layout', () => {
      if (!this.editor.layout.pieces.length) return;
      this.editor.load({ pieces: [] });
      this.dom.sharePanel.hidePopover();
      this.editor.flash('Started a new layout. Undo brings the old one back.');
    });

    const actions = el('div', 'actions');
    actions.append(link, this.linkField, download, open, fresh, this.fileInput);
    const foot = el('p', 'panel-foot', 'A share link holds the whole layout, so anyone who opens it sees exactly this track. Nothing is uploaded.');
    this.dom.sharePanel.append(head, actions, foot);
  }

  private async openFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    try {
      const layout = layoutFromJson(await file.text());
      this.editor.load(layout);
      this.dom.sharePanel.hidePopover();
      this.editor.flash(`Opened ${file.name}. Undo brings back what you had.`);
      this.editor.fit();
    } catch (e) {
      this.editor.flash(e instanceof LayoutFileError ? e.message : "Couldn't open that file.");
    }
  }
}
