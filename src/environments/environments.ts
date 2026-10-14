import { heightAt, pathLength, poseAt } from '../geometry/path';
import { applyPose, type Vec2 } from '../geometry/pose';
import * as D from '../pieces/dimensions';
import { baseOf, defOf, type Layout, type PlacedPiece } from '../layout/layout';

// What the track is built on top of. Every environment puts its play surface
// at the floor level the track sits on (height 0), so building, snapping and
// dragging work the same everywhere; only the surroundings change.
//
// Sizes are real millimetres. Environments with a play area of a fixed size
// (the table, the rug) say how big it is, so the check can say when track
// runs off it. Environments with water (a river, a lake) say where it is,
// so the check can say when track on the ground runs into it.

export type EnvironmentId = 'table' | 'rug' | 'playmat' | 'floor' | 'grid' | 'grass' | 'town' | 'river' | 'lake' | 'snow';

export interface Environment {
  id: EnvironmentId;
  name: string;
  /** One line under the name in the picker. */
  detail: string;
  /** The usable play area, centred on the origin, mm. Missing means it runs on and on. */
  area?: { width: number; depth: number };
  /** What leaving the area means, for the check: true where track would fall off. */
  edgeIsDrop?: boolean;
  /** Where there's water, if anywhere: what it's called, and whether a plan point is in it. */
  water?: { name: string; contains: (p: Vec2) => boolean };
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

/** A printed play mat for children: roads, a river, a farm, a beach. About 4 mm thick. */
export const PLAYMAT = { width: 2400, depth: 1600, thickness: 4 } as const;

/**
 * A river across the plan, north of the middle so a layout started at the
 * origin is on dry land. Its centreline meanders gently; plan mm.
 */
export const RIVER = { y: 650, width: 320, swing: 160, wavelength: 2600 } as const;

export const riverCentre = (x: number): number => RIVER.y + RIVER.swing * Math.sin((2 * Math.PI * x) / RIVER.wavelength);

/** Inside the river's banks. */
export function inRiver(p: Vec2): boolean {
  return Math.abs(p.y - riverCentre(p.x)) < RIVER.width / 2;
}

/** A lake to the east of the middle, with a wobbly shore. Plan mm. */
export const LAKE = { x: 1150, y: -150, rx: 620, ry: 440 } as const;

/** How far the shore is from the lake's middle in direction `angle`, as a fraction of the ellipse. */
export const lakeShore = (angle: number): number => 1 + 0.09 * Math.sin(3 * angle + 0.6) + 0.05 * Math.sin(5 * angle + 2.1);

/** Inside the lake's shore. */
export function inLake(p: Vec2): boolean {
  const dx = (p.x - LAKE.x) / LAKE.rx;
  const dy = (p.y - LAKE.y) / LAKE.ry;
  return Math.hypot(dx, dy) < lakeShore(Math.atan2(dy, dx));
}

/** Town streets run in a grid this far apart, centre to centre, plan mm. */
export const TOWN = { block: 1500, road: 200, pavement: 40 } as const;

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
  {
    id: 'playmat',
    name: 'Kids’ play mat',
    detail: `${PLAYMAT.width / 1000} × ${PLAYMAT.depth / 1000} m of roads, river, farm and beach`,
    area: { width: PLAYMAT.width, depth: PLAYMAT.depth },
  },
  { id: 'floor', name: 'Hardwood floor', detail: 'Oak boards, room for anything' },
  { id: 'grid', name: 'Grid mat', detail: '10 cm squares for measuring' },
  { id: 'grass', name: 'Outdoor grass', detail: 'A lawn on a sunny day' },
  { id: 'town', name: 'Town streets', detail: `Roads every ${TOWN.block / 1000} m, for level crossings` },
  {
    id: 'river',
    name: 'River meadow',
    detail: `A ${RIVER.width / 10} cm river to bridge`,
    water: { name: 'river', contains: inRiver },
  },
  { id: 'lake', name: 'Lake beach', detail: 'Sand round a lake', water: { name: 'lake', contains: inLake } },
  { id: 'snow', name: 'Snowy field', detail: 'A winter layout' },
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

/** Track lower than this is lying on the ground (or in the water). */
const ON_GROUND = 1;

/**
 * Pieces lying on the ground where there's water, and roughly where.
 * Raised track (on supports, or the top of a ramp) can cross water like a
 * bridge; track on the ground would sink.
 */
export function inWater(layout: Layout, environment: Environment): { uids: string[]; at: Vec2 } | null {
  const water = environment.water;
  if (!water) return null;
  const half = D.TRACK_WIDTH / 2;
  const uids: string[] = [];
  const sum = { x: 0, y: 0, n: 0 };
  for (const piece of layout.pieces) {
    if (wet(piece, water.contains, half, sum)) uids.push(piece.uid);
  }
  return uids.length ? { uids, at: { x: sum.x / sum.n, y: sum.y / sum.n } } : null;
}

function wet(piece: PlacedPiece, contains: (p: Vec2) => boolean, half: number, sum: { x: number; y: number; n: number }): boolean {
  let any = false;
  for (const path of defOf(piece).paths) {
    const length = pathLength(path);
    const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP));
    for (let i = 0; i <= steps; i++) {
      const along = (length * i) / steps;
      if (baseOf(piece) + heightAt(path, along) >= ON_GROUND) continue;
      const at = poseAt(path, along);
      for (const side of [-half, 0, half]) {
        const p = applyPose(piece.pose, applyPose(at, { x: 0, y: side, angle: 0 }));
        if (!contains(p)) continue;
        any = true;
        sum.x += p.x;
        sum.y += p.y;
        sum.n++;
      }
    }
  }
  return any;
}
