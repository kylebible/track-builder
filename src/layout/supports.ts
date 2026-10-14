import type { Vec2 } from '../geometry/pose';
import { LEVEL_HEIGHT } from '../pieces/dimensions';
import { worldEnds, type Layout } from './layout';

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
  for (const piece of layout.pieces) {
    for (const end of worldEnds(piece)) {
      const height = end.connector.z ?? 0;
      if (height < 1) continue;
      const { x, y, angle } = end.connector.pose;
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
