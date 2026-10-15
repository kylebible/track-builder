import { canMate, DEFAULT_PLAY, placeToMate, type Play } from '../geometry/joint';
import { pathLength, poseAt } from '../geometry/path';
import { applyPose, normalizeAngle, type Pose, type Vec2 } from '../geometry/pose';
import { offered } from '../pieces/basic';
import { getPiece } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import type { Gender } from '../pieces/types';
import { checkLayout } from '../planning/check';
import { CRANE } from '../scenery/models';
import { PLACES } from '../trains/stops';
import { layoutTraps, newTrapEntries } from '../trains/traps';
import { estimate, findFills, trackMoves, type Fill, type TrackMove, type Way } from './fill';
import { addPiece, baseOf, defOf, findPiece, sameEnd, worldEnd, type EndRef, type Layout } from './layout';
import { Occupancy } from './occupancy';

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
  /** End sidings with buffer stops, or leave them open to build on or fill from. */
  sidings: 'buffer' | 'open';
  climb: Climb;
  /** Stations, crossings, signals, trackside stops and the like along it. */
  stops: number;
  seed: number;
}

export const DEFAULT_SECTION: SectionOptions = {
  pieces: 14,
  loop: false,
  curves: 0.4,
  switches: 1,
  sidings: 'buffer',
  climb: 'none',
  stops: 1,
  seed: 1,
};

export const MAX_SECTION_PIECES = 120;

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
}

/** Things to stop at or look at along the line, and how each goes on. */
type StopKind = 'seat' | 'inline' | 'beside';
interface StopDef {
  id: string;
  how: StopKind;
  /** How far beside the track, for things that stand next to it. */
  offset?: number;
}

