import { pathLength, poseAt } from '../geometry/path';
import { applyPose, type Vec2 } from '../geometry/pose';
import * as D from '../pieces/dimensions';
import { defOf, type Layout } from '../layout/layout';

// What the track is built on top of. Every environment puts its play surface
// at the floor level the track sits on (height 0), so building, snapping and
// dragging work the same everywhere; only the surroundings change.
//
// Sizes are real millimetres. Environments with a play area of a fixed size
// (the table, the rug) say how big it is, so the check can say when track
// runs off it.

export type EnvironmentId = 'table' | 'rug' | 'floor' | 'grass' | 'grid';

export interface Environment {
  id: EnvironmentId;
  name: string;
  /** One line under the name in the picker. */
  detail: string;
  /** The usable play area, centred on the origin, mm. Missing means it runs on and on. */
  area?: { width: number; depth: number };
  /** What leaving the area means, for the check: true where track would fall off. */
  edgeIsDrop?: boolean;
}

/**
 * UNMEASURED ASSUMPTION. Train tables vary (Brio's own, IKEA, KidKraft). This
 * is a common size: a 1220 x 820 mm top with a 20 mm raised rim, leaving
 * 1180 x 780 mm of play surface, about 400 mm off the floor.
 */
export const TABLE = {
  width: 1220,
  depth: 820,
  rim: 20,
  rimHeight: 18,
  top: 18,
  height: 400,
} as const;

/** A 2 x 1.4 m rug, about 10 mm thick. */
export const RUG = { width: 2000, depth: 1400, thickness: 10 } as const;

export const ENVIRONMENTS: readonly Environment[] = [
  {
    id: 'table',
    name: 'Play table',
    detail: `${(TABLE.width / 10).toFixed(0)} × ${(TABLE.depth / 10).toFixed(0)} cm with a rim`,
    area: { width: TABLE.width - 2 * TABLE.rim, depth: TABLE.depth - 2 * TABLE.rim },
    edgeIsDrop: true,
  },
  {
    id: 'rug',
    name: 'Living room rug',
    detail: `${RUG.width / 1000} × ${RUG.depth / 1000} m on a wooden floor`,
    area: { width: RUG.width, depth: RUG.depth },
  },
  { id: 'floor', name: 'Hardwood floor', detail: 'Oak boards, room for anything' },
  { id: 'grass', name: 'Outdoor grass', detail: 'A lawn on a sunny day' },
  { id: 'grid', name: 'Grid mat', detail: '10 cm squares for measuring' },
];

export const DEFAULT_ENVIRONMENT: EnvironmentId = 'table';

export function getEnvironment(id: EnvironmentId): Environment {
  return ENVIRONMENTS.find((e) => e.id === id)!;
}

/** The environment a saved value names, if it names one we know. */
export function environmentId(value: unknown): EnvironmentId | undefined {
  return ENVIRONMENTS.find((e) => e.id === value)?.id;
}

/** Spacing of the points sampled along each piece's track. */
const SAMPLE_STEP = 10;

/**
 * Pieces whose track goes past the edge of the environment's play area,
 * and roughly where. Track counts as off once either of its sides crosses
 * the edge (the table's rim, the rug's border). Scenery isn't checked.
 */
export function offArea(layout: Layout, environment: Environment): { uids: string[]; at: Vec2 } | null {
  const area = environment.area;
  if (!area) return null;
  const halfW = area.width / 2;
  const halfD = area.depth / 2;
  const half = D.TRACK_WIDTH / 2;
  const uids: string[] = [];
  const sum = { x: 0, y: 0, n: 0 };
  for (const piece of layout.pieces) {
    let off = false;
    for (const path of defOf(piece).paths) {
      const length = pathLength(path);
      const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP));
      for (let i = 0; i <= steps; i++) {
        const at = poseAt(path, (length * i) / steps);
        // Both edges of the track, not just its centreline.
        for (const side of [-half, half]) {
          const p = applyPose(piece.pose, applyPose(at, { x: 0, y: side, angle: 0 }));
          if (Math.abs(p.x) <= halfW + 1e-6 && Math.abs(p.y) <= halfD + 1e-6) continue;
          off = true;
          sum.x += p.x;
          sum.y += p.y;
          sum.n++;
        }
      }
    }
    if (off) uids.push(piece.uid);
  }
  return uids.length ? { uids, at: { x: sum.x / sum.n, y: sum.y / sum.n } } : null;
}
