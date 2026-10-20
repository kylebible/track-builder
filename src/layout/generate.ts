import { canMate, DEFAULT_PLAY, placeToMate, type Play } from '../geometry/joint';
import { pathLength, poseAt } from '../geometry/path';
import { applyPose, normalizeAngle, type Pose, type Vec2 } from '../geometry/pose';
import { offered } from '../pieces/basic';
import { CATALOG, getPiece } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import type { Gender } from '../pieces/types';
import { checkLayout } from '../planning/check';
import { CRANE } from '../scenery/models';
import { getPlace, PLACES } from '../trains/stops';
import { layoutTraps, newTrapEntries } from '../trains/traps';
import { estimate, findFills, trackMoves, type Fill, type TrackMove, type Way } from './fill';
import { addPiece, baseOf, defOf, findPiece, sameEnd, worldEnd, type EndRef, type Layout } from './layout';
import { Occupancy } from './occupancy';
import { pickStops, type StopDef } from './stopPicks';

// Generate a section of track: a random run (or loop) of a given number of
// pieces, with switches leading off to sidings, a climb up a level, and
// stations, crossings and other things to stop at along it, as asked.
//
// It is laid a piece at a time from a start, the same way a tap on the
// palette adds a piece, choosing peg and hole versions so every joint is
// peg into hole. Each piece has to keep clear of track already down (and
// on the table); when one can't go anywhere, that try is dropped and
// another started. A loop is laid most of the way round, then closed with
// Fill gap's search. Whatever comes out has passed the layout check.

/** Plain straights and curves only, a few other kinds of track, or plenty. */
export type Variety = 'plain' | 'mixed' | 'lots';
const VARIETY: Record<Variety, number> = { plain: 0, mixed: 0.18, lots: 0.4 };

/** Go up a level along the way: not at all, up and back down, or up to finish raised. */
export type Climb = 'none' | 'over' | 'up';

export interface SectionOptions {
  /** Main line pieces, not counting sidings or things placed beside it. */
  pieces: number;
  /** Close it into a loop, rather than an open run with two ends. */
  loop: boolean;
  /** Share of the main line that curves, 0 to 1. */
  curves: number;
  /** Switches along it, each leading off to a short siding. */
  switches: number;
  /** How many of those switches lead off to a loop that comes back to the line further on, rather than a siding. */
  closed: number;
  /** End sidings with buffer stops, or leave them open to build on or fill from. */
  sidings: 'buffer' | 'open';
  climb: Climb;
  /** Stations, crossings, signals, trackside stops and the like along it. */
  stops: number;
  /** How often it reaches past plain straights and curves for other kinds of track: bendy and bumpy track, half curves, bridges. */
  variety: Variety;
  /** For each loop in turn, the job stop it goes out to; '' (or none given) for just a loop. */
  loopTo: string[];
  seed: number;
}

export const DEFAULT_SECTION: SectionOptions = {
  pieces: 14,
  loop: false,
  curves: 0.4,
  switches: 1,
  closed: 0,
  sidings: 'buffer',
  climb: 'none',
  stops: 1,
  variety: 'mixed',
  loopTo: [],
  seed: 1,
};

/** Job stops a loop can go out to: any place trains do work at, and car sidings, laid as a yard off the loop. */
export const LOOP_STOPS: readonly string[] = PLACES.filter((p) => p.id !== 'pump-house').map((p) => p.id);
/** Straights in a yard's dead-end road, before its buffer stop. */
const YARD_ROAD = 2;

export const MAX_SECTION_PIECES = 120;
/** As many stops as there could be room for: one on every other piece of the longest section. */
export const MAX_SECTION_STOPS = MAX_SECTION_PIECES / 2;

export interface GenerateContext {
  /** An open end to build on from; without one, the section starts loose at `at`. */
  start?: EndRef;
  at?: Vec2;
  play?: Play;
  /** Pieces with problems the layout check can't see (off the table, in the water). */
  blocked?: (layout: Layout) => Iterable<string>;
  /**
   * An open end for a run to finish at: it is laid most of the way with
   * everything asked for along it, then joined to this end with Fill gap's
   * search, as near the number of pieces asked for as it can.
   */
  goal?: EndRef;
  /** How long to keep trying, ms. */
  budgetMs?: number;
}

export interface Section {
  layout: Layout;
  /** Every piece it adds. */
  uids: string[];
  /** Main line pieces laid; fewer than asked when no more would fit. */
  laid: number;
  /** Whether a loop asked for was closed, or a run joined to the end it was to finish at. */
  closed: boolean;
  /** Things to stop at that it placed. */
  stops: number;
  switches: number;
  /** It makes a train trap: the only ways found shut trains in a loop. */
  trapped?: boolean;
  /** Switches that lead off to a loop back onto the line, each with the switch it rejoins by. */
  loops: number;
  /** Job stops placed out along those loops. */
  visits: number;
}

/** Things to stop at or look at along the line, and how each goes on. */
export const STOPS: readonly StopDef[] = [
  { id: 'station', how: 'seat' },
  { id: 'level-crossing', how: 'inline' },
  { id: 'signal', how: 'beside', offset: 55 },
  { id: 'tunnel', how: 'seat' },
  { id: 'lift-bridge', how: 'inline' },
  { id: 'cargo-loader', how: 'seat' },
  { id: 'crane', how: 'beside', offset: (CRANE.minReach + CRANE.maxReach) / 2 },
  // Not the pump house: it only works by a river or lake, which the generator can't promise.
  // Not car sidings either: they need a dead end, which only a loop's yard gets (see Attempt.yard).
  ...PLACES.filter((p) => p.id !== 'station' && p.id !== 'pump-house' && !p.spares).map((p): StopDef => ({ id: p.id, how: 'seat' })),
];

const CATALOG_IDS = new Set(CATALOG.map((p) => p.id));

/** Random numbers from a seed, the same every time for the same seed. */
function random(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick from `items`, more often the heavier ones. */
function weighted<T>(items: [T, number][], rand: () => number): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) if ((r -= w) <= 0) return item;
  return items[items.length - 1][0];
}

/** What goes in each place along the main line. */
type Slot =
  | { kind: 'plain' }
  /** A straight of just this length, or a curve this way: for loops laid to plan. */
  | { kind: 'length'; length: number }
  | { kind: 'curve'; dir: number }
  | { kind: 'straight' }
  | { kind: 'up' }
  | { kind: 'down' }
  /** In a loop: a curved switch, its siding off the outside. */
  | { kind: 'switch'; outward?: number }
  /** One end of a loop off the line: it leaves at the first switch and comes back at the second. */
  | { kind: 'loop'; pair: number; role: 'leave' | 'rejoin' }
  | { kind: 'stop'; stop: StopDef; length?: number };

/** A lettered piece, with one peg and one hole if it can: what most people have. */
const wayCost = (w: Way) => (w.attachGender === w.outGender ? 1 : 0) + (getPiece(w.pieceId).brioIds.length ? 0 : 0.5);

/** How far round a loop turns before it is closed. */
const LOOP_TURN = (3 * Math.PI) / 2;
/** Share of a loop's pieces laid before it is closed: the rest are Fill gap's. */
const LOOP_LAID = 0.7;

const SWITCHES: [string, number][] = [
  ['switch-curved', 4],
  ['switch-parallel', 2],
  ['switch-short-curved', 1],
  ['switch-parallel-new', 1],
  ['switch-three-way', 1],
];

/** Switches a loop leaves and rejoins the line by: a passing loop beside it, or a wider one round. */
const LOOP_SWITCHES: [string, number][] = [
  ['switch-parallel', 2],
  ['switch-curved', 2],
];

