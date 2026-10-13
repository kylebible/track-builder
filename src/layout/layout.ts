import { canMate, DEFAULT_PLAY, jointError, placeConnectorAt, placeToMate, worldConnector, type Play } from '../geometry/joint';
import { applyPose, invertPose, normalizeAngle, rotationAbout, type Pose, type Vec2 } from '../geometry/pose';
import { getPiece, mirrorPiece } from '../pieces/catalog';
import type { Connector, PieceDef } from '../pieces/types';

// A layout is plain, immutable data: which catalog pieces sit where. Joints
// are never stored; two ends are joined whenever they mate within the joint
// play, exactly as on the floor. Every edit returns a new layout, which keeps
// undo trivial.

export interface PlacedPiece {
  uid: string;
  pieceId: string;
  /** Turned over, so left-hand pieces turn right. */
  flipped: boolean;
  /** Where the piece's own frame sits in the plan. */
  pose: Pose;
}

export interface Layout {
  pieces: readonly PlacedPiece[];
}

export const EMPTY_LAYOUT: Layout = { pieces: [] };

/** One end of one placed piece. */
export interface EndRef {
  uid: string;
  connectorId: string;
}

/** An end with its connector in world coordinates. */
export interface WorldEnd extends EndRef {
  connector: Connector;
}

export interface Joint {
  a: EndRef;
  b: EndRef;
}

const flippedDefs = new Map<string, PieceDef>();

/** The piece's shape as placed: the catalog piece, turned over if flipped. */
export function defOf(piece: Pick<PlacedPiece, 'pieceId' | 'flipped'>): PieceDef {
  const base = getPiece(piece.pieceId);
  if (!piece.flipped) return base;
  let def = flippedDefs.get(base.id);
  if (!def) flippedDefs.set(base.id, (def = mirrorPiece(base)));
  return def;
}

export function findPiece(layout: Layout, uid: string): PlacedPiece {
  const p = layout.pieces.find((q) => q.uid === uid);
  if (!p) throw new Error(`No piece ${uid}`);
  return p;
}

export function worldEnds(piece: PlacedPiece, placement: Pose = piece.pose): WorldEnd[] {
  return defOf(piece).connectors.map((c) => ({
    uid: piece.uid,
    connectorId: c.id,
    connector: worldConnector(placement, c),
  }));
}

export function worldEnd(layout: Layout, end: EndRef): WorldEnd {
  const found = worldEnds(findPiece(layout, end.uid)).find((e) => e.connectorId === end.connectorId);
  if (!found) throw new Error(`No end ${end.uid}:${end.connectorId}`);
  return found;
}

export const sameEnd = (a: EndRef, b: EndRef): boolean => a.uid === b.uid && a.connectorId === b.connectorId;
const endKey = (e: EndRef): string => `${e.uid}:${e.connectorId}`;

/**
 * Every pair of ends that mate within play. Each end joins at most one
 * other: when several candidates are in range, the closest wins.
 */
export function findJoints(layout: Layout, play: Play = DEFAULT_PLAY): Joint[] {
  const ends = layout.pieces.flatMap((p) => worldEnds(p));
  const candidates: { a: WorldEnd; b: WorldEnd; gap: number }[] = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i];
      const b = ends[j];
      if (a.uid === b.uid) continue;
      if (canMate(a.connector, b.connector, play)) {
        candidates.push({ a, b, gap: jointError(a.connector.pose, b.connector.pose).gapMm });
      }
    }
  }
  candidates.sort((x, y) => x.gap - y.gap);
  const used = new Set<string>();
  const joints: Joint[] = [];
  for (const { a, b } of candidates) {
    if (used.has(endKey(a)) || used.has(endKey(b))) continue;
    used.add(endKey(a));
    used.add(endKey(b));
    joints.push({ a: { uid: a.uid, connectorId: a.connectorId }, b: { uid: b.uid, connectorId: b.connectorId } });
  }
  return joints;
}

/** Ends not joined to anything. */
export function openEnds(layout: Layout, joints: Joint[] = findJoints(layout)): WorldEnd[] {
  const joined = new Set(joints.flatMap((j) => [endKey(j.a), endKey(j.b)]));
  return layout.pieces.flatMap((p) => worldEnds(p)).filter((e) => !joined.has(endKey(e)));
}

/** The end joined to `end`, if any. */
export function partnerOf(joints: Joint[], end: EndRef): EndRef | null {
  for (const j of joints) {
    if (sameEnd(j.a, end)) return j.b;
    if (sameEnd(j.b, end)) return j.a;
  }
  return null;
}

