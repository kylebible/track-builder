import { heightAt, pathLength, poseAt } from '../geometry/path';
import { DEFAULT_PLAY, heightGap, jointError, type Play } from '../geometry/joint';
import { applyPose, distance, type Vec2 } from '../geometry/pose';
import * as D from '../pieces/dimensions';
import { isBrio } from '../pieces/basic';
import { getPiece } from '../pieces/catalog';
import { baseOf, defOf, findJoints, nearbyPairs, openEnds, worldEnd, type EndRef, type Layout, type PlacedPiece, type WorldEnd } from '../layout/layout';
import { supportsOf, type Support } from '../layout/supports';

// The layout check: what would go wrong when building this on the floor.
//
// - A near miss is two open ends close enough that they were surely meant
//   to join but aren't within the joint play: a loop that doesn't quite
//   close, or two pegs (or two holes) meeting.
// - An open end is any other end with nothing on it.
// - An overlap is two pieces whose track runs into each other. Track that
//   passes over other track a full level up is a bridge, not an overlap.
// - A height mismatch is two ends that line up in plan at different levels.
// - A blocked support is one that would have to stand on the track below,
//   where not even an arch over that track fits.
// - Off the area is track past the edge of a table or rug, and in water is
//   track on the ground in a river or lake (both added by the panel, which
//   knows what the layout is built on).
// - Not Brio is a piece Brio doesn't sell, in Basic mode (also added by the
//   panel, which knows the mode).

export type IssueKind = 'near-miss' | 'same-gender' | 'height' | 'overlap' | 'support' | 'open-end' | 'off-area' | 'in-water' | 'not-brio';

export interface Issue {
  kind: IssueKind;
  /** Where to look, in plan mm. */
  at: Vec2;
  /** Height above the floor of the spot to look at. */
  z?: number;
  /** The pieces involved. */
  uids: string[];
  /** The open end, for open-end issues. */
  end?: EndRef;
  message: string;
}

/** How far apart two open ends can be and still count as meant to join. */
export interface NearRange {
  mm: number;
  deg: number;
}

export const DEFAULT_NEAR_RANGE: NearRange = { mm: 40, deg: 30 };

/**
 * Two tracks whose centerlines come closer than this run into each other.
 * Side by side at exactly a track width they just touch, which is fine;
 * the joint play is allowed on top.
 */
export const OVERLAP_DISTANCE = D.TRACK_WIDTH - DEFAULT_PLAY.mm;

/**
 * Two pieces that meet end to end are allowed to come this close to each
 * other around the spot where they meet.
 */
const JOINT_CLEARANCE = 45;
/** Spacing of the points sampled along each piece's track. */
const SAMPLE_STEP = 8;

export interface CheckOptions {
  play?: Play;
  near?: NearRange;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pieceName = (layout: Layout, uid: string) => getPiece(layout.pieces.find((p) => p.uid === uid)!.pieceId).name;
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());

