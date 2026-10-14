import type { EnvironmentId } from '../environments/environments';
import { IDENTITY, normalizeAngle, type Pose } from '../geometry/pose';
import {
  addPiece,
  centerOf,
  EMPTY_LAYOUT,
  extendFrom,
  findJoints,
  openEnds,
  transformPieces,
  worldEnd,
  type EndRef,
  type Layout,
} from '../layout/layout';

// Ready-made layouts to start from: the classic shapes people build first.
// Each is put together piece by piece the way it would be on the floor,
// every piece pushed onto an open end, so the joints are exact and the
// layout check passes (the tests make sure of it). Every template fits on
// the play table.

export interface Template {
  id: string;
  name: string;
  /** One line under the name in the picker. */
  detail: string;
  build: () => Layout;
  /** The scene it's laid out for, when it doesn't fit the play table. */
  environment?: EnvironmentId;
}

/**
 * A run of track written as tokens: straights by Brio letter (D long,
 * A medium, A1 short, A2 mini), curves by which way they turn (L or R a
 * large curve, l or r a short one). Add ":pp" or ":hh" for the version with
 * two pegs or two holes, ":up" or ":down" on a ramp ("N").
 */
type Token = string;

const STRAIGHT_IDS: Record<string, string> = {
  D: 'straight-long',
  A: 'straight-medium',
  A1: 'straight-short',
  A2: 'straight-mini',
};
const CURVE_IDS: Record<string, [string, 1 | -1]> = {
  L: ['curve-large', 1],
  R: ['curve-large', -1],
  l: ['curve-short', 1],
  r: ['curve-short', -1],
};

/** Builds a layout one piece at a time, like a person on the floor. */
class Builder {
  layout: Layout = EMPTY_LAYOUT;

  /** Put the first piece down. */
  place(pieceId: string, pose: Pose = IDENTITY, flipped = false): string {
    const added = addPiece(this.layout, pieceId, pose, flipped);
    this.layout = added.layout;
    return added.uid;
  }

  /**
   * Push a piece onto `end`, by its end `via` (or whichever fits first).
   * Tries it both ways up and keeps the one `prefer` likes, by default the
   * one that joins the most ends.
   */
  add(end: EndRef, pieceId: string, opts: { via?: string; prefer?: (layout: Layout, uid: string) => number } = {}): string {
    const score = opts.prefer ?? ((layout: Layout) => findJoints(layout).length);
    let best: { layout: Layout; uid: string; score: number } | null = null;
    for (const flipped of [false, true]) {
      const ext = extendFrom(this.layout, end, pieceId, flipped, opts.via);
      if (!ext) continue;
      const s = score(ext.layout, ext.uid);
      if (!best || s > best.score) best = { layout: ext.layout, uid: ext.uid, score: s };
    }
    if (!best) throw new Error(`${pieceId} doesn't fit on ${end.uid}:${end.connectorId}`);
    this.layout = best.layout;
    return best.uid;
  }

  /** The end of `uid` still open, other than `not`. Null once everything is joined. */
  open(uid: string): EndRef | null {
    const e = openEnds(this.layout).find((o) => o.uid === uid);
    return e ? { uid, connectorId: e.connectorId } : null;
  }

  /** Lay a run of track from `end`. Returns the open end at the far end, or null when the run closed a loop. */
  run(end: EndRef, tokens: Token[]): EndRef | null {
    let at: EndRef | null = end;
    for (const token of tokens) {
      if (!at) throw new Error(`Run already closed before ${token}`);
      const [shape, variant] = token.split(':');
      const suffix = variant === 'pp' || variant === 'hh' ? `-${variant}` : '';
      let uid: string;
      if (STRAIGHT_IDS[shape]) {
        uid = this.add(at, STRAIGHT_IDS[shape] + suffix);
      } else if (CURVE_IDS[shape]) {
        const [id, turn] = CURVE_IDS[shape];
        const from = worldEnd(this.layout, at).connector.pose.angle;
        // Whichever way up turns the right way: the far end's heading against the way we came in.
        uid = this.add(at, id + suffix, {
          prefer: (layout, added) => {
            const far = openEnds(layout).find((o) => o.uid === added);
            const heading = far ? far.connector.pose.angle : farHeading(layout, added, at!);
            return turn * normalizeAngle(heading - from);
          },
        });
      } else if (shape === 'N') {
        // A ramp climbs from its a end, so going up it goes on by a, down by b.
        uid = this.add(at, 'ramp' + suffix, { via: variant === 'down' ? 'b' : 'a' });
      } else {
        uid = this.add(at, token);
      }
      at = this.open(uid);
    }
    return at;
  }