export const STOPS: readonly StopDef[] = [
  { id: 'station', how: 'seat' },
  { id: 'level-crossing', how: 'inline' },
  { id: 'signal', how: 'beside', offset: 55 },
  { id: 'tunnel', how: 'seat' },
  { id: 'lift-bridge', how: 'inline' },
  { id: 'cargo-loader', how: 'seat' },
  { id: 'crane', how: 'beside', offset: (CRANE.minReach + CRANE.maxReach) / 2 },
  // Not the pump house: it only works by a river or lake, which the generator can't promise.
  ...PLACES.filter((p) => p.id !== 'station' && p.id !== 'pump-house').map((p): StopDef => ({ id: p.id, how: 'seat' })),
];

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
  readonly seats: { uid: string; stop: StopDef }[] = [];
  stops = 0;
  /** Laying the last pieces of a loop, which meet its first. */
  closing = false;
  /** Which way, and how far, the line has turned so far: for loops. */
  turned = 0;
  /** Pieces Fill gap is left to join a run to its goal end with. */
  aim = 0;

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
      turned: this.turned,
      lastTurn: this.lastTurn,
    };
  }

  load(saved: Saved): void {
    this.restore(saved);
    Object.assign(this, { end: saved.end, laid: saved.laid, switches: saved.switches, stops: saved.stops, turned: saved.turned, lastTurn: saved.lastTurn });
    this.seats.splice(0, this.seats.length, ...saved.seats);
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
        const order = dir ? [...curves(dir), ...straights()] : [...straights(), ...curves(rand() < 0.5 ? 1 : -1)];
        laid = this.plain(end, this.roomy(end, order));
        break;
      }
      case 'up':
        if (z > 1) return this.slot({ kind: 'straight' }, opts, remaining);
        laid = this.plain(end, all.filter((m) => m.kind === 'ramp' && m.dz > 0));
        break;
      case 'down':
        if (z < D.LEVEL_HEIGHT - 1) return this.slot({ kind: 'straight' }, opts, remaining);
        laid = this.plain(end, all.filter((m) => m.kind === 'ramp' && m.dz < 0));
        break;
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
      const was = this.snapshot();
      const uid = this.place(end, id, flipped, attach);
      if (!uid) continue;
      if (!this.siding({ uid, connectorId: 'branch1' }, opts)) {
        this.restore(was);
        continue;
      }
      this.end = { uid, connectorId: facing ? 'branch0' : 'trunk' };
      this.laid++;
      this.switches++;
      return true;
    }
    return false;
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
  private stopSlot(stop: StopDef): boolean {
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
    this.seats.push({ uid: laid.uid, stop });
    this.end = laid.out;
    this.laid++;
    return true;
  }

  /** Seat or stand the stops beside the straights kept for them. */
  placeStops(): void {
    for (const { uid, stop } of this.seats) {
      const piece = findPiece(this.layout, uid);
      const path = defOf(piece).paths[0];
      const mid = applyPose(piece.pose, poseAt(path, pathLength(path) / 2));
      const z = baseOf(piece);
      if (stop.how === 'seat') {
        const turned = this.rand() < 0.5 ? Math.PI : 0;
        const holds = getPiece(stop.id).holdsTrackAt ?? 0;
        this.layout = addPiece(this.layout, stop.id, { ...mid, angle: normalizeAngle(mid.angle + turned) }, false, z - holds).layout;
        this.uids.push(this.layout.pieces[this.layout.pieces.length - 1].uid);
        this.stops++;
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

interface Saved {
  layout: Layout;
  n: number;
  end: EndRef | null;
  laid: number;
  switches: number;
  stops: number;
  seats: { uid: string; stop: StopDef }[];
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
function planLoop(opts: SectionOptions, rand: () => number, compact = 0): Slot[] | null {
  const dir = 1;
  const items: { slot: Slot; length: number }[] = [];
  for (let k = 0; k < opts.switches; k++) items.push({ slot: { kind: 'switch', outward: -dir }, length: D.MEDIUM_STRAIGHT });
  for (const stop of shuffle(STOPS.filter((s) => offered(getPiece(s.id))), rand).slice(0, opts.stops)) items.push({ slot: { kind: 'stop', stop, length: stopLength(stop) }, length: stopLength(stop) });
  const climb = opts.climb !== 'none';
  // Corners, and the pieces in sides A and C (B and D) each.
  const inCorner = opts.pieces >= 20 && rand() < 0.35 ? 1 : 0;
  // Less the long straight it starts with and the one across from it.
  const rest = opts.pieces - 8 - 4 * inCorner - (climb ? 3 : 0) - 2;
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
function plan(opts: SectionOptions, rand: () => number, more = false): Slot[] {
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
  for (let k = 0; k < opts.switches; k++) {
    // Spread out along the line, nudged to a free place.
    const aim = Math.round(((k + 1) * last) / (opts.switches + 1));
    const i = [0, 1, -1, 2, -2, 3, -3].map((d) => aim + d).find(free);
    if (i !== undefined) put(i, { kind: 'switch' });
  }
  const stops = shuffle(STOPS.filter((s) => offered(getPiece(s.id))), rand).slice(0, opts.stops);
  for (const stop of stops) {
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
  const specials = 2 * (opts.switches + opts.stops + (opts.climb === 'none' ? 0 : 2)) + 2;
  // Near enough the pieces asked for, for a run to a goal end.
  const close = Math.max(1, Math.round(opts.pieces * 0.1));

  /** How many of the things asked for along it a section is short of. */
  const missing = (a: Attempt): number => {
    const raised = opts.climb === 'none' || a.uids.some((uid) => baseOf(findPiece(a.layout, uid)) >= D.LEVEL_HEIGHT - 1);
    return Math.max(0, opts.switches - a.switches) + Math.max(0, opts.stops - a.stops) + (raised ? 0 : 1);
  };

  // A section never shuts trains in a loop they can't get back out of.
  const trapsBefore = layoutTraps(base);
  const traps = (layout: Layout) => newTrapEntries(trapsBefore, layoutTraps(layout)).length > 0;

  let best: Attempt | null = null;
  /** The best of those that would make a train trap, for when every way does. */
  let trapped: Attempt | null = null;
  /** How many pieces over (or under) the last runs to a goal end came out: the next try's run is that much shorter. */
  let over = 0;
  const better = (a: Attempt, b: Attempt | null): boolean => {
    if (!b) return true;
    if (a.closed !== b.closed) return a.closed;
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
    const planned = opts.loop && tries < LOOP_PLANS ? planLoop({ ...opts, ...fewer, pieces: shrink }, rand, tries / LOOP_PLANS) : null;
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
    const slots = planned ?? plan(opts.loop ? { ...opts, pieces: Math.max(4, Math.round(opts.pieces * LOOP_LAID)) } : { ...opts, pieces: walk }, rand, !!goal);
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
    if (!goal) attempt.placeStops();
    const added = new Set(attempt.uids);
    const trouble = checkLayout(attempt.layout, { play, traps: false }).some((i) => i.kind !== 'open-end' && i.uids.some((u) => added.has(u)));
    if (trouble || !attempt.uids.length) continue;
    if (traps(attempt.layout)) {
      if (better(attempt, trapped)) trapped = attempt;
      continue;
    }
    if (ok && (!goal || !missing(attempt))) return result(attempt);
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
  return { layout: a.layout, uids: [...a.uids], laid: a.laid, closed: a.closed, stops: a.stops, switches: a.switches };
}