/** One go at laying a section; dropped as soon as a piece won't fit. */
class Attempt {
  layout: Layout;
  readonly uids: string[] = [];
  readonly occupied: Occupancy;
  /** The end the main line goes on from. */
  end: EndRef | null = null;
  /** The main line's first end, when it started loose: where a loop closes back to. */
  first: EndRef | null = null;
  laid = 0;
  switches = 0;
  closed = false;
  /** Straights put down to seat things on, or stand things beside, once the line is down. */
  readonly seats: { uid: string; stop: StopDef; visit?: boolean }[] = [];
  stops = 0;
  /** Laying the last pieces of a loop, which meet its first. */
  closing = false;
  /** Which way, and how far, the line has turned so far: for loops. */
  turned = 0;
  /** Pieces Fill gap is left to join a run to its goal end with. */
  aim = 0;
  /** Switches and stops the plan found places for. */
  planned = { switches: 0, stops: 0, loops: 0, visits: 0 };
  /** Loops left open at the switch they leave by, waiting for the one they rejoin by. */
  leaving: Leaving[] = [];
  /** Loops with both switches down, to join up once the line is laid. */
  readonly loopsToJoin: { pair: number; from: EndRef; to: EndRef }[] = [];
  loops = 0;
  /** Job stops placed out along loops. */
  visits = 0;

  constructor(
    base: Layout,
    private readonly rand: () => number,
    private readonly ctx: GenerateContext,
  ) {
    this.layout = base;
    this.occupied = new Occupancy(base.pieces);
    this.keepApproachClear();
  }

  /**
   * Keep the way into a goal end clear while the run is laid, so Fill gap
   * has room to come in to it: a long straight's worth of floor out from
   * the end counts as taken, unless track is already there.
   */
  private keepApproachClear(): void {
    if (!this.ctx.goal) return;
    const at = worldEnd(this.layout, this.ctx.goal).connector;
    const def = defOf({ pieceId: 'straight-long', flipped: false });
    const piece = { uid: 'approach', pieceId: 'straight-long', flipped: false, pose: placeToMate(at.pose, def, 'a'), z: at.z ?? 0 };
    if (this.occupied.piece(piece, new Set([this.ctx.goal.uid]))) return;
    // Nor where the run starts from.
    const start = this.ctx.start && worldEnd(this.layout, this.ctx.start).connector;
    if (start && new Occupancy([piece]).hits({ p: start.pose, z: start.z ?? 0 }, undefined, 120)) return;
    this.occupied.add(piece);
  }

  private gender(end: EndRef): Gender {
    return worldEnd(this.layout, end).connector.gender;
  }

  height(end: EndRef): number {
    return worldEnd(this.layout, end).connector.z ?? 0;
  }

  /** Put a piece on, if it keeps clear of everything. Its uid, or null. */
  place(from: EndRef, pieceId: string, flipped: boolean, attach?: string): string | null {
    return this.placed(from, pieceId, flipped, attach)?.uid ?? null;
  }

  private placed(from: EndRef, pieceId: string, flipped: boolean, attach?: string): { uid: string; attached: string } | null {
    const ext = this.extend(from, pieceId, flipped, attach);
    if (!ext) return null;
    const piece = findPiece(ext.layout, ext.uid);
    const ignore = new Set([from.uid]);
    // A loop's last pieces come round to meet its first.
    if (this.closing && this.first) ignore.add(this.first.uid);
    if (this.occupied.piece(piece, ignore)) return null;
    if (this.ctx.blocked && [...this.ctx.blocked({ pieces: [piece] })].length) return null;
    this.layout = ext.layout;
    this.occupied.add(piece);
    this.uids.push(ext.uid);
    return { uid: ext.uid, attached: ext.attached };
  }

  /**
   * `extendFrom` without working out the new piece's open end, which means
   * finding every joint in the layout: too slow for laying hundreds of tries.
   */
  private extend(from: EndRef, pieceId: string, flipped: boolean, attach?: string): { layout: Layout; uid: string; attached: string } | null {
    const target = worldEnd(this.layout, from).connector;
    const def = defOf({ pieceId, flipped });
    const c = def.connectors.find((k) => (attach ? k.id === attach : true) && k.gender !== target.gender && (target.z ?? 0) - (k.z ?? 0) > -1e-6);
    if (!c) return null;
    const added = addPiece(this.layout, pieceId, placeToMate(target.pose, def, c.id), flipped, (target.z ?? 0) - (c.z ?? 0));
    return { ...added, attached: c.id };
  }

  /** Start loose at `at`, with a long straight pointing one of eight ways. */
  startLoose(at: Vec2, place: (angle: number) => Pose = (angle) => ({ ...at, angle }), ok: (angle: number) => boolean = () => true): boolean {
    for (const turn of shuffle([0, 1, 2, 3, 4, 5, 6, 7], this.rand)) {
      if (!ok(normalizeAngle((turn * Math.PI) / 4))) continue;
      const added = addPiece(this.layout, 'straight-long', place(normalizeAngle((turn * Math.PI) / 4)));
      const piece = findPiece(added.layout, added.uid);
      if (this.occupied.piece(piece)) continue;
      if (this.ctx.blocked && [...this.ctx.blocked({ pieces: [piece] })].length) continue;
      this.layout = added.layout;
      this.occupied.add(piece);
      this.uids.push(added.uid);
      this.first = { uid: added.uid, connectorId: 'a' };
      this.end = { uid: added.uid, connectorId: 'b' };
      this.laid = 1;
      return true;
    }
    return false;
  }

  /**
   * Add one plain piece of `moves` (tried in the order given) onto `from`,
   * in whichever peg and hole version fits; a two-hole or two-peg straight
   * goes in first if no version of the piece fits that end.
   */
  plain(from: EndRef, moves: TrackMove[]): { uid: string; move: TrackMove; out: EndRef } | null {
    const g = this.gender(from);
    const z = this.height(from);
    for (const move of moves) {
      if (z - move.lift < -1e-6) continue;
      const ways = move.ways.filter((w) => w.attachGender !== g).sort((x, y) => wayCost(x) - wayCost(y));
      for (const way of ways) {
        const uid = this.place(from, way.pieceId, way.flipped, way.attach);
        if (uid) return { uid, move, out: { uid, connectorId: way.out } };
      }
      if (!ways.length) {
        // Turn the end round with a two-peg or two-hole straight first.
        const changer = trackMoves()
          .filter((m) => m.kind === 'straight')
          .flatMap((m) => m.ways)
          .filter((w) => w.attachGender !== g && w.outGender === w.attachGender)
          .sort((x, y) => pathLength(defOf(x).paths[0]) - pathLength(defOf(y).paths[0]))[0];
        if (!changer) continue;
        const was = this.snapshot();
        const uid = this.place(from, changer.pieceId, changer.flipped, changer.attach);
        if (!uid) continue;
        const next = this.plain({ uid, connectorId: changer.out }, [move]);
        if (next) return next;
        this.restore(was);
      }
    }
    return null;
  }

  /** Everything about the attempt so far, to come back to after a dead end. */
  save(): Saved {
    return {
      layout: this.layout,
      n: this.uids.length,
      end: this.end,
      laid: this.laid,
      switches: this.switches,
      stops: this.stops,
      seats: [...this.seats],
      leaving: [...this.leaving],
      loopsToJoin: [...this.loopsToJoin],
      turned: this.turned,
      lastTurn: this.lastTurn,
    };
  }

