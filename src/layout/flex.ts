import { DEFAULT_PLAY, jointError, type Play } from '../geometry/joint';
import { applyPose, distance, IDENTITY, normalizeAngle, rotationAbout, type Pose, type Vec2 } from '../geometry/pose';
import { DEFAULT_SNAP_RANGE, findJoints, openEnds, worldEnds, type EndRef, type Joint, type Layout, type SnapRange } from './layout';

// Dragging a piece that is joined into track flexes its joints, the way you
// nudge real wooden track: every joint can give a little (the joint play),
// the far end of the track stays put, and once the joints run out of play
// the piece stops. Pull much further and it unclips, like lifting it out.
//
// The track is treated as rigid bodies (the dragged pieces as one, every
// other piece on its own) linked by joints that may open up to the play.
// A small position-based solver pulls the grabbed point toward the pointer
// and then pushes every joint back inside its play.

/** How much a joint may give while flexing, as a share of the joint play. Kept under 1 so flexed joints still count as joined. */
const FLEX_SHARE = 0.9;
/** How snugly a loop closed by flexing is seated, as a share of the play. */
const CLOSE_SHARE = 0.3;
/** A joint flexed this close to its limit counts as at its limit. */
const LIMIT_SHARE = 0.85;
/** Pull the grabbed point this far past where the joints allow and the piece unclips. */
export const UNCLIP_MM = 25;

const PULL_ROUNDS = 60;
const PASSES_PER_ROUND = 4;
const SETTLE_PASSES = 150;
/** Each round, loose pieces creep this share of the way back to where they started, like friction on the floor. */
const FRICTION = 0.04;
const TOLERANCE = 1e-3;

interface Body {
  uids: string[];
  /** The body's movement so far, applied to its pieces' starting poses. */
  move: Pose;
  /** Middle of its ends at the start, the point it turns about. */
  center0: Vec2;
  invMass: number;
  invInertia: number;
  /** The track you grab and the far end that holds still. */
  role: 'dragged' | 'held' | 'loose';
}

interface Link {
  a: { body: number; pose: Pose };
  b: { body: number; pose: Pose };
  mm: number;
  rad: number;
  joint: Joint;
}

export interface FlexContext {
  start: Layout;
  dragged: ReadonlySet<string>;
  /** The point on the dragged track that follows the pointer, at the start. */
  grab: Vec2;
  play: Play;
  bodies: Body[];
  links: Link[];
  /** Open ends of the flexing track, and every other open end they could close onto. */
  open: { end: EndRef; body: number; pose: Pose; gender: string; z: number }[];
  others: { end: EndRef; body: number; pose: Pose; gender: string; z: number }[];
}

export interface FlexResult {
  layout: Layout;
  /** Joints flexed to their limit: these are what stop the drag. */
  atLimit: Joint[];
  /** A joint the flex closed, such as the last gap in a loop. */
  closed: Joint | null;
}

/**
 * Set up flexing for dragging `dragged` by the point `grab`. Null when the
 * dragged pieces aren't joined to any other track, so there is nothing to
 * flex and they just move.
 */
