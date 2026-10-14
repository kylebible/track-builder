import { DEFAULT_PLAY, jointError, placeToMate, type Play } from '../geometry/joint';
import { applyPose, IDENTITY, normalizeAngle, rotationAbout, type Pose, type Vec2 } from '../geometry/pose';
import { CATALOG, getPiece } from '../pieces/catalog';
import type { Gender, PieceDef } from '../pieces/types';
import { checkLayout } from '../planning/check';
import { defOf, extendFrom, findJoints, openEnds, sameEnd, worldEnd, type EndRef, type Layout } from './layout';

// Auto-fill: given two open ends, find a few runs of plain track (straights,
// curves, and ramps when the ends are at different heights) that join them.
//
// Runs are searched by shape alone, from both ends at once: every short
// chain grown out from one end is matched against every short chain grown
// out from the other, which reaches twice as far for the same work. Each
// match is then built with real pieces, picking peg and hole versions so
// every joint is peg into hole, and the small mismatch left over is shared
// out between its joints, each giving no more than the joint play allows.
// A run is only offered if the layout check finds nothing wrong with it.

/** How much of the joint play a filled run may use at each joint, leaving some for the floor. */
const FILL_SHARE = 0.8;
/** Pieces grown out from each end before chains are matched. */
const DEPTH_PER_SIDE = 5;
export const MAX_PIECES = DEPTH_PER_SIDE * 2;
/** How close two chain ends have to be to be worth building and checking. */
const MATCH_MM = 30;
/** Matches tried per run length, best first. */
const TRIES_PER_LENGTH = 60;
/** Stop trying once this many good runs are found, or after this long. */
const WANTED = 4;
const BUDGET_MS = 600;

/** One way to fill the gap. */
export interface Fill {
  layout: Layout;
  /** The pieces it adds, in order from the first end. */
  uids: string[];
  /** Pieces needing two pegs or two holes. */
  odd: number;
  /** The most any of its joints is flexed, as a share of the joint play. */
  flex: number;
}

/** A piece's shape as it runs from the end it attaches by: where its other end lands, relative to the first. */
interface Move {
  step: Pose;
  /** How far it climbs. */
  dz: number;
  /** Height of the end it attaches by above its bottom: it can't attach there below that height. */
  lift: number;
  kind: 'straight' | 'curve' | 'ramp';
  /** The real pieces with this shape, by which genders their ends have. */
  ways: Way[];
  /** The same shape run the other way. */
  reverse: number;
}

interface Way {
  pieceId: string;
  flipped: boolean;
  attach: string;
  out: string;
  attachGender: Gender;
  outGender: Gender;
}

let movesCache: Move[] | null = null;

/** Every shape a plain two-ended track piece can take, worked out from the catalog. */
function moves(): Move[] {
  if (movesCache) return movesCache;
  const found = new Map<string, Move>();
  const keyOf = (step: Pose, dz: number) => [step.x, step.y, step.angle * 1000, dz].map((n) => Math.round(n * 10)).join(',');
  const wayKey = new Map<string, string>();
  for (const base of CATALOG) {
    if (base.category !== 'straight' && base.category !== 'curve' && base.category !== 'ramp') continue;
    if (base.connectors.length !== 2 || base.paths.length !== 1) continue;
    // Plain track only: not bridge spans, or every bend of a bendy track.
    if (base.bridge || base.bend !== undefined) continue;
    for (const flipped of [false, true]) {
      const def: PieceDef = defOf({ pieceId: base.id, flipped });
      for (const attach of def.connectors) {
        const out = def.connectors.find((c) => c !== attach)!;
        const step = applyPose(placeToMate(IDENTITY, def, attach.id), out.pose);
        const dz = (out.z ?? 0) - (attach.z ?? 0);
        const key = keyOf(step, dz);
        let move = found.get(key);
        if (!move) found.set(key, (move = { step, dz, lift: attach.z ?? 0, kind: base.category, ways: [], reverse: -1 }));
        move.ways.push({ pieceId: base.id, flipped, attach: attach.id, out: out.id, attachGender: attach.gender, outGender: out.gender });
        wayKey.set(`${base.id}:${flipped}:${attach.id}`, key);
      }
    }
  }
  const list = [...found.values()];
  const index = new Map([...found.keys()].map((k, i) => [k, i]));
  for (const move of list) {
    const w = move.ways[0];
    move.reverse = index.get(wayKey.get(`${w.pieceId}:${w.flipped}:${w.out}`)!)!;
  }
  return (movesCache = list);
}

