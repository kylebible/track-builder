import { heightAt, pathLength, poseAt } from '../geometry/path';
import { applyPose, rotate, type Vec2 } from '../geometry/pose';
import * as D from '../pieces/dimensions';
import { LEVEL_HEIGHT } from '../pieces/dimensions';
import type { PieceDef } from '../pieces/types';
import { baseOf, defOf, worldEnds, type Layout } from './layout';

/** Pieces on a structure of their own (a bridge span, a helix tower), which need no supports. */
export const standsAlone = (def: PieceDef): boolean => !!def.bridge || def.structure === 'helix';

// Raised track stands on stacks of support blocks, one stack under every
// raised end: two joined ends share one, as on the floor, where the support
// goes under the joint. They are worked out from the layout, never placed
// by hand, so they can't be forgotten from the parts list.
//
// A stack that would stand on lower track becomes an arch: a stack each
// side of the lower track and a beam across their tops, under the raised
// end. When there's no room for one (the lower track is less than a level
// down, or other track is in the way of the legs) the support stays
// blocked and the layout check says so.

export interface Arch {
  /** Where the two legs stand, in plan mm. */
  legs: [Vec2, Vec2];
  /** Which way the beam runs, from one leg to the other. */
  angle: number;
  /** Beam length, outside edge to outside edge of the legs. */
  span: number;
  /** Blocks stacked in each leg. */
  legBlocks: number;
}

export interface Support {
  /** Where it stands, in plan mm. */
  at: Vec2;
  /** Which way the track runs over it. */
  angle: number;
  /** Height of its top: the bottom of the track it holds. */
  height: number;
  /** Blocks stacked to reach that height (both legs, for an arch). */
  blocks: number;
  /** The pieces resting on it. */
  uids: string[];
  /** Standing either side of lower track instead of on it. */
  arch?: Arch;
  /** Lower track it would stand on, when not even an arch fits. */
  blockedBy?: string[];
}

/** Ends this close count as resting on the same support. */
const SHARE_MM = 12;
/** Spacing of the points sampled along each piece's track. */
const SAMPLE_STEP = 8;
/** A leg's footprint: a support block turned to stand alongside the lower track. */
const LEG_ACROSS = D.SUPPORT_LENGTH;
const LEG_ALONG = D.SUPPORT_WIDTH;

const blocksFor = (height: number): number => Math.max(1, Math.ceil(height / LEVEL_HEIGHT - 1e-6));

// Layouts are immutable, so the supports of one are worked out once.
const memo = new WeakMap<Layout, Support[]>();

export function supportsOf(layout: Layout): Support[] {
  let supports = memo.get(layout);
  if (!supports) memo.set(layout, (supports = placeSupports(layout)));
  return supports;
}

function placeSupports(layout: Layout): Support[] {
  const supports: Support[] = [];
  // Bridge spans stand on their own abutments, which carry the track joined to them too.
  const abutments = layout.pieces.filter((p) => standsAlone(defOf(p))).flatMap((p) => worldEnds(p).map((e) => e.connector));
  for (const piece of layout.pieces) {
    for (const end of worldEnds(piece)) {
      const height = end.connector.z ?? 0;
      if (height < 1) continue;
      const { x, y, angle } = end.connector.pose;
      if (abutments.some((a) => Math.hypot(a.pose.x - x, a.pose.y - y) < SHARE_MM && Math.abs((a.z ?? 0) - height) < 1)) continue;
      const shared = supports.find((s) => Math.hypot(s.at.x - x, s.at.y - y) < SHARE_MM && Math.abs(s.height - height) < 1);
      if (shared) {
        if (!shared.uids.includes(piece.uid)) shared.uids.push(piece.uid);
        continue;
      }
      supports.push({ at: { x, y }, angle, height, blocks: blocksFor(height), uids: [piece.uid] });
    }
  }
  if (!supports.length) return supports;
  const samples = sampleTrack(layout);
  return supports.map((s) => clearOfTrack(s, samples));
}

/** A point on a piece's track: plan position, the bottom of the track there, and its heading. */
interface Sample {
  uid: string;
  x: number;
  y: number;
  z: number;
  angle: number;
}

