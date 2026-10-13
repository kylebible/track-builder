import * as THREE from 'three';
import { deg, IDENTITY, type Pose, type Vec2 } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import { History } from '../layout/history';
import {
  addPiece,
  canExtend,
  dragContext,
  EMPTY_LAYOUT,
  extendFrom,
  findJoints,
  findSnap,
  flipPiece,
  mirrorPieces,
  openEnds,
  partnerOf,
  removePieces,
  rotatePieces,
  sectionOf,
  swapEnd,
  transformPieces,
  worldEnds,
  type DragContext,
  type EndRef,
  type Layout,
  type Snap,
} from '../layout/layout';
import { Palette } from './palette';
import { LayoutView } from './view';

// Turns pointer, keyboard and toolbar input into layout edits. Every edit
// goes through `commit`, which records it for undo and redraws.

type Selection = { kind: 'none' } | { kind: 'end'; end: EndRef } | { kind: 'pieces'; uids: ReadonlySet<string> };

const NONE: Selection = { kind: 'none' };
/** Pointer travel, in pixels, before a press on a piece becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
const ROTATE_STEP = deg(45);

interface Drag {
  pointerId: number;
  uids: ReadonlySet<string>;
  start: Layout;
  context: DragContext;
  grab: Vec2;
  screen: Vec2;
  active: boolean;
  transform: Pose;
  snap: Snap | null;
}

export interface EditorDom {
  canvas: HTMLElement;
  palette: HTMLElement;
  status: HTMLElement;
  buttons: Record<'undo' | 'redo' | 'rotateLeft' | 'rotateRight' | 'flip' | 'swap' | 'section' | 'remove', HTMLButtonElement>;
}

export class Editor {
  private readonly history = new History(EMPTY_LAYOUT);
  private selection: Selection = NONE;
  private drag: Drag | null = null;
  /** Remember flips per piece, so a run of right-hand curves stays right-handed. */
  private readonly flipPreference = new Map<string, boolean>();
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
    this.view = new LayoutView(scene);
    this.palette = new Palette(dom.palette, (id) => this.pick(id));
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
    b.redo.onclick = () => this.redo();
    b.rotateLeft.onclick = () => this.rotate(1);
    b.rotateRight.onclick = () => this.rotate(-1);
    b.flip.onclick = () => this.flip();
    b.swap.onclick = () => this.swap();
    b.section.onclick = () => this.selectSection();
    b.remove.onclick = () => this.remove();
    this.refresh();
  }

  get layout(): Layout {
    return this.history.current;
  }

  // ---- edits -------------------------------------------------------------

  private commit(next: Layout | null, selection: Selection = this.selection): void {
    if (!next) return;
    this.history.push(next);
    this.selection = selection;
    this.refresh();
  }

  /** A palette tile was tapped: add onto the selected end, or drop the piece loose. */
  pick(pieceId: string): void {
    if (this.selection.kind === 'end') {
      const end = this.selection.end;
      if (!canExtend(this.layout, end, pieceId)) {
        this.flash(`A ${getPiece(pieceId).name.toLowerCase()} has no end that fits this ${this.genderOf(end)}.`);
        return;
      }
      const ext = extendFrom(this.layout, end, pieceId, this.flipPreference.get(pieceId) ?? false)!;
      this.commit(ext.layout, ext.next ? { kind: 'end', end: ext.next } : { kind: 'pieces', uids: new Set([ext.uid]) });
      return;
    }
    const spot = this.freeSpot();
    const { layout, uid } = addPiece(this.layout, pieceId, { ...spot, angle: 0 }, this.flipPreference.get(pieceId) ?? false);
    const ends = getPiece(pieceId).connectors;
    const next = ends[1] ?? ends[0];
    this.commit(layout, { kind: 'end', end: { uid, connectorId: next.id } });
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
      const next = flipPiece(this.layout, uid);
      const piece = next.pieces.find((p) => p.uid === uid)!;
      this.flipPreference.set(piece.pieceId, piece.flipped);
      this.commit(next);
    } else {
      this.commit(mirrorPieces(this.layout, uids));
    }
  }

  swap(): void {
    const uids = this.targets();
    if (uids.size !== 1) return;
    const [uid] = uids;
    const next = swapEnd(this.layout, uid);
    if (!next) {
      this.flash('This piece only fits one way round here.');
      return;
    }
    // Keep building from the new piece's open end.
    const open = openEnds(next).find((e) => e.uid === uid);
    this.commit(next, open ? { kind: 'end', end: open } : this.selection);
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

  undo(): void {
    this.history.undo();
    this.selection = this.validSelection();
    this.refresh();
  }

  redo(): void {
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
    const m = this.raycaster.intersectObject(markers, true)[0];
    if (m) return { end: m.object.userData.end as EndRef };
    const p = this.raycaster.intersectObject(pieces, true)[0];
    if (p) return { uid: p.object.userData.uid as string };
    return null;
  }

  /** Plan coordinates of the point on the floor under the pointer. */
  private floorPoint(e: { clientX: number; clientY: number }): Vec2 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const point = this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    return point ? { x: point.x, y: -point.z } : null;
  }

  private pressStart: Vec2 | null = null;

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.pressStart = { x: e.clientX, y: e.clientY };
    const hit = this.hit(e);
    if (!hit) return;
    // Pressing track or an end belongs to the editor, not the camera.
    this.controls.enabled = false;
    if ('end' in hit) {
      this.selection = { kind: 'end', end: hit.end };
      this.refresh();
      return;
    }
    const grab = this.floorPoint(e);
    if (!grab) return;
    const s = this.selection;
    const uids =
      s.kind === 'pieces' && s.uids.has(hit.uid)
        ? s.uids
        : e.shiftKey
          ? sectionOf(this.layout, hit.uid)
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
    };
  }

  private pointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.screen.x, e.clientY - drag.screen.y) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      this.selection = { kind: 'pieces', uids: drag.uids };
    }
    const at = this.floorPoint(e);
    if (!at) return;
    const moved: Pose = { x: at.x - drag.grab.x, y: at.y - drag.grab.y, angle: 0 };
    drag.snap = findSnap(drag.context, moved);
    drag.transform = drag.snap?.transform ?? moved;
    this.refresh();
  }

  private pointerUp(e: PointerEvent): void {
    const drag = this.drag;
    const press = this.pressStart;
    this.pressStart = null;
    this.controls.enabled = true;
    if (drag && e.pointerId === drag.pointerId) {
      this.drag = null;
      if (drag.active) {
        this.commit(transformPieces(drag.start, drag.uids, drag.transform), { kind: 'pieces', uids: drag.uids });
      } else {
        // A click on a piece selects it.
        this.selection = { kind: 'pieces', uids: drag.uids };
        this.refresh();
      }
      return;
    }
    // A click (not a camera drag) on empty floor clears the selection.
    if (press && e.button === 0 && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX && !this.hit(e)) {
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
    } else if (mod) {
      return;
    } else if (k === 'r') {
      this.rotate(e.shiftKey ? -1 : 1);
    } else if (k === 'f') {
      this.flip();
    } else if (k === 's') {
      this.swap();
    } else if (k === 'a') {
      this.selectSection();
    } else if (k === 'delete' || k === 'backspace') {
      this.remove();
    } else if (k === 'escape') {
      this.selection = NONE;
      this.refresh();
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- helpers -----------------------------------------------------------

  private genderOf(end: EndRef): string {
    return openEnds(this.layout).find((e) => e.uid === end.uid && e.connectorId === end.connectorId)?.connector.gender ?? 'end';
  }

  /** A spot near the middle of the view that no piece is sitting on. */
  private freeSpot(): Vec2 {
    const base = { x: this.controls.target.x, y: -this.controls.target.z };
    const taken = this.layout.pieces.flatMap((p) => worldEnds(p).map((e) => e.connector.pose));
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

  private flash(text: string): void {
    this.flashText = text;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashText = '';
      this.refresh();
    }, 3000);
    this.refresh();
  }

  private refresh(): void {
    const drag = this.drag?.active ? this.drag : null;
    const layout = drag ? transformPieces(drag.start, drag.uids, drag.transform) : this.layout;
    const joints = findJoints(layout);
    const open = openEnds(layout, joints);
    const s = this.selection;
    const snapAt = drag?.snap ? this.snapPoint(drag) : null;
    this.view.update({
      layout,
      openEnds: open,
      selectedPieces: s.kind === 'pieces' ? s.uids : new Set(),
      selectedEnd: s.kind === 'end' ? s.end : null,
      snapAt,
    });

    const end = s.kind === 'end' ? s.end : null;
    this.palette.setEnabled((id) => !end || canExtend(this.layout, end, id));

    const has = this.targets().size > 0;
    const b = this.dom.buttons;
    b.undo.disabled = !this.history.canUndo;
    b.redo.disabled = !this.history.canRedo;
    for (const button of [b.rotateLeft, b.rotateRight, b.flip, b.section, b.remove]) button.disabled = !has;
    b.swap.disabled = this.targets().size !== 1;

    this.dom.status.textContent = this.flashText || this.describe(layout, open.length, joints.length);
  }

  private snapPoint(drag: Drag): Vec2 {
    const fixed = drag.context.fixedEnds.find((e) => e.uid === drag.snap!.fixed.uid && e.connectorId === drag.snap!.fixed.connectorId)!;
    return fixed.connector.pose;
  }

  private describe(layout: Layout, open: number, joints: number): string {
    const s = this.selection;
    const count = `${layout.pieces.length} piece${layout.pieces.length === 1 ? '' : 's'}, ${joints} joint${joints === 1 ? '' : 's'}, ${open} open end${open === 1 ? '' : 's'}.`;
    if (this.drag?.active) return this.drag.snap ? 'Snapping on. Let go to join.' : 'Drag near an open end to snap on.';
    if (s.kind === 'end') return `${this.genderOf(s.end) === 'peg' ? 'Peg' : 'Hole'} end selected: tap a piece to add it. ${count}`;
    if (s.kind === 'pieces') return `${s.uids.size} selected: drag to move, or rotate, flip, delete. ${count}`;
    if (!layout.pieces.length) return 'Tap a piece in the palette to start.';
    return `Tap an open end to build from it. ${count}`;
  }
}