/** A chain of moves grown out from one end, as a linked list back to its start. */
interface Chain {
  pose: Pose;
  z: number;
  depth: number;
  move: number;
  parent: Chain | null;
}

function grow(start: Pose, z: number, allowed: number[], depth: number): Chain[] {
  const all = moves();
  const root: Chain = { pose: start, z, depth: 0, move: -1, parent: null };
  const chains = [root];
  const seen = new Set<string>([poseKey(start, z)]);
  let frontier = [root];
  for (let d = 1; d <= depth; d++) {
    const next: Chain[] = [];
    for (const chain of frontier) {
      for (const m of allowed) {
        const move = all[m];
        if (chain.z - move.lift < -1e-6) continue;
        const pose = applyPose(chain.pose, move.step);
        const nz = chain.z + move.dz;
        // Chains that end in the same place are the same pieces in a different order; one will do.
        const key = poseKey(pose, nz);
        if (seen.has(key)) continue;
        seen.add(key);
        const c = { pose, z: nz, depth: d, move: m, parent: chain };
        next.push(c);
      }
    }
    // One at a time: a spread of a big frontier can overflow the stack.
    for (const c of next) chains.push(c);
    frontier = next;
  }
  return chains;
}

const poseKey = (p: Pose, z: number) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.angle * 200)},${Math.round(z)}`;

function movesOf(chain: Chain): number[] {
  const out: number[] = [];
  for (let c: Chain | null = chain; c && c.move >= 0; c = c.parent) out.unshift(c.move);
  return out;
}

export interface FillOptions {
  play?: Play;
  /** Pieces with problems the layout check can't see (off the table, in the water). */
  blocked?: (layout: Layout) => Iterable<string>;
}

/**
 * Up to a few ways to join the open ends `from` and `to` with plain track,
 * fewest pieces first. Empty when there is no way within `MAX_PIECES`.
 */
export function findFills(layout: Layout, from: EndRef, to: EndRef, options: FillOptions = {}): Fill[] {
  const play = options.play ?? DEFAULT_PLAY;
  if (sameEnd(from, to)) return [];
  const open = openEnds(layout);
  const a = open.find((e) => sameEnd(e, from));
  const b = open.find((e) => sameEnd(e, to));
  if (!a || !b) return [];
  const za = a.connector.z ?? 0;
  const zb = b.connector.z ?? 0;
  const all = moves();
  const climb = Math.abs(za - zb) > play.mm;
  const allowed = all.map((_, i) => i).filter((i) => (climb ? true : all[i].kind !== 'ramp'));

  const started = performance.now();
  const forward = grow(a.connector.pose, za, allowed, DEPTH_PER_SIDE);
  const backward = grow(b.connector.pose, zb, allowed, DEPTH_PER_SIDE);

  // Backward chains by where they end, to look up against forward ones.
  const cell = MATCH_MM;
  const grid = new Map<string, Chain[]>();
  for (const c of backward) {
    const k = `${Math.floor(c.pose.x / cell)},${Math.floor(c.pose.y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(c);
  }

  // Candidate runs by length, each with how far off it is before flexing.
  const byLength = new Map<number, { f: Chain; g: Chain; score: number }[]>();
  for (const f of forward) {
    const cx = Math.floor(f.pose.x / cell);
    const cy = Math.floor(f.pose.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const g of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const n = f.depth + g.depth;
          if (n === 0 || Math.abs(f.z - g.z) > 0.5) continue;
          const e = jointError(f.pose, g.pose);
          // Each joint can turn only a little, so the ends must already nearly face each other.
          if (e.gapMm > MATCH_MM || e.angleDeg > play.deg * FILL_SHARE * (n + 1)) continue;
          const score = e.gapMm / play.mm + e.angleDeg / play.deg;
          let list = byLength.get(n);
          if (!list) byLength.set(n, (list = []));
          list.push({ f, g, score });
        }
      }
    }
  }

  const fills: Fill[] = [];
  const seen = new Set<string>();
  for (const n of [...byLength.keys()].sort((x, y) => x - y)) {
    const list = byLength.get(n)!.sort((x, y) => x.score - y.score).slice(0, TRIES_PER_LENGTH);
    for (const { f, g } of list) {
      if (fills.length >= WANTED || performance.now() - started > BUDGET_MS) break;
      const run = [...movesOf(f), ...movesOf(g).reverse().map((m) => all[m].reverse)];
      const fill = build(layout, from, to, run, play, options);
      if (!fill) continue;
      const key = describeKey(fill, layout);
      if (seen.has(key)) continue;
      seen.add(key);
      fills.push(fill);
    }
    if (fills.length >= WANTED) break;
  }
  return fills.sort((x, y) => x.uids.length - y.uids.length || x.odd - y.odd || x.flex - y.flex);
}