function sampleTrack(layout: Layout): Sample[] {
  const samples: Sample[] = [];
  for (const piece of layout.pieces) {
    for (const path of defOf(piece).paths) {
      const length = pathLength(path);
      const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP));
      for (let i = 0; i <= steps; i++) {
        const along = (length * i) / steps;
        const p = applyPose(piece.pose, poseAt(path, along));
        samples.push({ uid: piece.uid, x: p.x, y: p.y, z: baseOf(piece) + heightAt(path, along), angle: p.angle });
      }
    }
  }
  return samples;
}

/** Track centerline within this of a footprint runs into it. */
const REACH = D.TRACK_WIDTH / 2 - 2;

/** How far the centerline point `p` is from a box of half-sizes (`along`, `across`) at `at`, turned to `angle`. */
function boxDistance(p: Vec2, at: Vec2, angle: number, along: number, across: number): number {
  const local = rotate({ x: p.x - at.x, y: p.y - at.y }, -angle);
  return Math.hypot(Math.max(Math.abs(local.x) - along, 0), Math.max(Math.abs(local.y) - across, 0));
}

/** The support as it is if no lower track is in its way, else an arch over it, else marked blocked. */
function clearOfTrack(support: Support, samples: Sample[]): Support {
  // Track that's lower than the support's top, other than what it holds up.
  // Nothing further off than an arch can span matters.
  const near = D.ARCH_MAX_SPAN;
  const lower = samples.filter(
    (s) => Math.abs(s.x - support.at.x) < near && Math.abs(s.y - support.at.y) < near && s.z < support.height - 1 && !support.uids.includes(s.uid),
  );
  const under = lower.filter((s) => boxDistance(s, support.at, support.angle, D.SUPPORT_LENGTH / 2, D.SUPPORT_WIDTH / 2) < REACH);
  if (!under.length) return support;
  const arch = archOver(support, under, lower);
  if (arch) return { ...support, arch, blocks: 2 * arch.legBlocks };
  return { ...support, blockedBy: [...new Set(under.map((s) => s.uid))] };
}

/**
 * Two legs either side of the lower track under a support, as close in as
 * they can stand, and the beam across them. Null when the lower track is
 * too high to pass under the beam, or there's no room for the legs.
 */
function archOver(support: Support, under: Sample[], lower: Sample[]): Arch | null {
  // A train needs a full level from the lower track's bottom to the upper track's.
  if (under.some((s) => s.z > support.height - LEVEL_HEIGHT + 1)) return null;
  const nearest = under.reduce((a, b) => (Math.hypot(a.x - support.at.x, a.y - support.at.y) <= Math.hypot(b.x - support.at.x, b.y - support.at.y) ? a : b));
  // The beam runs square across the lower track, through the support's spot.
  const angle = nearest.angle + Math.PI / 2;
  const across = (s: Vec2) => rotate({ x: s.x - support.at.x, y: s.y - support.at.y }, -angle);
  // Lower track passing through the strip the legs stand in, by how far along the beam it crosses,
  // and whether a train on it would fit under the beam.
  const strip = lower
    .map((s) => ({ ...across(s), low: s.z <= support.height - LEVEL_HEIGHT + 1 }))
    .filter((p) => Math.abs(p.y) < LEG_ALONG / 2 + REACH && Math.abs(p.x) < D.ARCH_MAX_SPAN);
  let lo = Math.min(...under.map((s) => across(s).x));
  let hi = Math.max(...under.map((s) => across(s).x));
  // Widen the arch over any other track its legs would land on, until both legs stand clear.
  const reach = D.ARCH_CLEARANCE + LEG_ACROSS + REACH;
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of strip) {
      if (p.x < lo && p.x > lo - reach) (lo = p.x), (grew = true);
      if (p.x > hi && p.x < hi + reach) (hi = p.x), (grew = true);
    }
    // Track too high for a train to pass under the beam can't go under the arch.
    if (strip.some((p) => !p.low && p.x >= lo && p.x <= hi)) return null;
  }
  const inner = D.ARCH_CLEARANCE + LEG_ACROSS / 2;
  const left = lo - inner;
  const right = hi + inner;
  const span = right - left + LEG_ACROSS;
  if (span > D.ARCH_MAX_SPAN) return null;
  const leg = (x: number): Vec2 => {
    const p = rotate({ x, y: 0 }, angle);
    return { x: support.at.x + p.x, y: support.at.y + p.y };
  };
  return { legs: [leg(left), leg(right)], angle, span, legBlocks: blocksFor(support.height - D.ARCH_BEAM) };
}