export function flexContext(layout: Layout, dragged: ReadonlySet<string>, grab: Vec2, play: Play = DEFAULT_PLAY): FlexContext | null {
  const joints = findJoints(layout, play);
  const bodyOf = new Map<string, number>();
  const bodies: Body[] = [];
  const addBody = (uids: string[], role: Body['role']): number => {
    const points = layout.pieces.filter((p) => uids.includes(p.uid)).flatMap((p) => worldEnds(p).map((e) => e.connector.pose));
    const center0 = { x: avg(points.map((p) => p.x)), y: avg(points.map((p) => p.y)) };
    const reach = Math.max(20, ...points.map((p) => distance(p, center0)));
    bodies.push({ uids, move: IDENTITY, center0, invMass: 1, invInertia: 1 / (reach * reach), role });
    for (const uid of uids) bodyOf.set(uid, bodies.length - 1);
    return bodies.length - 1;
  };
  addBody([...dragged], 'dragged');

  // Walk out along joints from the dragged track, noting how far each piece is.
  const depth = new Map<number, number>([[0, 0]]);
  const queue = [0];
  while (queue.length) {
    const current = queue.shift()!;
    for (const j of joints) {
      for (const [from, to] of [
        [j.a, j.b],
        [j.b, j.a],
      ]) {
        if (bodyOf.get(from.uid) !== current || bodyOf.has(to.uid)) continue;
        const next = addBody([to.uid], 'loose');
        depth.set(next, depth.get(current)! + 1);
        queue.push(next);
      }
    }
  }
  if (bodies.length === 1) return null;

  // The piece furthest along the track from the one you grab stays put.
  let far = 1;
  for (const [body, d] of depth) if (d > depth.get(far)!) far = body;
  hold(bodies[far]);

  const endPose = (end: EndRef): Pose => worldEnds(layout.pieces.find((p) => p.uid === end.uid)!).find((e) => e.connectorId === end.connectorId)!.connector.pose;
  const links: Link[] = [];
  for (const joint of joints) {
    const a = bodyOf.get(joint.a.uid);
    const b = bodyOf.get(joint.b.uid);
    if (a === undefined || b === undefined || a === b) continue;
    const pa = endPose(joint.a);
    const pb = endPose(joint.b);
    const error = jointError(pa, pb);
    // Never tighten a joint that already sits further out than the flex allows.
    links.push({
      a: { body: a, pose: pa },
      b: { body: b, pose: pb },
      mm: Math.max(play.mm * FLEX_SHARE, error.gapMm),
      rad: (Math.max(play.deg * FLEX_SHARE, error.angleDeg) * Math.PI) / 180,
      joint,
    });
  }

  const open: FlexContext['open'] = [];
  const others: FlexContext['others'] = [];
  let world = -1;
  for (const e of openEnds(layout, joints)) {
    const end = { uid: e.uid, connectorId: e.connectorId };
    const entry = { end, pose: e.connector.pose, gender: e.connector.gender, z: e.connector.z ?? 0 };
    const body = bodyOf.get(e.uid);
    if (body !== undefined) {
      open.push({ ...entry, body });
    } else {
      // Track elsewhere in the layout doesn't flex: it acts as the floor.
      if (world < 0) {
        world = bodies.length;
        bodies.push({ uids: [], move: IDENTITY, center0: { x: 0, y: 0 }, invMass: 0, invInertia: 0, role: 'held' });
      }
      others.push({ ...entry, body: world });
    }
  }
  others.push(...open);

  return { start: layout, dragged, grab, play, bodies, links, open, others };
}

/**
 * Flex the track so the grabbed point gets as close to `target` as the
 * joints allow. If that leaves an open end within snap range of another,
 * the flex tries to close that joint too, as when a loop that nearly meets
 * is nudged shut. Null when the target is so far past the joints' limit
 * that the dragged pieces unclip.
 */
export function flexDrag(context: FlexContext, target: Vec2, range: SnapRange = DEFAULT_SNAP_RANGE): FlexResult | null {
  const bodies = solve(context, target, null);
  const reached = applyPose(bodies[0].move, { ...context.grab, angle: 0 });
  if (distance(reached, target) > UNCLIP_MM) return null;

  const closing = nearestClosure(context, bodies, range);
  if (closing) {
    const closedBodies = solve(context, target, closing);
    if (satisfied(context, closedBodies, closing)) return result(context, closedBodies, closing);
  }
  return result(context, bodies, null);
}

// ---- solver ---------------------------------------------------------------

function solve(context: FlexContext, target: Vec2, closing: Link | null): Body[] {
  const bodies = context.bodies.map((b) => ({ ...b }));
  const links = closing ? [...context.links, closing] : context.links;
  const dragged = bodies[0];
  for (let round = 0; round < PULL_ROUNDS; round++) {
    pullPoint(dragged, context.grab, target);
    for (const body of bodies) if (body.role === 'loose') creepBack(body, FRICTION);
    for (let pass = 0; pass < PASSES_PER_ROUND; pass++) for (const link of links) enforce(bodies, link);
  }
  for (let pass = 0; pass < SETTLE_PASSES; pass++) for (const link of links) enforce(bodies, link);
  return bodies;
}

function satisfied(context: FlexContext, bodies: Body[], closing: Link): boolean {
  return [...context.links, closing].every((link) => {
    const e = jointError(endNow(bodies, link.a), endNow(bodies, link.b));
    return e.gapMm <= link.mm + TOLERANCE && e.angleDeg <= (link.rad * 180) / Math.PI + TOLERANCE;
  });
}

function nearestClosure(context: FlexContext, bodies: Body[], range: SnapRange): Link | null {
  let best: { link: Link; gap: number } | null = null;
  for (const m of context.open) {
    const mp = endNow(bodies, m);
    for (const f of context.others) {
      // Flexing never lifts track, so only ends at the same height can close.
      if (f.body === m.body || f.gender === m.gender || Math.abs(f.z - m.z) > context.play.mm) continue;
      if (bodies[m.body].role === 'held' && bodies[f.body].role === 'held') continue;
      const fp = endNow(bodies, f);
      const e = jointError(mp, fp);
      if (e.gapMm > range.mm || e.angleDeg > range.deg || (best && e.gapMm >= best.gap)) continue;
      best = {
        gap: e.gapMm,
        link: {
          a: m,
          b: f,
          mm: context.play.mm * CLOSE_SHARE,
          rad: (context.play.deg * CLOSE_SHARE * Math.PI) / 180,
          joint: { a: m.end, b: f.end },
        },
      };
    }
  }
  return best?.link ?? null;
}