/** Runs that use the same pieces along roughly the same route count as one. */
function describeKey(fill: Fill, before: Layout): string {
  const added = fill.layout.pieces.filter((p) => fill.uids.includes(p.uid));
  const names = added.map((p) => `${p.pieceId}${p.flipped ? '~' : ''}`).sort();
  const mid = added.reduce((s, p) => ({ x: s.x + p.pose.x / added.length, y: s.y + p.pose.y / added.length }), { x: 0, y: 0 });
  return `${before.pieces.length}|${names.join(',')}|${Math.round(mid.x / 120)},${Math.round(mid.y / 120)}`;
}

/**
 * Pick a real piece for each shape so every joint is peg into hole, with
 * as few two-peg or two-hole pieces as possible. Null if there's no way.
 */
function chooseWays(run: number[], start: Gender, end: Gender): Way[] | null {
  const all = moves();
  // Cheapest way to reach each step with the open end of each gender.
  type Best = { cost: number; ways: Way[] };
  let best = new Map<Gender, Best>([[start, { cost: 0, ways: [] }]]);
  for (const m of run) {
    const next = new Map<Gender, Best>();
    for (const [gender, so] of best) {
      for (const way of all[m].ways) {
        if (way.attachGender === gender) continue;
        // Two pegs or two holes are rarer than one of each; lettered Brio pieces are what people have.
        const odd = way.attachGender === way.outGender ? 1 : 0;
        const unlettered = getPiece(way.pieceId).brioIds.length ? 0 : 0.01;
        const cost = so.cost + odd + unlettered;
        const was = next.get(way.outGender);
        if (!was || cost < was.cost) next.set(way.outGender, { cost, ways: [...so.ways, way] });
      }
    }
    best = next;
  }
  const done = best.get(end === 'peg' ? 'hole' : 'peg');
  return done ? done.ways : null;
}

function build(layout: Layout, from: EndRef, to: EndRef, run: number[], play: Play, options: FillOptions): Fill | null {
  const target = worldEnd(layout, to).connector;
  const ways = chooseWays(run, worldEnd(layout, from).connector.gender, target.gender);
  if (!ways) return null;

  let next = layout;
  let end: EndRef = from;
  const uids: string[] = [];
  for (const way of ways) {
    const ext = extendFrom(next, end, way.pieceId, way.flipped, way.attach);
    if (!ext) return null;
    next = ext.layout;
    uids.push(ext.uid);
    end = { uid: ext.uid, connectorId: way.out };
  }

  // Share the leftover mismatch out between the joints; twice, to take up what the first pass couldn't see.
  for (let pass = 0; pass < 2; pass++) next = flexRun(next, from, uids, ways, target.pose, play);

  // Every joint along the run, and the last one onto `to`, must hold.
  const joints = findJoints(next, play);
  const joined = (x: EndRef, y: EndRef) => joints.some((j) => (sameEnd(j.a, x) && sameEnd(j.b, y)) || (sameEnd(j.a, y) && sameEnd(j.b, x)));
  let worst = 0;
  const pairs: [EndRef, EndRef][] = [];
  let prev = from;
  uids.forEach((uid, i) => {
    pairs.push([prev, { uid, connectorId: ways[i].attach }]);
    prev = { uid, connectorId: ways[i].out };
  });
  pairs.push([prev, to]);
  for (const [x, y] of pairs) {
    if (!joined(x, y)) return null;
    const e = jointError(worldEnd(next, x).connector.pose, worldEnd(next, y).connector.pose);
    worst = Math.max(worst, e.gapMm / play.mm, e.angleDeg / play.deg);
  }
  if (worst > FILL_SHARE + 0.05) return null;

  const added = new Set(uids);
  const trouble = checkLayout(next, { play }).some((i) => i.kind !== 'open-end' && i.uids.some((u) => added.has(u)));
  if (trouble) return null;
  if (options.blocked && [...options.blocked(next)].some((u) => added.has(u))) return null;

  const odd = ways.filter((w) => w.attachGender === w.outGender).length;
  return { layout: next, uids, odd, flex: worst };
}