  load(saved: Saved): void {
    this.restore(saved);
    Object.assign(this, { end: saved.end, laid: saved.laid, switches: saved.switches, stops: saved.stops, turned: saved.turned, lastTurn: saved.lastTurn });
    this.seats.splice(0, this.seats.length, ...saved.seats);
    this.leaving = [...saved.leaving];
    this.loopsToJoin.splice(0, this.loopsToJoin.length, ...saved.loopsToJoin);
  }

  /** Whether there's open floor (or table) ahead of a pose, worth heading into. */
  private roomAhead(pose: Pose, z: number): boolean {
    for (const ahead of [60, 160, 360]) {
      const p = applyPose(pose, { x: ahead, y: 0, angle: 0 });
      if (this.occupied.hits({ p, z }, undefined, 60)) return false;
      if (this.ctx.blocked && [...this.ctx.blocked({ pieces: [{ uid: 'probe', pieceId: 'straight-mini', flipped: false, pose: { ...p, angle: pose.angle } }] })].length) return false;
    }
    return true;
  }

  /** Whether there's room past the end of the line to build on from it. */
  roomToGoOn(): boolean {
    const at = worldEnd(this.layout, this.end!).connector;
    return this.roomAhead(at.pose, at.z ?? 0);
  }

  /** `moves` with the ones that leave room ahead first, otherwise in the same order. */
  private roomy(end: EndRef, moves: TrackMove[]): TrackMove[] {
    const at = worldEnd(this.layout, end).connector;
    const z = at.z ?? 0;
    const ok = moves.map((m) => this.roomAhead(applyPose(at.pose, m.step), z + m.dz));
    return [...moves.filter((_, i) => ok[i]), ...moves.filter((_, i) => !ok[i])];
  }

  private snapshot() {
    return { layout: this.layout, n: this.uids.length };
  }

  /** Take back pieces put down since `was`. */
  private restore(was: { layout: Layout; n: number }): void {
    const kept = new Set(was.layout.pieces.map((p) => p.uid));
    for (const piece of this.layout.pieces) if (!kept.has(piece.uid)) this.occupied.remove(piece);
    this.layout = was.layout;
    this.uids.length = was.n;
  }

  /** Lay one place along the main line. */
  slot(slot: Slot, opts: SectionOptions, remaining: number): boolean {
    const end = this.end!;
    const all = trackMoves();
    const rand = this.rand;
    const z = this.height(end);
    const flat = (m: TrackMove) => m.dz === 0;
    const straights = (lengths?: number[]) =>
      shuffle(
        all.filter((m) => m.kind === 'straight' && flat(m) && (!lengths || lengths.some((l) => Math.abs(l - m.length) < 1))),
        rand,
      ).sort((x, y) => straightWeight(y) * rand() - straightWeight(x) * rand());
    const curves = (dir: number) =>
      shuffle(all.filter((m) => m.kind === 'curve' && flat(m) && Math.sign(m.step.angle) === dir), rand).sort(
        (x, y) => curveWeight(y) * rand() - curveWeight(x) * rand(),
      );

    let laid: { uid: string; move: TrackMove; out: EndRef } | null = null;
    switch (slot.kind) {
      case 'length':
        laid = this.plain(end, straights().filter((m) => Math.abs(m.length - slot.length) < 1));
        break;
      case 'curve':
        laid = this.plain(end, curves(slot.dir).filter((m) => m.length > 120));
        break;
      case 'plain':
      case 'straight': {
        const dir = this.direction(opts, remaining, slot.kind === 'straight');
        // Now and then another kind of track in its place.
        if (slot.kind === 'plain' && rand() < VARIETY[opts.variety ?? 'plain'] && this.special(dir)) return true;
        const order = dir ? [...curves(dir), ...straights()] : [...straights(), ...curves(rand() < 0.5 ? 1 : -1)];
        laid = this.plain(end, this.roomy(end, order));
        break;
      }
      case 'up':
        if (z > 1) return this.slot({ kind: 'straight' }, opts, remaining);
        // A curved ramp, now and then, on an open run: a loop's corners are planned.
        if (!opts.loop && rand() < VARIETY[opts.variety ?? 'plain'] && this.specialOf(['ramp-curve'], rand() < 0.5 ? 1 : -1)) return true;
        laid = this.plain(end, all.filter((m) => m.kind === 'ramp' && m.dz > 0));
        break;
      case 'down':
        if (z < D.LEVEL_HEIGHT - 1) return this.slot({ kind: 'straight' }, opts, remaining);
        laid = this.plain(end, all.filter((m) => m.kind === 'ramp' && m.dz < 0));
        break;
      case 'loop':
        return this.loopSlot(slot.pair, slot.role, opts) || this.slot({ kind: 'straight' }, opts, remaining);
      case 'switch':
        return (
          this.switchSlot(opts, slot.outward) ||
          this.slot(slot.outward ? { kind: 'length', length: D.MEDIUM_STRAIGHT } : { kind: 'straight' }, opts, remaining)
        );
      case 'stop':
        return this.stopSlot(slot.stop) || this.slot(slot.length ? { kind: 'length', length: slot.length } : { kind: 'plain' }, opts, remaining);
    }
    if (!laid) return false;
    this.turned += laid.move.step.angle;
    this.end = laid.out;
    this.laid++;
    return true;
  }

  /**
   * Another kind of track for a plain place along the line, going the way
   * `dir` says: bumpy track or an arch bridge for a straight on the floor,
   * a bridge span up a level, half curves or bendy track for a bend.
   */
  private special(dir: number): boolean {
    const high = this.height(this.end!) >= D.LEVEL_HEIGHT - 1;
    const ids = dir
      ? ['curve-large-half', 'curve-short-half', 'bendy-b2', 'bendy-b3', 'bendy-b4', 'bendy-b6', ...(high ? ['bridge-viaduct-curved'] : [])]
      : high
        ? ['bridge-truss', 'bridge-covered', 'bridge-viaduct', 'bridge-suspension']
        : ['bumpy', 'arch-bridge', 'bumpy'];
    return this.specialOf(shuffle(ids, this.rand), dir || (this.rand() < 0.5 ? 1 : -1));
  }

  /** The first of `ids` (or its two-peg or two-hole version) that goes on the end of the line, turning `dir`. */
  private specialOf(ids: string[], dir: number): boolean {
    const end = this.end!;
    const before = worldEnd(this.layout, end).connector.pose.angle;
    for (const base of ids) {
      for (const id of [base, `${base}-pp`, `${base}-hh`]) {
        if (!CATALOG_IDS.has(id) || !offered(getPiece(id))) continue;
        const def = getPiece(id);
        if (def.connectors.length !== 2) continue;
        // In by an end of the other kind, at or below the line's height; out by its other end.
        const placed = this.placed(end, id, dir < 0);
        if (!placed) continue;
        const out = def.connectors.find((c) => c.id !== placed.attached)!;
        this.end = { uid: placed.uid, connectorId: out.id };
        // Turned by how far its far end points from straight on.
        this.turned += normalizeAngle(worldEnd(this.layout, this.end).connector.pose.angle - before);
        this.laid++;
        return true;
      }
    }
    return false;
  }

