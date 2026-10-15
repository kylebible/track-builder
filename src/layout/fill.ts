import { DEFAULT_PLAY, jointError, placeToMate, type Play } from '../geometry/joint';
import { pathLength, poseAt } from '../geometry/path';
import { applyPose, IDENTITY, normalizeAngle, rotationAbout, type Pose, type Vec2 } from '../geometry/pose';
import { MODE, offered } from '../pieces/basic';
import { CATALOG, getPiece } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import type { Gender, PieceDef } from '../pieces/types';
import { checkLayout } from '../planning/check';
import { defOf, extendFrom, findJoints, openEnds, sameEnd, worldEnd, type EndRef, type Layout } from './layout';
import { Occupancy } from './occupancy';

// Auto-fill: given two open ends, find a few runs of plain track (straights,
// curves, and ramps when the ends are at different heights) that join them.
//
// Runs are searched by shape alone, from both ends at once: every short
// chain grown out from one end is matched against every short chain grown
// out from the other, which reaches twice as far for the same work. Ends
// further apart than that are reached by a beam search: chains keep growing
// a layer at a time, only the most promising few thousand kept each time
// (judged by how far they've come and how far they still have to go,
// steering clear of track already down), until they land among the short
// chains around the other end. There is no limit on the number of pieces;
// the search runs in small slices so it can be shown as it goes, and stops
// when it has found enough or runs out of time.
//
// Each match is then built with real pieces, picking peg and hole versions so
// every joint is peg into hole, and the small mismatch left over is shared
// out between its joints, each giving no more than the joint play allows.
// A run is only offered if the layout check finds nothing wrong with it.

/** How much of the joint play a filled run may use at each joint, leaving some for the floor. */
const FILL_SHARE = 0.8;
/** Pieces grown out from each end in full before chains are matched. */
const DEPTH_PER_SIDE = 5;
/** Runs up to this long are found by the full search; longer ones by the beam. */
export const NEAR_PIECES = DEPTH_PER_SIDE * 2;
/** How close two chain ends have to be to be worth building and checking. */
const MATCH_MM = 30;
/** Matches tried per run length, best first. */
const TRIES_PER_LENGTH = 60;
/** Chains kept at each layer of the beam, from each end. */
const BEAM_WIDTH = 1500;
/** Size of a patch of floor, and how many beam chains may end in it facing about the same way. */
const SPREAD_MM = 120;
const PER_PATCH = 6;
/** Matches tried per beam layer, best first. */
const TRIES_PER_LAYER = 12;
/** After the first long run is found, layers more to look for others. */
const MORE_LAYERS = 8;
/** A long run's ends must already face each other this nearly, degrees, before flexing. */
const LONG_MATCH_DEG = 10;
/** Stop trying once this many good runs are found, or after this long. */
const WANTED = 4;
const BUDGET_MS = 2500;
/** Tightest radius a run can turn on, for guessing how far a chain still has to go. */
const TURN_RADIUS = D.SHORT_CURVE_RADIUS;
/** Spacing of the points checked along a piece for running into track. */
const ALONG_MM = 40;
/** Track a beam chain may come this close to without counting as running into it. */
const CLEAR_MM = 40;

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
export interface TrackMove {
  step: Pose;
  /** How far it climbs. */
  dz: number;
  /** Height of the end it attaches by above its bottom: it can't attach there below that height. */
  lift: number;
  /** Length of track it lays. */
  length: number;
  /** Points along its track, relative to the end it attaches by, close enough together to find what it would run into. */
  along: Pose[];
  kind: 'straight' | 'curve' | 'ramp';
  /** The real pieces with this shape, by which genders their ends have. */
  ways: Way[];
  /** The same shape run the other way. */
  reverse: number;
}

export interface Way {
  pieceId: string;
  flipped: boolean;
  attach: string;
  out: string;
  attachGender: Gender;
  outGender: Gender;
}

/** Worked out once for each mode: Basic mode uses only real Brio pieces. */
const movesCache = new Map<boolean, TrackMove[]>();