/**
 * Nudge the new pieces at each of their joints so the run's last end lands
 * on `target`. The smallest set of nudges that does it, weighed against the
 * play, so every joint gives about the same share of what it can.
 */
function flexRun(layout: Layout, from: EndRef, uids: string[], ways: Way[], target: Pose, play: Play): Layout {
  const n = uids.length;
  const last = worldEnd(layout, { uid: uids[n - 1], connectorId: ways[n - 1].out }).connector.pose;
  const goal: Pose = { ...target, angle: normalizeAngle(target.angle + Math.PI) };
  const e = [goal.x - last.x, goal.y - last.y, normalizeAngle(goal.angle - last.angle)];

  // Joint i sits before new piece i; the last joint, onto the target, takes its share where it is.
  const points: Vec2[] = [worldEnd(layout, from).connector.pose];
  for (let i = 1; i < n; i++) points.push(worldEnd(layout, { uid: uids[i], connectorId: ways[i].attach }).connector.pose);
  points.push(last);

  // Each joint nudges by (dx, dy, turn about the joint); its effect on the last end is A_i u_i.
  const mm2 = play.mm ** 2;
  const rad2 = ((play.deg * Math.PI) / 180) ** 2;
  const columns = points.map((p) => {
    const rx = last.x - p.x;
    const ry = last.y - p.y;
    // Columns of A_i: dx, dy, and the turn.
    return [
      [1, 0, 0],
      [0, 1, 0],
      [-ry, rx, 1],
    ];
  });
  const weights = [mm2, mm2, rad2];
  // M = sum A_i W A_i^T
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const cols of columns) {
    for (let k = 0; k < 3; k++) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += cols[k][r] * cols[k][c] * weights[k];
    }
  }
  const lambda = solve3(M, e);
  if (!lambda) return layout;

  let pieces = layout.pieces;
  // Apply each joint's nudge to every new piece after it.
  for (let i = 0; i < n; i++) {
    const cols = columns[i];
    const u = cols.map((col, k) => weights[k] * (col[0] * lambda[0] + col[1] * lambda[1] + col[2] * lambda[2]));
    const after = new Set(uids.slice(i));
    // Where the joint is now, after the nudges before it.
    const at = i === 0 ? points[0] : worldEnd({ pieces }, { uid: uids[i], connectorId: ways[i].attach }).connector.pose;
    const turn = rotationAbout(at, u[2]);
    const nudge: Pose = applyPose({ x: u[0], y: u[1], angle: 0 }, turn);
    pieces = pieces.map((p) => (after.has(p.uid) ? { ...p, pose: applyPose(nudge, p.pose) } : p));
  }
  return { pieces };
}

function solve3(m: number[][], b: number[]): number[] | null {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map((col) => det(m.map((row, r) => row.map((v, c) => (c === col ? b[r] : v)))) / d);
}

/** A short description of a fill's pieces: "2 long straights, 1 large curve". */
export function describeFill(fill: Fill): string[] {
  const counts = new Map<string, number>();
  for (const p of fill.layout.pieces) {
    if (!fill.uids.includes(p.uid)) continue;
    const name = getPiece(p.pieceId).name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${count} × ${name.charAt(0).toLowerCase()}${name.slice(1)}`);
}
