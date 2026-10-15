import * as THREE from 'three';
import { deg, IDENTITY, type Pose, type Vec2 } from '../geometry/pose';
import { BENDY_IDS, getPiece } from '../pieces/catalog';
import { LEVEL_HEIGHT } from '../pieces/dimensions';
import type { Gender } from '../pieces/types';
import { History } from '../layout/history';
import {
  addPiece,
  baseOf,
  anchorPoints,
  canExtend,
  centerOf,
  clearSpotFor,
  copyPieces,
  defOf,
  dragContext,
  EMPTY_LAYOUT,
  extendFrom,
  findJoints,
  findPiece,
  findSeat,
  findSnap,
  flipPiece,
  mirrorPieces,
  openEnds,
  partnerOf,
  pastePieces,
  sameEnd,
  raisePieces,
  reshapePiece,
  removePieces,
  rotatePieces,
  sectionOf,
  swapEnd,
  transformPieces,
  worldEnd,
  worldEnds,
  type Clip,
  type DragContext,
  type EndRef,
  type Layout,
  type Snap,
} from '../layout/layout';
import { flexContext, flexDrag, type FlexContext, type FlexResult } from '../layout/flex';
import { describeFill, searchFills, type Fill } from '../layout/fill';
import { layoutTraps, newTrapEntries, type TrapEntry } from '../trains/traps';
import { DEFAULT_SECTION, generateSection, type SectionOptions } from '../layout/generate';
import { searchConnections } from '../layout/connect';
import { renderGeneratePanel, type GeneratePanelState } from './generatePanel';
import { Palette } from './palette';
import { attachEnd, flipFor, hasEndsChoice, offeredIds, turnFrom, isLoose, SHAPES, variantFor, type Shape } from './variants';
import { LayoutView } from './view';

// Turns pointer, keyboard and toolbar input into layout edits. Every edit
// goes through `commit`, which records it for undo and redraws.

type Selection = { kind: 'none' } | { kind: 'end'; end: EndRef } | { kind: 'pieces'; uids: ReadonlySet<string> };

const NONE: Selection = { kind: 'none' };
/** Pointer travel, in pixels, before a press on a piece becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
const ROTATE_STEP = deg(45);
/** Where the copied pieces are kept, so they can be pasted after a reload or in another tab. */
const CLIP_KEY = 'track-builder:clipboard';

/** A rubber-band box being dragged across the view to select what's inside it. */
interface Box {
  pointerId: number;
  from: Vec2;
  to: Vec2;
  /** What was selected before, which the box adds to. */
  base: ReadonlySet<string>;
}

interface Drag {
  pointerId: number;
  uids: ReadonlySet<string>;
  start: Layout;
  context: DragContext;
  grab: Vec2;
  /** The level the drag moves across. */
  height: number;
  screen: Vec2;
  active: boolean;
  transform: Pose;
  snap: Snap | null;
  /** Set when the dragged pieces are joined into track, whose joints flex. */
  flex: FlexContext | null;
  /** The flexed track, while the drag is held by its joints. */
  flexed: FlexResult | null;
  /** A shift-click or select-mode tap on this piece adds it to the selection or takes it out, if it isn't dragged. */
  toggles: string | null;
  /** Lined up over a straight, for scenery that sits on track. */
  seated: boolean;
  /** How far the drag lifts the pieces: onto a raised end, or onto raised track. */
  dz: number;
}

/** A piece being dragged out of the palette, and where it would go if let go now. */
interface PaletteDrag {
  pointerId: number;
  shape: Shape;
  /** Null while the pointer is off the floor (over the palette or a panel). */
  drop: Drop | null;
}

interface Drop {
  layout: Layout;
  uid: string;
  /** What to select once it's down: the end to keep building from. */
  after: Selection;
  /** The open end it joins, if it was brought near one. */
  joins: EndRef | null;
}

/**
 * A piece dragged from the palette joins an open end when the pointer is
 * this close to where the joined piece's middle would be, or to the end itself.
 */
const DROP_CAPTURE_MM = { middle: 110, end: 70 };

/**
 * Filling a gap: the end it starts from, then (once the other end is
 * tapped) the runs of track that would join them, one previewed at a time.
 */
interface Filling {
  from: EndRef;
  to: EndRef | null;
  options: Fill[];
  index: number;
  /** Still looking for more ways, a slice at a time. */
  searching: boolean;
  /**
   * Joining these two ends makes a train trap, whichever way the gap is
   * filled (that only depends on which ends join): null until a way is found.
   */
  traps: TrapEntry[] | null;
}

/** A section being generated: its settings and the one previewed. */
interface Generating extends GeneratePanelState {
  /** Where it starts: the selected end, or loose here. */
  start: EndRef | null;
  at: Vec2;
  /** The open end it finishes at, if one was picked. */
  goal: EndRef | null;
}

const SECTION_KEY = 'track-builder:generate';

function savedSectionOptions(): SectionOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(SECTION_KEY) ?? 'null');
    return { ...DEFAULT_SECTION, ...(saved && typeof saved === 'object' ? saved : {}), seed: Math.floor(Math.random() * 1e9) };
  } catch {
    return { ...DEFAULT_SECTION, seed: Math.floor(Math.random() * 1e9) };
  }
}

export interface EditorDom {
  canvas: HTMLElement;
  palette: HTMLElement;
  status: HTMLElement;
  /** Shown while the layout is empty. */
  empty: HTMLElement;
  buttons: Record<
    | 'undo'
    | 'redo'
    | 'select'
    | 'rotateLeft'
    | 'rotateRight'
    | 'flip'
    | 'swap'
    | 'bend'
    | 'raise'
    | 'lower'
    | 'section'
    | 'copy'
    | 'paste'
    | 'duplicate'
    | 'fill'
    | 'generate'
    | 'remove'
    | 'fit',
    HTMLButtonElement
  >;
  /** Where the auto-fill choices are listed. */
  fillPanel: HTMLElement;
  /** Where a new section's settings are. */
  generatePanel: HTMLElement;
  /** Pieces in trouble the layout check can't see, such as off the table or in the water. */
  blocked?: (layout: Layout) => Iterable<string>;
  /** Frame the whole layout in the view. */
  onFit: () => void;
  /** The layout to start with, such as the one saved last time. */
  initial?: Layout;
  /** Called whenever the layout itself changes: an edit, undo or redo, or a layout loaded. */
  onChange?: (layout: Layout) => void;
}

/** A spot the layout check wants looked at. */
export interface Mark {
  at: Vec2;
  /** Height above the floor, for problems on raised track. */
  z?: number;
  /** Highlighted, because it is the one being looked at. */
  focused: boolean;
}