/** Every shape a plain two-ended track piece can take, worked out from the catalog. */
export function trackMoves(): TrackMove[] {
  const cached = movesCache.get(MODE.basic);
  if (cached) return cached;
  const found = new Map<string, TrackMove>();
  const keyOf = (step: Pose, dz: number) => [step.x, step.y, step.angle * 1000, dz].map((n) => Math.round(n * 10)).join(',');
  const wayKey = new Map<string, string>();
  for (const base of CATALOG) {
    if (base.category !== 'straight' && base.category !== 'curve' && base.category !== 'ramp') continue;
    if (base.connectors.length !== 2 || base.paths.length !== 1) continue;
    // Plain, common track only: not bridge spans, helixes, bumpy track, every bend of a bendy track, or rare pieces.
    if (base.bridge || base.structure || base.paths[0].bumps || base.bend !== undefined || base.noFill || !offered(base)) continue;
    for (const flipped of [false, true]) {
      const def: PieceDef = defOf({ pieceId: base.id, flipped });
      for (const attach of def.connectors) {
        const out = def.connectors.find((c) => c !== attach)!;
        const step = applyPose(placeToMate(IDENTITY, def, attach.id), out.pose);
        const dz = (out.z ?? 0) - (attach.z ?? 0);
        const key = keyOf(step, dz);
        let move = found.get(key);
        if (!move) {
          const length = pathLength(def.paths[0]);
          const placed = placeToMate(IDENTITY, def, attach.id);
          const n = Math.ceil(length / ALONG_MM);
          const along = Array.from({ length: n - 1 }, (_, i) => applyPose(placed, poseAt(def.paths[0], (length * (i + 1)) / n)));
          move = { step, dz, lift: attach.z ?? 0, length, along, kind: base.category, ways: [], reverse: -1 };
          found.set(key, move);
        }
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
  movesCache.set(MODE.basic, list);
  return list;
}

/** A chain of moves grown out from one end, as a linked list back to its start. */
interface Chain {
  pose: Pose;
  z: number;
  depth: number;
  /** Length of track laid so far. */
  travelled: number;
  move: number;
  parent: Chain | null;
  /** Whether its pieces keep clear of track already down; worked out when needed. */
  clear?: boolean;
}

const rootOf = (pose: Pose, z: number): Chain => ({ pose, z, depth: 0, travelled: 0, move: -1, parent: null });

function grow(start: Pose, z: number, allowed: number[], depth: number): Chain[] {
  const all = trackMoves();
  const root = rootOf(start, z);
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
        next.push({ pose, z: nz, depth: d, travelled: chain.travelled + move.length, move: m, parent: chain });
      }
    }
    // One at a time: a spread of a big frontier can overflow the stack.
    for (const c of next) chains.push(c);
    frontier = next;
  }
  return chains;
}

