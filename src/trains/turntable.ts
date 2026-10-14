import { pathLength, poseAt } from '../geometry/path';
import { applyPose, normalizeAngle, type Vec2 } from '../geometry/pose';
import { defOf, type Layout } from '../layout/layout';

// The turntable's turning bridge. It lines up with one of the four lines
// across the pit at a time, which joins the two ends straight across from
// each other; the other six ends lead nowhere until it turns to them. A
// train waits at the pit while the bridge isn't lined up with its end, or
// is still turning, and one standing wholly on the bridge turns with it.
// Angles are in the piece's own frame, so they hold when the piece moves.

/** Tunable estimates. */
export const TURNTABLE = {
  /** How fast the bridge turns, degrees per second (turned by hand on the toy). */
  degPerSecond: 60,
  /** Where a train's front stops short of the pit while it waits. */
  gapMm: 10,
  /** A tap this close to the pivot turns the bridge on to the next line; further out, to the end nearest the tap. */
  middleShare: 0.3,
};

export interface Turntable {
  uid: string;
  /** The pivot, in plan. */
  center: Vec2;
  radius: number;
  /** The piece's own angle, to turn plan points into its frame. */
  pieceAngle: number;
  /** The lines across, in path order: their edges and headings in the piece's frame. */
  lines: { edgeKey: string; angle: number }[];
}

export interface TurntableState {
  /** Which way the bridge points now, and where it is turning to, radians in the piece's frame. */
  angle: number;
  target: number;
  /** Trains riding round on it, and the angle they got on at. */
  riders: number[];
  from: number;
}

/** Every turntable in the layout. Edges are keyed `uid:index`. */
export function findTurntables(layout: Layout): Turntable[] {
  const out: Turntable[] = [];
  for (const piece of layout.pieces) {
    const def = defOf(piece);
    if (def.structure !== 'turntable') continue;
    const first = def.paths[0];
    const length = pathLength(first);
    const mid = poseAt(first, length / 2);
    out.push({
      uid: piece.uid,
      center: applyPose(piece.pose, { ...mid, angle: 0 }),
      radius: length / 2,
      pieceAngle: piece.pose.angle,
      lines: def.paths.map((p, i) => ({ edgeKey: `${piece.uid}:${i}`, angle: p.from.angle })),
    });
  }
  return out;
}

/** How far apart two headings are, taking a line either way round (mod half a turn). */
const lineGap = (a: number, b: number) => Math.abs(normalizeAngle(2 * (a - b))) / 2;

/** The line the bridge lies along at `angle`, or -1 between lines. */
export function lineAt(table: Turntable, angle: number): number {
  const i = table.lines.findIndex((l) => lineGap(l.angle, angle) < 1e-6);
  return i;
}

/** The heading of line `index` nearest `from`: the bridge turns the short way, either end first. */
export function headingToward(table: Turntable, index: number, from: number): number {
  const a = table.lines[index].angle;
  return a + Math.round((from - a) / Math.PI) * Math.PI;
}

/** The line whose end is nearest a plan point, or the next line round for a point near the pivot. */
export function lineToward(table: Turntable, point: Vec2, current: number, middleSteps = true): number {
  const dx = point.x - table.center.x;
  const dy = point.y - table.center.y;
  const now = Math.max(0, lineAt(table, current));
  if (Math.hypot(dx, dy) < table.radius * TURNTABLE.middleShare) return middleSteps ? (now + 1) % table.lines.length : now;
  const local = Math.atan2(dy, dx) - table.pieceAngle;
  let best = 0;
  table.lines.forEach((l, i) => {
    if (lineGap(l.angle, local) < lineGap(table.lines[best].angle, local)) best = i;
  });
  return best;
}

/** Turn the bridge toward its target for `dt` seconds. Returns whether it has just come to rest. */
export function turn(state: TurntableState, dt: number): boolean {
  if (state.angle === state.target) return false;
  const step = (TURNTABLE.degPerSecond * Math.PI * dt) / 180;
  const left = state.target - state.angle;
  if (Math.abs(left) <= step) {
    state.angle = state.target;
    return true;
  }
  state.angle += Math.sign(left) * step;
  return false;
}

/** Where a plan point on the bridge ends up when it turns by `delta` about the pivot. */
export function turnPoint(table: Turntable, p: Vec2, delta: number): Vec2 {
  const c = Math.cos(delta);
  const s = Math.sin(delta);
  const dx = p.x - table.center.x;
  const dy = p.y - table.center.y;
  return { x: table.center.x + dx * c - dy * s, y: table.center.y + dx * s + dy * c };
}