export function checkLayout(layout: Layout, options: CheckOptions = {}): Issue[] {
  const play = options.play ?? DEFAULT_PLAY;
  const near = options.near ?? DEFAULT_NEAR_RANGE;
  const joints = findJoints(layout, play);
  const open = openEnds(layout, joints);

  const misses = nearMisses(open, near);
  const paired = new Set(misses.flatMap(([a, b]) => [a, b]));
  const issues: Issue[] = [];

  for (const [a, b] of misses) {
    const at = midpoint(a.connector.pose, b.connector.pose);
    const z = Math.max(a.connector.z ?? 0, b.connector.z ?? 0);
    const uids = [...new Set([a.uid, b.uid])];
    const rise = heightGap(a.connector, b.connector);
    if (rise > play.mm) {
      issues.push({
        kind: 'height',
        at,
        z,
        uids,
        message: `These ends line up but one is ${fmt(rise)} mm higher. Put a ramp in, or raise or lower one side.`,
      });
    } else if (a.connector.gender === b.connector.gender) {
      const what = a.connector.gender === 'peg' ? 'pegs' : 'holes';
      issues.push({
        kind: 'same-gender',
        at,
        z,
        uids,
        message: `Two ${what} meet here, so these ends can't join. Swap one piece for a version with a ${a.connector.gender === 'peg' ? 'hole' : 'peg'}.`,
      });
    } else {
      const e = jointError(a.connector.pose, b.connector.pose);
      const parts = [];
      if (e.gapMm > play.mm) parts.push(`${fmt(e.gapMm)} mm apart`);
      if (e.angleDeg > play.deg) parts.push(`${fmt(e.angleDeg)}° out of line`);
      issues.push({
        kind: 'near-miss',
        at,
        z,
        uids,
        message: `These ends are ${parts.join(' and ')}, more than a joint gives (${play.mm} mm, ${play.deg}°).`,
      });
    }
  }

  const meetings: Meeting[] = [
    ...joints.map((j) => ({ uids: [j.a.uid, j.b.uid], at: worldEnd(layout, j.a).connector.pose })),
    ...misses.map(([a, b]) => ({ uids: [a.uid, b.uid], at: midpoint(a.connector.pose, b.connector.pose) })),
  ];
  issues.push(...overlaps(layout, meetings));
  // Ends already flagged as meeting at the wrong height explain their own support.
  const flagged = new Set(issues.filter((i) => i.kind === 'height').map((i) => i.uids.slice().sort().join('|')));
  issues.push(...blockedSupports(layout, supportsOf(layout)).filter((i) => !flagged.has(i.uids.slice().sort().join('|'))));

  for (const e of open) {
    if (paired.has(e)) continue;
    issues.push({
      kind: 'open-end',
      at: e.connector.pose,
      z: e.connector.z,
      uids: [e.uid],
      end: { uid: e.uid, connectorId: e.connectorId },
      message: `Open ${e.connector.gender} end on a ${pieceName(layout, e.uid).toLowerCase()}.`,
    });
  }
  return issues;
}

/** Open ends that face each other within `range` but don't join, closest first, each end used once. */
function nearMisses(open: WorldEnd[], range: NearRange): [WorldEnd, WorldEnd][] {
  const candidates: { a: WorldEnd; b: WorldEnd; gap: number }[] = [];
  for (const [i, j] of nearbyPairs(open, range.mm)) {
    const a = open[i];
    const b = open[j];
    if (a.uid === b.uid) continue;
    const e = jointError(a.connector.pose, b.connector.pose);
    if (e.gapMm <= range.mm && e.angleDeg <= range.deg) candidates.push({ a, b, gap: e.gapMm });
  }
  candidates.sort((x, y) => x.gap - y.gap);
  const used = new Set<WorldEnd>();
  const pairs: [WorldEnd, WorldEnd][] = [];
  for (const { a, b } of candidates) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    pairs.push([a, b]);
  }
  return pairs;
}

/** Where two pieces meet end to end, joined or nearly. */
interface Meeting {
  uids: string[];
  at: Vec2;
}

interface Sample {
  uid: string;
  p: Vec2;
  /** Height of the track's bottom above the floor. */
  z: number;
}

/** A piece's centerline samples and their bounds, kept per placed piece: a moved piece is a new object. */
interface PieceSamples {
  samples: Sample[];
  min: Vec2;
  max: Vec2;
}
const sampleCache = new WeakMap<PlacedPiece, PieceSamples>();