  /**
   * Which way the next plain piece turns: 0 for straight on. A loop has to
   * turn all the way round, so it leans one way and turns more as it runs
   * out of pieces; an open run wanders, turning back before it doubles over.
   */
  private direction(opts: SectionOptions, remaining: number, straight: boolean): number {
    if (straight) return 0;
    const eighth = Math.PI / 4;
    if (opts.loop) {
      // Three quarters of the way round by the last piece, leaving the rest for Fill gap to close.
      const need = (LOOP_TURN - this.turned) / eighth;
      if (need >= remaining - 0.5) return 1;
      if (need <= 0.5) return 0;
      if (this.rand() >= Math.max(opts.curves, need / remaining)) return 0;
      return this.rand() < 0.85 ? 1 : -1;
    }
    const toward = this.toward(remaining);
    if (toward !== null) return toward;
    if (this.rand() >= opts.curves) return 0;
    if (Math.abs(this.turned) >= Math.PI - 1e-6) return -Math.sign(this.turned);
    // Bends of two or three curves read better than single kinks.
    const last = this.lastTurn;
    const dir = last && this.rand() < 0.65 ? last : this.rand() < 0.5 ? 1 : -1;
    this.lastTurn = dir;
    return dir;
  }
  lastTurn = 0;

  /** How many pieces it would take to get from the end of the line to the goal end, and which way that is. */
  toGoal(): { pieces: number; turn: number } | null {
    if (!this.ctx.goal || !this.end) return null;
    const here = worldEnd(this.layout, this.end).connector;
    const there = worldEnd(this.layout, this.ctx.goal).connector;
    // Heading for the mouth of the way in, kept clear in front of the end.
    const mouth = applyPose(there.pose, { x: APPROACH_MM, y: 0, angle: 0 });
    const goal: Pose = { ...mouth, angle: normalizeAngle(there.pose.angle + Math.PI) };
    const pieces = (estimate(here.pose, here.z ?? 0, goal, there.z ?? 0) + APPROACH_MM) / PIECE_MM;
    const turn = normalizeAngle(Math.atan2(goal.y - here.pose.y, goal.x - here.pose.x) - here.pose.angle);
    return { pieces, turn };
  }

  /**
   * Heading for the goal end: which way to turn, once wandering any more
   * would leave it too far to reach in the pieces left. Null to wander.
   */
  private toward(remaining: number): number | null {
    const to = this.toGoal();
    if (!to || to.pieces + 1 < remaining + this.aim) return null;
    if (Math.abs(to.turn) < Math.PI / 8) return 0;
    return Math.sign(to.turn);
  }

  /** A switch onto the main line, with a short siding off its other branch. */
  private switchSlot(opts: SectionOptions, outward?: number): boolean {
    const end = this.end!;
    const g = this.gender(end);
    for (let tries = 0; tries < 4; tries++) {
      // A loop's switches run straight through for a medium straight's length, so it still closes.
      const base = outward ? 'switch-curved' : weighted(SWITCHES, this.rand);
      const facing = this.rand() < 0.6;
      // Curved switches branch left unless turned over.
      const flipped = outward ? outward < 0 : this.rand() < 0.5;
      const attach = facing ? 'trunk' : 'branch0';
      const id = [base, `${base}-peg`].find((v) => getPiece(v).connectors.find((c) => c.id === attach)!.gender !== g)!;
      if (!offered(getPiece(id))) continue;
      const was = this.snapshot();
      const uid = this.place(end, id, flipped, attach);
      if (!uid) continue;
      // A siding off every branch the line doesn't run on through.
      const out = facing ? 'branch0' : 'trunk';
      const spare = getPiece(id).connectors.map((c) => c.id).filter((c) => c !== attach && c !== out);
      if (!spare.every((c) => this.siding({ uid, connectorId: c }, opts))) {
        this.restore(was);
        continue;
      }
      this.end = { uid, connectorId: out };
      this.laid++;
      this.switches++;
      return true;
    }
    return false;
  }

  /**
   * A switch where a loop leaves the line, facing, or the one where it
   * comes back, trailing with its branch on the same side; the loop
   * between them is joined up once the line is laid.
   */
  private loopSlot(pair: number, role: 'leave' | 'rejoin', opts: SectionOptions): boolean {
    const end = this.end!;
    const g = this.gender(end);
    const leaving = this.leaving.find((l) => l.pair === pair);
    // The loop never left: a plain switch and siding here instead.
    if (role === 'rejoin' && !leaving) return this.switchSlot(opts);
    const attach = role === 'leave' ? 'trunk' : 'branch0';
    const out = role === 'leave' ? 'branch0' : 'trunk';
    const base = leaving?.base ?? weighted(LOOP_SWITCHES.filter(([b]) => offered(getPiece(b))), this.rand);
    for (const flipped of shuffle([false, true], this.rand)) {
      const id = [base, `${base}-peg`].find((v) => getPiece(v).connectors.find((c) => c.id === attach)!.gender !== g);
      if (!id || !offered(getPiece(id))) continue;
      const was = this.snapshot();
      const uid = this.place(end, id, flipped, attach);
      if (!uid) continue;
      const side = this.sideOf(uid, attach, out);
      if (leaving && side !== leaving.side) {
        this.restore(was);
        continue;
      }
      if (leaving) {
        this.leaving = this.leaving.filter((l) => l !== leaving);
        this.loopsToJoin.push({ pair, from: leaving.end, to: { uid, connectorId: 'branch1' } });
      } else {
        this.leaving = [...this.leaving, { pair, end: { uid, connectorId: 'branch1' }, side, base }];
      }
      this.end = { uid, connectorId: out };
      this.laid++;
      // Counted once for the loop, by the switch it leaves by.
      if (!leaving) this.switches++;
      return true;
    }
    return false;
  }

  /** Which side of the line a switch's branch goes off, going the way the line runs. */
  private sideOf(uid: string, inn: string, out: string): number {
    const at = (c: string) => worldEnd(this.layout, { uid, connectorId: c }).connector.pose;
    const a = at(inn);
    const b = at(out);
    const c = at('branch1');
    return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  }

  /**
   * Join up each loop between the switches it leaves and rejoins by, with
   * Fill gap; one that won't join gets sidings off both instead.
   */
  joinLoops(opts: SectionOptions, play: Play, budgetMs: number): void {
    const ends = [...this.loopsToJoin.map((l) => [l.from, l.to, l.pair] as const), ...this.leaving.map((l) => [l.end, null, l.pair] as const)];
    this.loopsToJoin.length = 0;
    this.leaving = [];
    for (const [from, to, pair] of ends) {
      const id = opts.loopTo?.[pair] ?? '';
      const stop: StopDef | undefined = LOOP_STOPS.includes(id) && offered(getPiece(id)) ? { id, how: 'seat' } : undefined;
      if (to && this.joinLoop(from, to, play, budgetMs, stop)) {
        this.loops++;
        continue;
      }
      for (const end of to ? [from, to] : [from]) this.siding(end, opts);
    }
  }

  /**
   * One loop: out from the line to somewhere well off it, then back by
   * Fill gap. Nearer in if that won't fit, and right beside the line last.
   */
  private joinLoop(from: EndRef, to: EndRef, play: Play, budgetMs: number, stop?: StopDef): boolean {
    const far = LOOP_REACH[0] + this.rand() * (LOOP_REACH[1] - LOOP_REACH[0]);
    for (const reach of [far, far * 0.6, 0]) {
      const was = this.snapshot();
      const seats = this.seats.length;
      let out = reach ? this.venture(from, to, reach) : from;
      // The job stop it goes out to, out at the far end.
      if (out && stop) out = this.visit(out, stop);
      if (out) {
        const fills = findFills(this.layout, out, to, { wanted: 1, budgetMs, play, blocked: this.ctx.blocked });
        if (fills.length) {
          this.layout = fills[0].layout;
          for (const uid of fills[0].uids) this.occupied.add(findPiece(this.layout, uid));
          this.uids.push(...fills[0].uids);
          return true;
        }
      }
      this.seats.length = seats;
      this.restore(was);
    }
    return false;
  }