const poseKey = (p: Pose, z: number) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.angle * 200)},${Math.round(z)}`;
/** A number for a cell of plan, heading and height; different cells rarely share one. */
const cellKey = (x: number, y: number, a: number, z: number) =>
  ((Math.round(x) * 73856093) ^ (Math.round(y) * 19349663) ^ (Math.round(a) * 83492791) ^ (Math.round(z) * 2654435761)) >>> 0;
/** Coarser, for the beam: chains this alike are not worth keeping both of. */
const beamKey = (p: Pose, z: number) => cellKey(p.x / 8, p.y / 8, p.angle * 30, z);

function movesOf(chain: Chain): number[] {
  const out: number[] = [];
  for (let c: Chain | null = chain; c && c.move >= 0; c = c.parent) out.unshift(c.move);
  return out;
}

/**
 * Chains by where they end and which way they face: cells of `MATCH_MM`,
 * and headings in sixteenths of a turn, to look up against chains from the
 * other end. Two chains that could meet face opposite ways.
 */
type ChainGrid = Map<number, Chain[]>;

const HEADINGS = 16;
const headingOf = (angle: number) => (((Math.round(angle / ((2 * Math.PI) / HEADINGS)) % HEADINGS) + HEADINGS) % HEADINGS);
const gridKey = (cx: number, cy: number, h: number) => cellKey(cx, cy, h, 0);

function gridOf(chains: Chain[]): ChainGrid {
  const grid: ChainGrid = new Map();
  for (const c of chains) {
    const k = gridKey(Math.floor(c.pose.x / MATCH_MM), Math.floor(c.pose.y / MATCH_MM), headingOf(c.pose.angle));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(c);
  }
  return grid;
}

/** Chains in `grid` ending near `at` and facing about the opposite way. */
function* near(grid: ChainGrid, at: Pose): Generator<Chain> {
  const cx = Math.floor(at.x / MATCH_MM);
  const cy = Math.floor(at.y / MATCH_MM);
  const h = headingOf(at.angle + Math.PI);
  for (let dh = -1; dh <= 1; dh++) {
    const hh = (h + dh + HEADINGS) % HEADINGS;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) yield* grid.get(gridKey(cx + dx, cy + dy, hh)) ?? [];
  }
}

/**
 * A rough guess at how much track it takes to get from `pose` to `goal`,
 * arriving facing the way `goal` faces: the distance, plus the turning
 * needed to head there and then to line up, plus any climb.
 */
export function estimate(pose: Pose, z: number, goal: Pose, goalZ: number): number {
  const dx = goal.x - pose.x;
  const dy = goal.y - pose.y;
  const d = Math.hypot(dx, dy);
  const bearing = Math.atan2(dy, dx);
  const turn =
    d < 1
      ? Math.abs(normalizeAngle(goal.angle - pose.angle))
      : Math.abs(normalizeAngle(bearing - pose.angle)) + Math.abs(normalizeAngle(goal.angle - bearing));
  const climb = (Math.abs(goalZ - z) / D.RAMP_RISE) * D.RAMP_LENGTH;
  return d + TURN_RADIUS * turn + climb;
}

export interface FillOptions {
  play?: Play;
  /** Pieces with problems the layout check can't see (off the table, in the water). */
  blocked?: (layout: Layout) => Iterable<string>;
  /** How long to search for, in ms of work. */
  budgetMs?: number;
  /** Stop once this many runs are found. */
  wanted?: number;
}

/**
 * Search for ways to join the open ends `from` and `to` with plain track,
 * a slice at a time: each step yields the runs found so far, fewest pieces
 * first, and the last returns them all. Steps are short, so a caller can
 * run a few per frame and show runs as they turn up.
 */
export function* searchFills(layout: Layout, from: EndRef, to: EndRef, options: FillOptions = {}): Generator<Fill[], Fill[]> {
  const play = options.play ?? DEFAULT_PLAY;
  const wanted = options.wanted ?? WANTED;
  const budget = options.budgetMs ?? BUDGET_MS;
  if (sameEnd(from, to)) return [];
  const open = openEnds(layout);
  const a = open.find((e) => sameEnd(e, from));
  const b = open.find((e) => sameEnd(e, to));
  if (!a || !b) return [];
  const za = a.connector.z ?? 0;
  const zb = b.connector.z ?? 0;
  const all = trackMoves();
  const climb = Math.abs(za - zb) > play.mm;
  const allowed = all.map((_, i) => i).filter((i) => (climb ? true : all[i].kind !== 'ramp'));

  // Only time spent working counts, not time between steps.
  let spent = 0;
  let resumed = performance.now();
  const over = () => spent + performance.now() - resumed > budget;
  const pause = function* (): Generator<Fill[], void> {
    spent += performance.now() - resumed;
    yield sorted();
    resumed = performance.now();
  };

  const fills: Fill[] = [];
  const sorted = () => [...fills].sort((x, y) => x.uids.length - y.uids.length || x.odd - y.odd || x.flex - y.flex);
  const seen = new Set<string>();
  /** Whether a run would cross itself: any two of its pieces, not next to each other, too close. */
  const crosses = (run: number[]): boolean => {
    const cell = CLEAR_MM;
    const grid = new Map<number, { p: Vec2; z: number; i: number }[]>();
    let pose = a.connector.pose;
    let z = za;
    for (let i = 0; i < run.length; i++) {
      const move = all[run[i]];
      const points = [...move.along.map((q) => ({ p: applyPose(pose, q), z: z + move.dz / 2 })), { p: applyPose(pose, move.step), z: z + move.dz }];
      for (const t of points) {
        const cx = Math.floor(t.p.x / cell);
        const cy = Math.floor(t.p.y / cell);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const o of grid.get(cellKey(cx + dx, cy + dy, 0, 0)) ?? []) {
              if (i - o.i >= 2 && Math.abs(o.z - t.z) < D.HEADROOM && Math.hypot(o.p.x - t.p.x, o.p.y - t.p.y) < CLEAR_MM) return true;
            }
          }
        }
        const k = cellKey(cx, cy, 0, 0);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push({ ...t, i });
      }
      pose = applyPose(pose, move.step);
      z += move.dz;
    }
    return false;
  };
  const tryRun = (f: Chain, g: Chain) => {
    const run = [...movesOf(f), ...movesOf(g).reverse().map((m) => all[m].reverse)];
    if (crosses(run)) return;
    const fill = build(layout, from, to, run, play, options);
    if (!fill) return;
    const key = describeKey(fill, layout);
    if (seen.has(key)) return;
    seen.add(key);
    fills.push(fill);
  };

  // Track already down, apart from the two pieces being joined: new track is meant to be close to those where it joins them.
  const occupied = new Occupancy(layout.pieces.filter((p) => p.uid !== a.uid && p.uid !== b.uid));
  const endPieces = new Occupancy(layout.pieces.filter((p) => p.uid === a.uid || p.uid === b.uid));
  const ends = [a.connector.pose, b.connector.pose];
  const free = (p: Vec2, z: number) =>
    !occupied.near({ p, z }, CLEAR_MM) && (!endPieces.near({ p, z }, CLEAR_MM) || ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 70));
  // Where track can go at all (on the table, out of the water), asked of a scrap of track at each
  // point, so chains don't wander off where no run built from them could be offered.
  const placeable = new Map<number, boolean>();
  const allowedAt = (pose: Pose, z: number): boolean => {
    if (!options.blocked) return true;
    const k = cellKey(pose.x / 10, pose.y / 10, pose.angle / (Math.PI / 8), z);
    let ok = placeable.get(k);
    if (ok === undefined) {
      const probe = { uid: 'probe', pieceId: 'straight-mini', flipped: false, pose: applyPose(pose, { x: -D.MINI_STRAIGHT / 2, y: 0, angle: 0 }), z };
      ok = [...options.blocked({ pieces: [probe] })].length === 0;
      placeable.set(k, ok);
    }
    return ok;
  };
  /** The ends are checked as exactly as chains are kept; points between, at about the height. */
  const clearMove = (p: Chain, move: TrackMove, pose: Pose, z: number) =>
    free(pose, z) &&
    allowedAt(pose, z) &&
    move.along.every((q) => {
      const at = applyPose(p.pose, q);
      return free(at, (p.z + z) / 2) && allowedAt(at, (p.z + z) / 2);
    });
  const clearChain = (c: Chain): boolean => {
    if (c.clear === undefined) {
      const p = c.parent;
      c.clear = !p || (clearChain(p) && clearMove(p, all[c.move], c.pose, c.z));
    }
    return c.clear;
  };

  // Near: every short chain from each end, matched against all from the other.
  const forward = grow(a.connector.pose, za, allowed, DEPTH_PER_SIDE);
  yield* pause();
  const backward = grow(b.connector.pose, zb, allowed, DEPTH_PER_SIDE);
  yield* pause();
  const backGrid = gridOf(backward);

  // Candidate runs by length, each with how far off it is before flexing.
  const byLength = new Map<number, { f: Chain; g: Chain; score: number }[]>();
  for (const f of forward) {
    for (const g of near(backGrid, f.pose)) {
      const n = f.depth + g.depth;
      if (n === 0 || Math.abs(f.z - g.z) > 0.5) continue;
      const e = jointError(f.pose, g.pose);
      // Each joint can turn only a little, so the ends must already nearly face each other.
      if (e.gapMm > MATCH_MM || e.angleDeg > play.deg * FILL_SHARE * (n + 1)) continue;
      if (!clearChain(f) || !clearChain(g)) continue;
      const score = e.gapMm / play.mm + e.angleDeg / play.deg;
      let list = byLength.get(n);
      if (!list) byLength.set(n, (list = []));
      list.push({ f, g, score });
    }
  }
  yield* pause();

  for (const n of [...byLength.keys()].sort((x, y) => x - y)) {
    const list = byLength.get(n)!.sort((x, y) => x.score - y.score).slice(0, TRIES_PER_LENGTH);
    for (const { f, g } of list) {
      if (fills.length >= wanted || over()) break;
      tryRun(f, g);
      yield* pause();
    }
    if (fills.length >= wanted || over()) break;
  }
  if (fills.length || over()) return sorted();

  // Far: beams from each end, each landing among the other end's short chains.
  const foreGrid = gridOf(forward);
  const turned = (p: Pose): Pose => ({ ...p, angle: normalizeAngle(p.angle + Math.PI) });
  const sides = [
    { front: [rootOf(a.connector.pose, za)], goal: turned(b.connector.pose), goalZ: zb, other: backGrid, seen: new Set<number>(), forward: true },
    { front: [rootOf(b.connector.pose, zb)], goal: turned(a.connector.pose), goalZ: za, other: foreGrid, seen: new Set<number>(), forward: false },
  ];
  let foundAt = -1;
  for (let layer = 1; !over(); layer++) {
    const candidates: { f: Chain; g: Chain; score: number }[] = [];
    for (const side of sides) {
      const next: (Chain & { score: number })[] = [];
      for (const chain of side.front) {
        for (const m of allowed) {
          const move = all[m];
          if (chain.z - move.lift < -1e-6) continue;
          const pose = applyPose(chain.pose, move.step);
          const nz = chain.z + move.dz;
          const key = beamKey(pose, nz);
          if (side.seen.has(key)) continue;
          side.seen.add(key);
          if (!clearMove(chain, move, pose, nz)) continue;
          const travelled = chain.travelled + move.length;
          next.push({ pose, z: nz, depth: layer, travelled, move: m, parent: chain, score: travelled + estimate(pose, nz, side.goal, side.goalZ) });
        }
      }
      next.sort((x, y) => x.score - y.score);
      // Best first, but spread out: only a few chains per patch of floor and heading, so
      // the beam doesn't all pile up against one obstacle with nothing left to go round it.
      const crowd = new Map<number, number>();
      side.front = [];
      for (const c of next) {
        if (side.front.length >= BEAM_WIDTH) break;
        const k = cellKey(c.pose.x / SPREAD_MM, c.pose.y / SPREAD_MM, c.pose.angle / (Math.PI / 4), c.z);
        const n = crowd.get(k) ?? 0;
        if (n >= PER_PATCH) continue;
        crowd.set(k, n + 1);
        side.front.push(c);
      }
      for (const c of side.front) {
        for (const o of near(side.other, c.pose)) {
          if (layer + o.depth <= NEAR_PIECES || Math.abs(c.z - o.z) > 0.5) continue;
          const e = jointError(c.pose, o.pose);
          if (e.gapMm > MATCH_MM || e.angleDeg > LONG_MATCH_DEG || !clearChain(o)) continue;
          const [f, g] = side.forward ? [c, o] : [o, c];
          candidates.push({ f, g, score: layer + o.depth + e.gapMm / play.mm / 10 + e.angleDeg / play.deg / 10 });
        }
      }
    }
    if (sides.every((s) => !s.front.length)) break;
    yield* pause();
    candidates.sort((x, y) => x.score - y.score);
    for (const { f, g } of candidates.slice(0, TRIES_PER_LAYER)) {
      if (fills.length >= wanted || over()) break;
      tryRun(f, g);
      yield* pause();
    }
    if (fills.length && foundAt < 0) foundAt = layer;
    if (fills.length >= wanted || (foundAt >= 0 && layer - foundAt >= MORE_LAYERS)) break;
  }
  return sorted();
}

/**
 * Up to a few ways to join the open ends `from` and `to` with plain track,
 * fewest pieces first, all at once. Empty when nothing is found in time.
 */
export function findFills(layout: Layout, from: EndRef, to: EndRef, options: FillOptions = {}): Fill[] {
  const search = searchFills(layout, from, to, options);
  for (;;) {
    const step = search.next();
    if (step.done) return step.value;
  }
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
  const all = trackMoves();
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
  const trouble = checkLayout(next, { play, traps: false }).some((i) => i.kind !== 'open-end' && i.uids.some((u) => added.has(u)));
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
