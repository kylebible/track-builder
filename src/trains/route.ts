import { poseAt } from '../geometry/path';
import { normalizeAngle, type Pose, type Vec2 } from '../geometry/pose';
import type { Edge, JointFit, TrackNetwork } from './network';

// The stretch of track one train is on, laid out as a single line measured
// in mm (`u`). It grows at either end as the train runs on, taking the way
// each switch lever points at the moment the train gets there, and is
// trimmed behind it.

export interface Segment {
  edge: Edge;
  /** Run from the path's end to its start. */
  reversed: boolean;
  /** Where the segment starts along the route. */
  u0: number;
}

/** Where the route crosses from one piece to the next. */
export interface Crossing {
  u: number;
  fit: JointFit;
  at: Vec2;
  /** The two pieces, in route order. */
  uids: [string, string];
}

export interface RouteEnd {
  kind: 'open' | 'buffer';
  u: number;
  at: Vec2;
}

export type Chooser = (uid: string, count: number) => number;

export class Route {
  segments: Segment[];
  crossings: Crossing[] = [];
  /** Set once the track runs out at that end. */
  front: RouteEnd | null = null;
  back: RouteEnd | null = null;

  constructor(edge: Edge, reversed: boolean, u0 = 0) {
    this.segments = [{ edge, reversed, u0 }];
  }

  /** An independent copy, to lay a rebuilt train on the same track. */
  clone(): Route {
    const copy = new Route(this.segments[0].edge, this.segments[0].reversed, this.segments[0].u0);
    copy.segments = this.segments.map((seg) => ({ ...seg }));
    copy.crossings = this.crossings.map((c) => ({ ...c }));
    copy.front = this.front && { ...this.front };
    copy.back = this.back && { ...this.back };
    return copy;
  }

  get start(): number {
    return this.segments[0].u0;
  }

  get end(): number {
    const last = this.segments[this.segments.length - 1];
    return last.u0 + last.edge.length;
  }

  private segmentIndex(u: number): number {
    const segs = this.segments;
    if (u <= segs[0].u0) return 0;
    for (let i = segs.length - 1; i >= 0; i--) if (u >= segs[i].u0) return i;
    return 0;
  }

  segmentAt(u: number): Segment {
    return this.segments[this.segmentIndex(u)];
  }

  /** Pose on the track at `u`, heading along the route. Off either end, the track's last direction carries straight on. */
  poseAt(u: number): Pose {
    const clamped = Math.min(Math.max(u, this.start), this.end);
    const seg = this.segmentAt(clamped);
    const s = clamped - seg.u0;
    const p = seg.reversed ? poseAt(seg.edge.path, seg.edge.length - s) : poseAt(seg.edge.path, s);
    const angle = seg.reversed ? normalizeAngle(p.angle + Math.PI) : p.angle;
    const over = u - clamped;
    return { x: p.x + over * Math.cos(angle), y: p.y + over * Math.sin(angle), angle };
  }

  /** Signed curvature at `u` (1/mm, positive turning left). */
  curvatureAt(u: number): number {
    const { edge, reversed } = this.segmentAt(u);
    if (edge.path.kind === 'straight') return 0;
    return (Math.sign(edge.path.sweep) / edge.path.radius) * (reversed ? -1 : 1);
  }

  /** Grow the route until it covers [lo, hi] or the track runs out. */
  extend(network: TrackNetwork, choose: Chooser, lo: number, hi: number): void {
    while (!this.front && this.end < hi) this.grow(network, choose, 'front');
    while (!this.back && this.start > lo) this.grow(network, choose, 'back');
  }

  private grow(network: TrackNetwork, choose: Chooser, side: 'front' | 'back'): void {
    const seg = side === 'front' ? this.segments[this.segments.length - 1] : this.segments[0];
    // The end of the edge the route leaves through on this side.
    const leave: 0 | 1 = (side === 'front') !== seg.reversed ? 1 : 0;
    const next = network.onward(seg.edge, leave, choose);
    if (next.kind !== 'edge') {
      const end: RouteEnd = { kind: next.kind, u: side === 'front' ? this.end : this.start, at: next.at };
      if (side === 'front') this.front = end;
      else this.back = end;
      return;
    }
    // Entering at the path's start means running it forwards on the front side.
    const reversed = side === 'front' ? next.enterAt === 1 : next.enterAt === 0;
    if (side === 'front') {
      const u0 = this.end;
      this.segments.push({ edge: next.edge, reversed, u0 });
      if (next.fit) this.crossings.push({ u: u0, fit: next.fit, at: next.at, uids: [seg.edge.uid, next.edge.uid] });
    } else {
      const u0 = this.start - next.edge.length;
      this.segments.unshift({ edge: next.edge, reversed, u0 });
      if (next.fit) this.crossings.unshift({ u: this.start + next.edge.length, fit: next.fit, at: next.at, uids: [next.edge.uid, seg.edge.uid] });
    }
  }

  /** Forget track well clear of [lo, hi], so the route doesn't grow forever on a loop. */
  trim(lo: number, hi: number): void {
    while (this.segments.length > 1 && this.segments[1].u0 < lo) {
      this.segments.shift();
      this.back = null;
    }
    while (this.segments.length > 1 && this.segments[this.segments.length - 1].u0 > hi) {
      this.segments.pop();
      this.front = null;
    }
    this.crossings = this.crossings.filter((c) => c.u > this.start && c.u < this.end);
  }

  /** Let go of track reserved beyond [lo, hi], so it is chosen afresh (a lever was thrown). */
  cut(lo: number, hi: number): void {
    this.trim(lo, hi);
  }

  /** Start again from these segments (the same track, rebuilt after an edit), finding the ends afresh. */
  rebase(segments: Segment[]): void {
    this.segments = segments;
    this.front = null;
    this.back = null;
    this.crossings = this.crossings.filter((c) => c.u > this.start && c.u < this.end);
  }

  /** Every piece the route currently runs over. */
  uids(): Set<string> {
    return new Set(this.segments.map((s) => s.edge.uid));
  }
}