  /** The finished layout, moved so its middle is the middle of the table. */
  done(): Layout {
    const all = new Set(this.layout.pieces.map((p) => p.uid));
    const c = centerOf(this.layout, all);
    return transformPieces(this.layout, all, { x: -c.x, y: -c.y, angle: 0 });
  }
}

/** Heading out of the end of `uid` that isn't joined to `from` (for a piece that closed a loop). */
function farHeading(layout: Layout, uid: string, from: EndRef): number {
  const joints = findJoints(layout);
  for (const j of joints) {
    for (const [mine, theirs] of [
      [j.a, j.b],
      [j.b, j.a],
    ]) {
      if (mine.uid === uid && !(theirs.uid === from.uid && theirs.connectorId === from.connectorId)) {
        return worldEnd(layout, mine).connector.pose.angle;
      }
    }
  }
  return NaN;
}

const times = (n: number, token: Token): Token[] => Array<Token>(n).fill(token);

/** The simplest loop: two long straights each side, round large curves. */
function oval(): Layout {
  const b = new Builder();
  const first = b.place('straight-long');
  b.run({ uid: first, connectorId: 'b' }, ['D', ...times(4, 'L'), 'D', 'D', ...times(4, 'L')]);
  return b.done();
}

/**
 * A figure eight through a cross. The cross sits turned 45°; each lobe is a
 * medium straight out, three quarters of a circle and a medium straight back,
 * which comes round exactly because half the cross plus a medium straight
 * is one curve radius.
 */
function figureEight(): Layout {
  const b = new Builder();
  const cross = b.place('cross', { x: 0, y: 0, angle: Math.PI / 4 });
  b.run({ uid: cross, connectorId: 'b' }, ['A', ...times(6, 'R'), 'A']);
  b.run({ uid: cross, connectorId: 'd' }, ['A', ...times(6, 'L'), 'A']);
  return b.done();
}

/**
 * Lay a passing loop from `end`: a parallel switch, `between` on both
 * tracks, and a second switch the other way round to bring them back
 * together. The second track goes off to the right. Returns the open end
 * after it.
 */
function passingLoop(b: Builder, end: EndRef, between: Token[], laid?: { main: string[]; loop: string[] }): EndRef {
  const right = (layout: Layout, uid: string) => {
    // The branch that leaves the main line should end up to the right of travel.
    const from = worldEnd(layout, end).connector.pose;
    const branch = worldEnd(layout, { uid, connectorId: 'branch1' }).connector.pose;
    const side = Math.cos(from.angle) * (branch.y - from.y) - Math.sin(from.angle) * (branch.x - from.x);
    return -side;
  };
  const first = b.add(end, 'switch-parallel', { via: 'trunk', prefer: right });
  const lay = (connectorId: string, into: string[] = []) => {
    let at: EndRef = { uid: first, connectorId };
    for (const token of between) {
      at = b.run(at, [token])!;
      into.push(at.uid);
    }
    return at;
  };
  const main = lay('branch0', laid?.main);
  lay('branch1', laid?.loop);
  const second = b.add(main, 'switch-parallel-peg', { via: 'branch0' });
  return { uid: second, connectorId: 'trunk' };
}

/** An oval with a passing loop on each side, so two trains can pass. */
function passingLoops(): Layout {
  const b = new Builder();
  const first = b.place('curve-large');
  let end = b.run({ uid: first, connectorId: 'b' }, times(3, 'L'))!;
  end = passingLoop(b, end, ['D']);
  end = b.run(end, times(4, 'L'))!;
  // The second switch's trunk lands on the first curve, closing the oval.
  passingLoop(b, end, ['D']);
  return b.done();
}

/**
 * An oval with a small goods yard off one side: a curved switch leads out
 * to two parallel sidings, each ending at a buffer stop.
 */