export class Editor {
  private readonly history: History;
  private selection: Selection = NONE;
  private drag: Drag | null = null;
  private paletteDrag: PaletteDrag | null = null;
  private filling: Filling | null = null;
  private box: Box | null = null;
  /** Select mode: taps add pieces to the selection and drags on the floor draw a box, for touch screens. */
  private multi = false;
  private clip: Clip | null = loadClip();
  /** The floor under the pointer when it last moved over the view, for pasting where it points. */
  private pointerAt: Vec2 | null = null;
  private readonly boxEl = document.createElement('div');
  private generating: Generating | null = null;
  private generateMode: GeneratePanelState['mode'] = 'section';
  private readonly view: LayoutView;
  private readonly palette: Palette;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly controls: { enabled: boolean; target: THREE.Vector3 },
    private readonly dom: EditorDom,
  ) {
    this.history = new History(dom.initial ?? EMPTY_LAYOUT);
    this.view = new LayoutView(scene);
    this.palette = new Palette(
      dom.palette,
      (shape) => this.pick(shape),
      () => this.refresh(),
      (shape, e) => this.startPaletteDrag(shape, e),
    );
    // Capture phase on the canvas's container, so a press on a piece is
    // claimed before the orbit controls on the canvas start turning the camera.
    dom.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    window.addEventListener('pointercancel', (e) => this.pointerUp(e));
    dom.canvas.addEventListener('dblclick', (e) => this.doubleClick(e));
    window.addEventListener('keydown', (e) => this.key(e));
    const b = dom.buttons;
    b.undo.onclick = () => this.undo();
    b.select.onclick = () => this.toggleSelectMode();
    b.copy.onclick = () => this.copy();
    b.paste.onclick = () => this.paste(false);
    b.duplicate.onclick = () => this.duplicate();
    b.redo.onclick = () => this.redo();
    b.rotateLeft.onclick = () => this.rotate(1);
    b.rotateRight.onclick = () => this.rotate(-1);
    b.flip.onclick = () => this.flip();
    b.swap.onclick = () => this.swap();
    b.bend.onclick = (e) => this.bend(e.shiftKey ? -1 : 1);
    b.raise.onclick = () => this.raise(1);
    b.lower.onclick = () => this.raise(-1);
    b.section.onclick = () => this.selectSection();
    b.fill.onclick = () => this.startFill();
    b.generate.onclick = () => this.startGenerate();
    b.remove.onclick = () => this.remove();
    b.fit.onclick = () => dom.onFit();
    this.boxEl.className = 'select-box';
    this.boxEl.hidden = true;
    dom.canvas.append(this.boxEl);
    this.refresh();
  }

  get layout(): Layout {
    return this.history.current;
  }

  /** Per-frame animation; `time` in ms. */
  tick(time: number): void {
    this.view.tick(time);
  }

  /** The placed pieces' three.js objects, for framing the view. */
  get pieceObjects(): THREE.Object3D {
    return this.view.pickables[1];
  }

  /** Open-connector buttons take priority over the train controls beneath them. */
  get endMarkers(): THREE.Object3D {
    return this.view.pickables[0];
  }

  /** Replace the whole layout, as one step that undo can take back. */
  load(layout: Layout): void {
    this.commit(layout, NONE);
  }

  /** Put in a change worked out elsewhere (a fix from the check), as one step, selecting the pieces it touched. */
  apply(layout: Layout, uids: Iterable<string>, message?: string): void {
    this.commit(layout, { kind: 'pieces', uids: new Set(uids) });
    if (message) this.flash(message);
  }

  /** Frame the whole layout in the view. */
  fit(): void {
    this.dom.onFit();
  }

  /** Select some pieces, as if they had been clicked. */
  selectPieces(uids: Iterable<string>): void {
    const exists = new Set(this.layout.pieces.map((p) => p.uid));
    const set = new Set([...uids].filter((u) => exists.has(u)));
    this.selection = set.size ? { kind: 'pieces', uids: set } : NONE;
    this.refresh();
  }

  /** Select an open end to build from. */
  selectEnd(end: EndRef): void {
    this.selection = { kind: 'end', end };
    this.selection = this.validSelection();
    this.refresh();
  }

  private marks: Mark[] = [];

  /** Show rings where the layout check found problems. */
  setMarks(marks: Mark[]): void {
    this.marks = marks;
    this.refresh();
  }

  // ---- edits -------------------------------------------------------------

  private commit(next: Layout | null, selection: Selection = this.selection): void {
    if (!next) return;
    this.filling = null;
    this.endGenerate();
    this.history.push(next);
    this.selection = selection;
    this.refresh();
  }

  /**
   * A palette tile was tapped: add onto the selected end, or drop the piece
   * loose. The palette's Turn and Ends settings pick the exact version.
   * Scenery that isn't track always goes down loose.
   */
  pick(shape: Shape): void {
    const hand = this.palette.hand;
    if (isLoose(shape)) {
      const { layout, uid } = addPiece(this.layout, shape.ids[0], { ...this.freeSpot(), angle: 0 });
      this.commit(layout, { kind: 'pieces', uids: new Set([uid]) });
      return;
    }
    if (this.selection.kind === 'end') {
      const end = this.selection.end;
      const target = this.genderOf(end);
      const pieceId = variantFor(shape, this.palette.ends, target);
      if (!canExtend(this.layout, end, pieceId)) {
        this.flash(`A ${getPiece(pieceId).name.toLowerCase()} has no end that fits this ${target ?? 'end'}.`);
        return;
      }
      const attach = attachEnd(pieceId, target, worldEnd(this.layout, end).connector.z);
      const ext = extendFrom(this.layout, end, pieceId, flipFor(pieceId, attach, hand), attach)!;
      this.commit(ext.layout, ext.next ? { kind: 'end', end: ext.next } : { kind: 'pieces', uids: new Set([ext.uid]) });
      return;
    }
    const pieceId = variantFor(shape, this.palette.ends, null);
    const ends = getPiece(pieceId).connectors;
    const spot = this.freeSpot();
    const { layout, uid } = addPiece(this.layout, pieceId, { ...spot, angle: 0 }, flipFor(pieceId, ends[0].id, hand));
    const next = ends[1] ?? ends[0];
    this.commit(layout, { kind: 'end', end: { uid, connectorId: next.id } });
  }

  /**
   * Where a palette piece would go if let go at `at`: onto the nearest open
   * end it fits, placed exactly as a tap on that end would, or loose with
   * its middle under the pointer.
   */
  private dropAt(shape: Shape, at: Vec2): Drop {
    const hand = this.palette.hand;
    let best: (Drop & { distance: number }) | null = null;
    for (const end of openEnds(this.layout)) {
      const target = end.connector.gender;
      const pieceId = variantFor(shape, this.palette.ends, target);
      if (!canExtend(this.layout, end, pieceId)) continue;
      const attach = attachEnd(pieceId, target, end.connector.z);
      const ext = extendFrom(this.layout, end, pieceId, flipFor(pieceId, attach, hand), attach);
      if (!ext) continue;
      const middle = centerOf(ext.layout, new Set([ext.uid]));
      const distance = Math.hypot(middle.x - at.x, middle.y - at.y);
      const toEnd = Math.hypot(end.connector.pose.x - at.x, end.connector.pose.y - at.y);
      if (distance > DROP_CAPTURE_MM.middle && toEnd > DROP_CAPTURE_MM.end) continue;
      if (best && distance >= best.distance) continue;
      const joins = { uid: end.uid, connectorId: end.connectorId };
      const after: Selection = ext.next ? { kind: 'end', end: ext.next } : { kind: 'pieces', uids: new Set([ext.uid]) };
      best = { layout: ext.layout, uid: ext.uid, after, joins, distance };
    }
    if (best) return best;

    const pieceId = variantFor(shape, this.palette.ends, null);
    const ends = getPiece(pieceId).connectors;
    const flipped = ends.length ? flipFor(pieceId, ends[0].id, hand) : false;
    const placed = addPiece(this.layout, pieceId, IDENTITY, flipped);
    const middle = centerOf(placed.layout, new Set([placed.uid]));
    const { layout, uid } = addPiece(this.layout, pieceId, { x: at.x - middle.x, y: at.y - middle.y, angle: 0 }, flipped);
    const next = ends[1] ?? ends[0];
    const after: Selection = next ? { kind: 'end', end: { uid, connectorId: next.id } } : { kind: 'pieces', uids: new Set([uid]) };
    return { layout, uid, after, joins: null };
  }

  /** The pieces the toolbar acts on: the selection, or the piece with the selected end. */
  private targets(): ReadonlySet<string> {
    if (this.selection.kind === 'pieces') return this.selection.uids;
    if (this.selection.kind === 'end') return new Set([this.selection.end.uid]);
    return new Set();
  }

  rotate(direction: 1 | -1): void {
    const uids = this.targets();
    if (uids.size) this.commit(rotatePieces(this.layout, uids, direction * ROTATE_STEP));
  }

  flip(): void {
    const uids = this.targets();
    if (!uids.size) return;
    if (uids.size === 1) {
      const [uid] = uids;
      this.commit(flipPiece(this.layout, uid));
    } else {
      this.commit(mirrorPieces(this.layout, uids));
    }
  }

  swap(): void {
    const uids = this.targets();
    if (uids.size !== 1) return;
    const [uid] = uids;
    const swapped = swapEnd(this.layout, uid);
    const result = swapped ? { layout: swapped, uid } : this.swapVariant(uid);
    if (!result) {
      this.flash('This piece only fits one way round here.');
      return;
    }
    const next = result.layout;
    // Keep building from the new piece's open end.
    const open = openEnds(next).find((e) => e.uid === result.uid);
    this.commit(next, open ? { kind: 'end', end: open } : this.selection);
  }

  /**
   * Turn a switch round where its own pegs and holes won't allow it, by
   * swapping it for its twin with the pegs the other way round.
   */
  private swapVariant(uid: string): { layout: Layout; uid: string } | null {
    const piece = findPiece(this.layout, uid);
    const shape = SHAPES.find((s) => s.ids.includes(piece.pieceId));
    if (!shape || hasEndsChoice(shape)) return null;
    const joints = findJoints(this.layout);
    const joined = worldEnds(piece).filter((e) => partnerOf(joints, e));
    if (joined.length !== 1) return null;
    const partner = partnerOf(joints, joined[0])!;
    const rest = removePieces(this.layout, new Set([uid]));
    const target = worldEnd(rest, partner).connector.gender;
    for (const id of offeredIds(shape).filter((i) => i !== piece.pieceId)) {
      for (const c of getPiece(id).connectors) {
        if (c.gender === target || c.id === joined[0].connectorId) continue;
        const ext = extendFrom(rest, partner, id, flipFor(id, c.id, this.palette.hand), c.id);
        if (ext) return { layout: ext.layout, uid: ext.uid };
      }
    }
    return null;
  }

  /** The one selected piece, if it is a bendy track. */
  private selectedBendy(): string | null {
    const uids = this.targets();
    if (uids.size !== 1) return null;
    const [uid] = uids;
    return BENDY_IDS.includes(findPiece(this.layout, uid).pieceId) ? uid : null;
  }

  /**
   * Bend a bendy track a step further (or back towards straight), keeping
   * the end it is joined by in place. It keeps bending the way it already
   * turns; a straight one starts bending the way the palette's Curves turn
   * setting says.
   */
  bend(direction: 1 | -1): void {
    const uid = this.selectedBendy();
    if (!uid) return;
    const piece = findPiece(this.layout, uid);
    const step = BENDY_IDS.indexOf(piece.pieceId);
    const next = step + direction;
    if (next < 0 || next >= BENDY_IDS.length) {
      this.flash(next < 0 ? 'That bendy track is already straight.' : 'That bendy track is bent as far as it goes.');
      return;
    }
    const id = BENDY_IDS[next];
    const layout = reshapePiece(this.layout, uid, id, (anchorId) => {
      const turn = step ? turnFrom(defOf(piece), anchorId) : 0;
      const hand = turn ? (turn > 0 ? 'left' : 'right') : this.palette.hand;
      return flipFor(id, anchorId, hand);
    });
    this.commit(layout, this.selection);
    this.flash(`Bent ${getPiece(id).bend}°.`);
  }

  /** Lift the selection a level (onto supports), or lower it a level. */
  raise(direction: 1 | -1): void {
    const uids = this.targets();
    if (!uids.size) return;
    const next = raisePieces(this.layout, uids, direction * LEVEL_HEIGHT);
    if (!next) {
      this.flash('That is already down on the floor.');
      return;
    }
    // Lifting one piece out of joined track leaves its neighbours behind.
    const joints = findJoints(this.layout);
    const torn = [...uids].some((uid) => worldEnds(findPiece(this.layout, uid)).some((e) => {
      const partner = partnerOf(joints, e);
      return partner && !uids.has(partner.uid);
    }));
    this.commit(next, { kind: 'pieces', uids });
    if (torn) this.flash(`${direction > 0 ? 'Raised' : 'Lowered'} just the selection. Select connected (A) to move a whole stretch.`);
  }

  remove(): void {
    const uids = this.targets();
    if (!uids.size) return;
    // Removing a single piece that hangs off one joint goes back to that
    // joint, like backspace, so a wrong piece can be swapped for another.
    let after: Selection = NONE;
    if (uids.size === 1) {
      const [uid] = uids;
      const joints = findJoints(this.layout);
      const piece = this.layout.pieces.find((p) => p.uid === uid)!;
      const partners = worldEnds(piece)
        .map((e) => partnerOf(joints, e))
        .filter((e): e is EndRef => e !== null);
      if (partners.length === 1) after = { kind: 'end', end: partners[0] };
    }
    this.commit(removePieces(this.layout, uids), after);
  }

  selectSection(): void {
    const uids = this.targets();
    if (!uids.size) return;
    const joints = findJoints(this.layout);
    const section = new Set<string>();
    for (const uid of uids) sectionOf(this.layout, uid, joints).forEach((u) => section.add(u));
    this.selection = { kind: 'pieces', uids: section };
    this.refresh();
  }

  // ---- multi-select, copy and paste ---------------------------------------

  /** Turn select mode on or off: taps add to the selection, and drags on the floor draw a box instead of turning the view. */
  toggleSelectMode(): void {
    this.multi = !this.multi;
    if (this.multi) this.flash('Select mode: tap pieces to add them, or drag a box round them. Tap Select again to finish.');
    else this.refresh();
  }

  selectAll(): void {
    this.selectPieces(this.layout.pieces.map((p) => p.uid));
  }

  /** Keep the selected pieces to paste later. */
  copy(): boolean {
    const uids = this.targets();
    if (!uids.size) return false;
    this.clip = copyPieces(this.layout, uids);
    saveClip(this.clip);
    this.flash(`Copied ${plural(uids.size, 'piece')}. Paste (Ctrl+V) puts a copy down.`);
    return true;
  }

  cut(): void {
    const uids = this.targets();
    if (!this.copy()) return;
    this.commit(removePieces(this.layout, uids), NONE);
    this.flash(`Cut ${plural(uids.size, 'piece')}. Paste (Ctrl+V) puts them back down.`);
  }

  /**
   * Put a copy of the copied pieces down: under the pointer when pasting
   * by key over the view, otherwise in the middle of the view. It steps
   * aside from track already there, and is left selected to drag into place.
   */
  paste(atPointer: boolean): void {
    if (!this.clip) {
      this.flash('Select some pieces and Copy them first.');
      return;
    }
    const near = (atPointer && this.pointerAt) || { x: this.controls.target.x, y: -this.controls.target.z };
    this.putDown(this.clip, clearSpotFor(this.layout, this.clip, near), 'Pasted');
  }

  /** Copy the selection and put the copy down right beside it. */
  duplicate(): void {
    const uids = this.targets();
    if (!uids.size) return;
    const clip = copyPieces(this.layout, uids);
    this.putDown(clip, clearSpotFor(this.layout, clip), 'Duplicated');
  }

  private putDown(clip: Clip, shift: Pose, verb: string): void {
    const { layout, uids } = pastePieces(this.layout, clip, shift);
    this.commit(layout, { kind: 'pieces', uids: new Set(uids) });
    this.flash(`${verb} ${plural(uids.length, 'piece')}: drag them into place, or near an open end to join on.`);
  }

  /** Add a piece to the selection, or take it out if it is already in. */
  private toggle(uid: string): void {
    const s = this.selection;
    const uids = new Set(s.kind === 'pieces' ? s.uids : s.kind === 'end' ? [s.end.uid] : []);
    if (uids.has(uid)) uids.delete(uid);
    else uids.add(uid);
    this.selection = uids.size ? { kind: 'pieces', uids } : NONE;
    this.refresh();
  }

  /** The pieces whose middles are inside the box, on screen. */
  private piecesInBox(box: Box): string[] {
    const rect = this.dom.canvas.getBoundingClientRect();
    const [left, right] = [Math.min(box.from.x, box.to.x), Math.max(box.from.x, box.to.x)];
    const [top, bottom] = [Math.min(box.from.y, box.to.y), Math.max(box.from.y, box.to.y)];
    const inside: string[] = [];
    for (const piece of this.layout.pieces) {
      const mid = centerOf(this.layout, new Set([piece.uid]));
      const v = new THREE.Vector3(mid.x, baseOf(piece), -mid.y).project(this.camera);
      if (v.z > 1) continue;
      const x = rect.left + ((v.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - v.y) / 2) * rect.height;
      if (x >= left && x <= right && y >= top && y <= bottom) inside.push(piece.uid);
    }
    return inside;
  }

  private moveBox(e: PointerEvent): void {
    const box = this.box!;
    box.to = { x: e.clientX, y: e.clientY };
    const rect = this.dom.canvas.getBoundingClientRect();
    Object.assign(this.boxEl.style, {
      left: `${Math.min(box.from.x, box.to.x) - rect.left}px`,
      top: `${Math.min(box.from.y, box.to.y) - rect.top}px`,
      width: `${Math.abs(box.to.x - box.from.x)}px`,
      height: `${Math.abs(box.to.y - box.from.y)}px`,
    });
    this.boxEl.hidden = false;
    const uids = new Set([...box.base, ...this.piecesInBox(box)]);
    this.selection = uids.size ? { kind: 'pieces', uids } : NONE;
    this.refresh();
  }

  private endBox(e: PointerEvent): void {
    const box = this.box!;
    this.box = null;
    this.boxEl.hidden = true;
    this.controls.enabled = true;
    // Barely moved: a tap on empty floor, which keeps the selection to add to.
    if (Math.hypot(e.clientX - box.from.x, e.clientY - box.from.y) < DRAG_THRESHOLD_PX) {
      this.selection = box.base.size ? { kind: 'pieces', uids: box.base } : NONE;
    }
    this.refresh();
  }

  // ---- auto-fill -----------------------------------------------------------

  /** Start filling a gap from the selected open end: the next end tapped is where it goes to. */
  startFill(): void {
    if (this.filling) {
      this.cancelFill();
      return;
    }
    const s = this.selection;
    if (s.kind !== 'end') {
      this.flash('Tap the dot on one open end first, then Fill gap.');
      return;
    }
    this.endGenerate();
    this.filling = { from: s.end, to: null, options: [], index: 0, searching: false, traps: null };
    this.refresh();
  }

  /**
   * The other end was tapped: look for ways to join the two. The search
   * runs a slice per frame, so runs show up as they're found and a long
   * way round doesn't freeze the page.
   */
  private fillTo(to: EndRef): void {
    const filling = this.filling!;
    if (sameEnd(to, filling.from)) return;
    const layout = this.layout;
    const search = searchFills(layout, filling.from, to, { blocked: this.dom.blocked });
    const current: Filling = { ...filling, to, options: [], index: 0, searching: true, traps: null };
    this.filling = current;
    const step = () => {
      // Stopped, or another end tapped, or the layout changed under it.
      if (this.filling !== current || this.layout !== layout) return;
      const until = performance.now() + 24;
      let next = search.next();
      while (!next.done && performance.now() < until) next = search.next();
      const shown = current.options[current.index];
      if (next.value.length !== current.options.length) {
        current.options = next.value;
        if (!current.traps && current.options.length) current.traps = newTrapEntries(layoutTraps(layout), layoutTraps(current.options[0].layout));
        current.index = Math.max(0, shown ? current.options.indexOf(shown) : 0);
      }
      if (next.done) {
        current.searching = false;
        if (!current.options.length) {
          this.filling = { ...current, to: null };
          this.flash('No run of track joins those ends without running into something. Try another end.');
          return;
        }
      } else {
        window.setTimeout(step, 0);
      }
      this.refresh();
    };
    this.refresh();
    window.setTimeout(step, 0);
  }

  /** Preview another of the ways to fill the gap. */
  showFill(index: number): void {
    const f = this.filling;
    if (!f || !f.options.length) return;
    f.index = (index + f.options.length) % f.options.length;
    this.refresh();
  }

  /** Put the previewed run in. */
  applyFill(): void {
    const f = this.filling;
    const fill = f?.options[f.index];
    if (!fill) return;
    this.commit(fill.layout, { kind: 'pieces', uids: new Set(fill.uids) });
    this.flash(`Added ${fill.uids.length === 1 ? 'a piece' : `${fill.uids.length} pieces`} to close the gap.`);
  }

  cancelFill(): void {
    if (!this.filling) return;
    this.filling = null;
    this.refresh();
  }

  // ---- generate a section ------------------------------------------------

  /** Open the Generate panel, building on from the selected end if there is one. */
  startGenerate(): void {
    if (this.generating) {
      this.cancelGenerate();
      return;
    }
    this.filling = null;
    const s = this.selection;
    this.generating = {
      mode: this.generateMode,
      connections: null,
      openEnds: openEnds(this.layout).length,
      options: savedSectionOptions(),
      section: null,
      busy: false,
      fromEnd: s.kind === 'end',
      start: s.kind === 'end' ? s.end : null,
      at: this.freeSpot(),
      goal: null,
      toEnd: false,
      pickingEnd: false,
    };
    this.regenerate();
  }

  private asks = 0;

  /** Lay the section the settings ask for, then show it. */
  private regenerate(): void {
    const g = this.generating;
    if (!g) return;
    g.busy = true;
    const ask = ++this.asks;
    this.renderGenerate();
    // Let the panel say it's working before a long one starts; a newer ask supersedes it.
    window.setTimeout(() => {
      if (this.generating !== g || ask !== this.asks) return;
      if (g.mode === 'connect') {
        const base = this.layout;
        const search = searchConnections(base, { seed: g.options.seed, blocked: this.dom.blocked });
        const step = () => {
          if (this.generating !== g || ask !== this.asks || this.layout !== base) return;
          const until = performance.now() + 24;
          let next = search.next();
          while (!next.done && performance.now() < until) next = search.next();
          const changed = g.connections !== next.value || g.busy !== !next.done;
          g.connections = next.value;
          g.busy = !next.done;
          if (changed) {
            this.renderGenerate();
            this.refresh();
          }
          if (!next.done) window.setTimeout(step, 0);
        };
        step();
        return;
      }
      g.section = generateSection(this.layout, g.options, { start: g.start ?? undefined, at: g.at, goal: g.goal ?? undefined, blocked: this.dom.blocked });
      g.busy = false;
      this.renderGenerate();
      this.refresh();
    }, 30);
  }

  private changeGenerateMode(mode: GeneratePanelState['mode']): void {
    const g = this.generating;
    if (!g || g.mode === mode) return;
    this.generateMode = mode;
    Object.assign(g, { mode, section: null, connections: null, pickingEnd: false });
    this.regenerate();
    this.refresh();
  }

  private changeGenerate(change: Partial<SectionOptions>): void {
    const g = this.generating;
    if (!g) return;
    g.options = { ...g.options, ...change };
    try {
      const { seed: _, ...keep } = g.options;
      localStorage.setItem(SECTION_KEY, JSON.stringify(keep));
    } catch {
      // Private browsing: settings just aren't kept.
    }
    this.regenerate();
  }

  /** Finish the section at the next open end tapped, or anywhere. */
  private finishAt(end: boolean): void {
    const g = this.generating;
    if (!g) return;
    if (end) {
      g.pickingEnd = true;
      this.renderGenerate();
      this.refresh();
      return;
    }
    Object.assign(g, { goal: null, toEnd: false, pickingEnd: false });
    this.regenerate();
  }

  /** Roll another section with the same settings. */
  anotherSection(): void {
    if (this.generating) this.changeGenerate({ seed: (this.generating.options.seed + 1) % 1e9 });
  }

  /** Put the previewed section in. */
  applyGenerate(): void {
    const g = this.generating;
    if (g?.mode === 'connect') {
      const plan = g.connections;
      if (g.busy || !plan?.uids.length) return;
      this.commit(plan.layout, { kind: 'pieces', uids: new Set(plan.uids) });
      this.flash(`Connected ${plan.initialEnds - plan.remaining.length} of ${plan.initialEnds} open ends with ${plural(plan.uids.length, 'piece')}.${plan.remaining.length ? ` ${plural(plan.remaining.length, 'end')} left open.` : ''}`);
      return;
    }
    const section = this.generating?.section;
    if (!section || this.generating?.busy) return;
    const open = openEnds(section.layout).filter((e) => section.uids.includes(e.uid)).length;
    this.commit(section.layout, { kind: 'pieces', uids: new Set(section.uids) });
    this.flash(
      open && this.layout.pieces.length > section.uids.length
        ? `Added ${section.uids.length} pieces. To join it up, tap one of its open ends, then Fill gap.`
        : `Added ${section.uids.length} pieces.`,
    );
  }

  cancelGenerate(): void {
    if (!this.generating) return;
    this.endGenerate();
    this.refresh();
  }

  private endGenerate(): void {
    if (!this.generating) return;
    this.generating = null;
    this.renderGenerate();
  }

  private renderGenerate(): void {
    renderGeneratePanel(this.dom.generatePanel, this.generating, {
      mode: (mode) => this.changeGenerateMode(mode),
      change: (c) => this.changeGenerate(c),
      another: () => this.anotherSection(),
      finishAt: (end) => this.finishAt(end),
      use: () => this.applyGenerate(),
      cancel: () => this.cancelGenerate(),
    });
  }

  /** List the ways to fill the gap, with the one being previewed picked out. */
  private renderFillPanel(): void {
    const panel = this.dom.fillPanel;
    const f = this.filling;
    if (!f || (!f.options.length && !f.searching)) {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    panel.hidden = false;
    const head = document.createElement('div');
    head.className = 'panel-head';
    const title = document.createElement('div');
    title.innerHTML = '<h2>Fill the gap</h2><p class="panel-sub"></p>';
    title.querySelector('p')!.textContent = !f.options.length
      ? 'Looking for a run of track that joins them…'
      : f.searching
        ? `${f.options.length === 1 ? 'One way' : `${f.options.length} ways`} so far, still looking…`
        : f.options.length === 1
          ? 'One way fits. It is shown on the track.'
          : `${f.options.length} ways fit. Pick one to see it on the track.`;
    head.append(title);
    if (f.traps?.length) {
      const warn = document.createElement('p');
      warn.className = 'fill-warning';
      warn.textContent = 'Joining these ends makes a train trap: trains that go one way at a switch get shut in a loop. Join another end, or use it and fix the trap from the layout check.';
      head.append(warn);
    }
    const list = document.createElement('div');
    list.className = 'fills';
    f.options.forEach((fill, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fill-option';
      b.setAttribute('aria-pressed', String(i === f.index));
      const name = document.createElement('b');
      name.textContent = `${fill.uids.length} ${fill.uids.length === 1 ? 'piece' : 'pieces'}`;
      const parts = document.createElement('span');
      parts.textContent = describeFill(fill).join(', ');
      const notes: string[] = [];
      if (fill.odd) notes.push(fill.odd === 1 ? 'needs a two-peg or two-hole piece' : `needs ${fill.odd} two-peg or two-hole pieces`);
      notes.push(fill.flex < 0.05 ? 'fits exactly' : fill.flex < 0.5 ? 'joints give a little' : 'joints flex near their limit');
      const note = document.createElement('small');
      note.textContent = notes.join(' · ');
      b.append(name, parts, note);
      b.addEventListener('click', () => this.showFill(i));
      list.append(b);
    });
    const actions = document.createElement('div');
    actions.className = 'fill-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'action compact primary';
    use.textContent = 'Use this';
    use.disabled = !f.options.length;
    use.addEventListener('click', () => this.applyFill());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'action compact';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancelFill());
    actions.append(use, cancel);
    panel.replaceChildren(head, list, actions);
  }

  undo(): void {
    this.filling = null;
    this.endGenerate();
    this.history.undo();
    this.selection = this.validSelection();
    this.refresh();
  }

  redo(): void {
    this.filling = null;
    this.endGenerate();
    this.history.redo();
    this.selection = this.validSelection();
    this.refresh();
  }

  /** Drop parts of the selection that no longer exist after undo or redo. */
  private validSelection(): Selection {
    const exists = new Set(this.layout.pieces.map((p) => p.uid));
    const s = this.selection;
    if (s.kind === 'end') {
      const stillOpen = openEnds(this.layout).some((e) => e.uid === s.end.uid && e.connectorId === s.end.connectorId);
      return stillOpen ? s : NONE;
    }
    if (s.kind === 'pieces') {
      const uids = new Set([...s.uids].filter((u) => exists.has(u)));
      return uids.size ? { kind: 'pieces', uids } : NONE;
    }
    return s;
  }

  // ---- pointer -----------------------------------------------------------

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.dom.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** What's under the pointer: an open-end marker, or a piece. */
  private hit(e: PointerEvent | MouseEvent): { end: EndRef } | { uid: string } | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const [markers, pieces] = this.view.pickables;
    // Objects added since the last frame have no world matrix yet.
    this.view.root.updateMatrixWorld();
    const m = this.raycaster.intersectObject(markers, true).find((i) => i.object.userData.end);
    if (m) return { end: m.object.userData.end as EndRef };
    const p = this.raycaster.intersectObject(pieces, true)[0];
    if (p) return { uid: p.object.userData.uid as string };
    return null;
  }

  /** Plan coordinates of the point under the pointer on the floor, or on a level `height` mm up. */
  private floorPoint(e: { clientX: number; clientY: number }, height = 0): Vec2 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.ground.constant = -height;
    const point = this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    return point ? { x: point.x, y: -point.z } : null;
  }

  private pressStart: Vec2 | null = null;

  /** Whether the pointer is over the 3D view itself, not the palette or a panel on top. */
  private overFloor(e: PointerEvent): boolean {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    return under instanceof HTMLCanvasElement && this.dom.canvas.contains(under);
  }

  private startPaletteDrag(shape: Shape, e: PointerEvent): void {
    if (this.drag || this.paletteDrag) return;
    this.paletteDrag = { pointerId: e.pointerId, shape, drop: null };
    document.body.classList.add('dragging-piece');
    this.movePaletteDrag(e);
  }

  private movePaletteDrag(e: PointerEvent): void {
    const drag = this.paletteDrag!;
    const at = this.overFloor(e) ? this.floorPoint(e) : null;
    drag.drop = at && this.dropAt(drag.shape, at);
    this.refresh();
  }

  private endPaletteDrag(e: PointerEvent): void {
    const drag = this.paletteDrag!;
    this.paletteDrag = null;
    document.body.classList.remove('dragging-piece');
    // Let go over the palette or a panel, or cancelled: put it back.
    const at = e.type === 'pointerup' && this.overFloor(e) ? this.floorPoint(e) : null;
    const drop = at && this.dropAt(drag.shape, at);
    if (drop) this.commit(drop.layout, drop.after);
    else this.refresh();
  }

  private pointerDown(e: PointerEvent): void {
    // Presses on the toolbar or a panel over the view aren't the floor's;
    // without this, the release cleared the selection before a toolbar
    // button's click could act on it.
    if (e.button !== 0 || !this.overFloor(e)) return;
    this.pressStart = { x: e.clientX, y: e.clientY };
    const hit = this.hit(e);
    const adding = e.shiftKey || e.ctrlKey || e.metaKey || this.multi;
    if (!hit) {
      // Shift-drag on the floor, or any drag in select mode, draws a box to select with.
      if ((e.shiftKey || this.multi) && !this.filling && !this.drag && !this.box) {
        this.controls.enabled = false;
        const s = this.selection;
        this.box = { pointerId: e.pointerId, from: this.pressStart, to: this.pressStart, base: s.kind === 'pieces' ? s.uids : new Set() };
      }
      return;
    }
    // Pressing track or an end belongs to the editor, not the camera.
    this.controls.enabled = false;
    if (this.filling) {
      if ('end' in hit) this.fillTo(hit.end);
      return;
    }
    if (this.generating) {
      // Tapping an open end builds the section on from there instead, or finishes it there when picking where.
      const g = this.generating;
      if (g.mode === 'connect') return;
      if ('end' in hit && !g.busy) {
        if (g.pickingEnd) {
          if (g.start && sameEnd(g.start, hit.end)) {
            this.flash('Pick a different end from the one it starts at.');
            return;
          }
          Object.assign(g, { goal: hit.end, toEnd: true, pickingEnd: false });
        } else {
          // Starting where it was to finish leaves nowhere to finish.
          if (g.goal && sameEnd(g.goal, hit.end)) Object.assign(g, { goal: null, toEnd: false });
          Object.assign(g, { start: hit.end, fromEnd: true });
        }
        this.regenerate();
      }
      return;
    }
    if ('end' in hit) {
      this.selection = { kind: 'end', end: hit.end };
      this.refresh();
      return;
    }
    // Raised track is dragged across its own level, so it stays under the pointer.
    const height = baseOf(findPiece(this.layout, hit.uid));
    const grab = this.floorPoint(e, height);
    if (!grab) return;
    const s = this.selection;
    // Pressing a selected piece drags the whole selection. Shift (or select
    // mode) adds the piece to what's selected, and a tap takes it back out.
    const uids =
      s.kind === 'pieces' && s.uids.has(hit.uid)
        ? s.uids
        : adding && s.kind === 'pieces'
          ? new Set([...s.uids, hit.uid])
          : new Set([hit.uid]);
    this.drag = {
      pointerId: e.pointerId,
      uids,
      start: this.layout,
      context: dragContext(this.layout, uids),
      grab,
      screen: { x: e.clientX, y: e.clientY },
      active: false,
      transform: IDENTITY,
      snap: null,
      height,
      flex: flexContext(this.layout, uids, grab),
      flexed: null,
      toggles: adding ? hit.uid : null,
      seated: false,
      dz: 0,
    };
  }

  private pointerMove(e: PointerEvent): void {
    if (this.paletteDrag?.pointerId === e.pointerId) {
      this.movePaletteDrag(e);
      return;
    }
    if (this.box?.pointerId === e.pointerId) {
      this.moveBox(e);
      return;
    }
    if (!this.drag && !this.paletteDrag) this.pointerAt = this.overFloor(e) ? this.floorPoint(e) : null;
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.screen.x, e.clientY - drag.screen.y) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      this.selection = { kind: 'pieces', uids: drag.uids };
    }
    const at = this.floorPoint(e, drag.height);
    if (!at) return;
    // Joined track flexes within its joint play; pulled well past that,
    // the pieces unclip and move freely.
    drag.flexed = drag.flex && flexDrag(drag.flex, at);
    const moved: Pose = { x: at.x - drag.grab.x, y: at.y - drag.grab.y, angle: 0 };
    drag.snap = drag.flexed ? null : findSnap(drag.context, moved);
    const seat = !drag.flexed && !drag.snap && drag.uids.size === 1 ? findSeat(drag.start, [...drag.uids][0], moved) : null;
    drag.seated = seat !== null;
    drag.transform = drag.snap?.transform ?? seat?.transform ?? moved;
    drag.dz = drag.snap?.dz ?? seat?.dz ?? 0;
    this.refresh();
  }

  private pointerUp(e: PointerEvent): void {
    if (this.paletteDrag?.pointerId === e.pointerId) {
      this.endPaletteDrag(e);
      return;
    }
    if (this.box?.pointerId === e.pointerId) {
      this.pressStart = null;
      this.endBox(e);
      return;
    }
    const drag = this.drag;
    const press = this.pressStart;
    this.pressStart = null;
    this.controls.enabled = true;
    if (drag && e.pointerId === drag.pointerId) {
      this.drag = null;
      if (drag.active) {
        this.commit(this.dragged(drag), { kind: 'pieces', uids: drag.uids });
      } else if (drag.toggles) {
        this.toggle(drag.toggles);
      } else {
        // A click on a piece selects it.
        this.selection = { kind: 'pieces', uids: drag.uids };
        this.refresh();
      }
      return;
    }
    // A click (not a camera drag) on empty floor clears the selection.
    if (press && e.button === 0 && !this.multi && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX && !this.hit(e)) {
      this.selection = NONE;
      this.refresh();
    }
  }

  private doubleClick(e: MouseEvent): void {
    const hit = this.hit(e);
    if (hit && 'uid' in hit) {
      this.selection = { kind: 'pieces', uids: sectionOf(this.layout, hit.uid) };
      this.refresh();
    }
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.shiftKey ? this.redo() : this.undo();
    } else if (mod && k === 'y') {
      this.redo();
    } else if (mod && k === 'c') {
      this.copy();
    } else if (mod && k === 'x') {
      this.cut();
    } else if (mod && k === 'v') {
      this.paste(true);
    } else if (mod && k === 'd') {
      this.duplicate();
    } else if (mod && k === 'a') {
      this.selectAll();
    } else if (mod) {
      return;
    } else if (k === 'r') {
      this.rotate(e.shiftKey ? -1 : 1);
    } else if (k === 'f') {
      this.flip();
    } else if (k === 's') {
      this.swap();
    } else if (k === 'b') {
      this.bend(e.shiftKey ? -1 : 1);
    } else if (k === 'u') {
      this.raise(1);
    } else if (k === 'd') {
      this.raise(-1);
    } else if (k === 'a') {
      this.selectSection();
    } else if (k === 't') {
      this.palette.setHand(this.palette.hand === 'left' ? 'right' : 'left');
    } else if (k === 'v') {
      this.dom.onFit();
    } else if (k === 'delete' || k === 'backspace') {
      this.remove();
    } else if (k === 'g') {
      this.startFill();
    } else if (k === 'n') {
      this.startGenerate();
    } else if (this.generating && k === 'enter') {
      this.applyGenerate();
    } else if (k === 'escape' && this.generating?.pickingEnd) {
      this.generating.pickingEnd = false;
      this.renderGenerate();
      this.refresh();
    } else if (k === 'escape' && this.generating) {
      this.cancelGenerate();
    } else if (this.filling?.options.length && k === 'enter') {
      this.applyFill();
    } else if (this.filling?.options.length && (k === 'arrowdown' || k === 'arrowright')) {
      this.showFill(this.filling.index + 1);
    } else if (this.filling?.options.length && (k === 'arrowup' || k === 'arrowleft')) {
      this.showFill(this.filling.index - 1);
    } else if (k === 'e') {
      this.toggleSelectMode();
    } else if (k === 'escape' && this.filling) {
      this.cancelFill();
    } else if (k === 'escape') {
      this.multi = false;
      this.selection = NONE;
      this.refresh();
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- helpers -----------------------------------------------------------

  private genderOf(end: EndRef): Gender | null {
    return openEnds(this.layout).find((e) => e.uid === end.uid && e.connectorId === end.connectorId)?.connector.gender ?? null;
  }

  /** A spot near the middle of the view that no piece is sitting on. */
  private freeSpot(): Vec2 {
    const base = { x: this.controls.target.x, y: -this.controls.target.z };
    const taken = this.layout.pieces.flatMap(anchorPoints);
    for (let ring = 0; ring < 20; ring++) {
      for (let i = 0; i < Math.max(1, ring * 6); i++) {
        const a = (i / Math.max(1, ring * 6)) * Math.PI * 2;
        const spot = { x: base.x + ring * 260 * Math.cos(a), y: base.y + ring * 260 * Math.sin(a) };
        if (taken.every((t) => Math.hypot(t.x - spot.x, t.y - spot.y) > 250)) return spot;
      }
    }
    return base;
  }

  private flashTimer = 0;
  private flashText = '';

  /** Show a message in the status bar for a few seconds. */
  flash(text: string): void {
    this.flashText = text;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashText = '';
      this.refresh();
    }, 3000);
    this.refresh();
  }

  private notified: Layout | null = null;

  private refresh(): void {
    const drag = this.drag?.active ? this.drag : null;
    const drop = this.paletteDrag?.drop ?? null;
    const filling = this.filling;
    const generated = this.generating?.mode === 'connect' ? this.generating.connections : this.generating?.section ?? null;
    const preview = filling?.options[filling.index] ?? generated;
    const layout = drop ? drop.layout : drag ? this.dragged(drag) : (preview?.layout ?? this.layout);
    const joints = findJoints(layout);
    const open = openEnds(layout, joints);
    const s = this.selection;
    const endAt = (end: EndRef) => {
      const c = worldEnd(layout, end).connector;
      return { ...c.pose, z: c.z };
    };
    const snapAt = drop
      ? drop.joins && endAt(drop.joins)
      : drag?.snap
        ? this.snapPoint(drag)
        : drag?.flexed?.closed
          ? endAt(drag.flexed.closed.b)
          : null;
    this.view.update({
      layout,
      openEnds: open,
      selectedPieces: drop ? new Set([drop.uid]) : preview ? new Set(preview.uids) : s.kind === 'pieces' ? s.uids : new Set(),
      selectedEnd: drop || preview ? null : filling ? filling.from : s.kind === 'end' ? s.end : null,
      snapAt,
      marks: this.generating?.mode === 'connect' && !this.generating.busy
        ? (this.generating.connections?.remaining ?? []).map((end) => {
            const c = worldEnd(layout, end).connector;
            return { at: c.pose, z: c.z, focused: false };
          })
        : drag || drop || filling || this.generating ? [] : this.marks,
    });
    if (this.layout !== this.notified) {
      this.notified = this.layout;
      this.dom.onChange?.(this.layout);
    }

    const end = s.kind === 'end' ? s.end : null;
    const target = end && this.genderOf(end);
    // Loose scenery can always be put down; it never joins the selected end.
    this.palette.setEnabled(
      (shape) => !end || isLoose(shape) || canExtend(this.layout, end, variantFor(shape, this.palette.ends, target)),
    );
    this.dom.empty.hidden = layout.pieces.length > 0;

    const has = this.targets().size > 0;
    const b = this.dom.buttons;
    b.undo.disabled = !this.history.canUndo;
    b.redo.disabled = !this.history.canRedo;
    for (const button of [b.rotateLeft, b.rotateRight, b.flip, b.raise, b.lower, b.section, b.copy, b.duplicate, b.remove]) button.disabled = !has;
    b.paste.disabled = !this.clip;
    b.select.setAttribute('aria-pressed', String(this.multi));
    b.swap.disabled = this.targets().size !== 1;
    b.bend.hidden = !this.selectedBendy();
    b.fit.disabled = layout.pieces.length === 0;
    b.fill.disabled = !filling && (s.kind !== 'end' || open.length < 2);
    b.fill.setAttribute('aria-pressed', String(!!filling));
    b.generate.setAttribute('aria-pressed', String(!!this.generating));
    this.renderFillPanel();

    const [hint, counts] = this.flashText ? [this.flashText, ''] : this.describe(layout, open.length, joints.length);
    const hintEl = document.createElement('span');
    hintEl.textContent = hint;
    const countsEl = document.createElement('span');
    countsEl.className = 'counts';
    countsEl.textContent = counts;
    this.dom.status.replaceChildren(hintEl, countsEl);
    this.dom.status.classList.toggle('flash', !!this.flashText);
    this.dom.status.hidden = !hint;
  }

  /** The layout as the drag has it now: flexed, or with the pieces moved. */
  private dragged(drag: Drag): Layout {
    return drag.flexed?.layout ?? transformPieces(drag.start, drag.uids, drag.transform, drag.dz);
  }

  private snapPoint(drag: Drag): Vec2 & { z?: number } {
    const fixed = drag.context.fixedEnds.find((e) => e.uid === drag.snap!.fixed.uid && e.connectorId === drag.snap!.fixed.connectorId)!;
    return { ...fixed.connector.pose, z: fixed.connector.z };
  }

  /** A hint for what to do next, and the layout's counts. */
  private describe(layout: Layout, open: number, joints: number): [string, string] {
    const s = this.selection;
    const counts = layout.pieces.length
      ? [plural(layout.pieces.length, 'piece'), plural(joints, 'joint'), plural(open, 'open end')].join(' · ')
      : '';
    if (this.paletteDrag) {
      const drop = this.paletteDrag.drop;
      if (!drop) return ['Drag it onto the floor, or near an open end to join it on.', counts];
      return [drop.joins ? 'Let go to join.' : 'Let go to put it down, or bring it near an open end.', counts];
    }
    const drag = this.drag?.active ? this.drag : null;
    if (drag?.flexed) {
      if (drag.flexed.closed) return ['The joints give enough to close it: let go to join.', counts];
      const stuck = drag.flexed.atLimit.length;
      return [stuck ? `Flexing: ${plural(stuck, 'joint')} at the limit. Pull harder to unclip.` : 'Flexing the joints.', counts];
    }
    if (this.generating?.pickingEnd) return ['Tap the open end the new section should finish at. Esc to go back.', counts];
    if (this.generating?.mode === 'connect') return [this.generating.busy ? 'Finding paths between open ends… Esc to cancel.' : 'Review the paths, then Use connections. Esc to cancel.', counts];
    if (this.generating) return ['Pick settings for the new section, then Use this. Tap an open end to build on from it. Esc to stop.', counts];
    if (this.filling) {
      if (this.filling.searching && !this.filling.options.length) return ['Looking for a run of track to join those ends…', counts];
      if (!this.filling.options.length) return ['Now tap the open end to join it to. Esc to stop.', counts];
      return ['Pick a way to fill the gap, then Use this. Esc to stop.', counts];
    }
    if (this.box) return [s.kind === 'pieces' ? `${plural(s.uids.size, 'piece')} in the box.` : 'Drag round the pieces to select.', counts];
    if (drag?.seated) return ['Lined up over the track: let go to place it.', counts];
    if (drag) return [drag.snap ? 'Let go to join.' : 'Drag near an open end to snap on.', counts];
    if (s.kind === 'end') {
      const what = this.genderOf(s.end) === 'peg' ? 'peg' : 'hole';
      return [`Building from this ${what}: tap a piece to add it, or Fill gap to join it to another end.`, counts];
    }
    if (s.kind === 'pieces') {
      const more = this.multi ? 'tap more to add them, or drag them to move' : 'drag to move, or use the toolbar';
      return [`${plural(s.uids.size, 'piece')} selected: ${more}.`, counts];
    }
    if (this.multi) return ['Select mode: tap pieces, or drag a box round them.', counts];
    if (!layout.pieces.length) return ['', ''];
    return ['Tap a dot on an open end to build from it.', counts];
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function loadClip(): Clip | null {
  try {
    const clip = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null') as Clip | null;
    // Pieces the catalog no longer has can't be pasted.
    clip?.pieces.forEach((p) => getPiece(p.pieceId));
    return clip?.pieces.length ? clip : null;
  } catch {
    return null;
  }
}

function saveClip(clip: Clip): void {
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(clip));
  } catch {
    // Private windows can refuse storage; the copy still works until reload.
  }
}