  /** Seat a job stop on a straight laid on from `from`, kept apart from the stops along the line. Where to carry on from, or null. */
  private visit(from: EndRef, stop: StopDef): EndRef | null {
    if (getPlace(stop.id)?.spares) return this.yard(from, stop);
    const end = this.end;
    const laid = this.laid;
    this.end = from;
    const ok = this.stopSlot(stop, true);
    const out = this.end;
    this.end = end;
    this.laid = laid;
    return ok ? out : null;
  }

  /**
   * A yard off a loop: a switch trailing for trains coming round, so an
   * engine can pass it and back in, with a dead-end road to a buffer stop
   * off its branch and the stop's sign beside the road. Where the loop
   * carries on from, or null.
   */
  private yard(from: EndRef, stop: StopDef): EndRef | null {
    const g = this.gender(from);
    const base = weighted(LOOP_SWITCHES.filter(([b]) => offered(getPiece(b))), this.rand);
    const straights = trackMoves().filter((m) => m.kind === 'straight' && m.dz === 0 && m.length >= D.LONG_STRAIGHT - 1);
    for (const flipped of shuffle([false, true], this.rand)) {
      const id = [base, `${base}-peg`].find((v) => getPiece(v).connectors.find((c) => c.id === 'branch0')!.gender !== g);
      if (!id || !offered(getPiece(id))) continue;
      const was = this.snapshot();
      const seats = this.seats.length;
      const uid = this.place(from, id, flipped, 'branch0');
      let road: string | null = null;
      let end: EndRef | null = uid ? { uid, connectorId: 'branch1' } : null;
      for (let i = 0; end && i < YARD_ROAD; i++) {
        const laid = this.plain(end, shuffle(straights, this.rand));
        road ??= laid?.uid ?? null;
        end = laid?.out ?? null;
      }
      if (uid && road && end && this.place(end, this.gender(end) === 'peg' ? 'buffer' : 'buffer-peg', false)) {
        this.seats.push({ uid: road, stop, visit: true });
        return { uid, connectorId: 'trunk' };
      }
      this.seats.length = seats;
      this.restore(was);
    }
    return null;
  }

  /**
   * Lay track from where a loop leaves the line out towards a point `reach`
   * mm off it, beside the middle of the loop; null if it can't get there.
   */
  private venture(from: EndRef, to: EndRef, reach: number): EndRef | null {
    const a = worldEnd(this.layout, from).connector;
    const b = worldEnd(this.layout, to).connector.pose;
    const ux = b.x - a.pose.x;
    const uy = b.y - a.pose.y;
    const len = Math.hypot(ux, uy) || 1;
    // Off the line on the side the loop leaves by: where its branch ends, from where the switch starts.
    const t = worldEnd(this.layout, { uid: from.uid, connectorId: 'trunk' }).connector.pose;
    const side = Math.sign(ux * (a.pose.y - t.y) - uy * (a.pose.x - t.x)) || 1;
    const target = { x: (a.pose.x + b.x) / 2 - (side * uy * reach) / len, y: (a.pose.y + b.y) / 2 + (side * ux * reach) / len };
    const moves = trackMoves().filter((m) => m.dz === 0 && m.kind !== 'ramp' && m.length >= 100);
    // How far from the target a pose leaves it, looking a little ahead of where it points.
    const miss = (p: Pose) => Math.hypot(p.x + Math.cos(p.angle) * 150 - target.x, p.y + Math.sin(p.angle) * 150 - target.y);
    let end = from;
    for (let i = 0; i < LOOP_VENTURE_PIECES; i++) {
      const at = worldEnd(this.layout, end).connector;
      if (Math.hypot(at.pose.x - target.x, at.pose.y - target.y) < 200) return end;
      const order = shuffle(moves, this.rand).sort((m, n) => miss(applyPose(at.pose, m.step)) - miss(applyPose(at.pose, n.step)));
      const laid = this.plain(end, this.roomy(end, order.slice(0, 4)));
      if (!laid) return null;
      end = laid.out;
    }
    const at = worldEnd(this.layout, end).connector.pose;
    return Math.hypot(at.x - target.x, at.y - target.y) < 350 ? end : null;
  }

  /** One to three pieces off a switch's branch, ending in a buffer stop if asked. */
  private siding(from: EndRef, opts: SectionOptions): boolean {
    const all = trackMoves().filter((m) => m.dz === 0 && (m.kind === 'straight' ? m.length >= D.SHORT_STRAIGHT : m.kind === 'curve'));
    const length = 1 + Math.floor(this.rand() * 3);
    let end = from;
    for (let i = 0; i < length; i++) {
      const order = shuffle(all, this.rand).sort((x, y) => (x.kind === 'straight' ? 0 : 1) - (y.kind === 'straight' ? 0 : 1) + (this.rand() - 0.5));
      const laid = this.plain(end, order);
      if (!laid) break;
      end = laid.out;
    }
    if (opts.sidings === 'open') return true;
    const g = this.gender(end);
    return !!this.place(end, g === 'peg' ? 'buffer' : 'buffer-peg', false);
  }

  /** A straight to seat something on or stand something beside, or a crossing or bridge that is itself track. */
  private stopSlot(stop: StopDef, visit = false): boolean {
    const end = this.end!;
    if (stop.how === 'inline') {
      const placed = this.placed(end, stop.id, false);
      if (!placed) return false;
      // Carry on from its other end, whichever end it went on by.
      const other = getPiece(stop.id).connectors.find((c) => c.id !== placed.attached)!;
      this.end = { uid: placed.uid, connectorId: other.id };
      this.laid++;
      this.stops++;
      return true;
    }
    const laid = this.plain(
      end,
      trackMoves().filter((m) => m.kind === 'straight' && m.dz === 0 && m.length >= D.LONG_STRAIGHT - 1),
    );
    if (!laid) return false;
    this.seats.push({ uid: laid.uid, stop, visit });
    this.end = laid.out;
    this.laid++;
    return true;
  }

  /** Seat or stand the stops beside the straights kept for them. */
  placeStops(): void {
    for (const { uid, stop, visit } of this.seats) {
      const piece = findPiece(this.layout, uid);
      const path = defOf(piece).paths[0];
      const mid = applyPose(piece.pose, poseAt(path, pathLength(path) / 2));
      const z = baseOf(piece);
      if (stop.how === 'seat') {
        const turned = this.rand() < 0.5 ? Math.PI : 0;
        const holds = getPiece(stop.id).holdsTrackAt ?? 0;
        this.layout = addPiece(this.layout, stop.id, { ...mid, angle: normalizeAngle(mid.angle + turned) }, false, z - holds).layout;
        this.uids.push(this.layout.pieces[this.layout.pieces.length - 1].uid);
        if (visit) this.visits++;
        else this.stops++;
        continue;
      }
      // Beside the track, on whichever side is clear.
      for (const side of shuffle([1, -1], this.rand)) {
        const offset = stop.offset ?? 60;
        const spot = applyPose(mid, { x: 0, y: side * offset, angle: 0 });
        if (this.occupied.hits({ p: spot, z }, new Set(), 40)) continue;
        // A signal faces trains coming towards it; either way along the line will do.
        const pose: Pose = { ...spot, angle: normalizeAngle(mid.angle + (stop.id === 'signal' ? Math.PI : 0)) };
        this.layout = addPiece(this.layout, stop.id, pose, false, z).layout;
        this.uids.push(this.layout.pieces[this.layout.pieces.length - 1].uid);
        this.stops++;
        break;
      }
    }
  }