/** Every piece reachable from `uid` through joints: the whole connected section. */
export function sectionOf(layout: Layout, uid: string, joints: Joint[] = findJoints(layout)): Set<string> {
  const section = new Set([uid]);
  const queue = [uid];
  while (queue.length) {
    const current = queue.pop()!;
    for (const j of joints) {
      for (const [from, to] of [
        [j.a, j.b],
        [j.b, j.a],
      ]) {
        if (from.uid === current && !section.has(to.uid)) {
          section.add(to.uid);
          queue.push(to.uid);
        }
      }
    }
  }
  return section;
}

function nextUid(layout: Layout): string {
  const max = layout.pieces.reduce((m, p) => Math.max(m, Number(p.uid.slice(1)) || 0), 0);
  return `p${max + 1}`;
}

export function addPiece(layout: Layout, pieceId: string, pose: Pose, flipped = false): { layout: Layout; uid: string } {
  const uid = nextUid(layout);
  return { layout: { pieces: [...layout.pieces, { uid, pieceId, flipped, pose }] }, uid };
}

/** Connectors of `def` that could mate with an end of the given gender, in catalog order. */
function compatible(def: PieceDef, with_: Connector): Connector[] {
  return def.connectors.filter((c) => c.gender !== with_.gender);
}

/** Whether `pieceId` can be added onto the end `end` (it has an end of the opposite gender). */
export function canExtend(layout: Layout, end: EndRef, pieceId: string): boolean {
  return compatible(getPiece(pieceId), worldEnd(layout, end).connector).length > 0;
}

export interface Extension {
  layout: Layout;
  uid: string;
  /** The new piece's end that went onto the old one. */
  attached: string;
  /** The new piece's first end left open, to keep building from. */
  next: EndRef | null;
}

/**
 * Add a piece onto an open end, peg into hole, aligned exactly. The new
 * piece attaches by its first end of the opposite gender (`connectorId`
 * picks another). Returns null if the piece has no end that fits.
 */
export function extendFrom(
  layout: Layout,
  end: EndRef,
  pieceId: string,
  flipped = false,
  connectorId?: string,
): Extension | null {
  const target = worldEnd(layout, end).connector;
  const def = defOf({ pieceId, flipped });
  const options = compatible(def, target);
  const attach = connectorId ? options.find((c) => c.id === connectorId) : options[0];
  if (!attach) return null;
  const added = addPiece(layout, pieceId, placeToMate(target.pose, def, attach.id), flipped);
  return { ...added, attached: attach.id, next: firstOpenEnd(added.layout, added.uid) };
}

export function firstOpenEnd(layout: Layout, uid: string): EndRef | null {
  const open = openEnds(layout).find((e) => e.uid === uid);
  return open ? { uid: open.uid, connectorId: open.connectorId } : null;
}

/** Apply a rigid transform to some pieces. */
export function transformPieces(layout: Layout, uids: ReadonlySet<string>, transform: Pose): Layout {
  return {
    pieces: layout.pieces.map((p) => (uids.has(p.uid) ? { ...p, pose: applyPose(transform, p.pose) } : p)),
  };
}

