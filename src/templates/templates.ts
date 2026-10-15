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
 * A whole town, laid out across a hall floor: one long loop with two lines
 * cutting across it, so trains can run round any of three loops, and a
 * passing loop at three spots on each side, four with a station. Every
 * kind of place stands along the way, most of them more than once, with a
 * storage depot on each side for goods nobody has room for yet. Off one end
 * is an engine terminal round a turntable, with the engine shed and a hill
 * up onto a viaduct; off the other, a goods yard round a second turntable
 * with the crane and the loader. One cut-across line crosses a road and the
 * other lifts for boats; the far end runs through a tunnel. It comes with
 * the town streets.
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
  /** How far to the left of the way out of `from` a new piece's end lies: positive is left, which is into the loop. */
  const leftOf = (from: EndRef, connectorId = 'branch1') => (layout: Layout, uid: string) => {
    const at = worldEnd(layout, from).connector.pose;
    const p = worldEnd(layout, { uid, connectorId }).connector.pose;
    return Math.cos(at.angle) * (p.y - at.y) - Math.sin(at.angle) * (p.x - at.x);
  };
  const rightOf = (from: EndRef) => {
    const left = leftOf(from);
    return (layout: Layout, uid: string) => -left(layout, uid);
  };
  /** A curved switch, with a hole or a peg at its trunk, whichever fits. */
  const curvedSwitch = (at: EndRef, opts: Parameters<Builder['add']>[2]) => {
    try {
      return b.add(at, 'switch-curved', opts);
    } catch {
      return b.add(at, 'switch-curved-peg', opts);
    }
  };
  /** A curved switch off `end`, its branch to one side; carries on along the straight. */
  const branchOff = (side: 'in' | 'out'): string => {
    const uid = curvedSwitch(end, { via: 'trunk', prefer: side === 'in' ? leftOf(end) : rightOf(end) });
    end = { uid, connectorId: 'branch0' };
    return uid;
  };
  /** A curved switch the other way round, where a line from inside the loop joins. */
  const joinFromIn = (): string => {
    const uid = curvedSwitch(end, { via: 'branch0', prefer: leftOf(end) });
    end = { uid, connectorId: 'trunk' };
    return uid;
  };
  /** A buffer stop, whichever kind fits. */
  const cap = (at: EndRef) => {
    try {
      b.add(at, 'buffer');
    } catch {
      b.add(at, 'buffer-peg');
    }
  };

  // Each long side, in the way trains run along it: three passing loops, the
  // middle one longest, a switch to each cut-across line between them, and
  // the way into a yard in the middle of the town. Both sides use the same
  // plan, and it reads the same both ways in length, so the cut-across lines
  // meet each side square on.
  interface Side {
    d: string[];
    loops: { main: string[]; loop: string[] }[];
    join: string;
    leave: string;
    yard: string;
  }
  const side = (start: string[]): Side => {
    const s: Side = { d: [...start], loops: [], join: '', leave: '', yard: '' };
    const plan = ['D', 'D', 'loop2', 'D', 'join', 'D', 'yard', 'loop3', 'AA', 'D', 'leave', 'D', 'loop2', 'D', 'D'].slice(start.length);
    for (const slot of plan) {
      if (slot === 'D') s.d.push(lay('D'));
      else if (slot === 'AA') s.d.push(lay('A'), lay('A'));
      else if (slot === 'join') s.join = joinFromIn();
      else if (slot === 'leave') s.leave = branchOff('in');
      else if (slot === 'yard') {
        s.yard = branchOff('in');
        lay('A');
      } else {
        const laid = { main: [] as string[], loop: [] as string[] };
        end = passingLoop(b, end, times(slot === 'loop3' ? 3 : 2, 'D'), laid);
        s.loops.push(laid);
      }
    }
    return s;
  };
  const near = side([first]);
  const e = ['L', 'L', 'D', 'D', 'A', 'D', 'D', 'D', 'L', 'L'].map(lay);
  const far = side([]);
  // Round the left-hand end, through the tunnel, and back to the start.
  const w = ['L', 'L', 'D', 'D', 'D', 'A', 'D', 'D', 'L'].map(lay);
  b.run(end, ['L']);

  // The cut-across lines: from the near side over the level crossing to the far
  // side, and from the far side over the lifting bridge back to the near side.
  b.run({ uid: near.leave, connectorId: 'branch1' }, ['L', 'D', 'level-crossing', 'D', 'D', 'D', 'D', 'L']);
  b.run({ uid: far.leave, connectorId: 'branch1' }, ['L', 'D', 'D', 'lift-bridge', 'A', 'D', 'D', 'L']);

  /**
   * A turntable at the end of `lead`, with roads off it straight on and
   * fanning out to the left, each ending at a buffer stop. The ends it
   * doesn't use get a buffer stop of their own.
   */
  const turntableRoads = (lead: EndRef, roads: Token[][]): { table: string; roads: string[] } => {
    const from = worldEnd(b.layout, lead).connector.pose;
    const table = b.add(lead, 'turntable');
    const ends = openEnds(b.layout)
      .filter((o) => o.uid === table)
      .map((o) => ({ end: { uid: table, connectorId: o.connectorId } as EndRef, turn: normalizeAngle(o.connector.pose.angle - from.angle) }))
      // Straight on first, then out to the left a little, then square to the left.
      .sort((x, y) => (x.turn > -0.01 ? x.turn : 10 - x.turn) - (y.turn > -0.01 ? y.turn : 10 - y.turn));
    const out: string[] = [];
    ends.forEach((o, i) => {
      if (!roads[i]) return cap(o.end);
      const at = b.run(o.end, roads[i])!;
      out.push(at.uid);
      cap(at);
    });
    return { table, roads: out };
  };
  // In the middle of the town, a yard off each side round a turntable. The
  // engine yard's roads: one for the shed, one up a hill onto a viaduct.
  const engines = turntableRoads(b.run({ uid: near.yard, connectorId: 'branch1' }, ['D', 'R'])!, [['D'], ['D'], ['N:up', 'bridge-viaduct', 'A:pp']]);
  // The goods yard's: the loader, the crane, and a road for spare cars.
  const yard = turntableRoads(b.run({ uid: far.yard, connectorId: 'branch1' }, ['D', 'R'])!, [['D'], ['D'], ['A']]);

  // What stands along the track. `in` puts a place on the side toward the
  // middle of the town, `out` on the side away from it.
  const pieceOf = (uid: string) => b.layout.pieces.find((p) => p.uid === uid)!;
  const middle = (() => {
    const a = pieceOf(near.loops[1].main[1]).pose;
    const z = pieceOf(far.loops[1].main[1]).pose;
    return { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
  })();
  const by = (uid: string, id: string, where: 'in' | 'out' = 'in', opts: { side?: number; along?: number } = {}) => {
    const { x, y, angle } = pieceOf(uid).pose;
    const d = opts.along ?? 108;
    const cx = x + d * Math.cos(angle);
    const cy = y + d * Math.sin(angle);
    // A place stands to the left of the way it faces.
    const leftIsIn = -Math.sin(angle) * (middle.x - cx) + Math.cos(angle) * (middle.y - cy) > 0;
    const heading = angle + (leftIsIn === (where === 'in') ? 0 : Math.PI);
    const side = opts.side ?? 0;
    b.place(id, { x: cx - side * Math.sin(heading), y: cy + side * Math.cos(heading), angle: heading });
  };
  const [nw, nm, ne] = near.loops;
  const [fe, fm, fw] = far.loops;
  // The near side, left to right. Places by the cut-across lines stand outside, clear of their curves.
  by(near.d[0], 'coal-mine');
  by(near.d[1], 'coaling-stage');
  by(near.d[1], 'whistle-board', 'out');
  by(nw.main[0], 'station');
  by(nw.main[1], 'post-office');
  by(nw.loop[1], 'pump-house', 'out');
  by(near.d[2], 'water-tower', 'out');
  by(near.d[3], 'power-station');
  by(nm.main[0], 'station');
  by(nm.main[1], 'sawmill');
  by(nm.main[2], 'depot');
  by(nm.loop[0], 'lumber-camp', 'out');
  by(nm.loop[2], 'farm', 'out');
  by(near.d[4], 'charging-post', 'in', { along: 72 });
  by(near.d[4], 'slow-board', 'out', { along: 72 });
  by(near.d[5], 'goods-shed', 'in', { along: 72 });
  by(near.d[6], 'toy-factory');
  by(near.d[7], 'market', 'out');
  by(ne.main[0], 'market');
  by(ne.main[1], 'station');
  by(ne.loop[1], 'post-office', 'out');
  by(ne.main[1], 'signal', 'out', { side: 60, along: 200 });
  by(near.d[8], 'water-tower');
  by(near.d[9], 'coaling-stage');
  // The far side, right to left.
  by(far.d[0], 'lumber-camp');
  by(far.d[1], 'coal-mine');
  by(fe.main[0], 'sawmill');
  by(fe.main[1], 'post-office');
  by(fe.loop[1], 'pump-house', 'out');
  by(far.d[2], 'toy-factory', 'out');
  by(far.d[3], 'charging-post');
  by(fm.main[0], 'station');
  by(fm.main[1], 'farm');
  by(fm.main[2], 'depot');
  by(fm.loop[1], 'lumber-camp', 'out');
  by(fm.main[1], 'signal', 'out', { side: 60, along: 200 });
  by(far.d[4], 'market', 'in', { along: 144 });
  by(far.d[6], 'goods-shed');
  by(far.d[7], 'water-tower', 'out');
  by(fw.main[0], 'power-station');
  by(fw.main[1], 'post-office');
  by(far.d[8], 'water-tower');
  by(far.d[9], 'coaling-stage');
  // The ends: a tunnel at the left, with cottages by it, and a signal at the right.
  by(w[4], 'tunnel');
  by(w[5], 'cottage', 'in', { side: 140, along: 72 });
  by(w[6], 'cottage', 'in', { side: 140 });
  by(e[5], 'signal', 'in', { side: 60, along: 20 });
  // The yards in the middle.
  by(engines.roads[1], 'engine-shed');
  by(yard.roads[0], 'cargo-loader');
  by(yard.roads[1], 'crane', 'out', { side: 90 });

  // A few houses and trees in the middle, beside the yards. The town's own
  // parks fill the spaces either side.
  const up = Math.sign(middle.y - pieceOf(first).pose.y) || 1;
  const scatter: [string, number, number, number][] = [
    ['cottage', 620, -150, 0.3], ['cottage', 740, 110, -0.2], ['cottage', 600, 300, Math.PI],
    ['leafy-tree', -650, 150, 0], ['pine-tree', -720, -120, 0], ['leafy-tree', -560, 380, 0], ['pine-tree', 820, -330, 0],
  ];
  for (const [id, x, y, angle] of scatter) b.place(id, { x: middle.x + x, y: middle.y + up * y, angle });
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