  /**
   * Close a loop back to its first end, or join a run to its goal end, with
   * Fill gap's search, unless it already meets it. For a run, the fill that
   * brings it nearest `pieces` long.
   */
  close(play: Play, budgetMs: number, pieces?: number): boolean {
    const to = this.ctx.goal ?? this.first;
    if (!to || !this.end) return false;
    if (canMate(worldEnd(this.layout, this.end).connector, worldEnd(this.layout, to).connector, play)) {
      this.closed = true;
      return true;
    }
    const fills = findFills(this.layout, this.end, to, { wanted: pieces ? 6 : 1, budgetMs, play, blocked: this.ctx.blocked });
    if (!fills.length) return false;
    const off = (f: Fill) => (pieces ? Math.abs(this.laid + f.uids.length - pieces) : 0);
    const fill = fills.reduce((best, f) => (off(f) < off(best) ? f : best));
    this.layout = fill.layout;
    this.uids.push(...fill.uids);
    this.laid += fill.uids.length;
    this.closed = true;
    return true;
  }
}

/** A loop that has left the line by a switch, and which side of the line it went. */
interface Leaving {
  pair: number;
  end: EndRef;
  side: number;
  base: string;
}

interface Saved {
  layout: Layout;
  n: number;
  end: EndRef | null;
  laid: number;
  switches: number;
  stops: number;
  seats: { uid: string; stop: StopDef; visit?: boolean }[];
  leaving: Leaving[];
  loopsToJoin: { pair: number; from: EndRef; to: EndRef }[];
  turned: number;
  lastTurn: number;
}

/** About how long a piece of the main line is, for guessing how many it takes to get somewhere. */
const PIECE_MM = 160;
/** How far out in front of a goal end the way in is kept clear. */
const APPROACH_MM = D.LONG_STRAIGHT;
/** Most pieces left for Fill gap to join a run to its goal end with: a short gap is quick to search. */
const GOAL_FILL = 6;
/** How long Fill gap gets to join each try to its goal end: a short gap is found quickly, or not at all. */
const GOAL_FILL_MS = 250;
/** Pieces a run to a goal end may take back up, one at a time, to find a place Fill gap can join it from. */
const GOAL_BACK_UP = 3;

/** How long Fill gap gets to join up each loop off the line. */
const LOOP_JOIN_MS = 400;
/** Places between the switches a loop leaves and rejoins the line by. */
const LOOP_SPAN = [3, 5];
/** How far off the line a loop goes out to, mm. */
const LOOP_REACH = [450, 1000];
/** Most pieces a loop lays heading out, before Fill gap brings it back. */
const LOOP_VENTURE_PIECES = 10;

/** Tries at a loop laid to plan before falling back to closing one with Fill gap. */
const LOOP_PLANS = 60;
/** Dead ends a try may back out of, a few pieces at a time, before it's given up. */
const BACKTRACKS = 60;

/** Long and medium straights are what most boxes are full of. */
function straightWeight(m: TrackMove): number {
  if (m.length >= D.LONG_STRAIGHT - 1) return 3;
  if (m.length >= D.MEDIUM_STRAIGHT - 1) return 3;
  if (m.length >= D.SHORT_STRAIGHT - 1) return 1.2;
  return 0.4;
}

function curveWeight(m: TrackMove): number {
  return m.length > 120 ? 3 : 1;
}

/** How long a stop's own place along the line is. */
const stopLength = (stop: StopDef) => (stop.id === 'level-crossing' ? D.MEDIUM_STRAIGHT : D.LONG_STRAIGHT);

/**
 * Plan a loop that closes by itself: four corners of two curves each, and
 * four sides of straights, opposite sides the same length (in a different
 * order) so it comes back exactly to where it started. Switches, stops and
 * a climb go along the sides, each matched by a straight as long on the
 * side across. Starts with the long straight already down.
 */
function planLoop(opts: SectionOptions, stops: readonly StopDef[], rand: () => number, compact = 0): Slot[] | null {
  const dir = 1;
  const items: { slot: Slot; length: number }[] = [];
  for (let k = 0; k < opts.switches; k++) items.push({ slot: { kind: 'switch', outward: -dir }, length: D.MEDIUM_STRAIGHT });
  const climb = opts.climb !== 'none';
  // Corners, and the pieces in sides A and C (B and D) each.
  const inCorner = opts.pieces >= 20 && rand() < 0.35 ? 1 : 0;
  // Less the long straight it starts with and the one across from it.
  const rest = opts.pieces - 8 - 4 * inCorner - (climb ? 3 : 0) - 2;
  // As many stops as there's room for along the sides.
  for (const stop of stops.slice(0, Math.max(0, Math.min(opts.stops, rest - items.length)))) items.push({ slot: { kind: 'stop', stop, length: stopLength(stop) }, length: stopLength(stop) });
  if (rest < 2 * Math.ceil(items.length / 2)) return null;
  const across = Math.floor((rest / 2) * (0.15 + rand() * 0.3));
  const along = Math.floor(rest / 2) - across;
  if (along < 1) return null;
  // Specials along the long sides, taking turns, and the short sides once those are full.
  const sides: { slot: Slot; length: number }[][] = [[], [], [], []];
  items.forEach((item, i) => {
    const long = sides[0].length + sides[2].length < along;
    sides[(long ? 0 : 1) + 2 * (i % 2)].push(item);
  });
  const straight = (): number =>
    weighted(
      [
        [D.LONG_STRAIGHT, 3 * (1 - compact)],
        [D.MEDIUM_STRAIGHT, 3],
        [D.SHORT_STRAIGHT, 1 + 3 * compact],
      ],
      rand,
    );
  // Each side's pieces as lengths: its own specials, room for the specials across, then plain straights.
  const sideSlots = (a: number, count: number): [Slot[], Slot[]] | null => {
    const c = (a + 2) % 4;
    const mine = sides[a];
    const theirs = sides[c];
    // Lengths both sides share: one for each special on either side, then plain ones.
    const lengths = [...mine.map((i) => i.length), ...theirs.map((i) => i.length)];
    if (lengths.length > count) return null;
    while (lengths.length < count) lengths.push(straight());
    const layOut = (specials: { slot: Slot; length: number }[]): Slot[] => {
      const pool = shuffle(lengths, rand);
      const slots: Slot[] = pool.map((length) => ({ kind: 'length', length }));
      for (const special of specials) {
        const at = slots.findIndex((sl, i) => sl.kind === 'length' && sl.length === special.length && pool[i] === special.length);
        if (at >= 0) slots[at] = special.slot;
      }
      return slots;
    };
    const opposite = layOut(theirs);
    // The long straight already down starts side A; side C has one to match.
    if (a === 0) opposite.splice(Math.floor(rand() * (opposite.length + 1)), 0, { kind: 'length', length: D.LONG_STRAIGHT });
    return [layOut(mine), opposite];
  };
  const ac = sideSlots(0, along);
  const bd = sideSlots(1, across);
  if (!ac || !bd) return null;
  if (climb) {
    // Up on side A, down on side C; going down needs a two-hole mini first to turn the pegs round, so A has a mini too.
    ac[0].splice(Math.floor(ac[0].length / 2), 0, { kind: 'up' }, { kind: 'length', length: D.MINI_STRAIGHT });
    ac[1].splice(Math.floor(ac[1].length / 2), 0, { kind: 'down' });
  }
  const corner = (): Slot[] => (inCorner ? [{ kind: 'curve', dir }, { kind: 'length', length: D.MEDIUM_STRAIGHT }, { kind: 'curve', dir }] : [{ kind: 'curve', dir }, { kind: 'curve', dir }]);
  // The long straight already down starts side A.
  return [{ kind: 'length', length: D.LONG_STRAIGHT }, ...ac[0], ...corner(), ...bd[0], ...corner(), ...ac[1], ...corner(), ...bd[1], ...corner()];
}