function goodsYard(): Layout {
  const b = new Builder();
  const first = b.place('straight-long');
  let end = b.run({ uid: first, connectorId: 'b' }, [...times(4, 'L'), 'D', 'A', 'D', ...times(4, 'L')])!;
  // The yard switch, with its curve heading out of the oval (to the right).
  const outward = (layout: Layout, uid: string) => {
    const from = worldEnd(layout, end).connector.pose;
    const branch = worldEnd(layout, { uid, connectorId: 'branch1' }).connector.pose;
    return -(Math.cos(from.angle) * (branch.y - from.y) - Math.sin(from.angle) * (branch.x - from.x));
  };
  const yard = b.add(end, 'switch-curved', { via: 'trunk', prefer: outward });
  // Along the oval, back to the first straight.
  b.run({ uid: yard, connectorId: 'branch0' }, ['D']);
  // Out to the yard: the curve straightens up beside the oval, then a second switch splits it.
  end = b.run({ uid: yard, connectorId: 'branch1' }, ['L'])!;
  const second = b.add(end, 'switch-curved', { via: 'trunk', prefer: outward });
  b.run({ uid: second, connectorId: 'branch0' }, ['A', 'buffer']);
  b.run({ uid: second, connectorId: 'branch1' }, ['L', 'A', 'buffer']);
  return b.done();
}

/** An oval with a hill: a ramp up, a straight along the top on supports, and a ramp down. */
function hill(): Layout {
  const b = new Builder();
  const first = b.place('straight-long');
  // Two holes on the top straight turn the run round for the ramp down; two pegs on a curve turn it back.
  b.run({ uid: first, connectorId: 'b' }, ['A', 'D', ...times(4, 'L'), 'N:up', 'A:hh', 'N:down', 'L:pp', ...times(3, 'L')]);
  return b.done();
}

/**
 * A whole town: a loop round the edge of a big table with a passing loop
 * and a station on each long side, a goods yard with the crane, loader and
 * engine shed, a hill over a viaduct, a level crossing, a lifting bridge and
 * a tunnel, and every place a train can work at along the way, from the coal
 * mine to the post office. Too big for the play table: it comes with the
 * town streets.
 */