function result(context: FlexContext, bodies: Body[], closing: Link | null): FlexResult {
  const moveOf = new Map<string, Pose>();
  for (const b of bodies) for (const uid of b.uids) moveOf.set(uid, b.move);
  const layout: Layout = {
    pieces: context.start.pieces.map((p) => {
      const move = moveOf.get(p.uid);
      return move ? { ...p, pose: applyPose(move, p.pose) } : p;
    }),
  };
  const atLimit = context.links
    .filter((link) => {
      const e = jointError(endNow(bodies, link.a), endNow(bodies, link.b));
      return e.gapMm >= context.play.mm * LIMIT_SHARE || e.angleDeg >= context.play.deg * LIMIT_SHARE;
    })
    .map((link) => link.joint);
  return { layout, atLimit, closed: closing?.joint ?? null };
}

function hold(body: Body): void {
  body.role = 'held';
  body.invMass = 0;
  body.invInertia = 0;
}

const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const cross = (r: Vec2, n: Vec2): number => r.x * n.y - r.y * n.x;

function endNow(bodies: Body[], end: { body: number; pose: Pose }): Pose {
  return applyPose(bodies[end.body].move, end.pose);
}

function centerNow(body: Body): Vec2 {
  return applyPose(body.move, { ...body.center0, angle: 0 });
}

function shift(body: Body, dx: number, dy: number, turn: number): void {
  const c = centerNow(body);
  let move: Pose = { ...body.move, x: body.move.x + dx, y: body.move.y + dy };
  if (turn) move = applyPose(rotationAbout({ x: c.x + dx, y: c.y + dy }, turn), move);
  body.move = move;
}

/** Nudge a body so `point` moves by `amount` along the unit vector `n`, turning it as much as its shape resists. */
function push(body: Body, point: Vec2, n: Vec2, lambda: number): void {
  if (!body.invMass) return;
  const r = { x: point.x - centerNow(body).x, y: point.y - centerNow(body).y };
  shift(body, n.x * lambda * body.invMass, n.y * lambda * body.invMass, cross(r, n) * lambda * body.invInertia);
}

function weight(body: Body, point: Vec2, n: Vec2): number {
  const c = centerNow(body);
  const r = { x: point.x - c.x, y: point.y - c.y };
  return body.invMass + body.invInertia * cross(r, n) ** 2;
}

function pullPoint(body: Body, grab0: Vec2, target: Vec2): void {
  const g = applyPose(body.move, { ...grab0, angle: 0 });
  const d = distance(g, target);
  if (d < TOLERANCE) return;
  const n = { x: (target.x - g.x) / d, y: (target.y - g.y) / d };
  push(body, g, n, d / weight(body, g, n));
}

function creepBack(body: Body, share: number): void {
  const c = centerNow(body);
  shift(body, (body.center0.x - c.x) * share, (body.center0.y - c.y) * share, -body.move.angle * share);
}

/** Push a joint back inside its limits, splitting the correction between its two bodies. */
function enforce(bodies: Body[], link: Link): void {
  const A = bodies[link.a.body];
  const B = bodies[link.b.body];

  // Angle first: the ends should face each other head on, within play.
  let pa = endNow(bodies, link.a);
  let pb = endNow(bodies, link.b);
  const off = normalizeAngle(pa.angle - pb.angle - Math.PI);
  if (Math.abs(off) > link.rad) {
    const excess = off - Math.sign(off) * link.rad;
    const total = A.invInertia + B.invInertia;
    if (total > 0) {
      shift(A, 0, 0, (-excess * A.invInertia) / total);
      shift(B, 0, 0, (excess * B.invInertia) / total);
    }
    pa = endNow(bodies, link.a);
    pb = endNow(bodies, link.b);
  }

  // Then the gap between peg and hole.
  const gap = distance(pa, pb);
  if (gap <= link.mm) return;
  const n = { x: (pb.x - pa.x) / gap, y: (pb.y - pa.y) / gap };
  const total = weight(A, pa, n) + weight(B, pb, n);
  if (total === 0) return;
  const lambda = (gap - link.mm) / total;
  push(A, pa, n, lambda);
  push(B, pb, { x: -n.x, y: -n.y }, lambda);
}