/**
 * Where to put the first piece of a planned loop so the whole loop sits
 * centred on `at`, heading off at `angle`: worked out by running round the
 * plan's shapes without laying anything.
 */
function centred(slots: Slot[], at: Vec2, angle: number): { start: Pose; points: Pose[] } {
  const all = trackMoves().filter((m) => m.dz === 0);
  const straight = (length: number) => all.find((m) => m.kind === 'straight' && Math.abs(m.length - length) < 1)!.step;
  const curve = all.find((m) => m.kind === 'curve' && m.step.angle > 0 && m.length > 120)!.step;
  let pose: Pose = { x: 0, y: 0, angle: 0 };
  const path: Pose[] = [pose];
  for (const slot of slots) {
    const step =
      slot.kind === 'curve'
        ? slot.dir > 0
          ? curve
          : { ...curve, y: -curve.y, angle: -curve.angle }
        : straight(slot.kind === 'length' ? slot.length : slot.kind === 'switch' ? D.MEDIUM_STRAIGHT : slot.kind === 'stop' ? (slot.length ?? D.LONG_STRAIGHT) : D.LONG_STRAIGHT);
    pose = applyPose(pose, step);
    path.push(pose);
  }
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  const mid = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const turned = applyPose({ x: 0, y: 0, angle }, { ...mid, angle: 0 });
  const start = { x: at.x - turned.x, y: at.y - turned.y, angle };
  return { start, points: path.map((p) => applyPose(start, p)) };
}

/** Whether a planned loop's ends of pieces all land in the space there is (on the table, out of the water). */
function fits(points: Pose[], ctx: GenerateContext): boolean {
  if (!ctx.blocked) return true;
  const probes = points.map((pose, i) => ({ uid: `probe${i}`, pieceId: 'straight-mini', flipped: false, pose }));
  return [...ctx.blocked({ pieces: probes })].length === 0;
}

/** Plan what goes where along the main line; `more` when Fill gap carries it on after the last place. */
function plan(opts: SectionOptions, stops: readonly StopDef[], rand: () => number, more = false): Slot[] {
  const n = opts.pieces;
  const slots: Slot[] = Array.from({ length: n }, () => ({ kind: 'plain' }));
  const taken = new Set<number>([0]);
  const put = (i: number, slot: Slot) => {
    slots[i] = slot;
    taken.add(i);
  };
  if (opts.climb !== 'none' && n >= 4) {
    const up = Math.max(1, Math.floor(n * (opts.climb === 'up' && !opts.loop ? 0.45 : 0.25)));
    put(up, { kind: 'up' });
    if (opts.climb === 'over' || opts.loop) put(Math.max(up + 2, Math.floor(n * 0.7)), { kind: 'down' });
  }
  const last = more ? n : n - 1;
  const free = (i: number) => i > 0 && i < last && !taken.has(i) && !taken.has(i - 1) && !taken.has(i + 1);
  // Loops first, as they need the most room: the line runs straight on between the switches, for the loop to run beside it.
  const asked = Math.min(opts.closed, opts.switches);
  let loops = 0;
  for (let k = 0; k < asked; k++) {
    const longest = LOOP_SPAN[0] + Math.floor(rand() * (LOOP_SPAN[1] - LOOP_SPAN[0] + 1));
    // Shorter between the switches if that's all there's room for along the line.
    for (let span = longest; span >= 2; span--) {
      const aim = Math.round(((k + 0.5) * last) / asked - span / 2);
      const i = [0, 1, -1, 2, -2, 3, -3, 4, -4].map((d) => aim + d).find((i) => free(i) && free(i + span) && Array.from({ length: span - 1 }, (_, j) => i + 1 + j).every((j) => !taken.has(j)));
      if (i === undefined) continue;
      put(i, { kind: 'loop', pair: k, role: 'leave' });
      for (let j = i + 1; j < i + span; j++) put(j, { kind: 'straight' });
      put(i + span, { kind: 'loop', pair: k, role: 'rejoin' });
      loops++;
      break;
    }
  }
  // Any loop with no room along the line is a switch to a siding instead.
  const open = opts.switches - loops;
  for (let k = 0; k < open; k++) {
    // Spread out along the line, nudged to a free place.
    const aim = Math.round(((k + 1) * last) / (open + 1));
    const i = [0, 1, -1, 2, -2, 3, -3].map((d) => aim + d).find(free);
    if (i !== undefined) put(i, { kind: 'switch' });
  }
  for (const stop of stops.slice(0, opts.stops)) {
    const spots = shuffle(
      slots.map((_, i) => i).filter(free),
      rand,
    );
    if (spots.length) put(spots[0], { kind: 'stop', stop });
  }
  return slots;
}

/**
 * A new section of track, laid onto `base` from `ctx.start` (or loose at
 * `ctx.at`). The same options and seed give the same section. Null when
 * nothing at all would fit.
 */
