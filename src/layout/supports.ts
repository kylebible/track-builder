import type { Vec2 } from '../geometry/pose';
import { LEVEL_HEIGHT } from '../pieces/dimensions';
import type { PieceDef } from '../pieces/types';
import { defOf, worldEnds, type Layout } from './layout';

/** Pieces on a structure of their own (a bridge span, a helix tower), which need no supports. */
export const standsAlone = (def: PieceDef): boolean => !!def.bridge || def.structure === 'helix';

// Raised track stands on stacks of support blocks, one stack under every
// raised end: two joined ends share one, as on the floor, where the support
// goes under the joint. They are worked out from the layout, never placed
// by hand, so they can't be forgotten from the parts list.

export interface Support {
  /** Where it stands, in plan mm. */
  at: Vec2;
  /** Which way the track runs over it. */
  angle: number;
  /** Height of its top: the bottom of the track it holds. */
  height: number;
  /** Blocks stacked to reach that height. */
  blocks: number;
  /** The pieces resting on it. */
  uids: string[];
}

/** Ends this close count as resting on the same support. */
const SHARE_MM = 12;

export function supportsOf(layout: Layout): Support[] {
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
      supports.push({ at: { x, y }, angle, height, blocks: Math.max(1, Math.ceil(height / LEVEL_HEIGHT - 1e-6)), uids: [piece.uid] });
    }
  }
  return supports;
}
