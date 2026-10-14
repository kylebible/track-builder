import { heightAt, pathLength, poseAt } from '../geometry/path';
import { applyPose, type Vec2 } from '../geometry/pose';
import * as D from '../pieces/dimensions';
import { OVERLAP_DISTANCE } from '../planning/check';
import { baseOf, defOf, type PlacedPiece } from './layout';

// Where track already runs, as points along each piece's centreline in a
// grid, so a search laying new track can ask "is this spot free?" quickly.
// It is a rough early test; the layout check has the last word.

const STEP = 12;
const CELL = OVERLAP_DISTANCE;
/** Cells of the quick mask, and heights in half levels. */
const FINE = 8;
const HALF_LEVEL = D.LEVEL_HEIGHT / 2;
const maskKey = (x: number, y: number, l: number) => ((x * 73856093) ^ (y * 19349663) ^ (l * 83492791)) >>> 0;

export interface TrackPoint {
  p: Vec2;
  /** Height of the track's bottom above the floor. */
  z: number;
}

interface Entry extends TrackPoint {
  uid: string;
}

/** Points along a placed piece's track. */
export function trackPoints(piece: PlacedPiece, step = STEP): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const path of defOf(piece).paths) {
    const length = pathLength(path);
    const steps = Math.max(1, Math.ceil(length / step));
    for (let i = 0; i <= steps; i++) {
      const along = (length * i) / steps;
      out.push({ p: applyPose(piece.pose, poseAt(path, along)), z: baseOf(piece) + heightAt(path, along) });
    }
  }
  return out;
}

export class Occupancy {
  private readonly grid = new Map<string, Entry[]>();
  private readonly masks = new Map<number, Set<number>>();

  constructor(pieces: Iterable<PlacedPiece> = []) {
    for (const piece of pieces) this.add(piece);
  }

  add(piece: PlacedPiece): void {
    this.masks.clear();
    for (const t of trackPoints(piece)) {
      const k = `${Math.floor(t.p.x / CELL)},${Math.floor(t.p.y / CELL)}`;
      let bucket = this.grid.get(k);
      if (!bucket) this.grid.set(k, (bucket = []));
      bucket.push({ ...t, uid: piece.uid });
    }
  }

  /** Forget a piece that was added. */
  remove(piece: PlacedPiece): void {
    this.masks.clear();
    for (const t of trackPoints(piece)) {
      const k = `${Math.floor(t.p.x / CELL)},${Math.floor(t.p.y / CELL)}`;
      const bucket = this.grid.get(k);
      if (bucket) this.grid.set(k, bucket.filter((e) => e.uid !== piece.uid));
    }
  }

  /** Whether track at `point` would run into track already here, other than the pieces in `ignore`. */
  hits(point: TrackPoint, ignore?: ReadonlySet<string>, reach = OVERLAP_DISTANCE): boolean {
    const cx = Math.floor(point.p.x / CELL);
    const cy = Math.floor(point.p.y / CELL);
    const cells = Math.ceil(reach / CELL);
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dy = -cells; dy <= cells; dy++) {
        for (const e of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (ignore?.has(e.uid)) continue;
          if (Math.abs(e.z - point.z) >= D.HEADROOM) continue;
          if (Math.hypot(e.p.x - point.p.x, e.p.y - point.p.y) < reach) return true;
        }
      }
    }
    return false;
  }


  /**
   * Quicker than `hits`, for a search asking millions of times: whether
   * `point` is within about `reach` of track here, from a fine grid of every
   * spot that close, made the first time it's asked for.
   */
  near(point: TrackPoint, reach: number): boolean {
    let mask = this.masks.get(reach);
    if (!mask) this.masks.set(reach, (mask = this.mask(reach)));
    return mask.has(maskKey(Math.floor(point.p.x / FINE), Math.floor(point.p.y / FINE), Math.round(point.z / HALF_LEVEL)));
  }

  private mask(reach: number): Set<number> {
    const mask = new Set<number>();
    const r = Math.ceil(reach / FINE) + 1;
    // Track a half level apart in height still runs into each other; a level apart, it passes over.
    const levels = Math.ceil(D.HEADROOM / HALF_LEVEL) - 1;
    for (const bucket of this.grid.values()) {
      for (const e of bucket) {
        const fx = Math.floor(e.p.x / FINE);
        const fy = Math.floor(e.p.y / FINE);
        const level = Math.round(e.z / HALF_LEVEL);
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            // Nearest point of the cell to the track point.
            const nx = Math.max((fx + dx) * FINE, Math.min(e.p.x, (fx + dx + 1) * FINE));
            const ny = Math.max((fy + dy) * FINE, Math.min(e.p.y, (fy + dy + 1) * FINE));
            if (Math.hypot(nx - e.p.x, ny - e.p.y) >= reach) continue;
            for (let dl = -levels; dl <= levels; dl++) mask.add(maskKey(fx + dx, fy + dy, level + dl));
          }
        }
      }
    }
    return mask;
  }

  /** Whether any of a piece's track runs into track already here, other than the pieces in `ignore`. */
  piece(piece: PlacedPiece, ignore?: ReadonlySet<string>): boolean {
    return trackPoints(piece).some((t) => this.hits(t, ignore));
  }
}