function samplesOf(piece: PlacedPiece): PieceSamples {
  let found = sampleCache.get(piece);
  if (found) return found;
  const samples: Sample[] = [];
  for (const path of defOf(piece).paths) {
    const length = pathLength(path);
    const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP));
    for (let i = 0; i <= steps; i++) {
      const along = (length * i) / steps;
      samples.push({ uid: piece.uid, p: applyPose(piece.pose, poseAt(path, along)), z: baseOf(piece) + heightAt(path, along) });
    }
  }
  const xs = samples.map((s) => s.p.x);
  const ys = samples.map((s) => s.p.y);
  found = { samples, min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
  sampleCache.set(piece, found);
  return found;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Pieces whose track runs into each other. Points are sampled along every
 * piece's centerline and bucketed in a grid, so big layouts stay quick.
 */
function overlaps(layout: Layout, meetings: Meeting[]): Issue[] {
  const meetingsOf = new Map<string, Vec2[]>();
  for (const m of meetings) {
    const k = pairKey(m.uids[0], m.uids[1]);
    meetingsOf.set(k, [...(meetingsOf.get(k) ?? []), m.at]);
  }
  /** Neighbours touching where they meet is by design. */
  const atMeeting = (s: Sample, t: Sample) =>
    (meetingsOf.get(pairKey(s.uid, t.uid)) ?? []).some((at) => distance(at, s.p) < JOINT_CLEARANCE || distance(at, t.p) < JOINT_CLEARANCE);

  const cell = OVERLAP_DISTANCE;
  const grid = new Map<number, Sample[]>();
  // Numbers, not strings, for grid keys: this runs for every sample on every edit.
  const key = (x: number, y: number) => x * 1_000_003 + y;
  const samples: Sample[] = [];
  for (const piece of layout.pieces) {
    for (const s of samplesOf(piece).samples) {
      samples.push(s);
      const k = key(Math.floor(s.p.x / cell), Math.floor(s.p.y / cell));
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, (bucket = []));
      bucket.push(s);
    }
  }

  const hits = new Map<string, { uids: [string, string]; sum: Vec2; z: number; under: boolean; n: number }>();
  for (const s of samples) {
    const cx = Math.floor(s.p.x / cell);
    const cy = Math.floor(s.p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const t of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (t.uid <= s.uid) continue;
          if (distance(s.p, t.p) >= OVERLAP_DISTANCE || Math.abs(s.z - t.z) >= D.HEADROOM || atMeeting(s, t)) continue;
          const k = pairKey(s.uid, t.uid);
          let hit = hits.get(k);
          if (!hit) hits.set(k, (hit = { uids: [s.uid, t.uid], sum: { x: 0, y: 0 }, z: 0, under: false, n: 0 }));
          hit.sum.x += (s.p.x + t.p.x) / 2;
          hit.sum.y += (s.p.y + t.p.y) / 2;
          hit.z = Math.max(hit.z, s.z, t.z);
          // Clear of each other's track but not a level apart: too low to pass under.
          if (Math.abs(s.z - t.z) > D.TRACK_HEIGHT) hit.under = true;
          hit.n++;
        }
      }
    }
  }

  return [...hits.values()].map((h) => {
    const [a, b] = h.uids.map((uid) => pieceName(layout, uid).toLowerCase());
    return {
      kind: 'overlap' as const,
      at: { x: h.sum.x / h.n, y: h.sum.y / h.n },
      z: h.z,
      uids: h.uids,
      message: h.under
        ? `A ${a} passes over a ${b} too low for a train to fit under. Track needs a full level (${D.LEVEL_HEIGHT} mm) to cross over.`
        : `A ${a} and a ${b} overlap.`,
    };
  });
}

/**
 * Supports that would have to stand where lower track runs, with no room
 * for an arch over it (see layout/supports.ts).
 */
function blockedSupports(layout: Layout, supports: Support[]): Issue[] {
  return supports.flatMap((support) =>
    (support.blockedBy ?? []).map((uid) => ({
      kind: 'support' as const,
      at: support.at,
      z: support.height,
      uids: [...support.uids, uid],
      message: `The support under this raised end would stand on the ${pieceName(layout, uid).toLowerCase()} below, and there's no room for an arch over it. Move the joint along so it lands clear, or raise this track another level.`,
    })),
  );
}

const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A one-line summary for the check button and panel. */
/**
 * Pieces Brio doesn't sell, for Basic mode: one issue for each kind, so a
 * layout from before Basic mode was on shows what to swap. Nothing is removed.
 */
export function notBrio(layout: Layout): Issue[] {
  const byPiece = new Map<string, PlacedPiece[]>();
  for (const placed of layout.pieces) {
    const piece = getPiece(placed.pieceId);
    if (isBrio(piece)) continue;
    const key = piece.partOf ?? piece.id;
    byPiece.set(key, [...(byPiece.get(key) ?? []), placed]);
  }
  return [...byPiece].map(([id, placed]) => {
    const name = getPiece(id).name;
    const n = placed.length;
    return {
      kind: 'not-brio' as const,
      at: { x: placed[0].pose.x, y: placed[0].pose.y },
      ...(placed[0].z ? { z: placed[0].z } : {}),
      uids: placed.map((p) => p.uid),
      message: n === 1 ? `${name}: Brio doesn't sell this piece.` : `${n} × ${name}: Brio doesn't sell this piece.`,
    };
  });
}

export function summarize(issues: Issue[]): string {
  const problems = issues.filter((i) => i.kind !== 'open-end').length;
  const open = issues.length - problems;
  if (!issues.length) return 'Every end is joined and nothing overlaps.';
  const parts = [];
  if (problems) parts.push(plural(problems, 'problem'));
  if (open) parts.push(plural(open, 'open end'));
  return parts.join(' and ');
}