function fullTown(): Layout {
  const b = new Builder();
  const first = b.place('straight-long');
  let end: EndRef = { uid: first, connectorId: 'b' };
  /** Lay one piece and note where it went. */
  const lay = (token: Token): string => {
    end = b.run(end, [token])!;
    return end.uid;
  };
  const near = { main: [] as string[], loop: [] as string[] };
  const far = { main: [] as string[], loop: [] as string[] };

  // The near side, left to right: a level crossing, then the first station's passing loop.
  const n1 = lay('D');
  lay('level-crossing');
  const n2 = lay('D');
  end = passingLoop(b, end, ['D', 'D'], near);
  const n3 = lay('D');
  // Up the right-hand end over the hill.
  for (const t of ['L', 'L', 'N:up', 'bridge-viaduct', 'N:down', 'A:pp', 'L', 'L']) lay(t);
  // The far side, right to left: the goods yard, the lifting bridge, the second station's passing loop.
  const f1 = lay('D');
  const outward = (from: EndRef) => (layout: Layout, uid: string) => {
    const at = worldEnd(layout, from).connector.pose;
    const branch = worldEnd(layout, { uid, connectorId: 'branch1' }).connector.pose;
    return -(Math.cos(at.angle) * (branch.y - at.y) - Math.sin(at.angle) * (branch.x - at.x));
  };
  const yard = b.add(end, 'switch-curved', { via: 'trunk', prefer: outward(end) });
  const yardOut = b.run({ uid: yard, connectorId: 'branch1' }, ['L'])!;
  const split = b.add(yardOut, 'switch-curved', { via: 'trunk', prefer: outward(yardOut) });
  let siding = b.run({ uid: split, connectorId: 'branch0' }, ['D'])!;
  const sidingA = siding.uid;
  siding = b.run(siding, ['D'])!;
  const sidingB = siding.uid;
  b.run(siding, ['buffer']);
  siding = b.run({ uid: split, connectorId: 'branch1' }, ['L', 'D'])!;
  const sidingC = siding.uid;
  b.run(siding, ['buffer']);
  end = { uid: yard, connectorId: 'branch0' };
  const f2 = lay('D');
  lay('lift-bridge');
  end = passingLoop(b, end, ['D', 'D'], far);
  // A straight before the bend, so long cars leave the loop's S-bend before they turn.
  const f3 = lay('D');
  // Down the left-hand end, through the tunnel, and round to the start.
  lay('L');
  lay('L');
  const w = ['D', 'D', 'A', 'D', 'D'].map(lay);
  b.run(end, ['L', 'L']);

  // What stands along the track, beside the piece it belongs to. Places
  // stand inside the loop; `out` turns one round to stand outside it.
  const by = (uid: string, id: string, opts: { out?: boolean; side?: number; along?: number } = {}) => {
    const piece = b.layout.pieces.find((p) => p.uid === uid)!;
    const { x, y, angle } = piece.pose;
    const d = opts.along ?? 108;
    const side = opts.side ?? 0;
    const heading = angle + (opts.out ? Math.PI : 0);
    b.place(id, { x: x + d * Math.cos(angle) - side * Math.sin(heading), y: y + d * Math.sin(angle) + side * Math.cos(heading), angle: heading });
  };
  // Near side: coal and water, the signs before the level crossing, the first station.
  by(first, 'coal-mine');
  by(first, 'whistle-board', { out: true });
  by(n1, 'coaling-stage');
  by(n1, 'slow-board', { out: true });
  by(n2, 'water-tower');
  by(n2, 'charging-post', { out: true });
  by(near.main[0], 'station');
  by(near.main[1], 'power-station');
  by(near.loop[0], 'pump-house', { out: true });
  by(near.loop[1], 'post-office', { out: true });
  by(n3, 'farm');
  by(n3, 'signal', { side: 60, along: 20, out: true });
  // Far side: the yard, the market, the second station and the timber trade.
  by(f1, 'market');
  by(sidingA, 'cargo-loader');
  by(sidingB, 'engine-shed', { along: 140 });
  by(sidingC, 'crane', { side: 100, out: true });
  by(f2, 'goods-shed');
  by(f3, 'toy-factory');
  by(far.main[0], 'sawmill');
  by(far.main[1], 'station');
  by(far.loop[0], 'post-office', { out: true });
  by(far.loop[1], 'lumber-camp', { out: true });
  by(far.main[1], 'signal', { side: 60, along: 200 });
  // The left-hand end: a tunnel, and houses beyond it.
  by(w[1], 'tunnel');
  by(w[4], 'cottage', { out: true, side: 140 });
  by(w[3], 'cottage', { out: true, side: 140 });
  // Houses and trees in the middle, and round the edge.
  const middle = b.layout.pieces.find((p) => p.uid === near.main[0])!.pose;
  const scatter: [string, number, number, number][] = [
    ['cottage', 120, 420, 0.2], ['cottage', 420, 380, -0.3], ['cottage', 760, 440, 0.1], ['cottage', 300, 700, Math.PI],
    ['leafy-tree', -120, 560, 0], ['leafy-tree', 560, 620, 0], ['pine-tree', 900, 640, 0], ['leafy-tree', 1100, 400, 0],
    ['pine-tree', -300, 380, 0], ['leafy-tree', -500, 640, 0], ['pine-tree', 1150, -260, 0], ['leafy-tree', -700, -230, 0],
    ['pine-tree', -400, -260, 0], ['leafy-tree', 1400, 1100, 0], ['pine-tree', -900, 300, 0],
  ];
  for (const [id, x, y, angle] of scatter) b.place(id, { x: middle.x + x, y: middle.y + y, angle });
  return b.done();
}

export const TEMPLATES: readonly Template[] = [
  { id: 'oval', name: 'Simple oval', detail: 'The classic first loop', build: oval },
  { id: 'figure-eight', name: 'Figure eight', detail: 'Two loops through a cross', build: figureEight },
  { id: 'passing-loops', name: 'Passing loops', detail: 'An oval where two trains can pass', build: passingLoops },
  { id: 'goods-yard', name: 'Goods yard', detail: 'An oval with two sidings', build: goodsYard },
  { id: 'hill', name: 'Over the hill', detail: 'Up a ramp and down again', build: hill },
  { id: 'full-town', name: 'Full town', detail: 'Every place, station and yard, on town streets', build: fullTown, environment: 'town' },
];

export function getTemplate(id: string): Template {
  const t = TEMPLATES.find((t) => t.id === id);
  if (!t) throw new Error(`Unknown template: ${id}`);
  return t;
}