/** The middle of a group of pieces' ends, used as a rotation pivot. */
export function centerOf(layout: Layout, uids: ReadonlySet<string>): Vec2 {
  const points = layout.pieces.filter((p) => uids.has(p.uid)).flatMap((p) => worldEnds(p).map((e) => e.connector.pose));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** Turn some pieces about a pivot, by default the middle of their ends. */
export function rotatePieces(layout: Layout, uids: ReadonlySet<string>, angle: number, pivot?: Vec2): Layout {
  return transformPieces(layout, uids, rotationAbout(pivot ?? centerOf(layout, uids), angle));
}

/**
 * Turn a piece over, so a left curve becomes a right curve. The end it is
 * joined by stays put (or its first end, if it is loose), so a piece just
 * added flips in place on the track.
 */
export function flipPiece(layout: Layout, uid: string): Layout {
  const piece = findPiece(layout, uid);
  const joints = findJoints(layout);
  const ends = worldEnds(piece);
  const anchor = ends.find((e) => partnerOf(joints, e)) ?? ends[0];
  const flipped = { ...piece, flipped: !piece.flipped };
  const pose = placeConnectorAt(anchor.connector.pose, defOf(flipped), anchor.connectorId);
  return { pieces: layout.pieces.map((p) => (p.uid === uid ? { ...flipped, pose } : p)) };
}

/**
 * Turn a group of pieces over together, mirroring the group across the
 * line through its middle that runs along x. Joints inside the group stay
 * joined.
 */
export function mirrorPieces(layout: Layout, uids: ReadonlySet<string>): Layout {
  const { y } = centerOf(layout, uids);
  return {
    pieces: layout.pieces.map((p) =>
      uids.has(p.uid)
        ? { ...p, flipped: !p.flipped, pose: { x: p.pose.x, y: 2 * y - p.pose.y, angle: normalizeAngle(-p.pose.angle) } }
        : p,
    ),
  };
}

/**
 * For a piece joined by exactly one end, attach it by its next end that
 * fits instead (a switch by a branch rather than its trunk, or a straight
 * turned end for end). Null when there is no other way round.
 */
export function swapEnd(layout: Layout, uid: string): Layout | null {
  const piece = findPiece(layout, uid);
  const joints = findJoints(layout);
  const joined = worldEnds(piece).filter((e) => partnerOf(joints, e));
  if (joined.length !== 1) return null;
  const partner = worldEnd(layout, partnerOf(joints, joined[0])!);
  const def = defOf(piece);
  const options = compatible(def, partner.connector);
  if (options.length < 2) return null;
  const index = options.findIndex((c) => c.id === joined[0].connectorId);
  const next = options[(index + 1) % options.length];
  const pose = placeToMate(partner.connector.pose, def, next.id);
  return { pieces: layout.pieces.map((p) => (p.uid === uid ? { ...p, pose } : p)) };
}

export function removePieces(layout: Layout, uids: ReadonlySet<string>): Layout {
  return { pieces: layout.pieces.filter((p) => !uids.has(p.uid)) };
}

/** How close an end has to be dragged to another before it snaps on. */
export interface SnapRange {
  mm: number;
  deg: number;
}

export const DEFAULT_SNAP_RANGE: SnapRange = { mm: 30, deg: 25 };

/**
 * Everything needed to snap a group of pieces while it is dragged:
 * the group's ends that face outward, and the rest of the layout's free ends.
 */
export interface DragContext {
  moving: ReadonlySet<string>;
  movingEnds: WorldEnd[];
  fixedEnds: WorldEnd[];
}

export function dragContext(layout: Layout, moving: ReadonlySet<string>): DragContext {
  const joints = findJoints(layout);
  const inGroup = (e: EndRef) => moving.has(e.uid);
  const movingEnds: WorldEnd[] = [];
  const fixedEnds: WorldEnd[] = [];
  for (const piece of layout.pieces) {
    for (const end of worldEnds(piece)) {
      const partner = partnerOf(joints, end);
      if (inGroup(end)) {
        if (!partner || !inGroup(partner)) movingEnds.push(end);
      } else if (!partner || inGroup(partner)) {
        fixedEnds.push(end);
      }
    }
  }
  return { moving, movingEnds, fixedEnds };
}

export interface Snap {
  /** The corrected transform for the dragged group. */
  transform: Pose;
  moving: EndRef;
  fixed: EndRef;
}

/**
 * With the dragged group moved by `transform`, find the nearest peg-to-hole
 * pair within snap range and the transform that seats it exactly.
 */
export function findSnap(context: DragContext, transform: Pose, range: SnapRange = DEFAULT_SNAP_RANGE): Snap | null {
  let best: { snap: Snap; gap: number } | null = null;
  for (const m of context.movingEnds) {
    const moved = applyPose(transform, m.connector.pose);
    for (const f of context.fixedEnds) {
      if (f.connector.gender === m.connector.gender) continue;
      const error = jointError(moved, f.connector.pose);
      if (error.gapMm > range.mm || error.angleDeg > range.deg) continue;
      if (best && error.gapMm >= best.gap) continue;
      const seat: Pose = { ...f.connector.pose, angle: normalizeAngle(f.connector.pose.angle + Math.PI) };
      const correction = applyPose(seat, invertPose(moved));
      best = {
        gap: error.gapMm,
        snap: { transform: applyPose(correction, transform), moving: m, fixed: f },
      };
    }
  }
  return best?.snap ?? null;
}

/** Describe an end for messages: "Large curve, peg end". */
export function describeEnd(layout: Layout, end: EndRef): string {
  const e = worldEnd(layout, end);
  return `${getPiece(findPiece(layout, end.uid).pieceId).name}, ${e.connector.gender} end`;
}