export function generateSection(base: Layout, options: Partial<SectionOptions>, ctx: GenerateContext = {}): Section | null {
  const opts: SectionOptions = { ...DEFAULT_SECTION, ...options };
  opts.pieces = Math.max(2, Math.min(MAX_SECTION_PIECES, Math.round(opts.pieces)));
  const play = ctx.play ?? DEFAULT_PLAY;
  // A loop stands on its own.
  const start = opts.loop ? undefined : ctx.start;
  if (opts.loop || (ctx.goal && start && sameEnd(ctx.goal, start))) ctx = { ...ctx, goal: undefined };
  const goal = ctx.goal;
  const budget = ctx.budgetMs ?? (goal ? 2500 : 1500);
  const started = performance.now();
  const rand = random(opts.seed);
  // The run to a goal end before Fill gap takes over has room for everything asked for along it, with a piece between each.
  const specials = Math.min(opts.pieces, 2 * (opts.switches + Math.min(opts.stops, Math.floor(opts.pieces / 3)) + (opts.climb === 'none' ? 0 : 2)) + 2);
  // Near enough the pieces asked for, for a run to a goal end.
  const close = Math.max(1, Math.round(opts.pieces * 0.1));

  /** How many of the things asked for along it a section is short of. */
  const missing = (a: Attempt): number => {
    const raised = opts.climb === 'none' || a.uids.some((uid) => baseOf(findPiece(a.layout, uid)) >= D.LEVEL_HEIGHT - 1);
    // Only what there was room for along it in the plan: more stops than every other piece can hold won't go on.
    return Math.max(0, a.planned.switches - a.switches) + Math.max(0, a.planned.stops - a.stops) + (raised ? 0 : 1);
  };

  // A section never shuts trains in a loop they can't get back out of.
  const trapsBefore = layoutTraps(base);
  const traps = (layout: Layout) => newTrapEntries(trapsBefore, layoutTraps(layout)).length > 0;
  // What to stop at along it, balancing the jobs already out there, and near where it goes.
  const near = start ? worldEnd(base, start).connector.pose : (ctx.at ?? { x: 0, y: 0 });
  const stops = pickStops(base, STOPS, opts.stops, near, rand);

  let best: Attempt | null = null;
  /** The best of those that would make a train trap, for when every way does. */
  let trapped: Attempt | null = null;
  /** How many pieces over (or under) the last runs to a goal end came out: the next try's run is that much shorter. */
  let over = 0;
  /** Loops, and job stops out along them, it's short of. */
  const unlooped = (a: Attempt): number => Math.max(0, a.planned.loops - a.loops) + Math.max(0, a.planned.visits - a.visits);
  const better = (a: Attempt, b: Attempt | null): boolean => {
    if (!b) return true;
    if (a.closed !== b.closed) return a.closed;
    if (unlooped(a) !== unlooped(b)) return unlooped(a) < unlooped(b);
    if (goal && missing(a) !== missing(b)) return missing(a) < missing(b);
    return goal ? Math.abs(a.laid - opts.pieces) < Math.abs(b.laid - opts.pieces) : a.laid > b.laid;
  };
  for (let tries = 0; tries < LOOP_PLANS + 20 && performance.now() - started < budget; tries++) {
    const attempt = new Attempt(base, rand, ctx);
    // A loop laid to plan closes by itself; when that won't fit, it's laid most of the way and closed with Fill gap.
    // Smaller each time round, in case the one asked for is too big for the space.
    const shrink = Math.max(10, Math.round(opts.pieces * (1 - tries * 0.012)));
    // Later still, with less on it and shorter straights.
    const fewer: Partial<SectionOptions> = tries >= 40 ? { climb: 'none', stops: Math.min(opts.stops, 1), switches: Math.min(opts.switches, 1) } : tries >= 25 ? { climb: 'none' } : {};
    const planned = opts.loop && tries < LOOP_PLANS ? planLoop({ ...opts, ...fewer, pieces: shrink }, stops, rand, tries / LOOP_PLANS) : null;
    if (opts.loop && !planned && tries < LOOP_PLANS) continue;
    const at = ctx.at ?? { x: 0, y: 0 };
    if (start) {
      attempt.end = start;
    } else if (!attempt.startLoose(at, planned ? (angle) => centred(planned, at, angle).start : undefined, planned ? (angle) => fits(centred(planned, at, angle).points, ctx) : undefined)) {
      continue;
    }
    let walk = opts.pieces;
    if (goal) {
      // Head for the goal end, leaving Fill gap a few pieces to join it up with: a short gap is quick to search.
      const there = attempt.toGoal()!.pieces * (0.9 + rand() * 0.4);
      attempt.aim = Math.max(2, Math.min(GOAL_FILL - Math.floor(rand() * 2), Math.round(there)));
      // Fill gap's runs come out a piece or so longer than the guess, coming round to meet the end square.
      walk = Math.max(Math.min(opts.pieces, specials), opts.pieces - attempt.aim - 1 - Math.round(over));
      attempt.aim = opts.pieces - walk;
    }
    const slots = planned ?? plan(opts.loop ? { ...opts, pieces: Math.max(4, Math.round(opts.pieces * LOOP_LAID)) } : { ...opts, pieces: walk }, stops, rand, !!goal);
    const leaves = slots.filter((s): s is Extract<Slot, { kind: 'loop' }> => s.kind === 'loop' && s.role === 'leave');
    attempt.planned = {
      switches: slots.filter((s) => s.kind === 'switch').length + leaves.length,
      stops: slots.filter((s) => s.kind === 'stop').length,
      loops: leaves.length,
      visits: leaves.filter((s) => LOOP_STOPS.includes(opts.loopTo?.[s.pair] ?? '')).length,
    };
    // Lay each place in turn; at a dead end, back up a few places and try other pieces.
    const first = attempt.laid;
    const saved: Saved[] = [];
    let most = attempt.save();
    /** And the furthest it got whether or not there's room past it, for when there never is. */
    let furthest = most;
    let backs = 0;
    let i = first;
    while (i < slots.length) {
      saved[i] = attempt.save();
      attempt.closing = !!planned && i >= slots.length - 2;
      // An open run's last piece leaves room to build on from it, not a dead end against other track or the table's edge.
      const deadEnds = !opts.loop && !goal;
      const laid = attempt.slot(slots[i], opts, slots.length - i) && (i + 1 < slots.length || !deadEnds || attempt.roomToGoOn());
      if (laid) {
        i++;
        if (attempt.laid > furthest.laid) furthest = attempt.save();
        // The furthest it got, to fall back on, also has room to go on from.
        if (attempt.laid > most.laid && (!deadEnds || attempt.roomToGoOn())) most = attempt.save();
        continue;
      }
      attempt.load(saved[i]);
      if (++backs > BACKTRACKS || performance.now() - started > budget) break;
      i = Math.max(first, i - 1 - Math.floor(rand() * Math.min(4, 1 + backs / 8)));
      attempt.load(saved[i]);
    }
    let ok = i >= slots.length;
    if (!ok) attempt.load(most.laid > first ? most : furthest);
    if (planned && !ok) continue;
    const left = () => Math.min(700, Math.max(300, budget - (performance.now() - started)));
    if (ok && opts.loop) ok = attempt.close(play, left());
    // A run to a goal end is joined to it from as far as it got, if that's near enough to be quick to search.
    if (goal) {
      const join = (): boolean => {
        // Stops go on first, so Fill gap's run keeps clear of them.
        attempt.placeStops();
        return attempt.toGoal()!.pieces <= GOAL_FILL + 3 && attempt.close(play, Math.min(GOAL_FILL_MS, left()), opts.pieces);
      };
      // When the end it got to won't join up, take the last few pieces back up and try from there.
      let joined = join();
      for (let back = 1; !joined && back <= GOAL_BACK_UP && i - back >= first && performance.now() - started < budget; back++) {
        attempt.load(saved[i - back]);
        joined = join();
      }
      ok = joined && Math.abs(attempt.laid - opts.pieces) <= close;
      if (attempt.closed) over += (attempt.laid - opts.pieces) / 2;
    }
    attempt.joinLoops(opts, play, LOOP_JOIN_MS);
    if (!goal) attempt.placeStops();
    const added = new Set(attempt.uids);
    const trouble = checkLayout(attempt.layout, { play, traps: false }).some((i) => i.kind !== 'open-end' && i.uids.some((u) => added.has(u)));
    if (trouble || !attempt.uids.length) continue;
    if (traps(attempt.layout)) {
      if (better(attempt, trapped)) trapped = attempt;
      continue;
    }
    if (ok && (!goal || !missing(attempt)) && !unlooped(attempt)) return result(attempt);
    if (better(attempt, best)) best = attempt;
  }
  // Nothing joined up: Fill gap straight there, without the extras, sooner than leave it short of the end.
  if (goal && start && !best?.closed) {
    const plain = new Attempt(base, rand, { ...ctx, goal });
    plain.end = start;
    if (plain.close(play, Math.max(GOAL_FILL_MS * 4, budget - (performance.now() - started)), opts.pieces)) {
      const added = new Set(plain.uids);
      if (!checkLayout(plain.layout, { play, traps: false }).some((i) => i.kind !== 'open-end' && i.uids.some((u) => added.has(u)))) {
        if (!traps(plain.layout)) return result(plain);
        if (!trapped?.closed) trapped = plain;
      }
    }
  }
  // Joined up but making a trap beats not joined up: the check says how to fix it.
  if (trapped && (!best || (trapped.closed && !best.closed))) return { ...result(trapped), trapped: true };
  return best && result(best);
}

function result(a: Attempt): Section {
  return { layout: a.layout, uids: [...a.uids], laid: a.laid, closed: a.closed, stops: a.stops, switches: a.switches, loops: a.loops, visits: a.visits };
}
