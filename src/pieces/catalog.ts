import { pathEnd } from '../geometry/path';
import { deg, normalizeAngle, type Pose } from '../geometry/pose';
import * as D from './dimensions';
import { PLACES } from '../trains/stops';
import type { Connector, Gender, PieceCategory, PieceDef, TrackPath } from './types';

// Every piece is defined in its own frame: the first connector sits at the
// origin facing -x, and the track runs along +x. Pieces with a turn are
// defined turning left; the right-hand version is the same piece flipped
// over (Brio track is grooved on both faces), see `mirrorPiece`.

const ORIGIN: Pose = { x: 0, y: 0, angle: 0 };

const startOf = (path: TrackPath, id: string, gender: Gender): Connector => ({
  id,
  gender,
  pose: { x: path.from.x, y: path.from.y, angle: normalizeAngle(path.from.angle + Math.PI) },
});

const endOf = (path: TrackPath, id: string, gender: Gender): Connector => ({
  id,
  gender,
  pose: pathEnd(path),
  ...(path.rise ? { z: path.rise } : {}),
});

const straightPath = (length: number, from: Pose = ORIGIN): TrackPath => ({
  kind: 'straight',
  from,
  length,
});

const arcPath = (radius: number, sweep: number, from: Pose = ORIGIN): TrackPath => ({
  kind: 'arc',
  from,
  radius,
  sweep,
});

type Ends = [Gender, Gender];
const GENDER_VARIANTS: { suffix: string; label: string; ends: Ends }[] = [
  { suffix: '', label: '', ends: ['hole', 'peg'] },
  { suffix: '-pp', label: ', two pegs', ends: ['peg', 'peg'] },
  { suffix: '-hh', label: ', two holes', ends: ['hole', 'hole'] },
];

function twoEnded(
  id: string,
  name: string,
  brioIds: string[],
  category: PieceCategory,
  path: TrackPath,
  ends: Ends,
): PieceDef {
  return {
    id,
    name,
    brioIds,
    category,
    paths: [path],
    connectors: [startOf(path, 'a', ends[0]), endOf(path, 'b', ends[1])],
  };
}

const STRAIGHTS: { id: string; name: string; length: number; brio: string[] }[] = [
  { id: 'straight-mini', name: 'Mini straight', length: D.MINI_STRAIGHT, brio: ['A2', 'B2', 'C2'] },
  { id: 'straight-short', name: 'Short straight', length: D.SHORT_STRAIGHT, brio: ['A1', 'B1', 'C1'] },
  { id: 'straight-medium', name: 'Medium straight', length: D.MEDIUM_STRAIGHT, brio: ['A', 'B', 'C'] },
  { id: 'straight-long', name: 'Long straight', length: D.LONG_STRAIGHT, brio: ['D'] },
];

const straights: PieceDef[] = STRAIGHTS.flatMap((s) =>
  // Brio letters: A = peg and hole, B = two pegs, C = two holes.
  GENDER_VARIANTS.filter((_, i) => i < s.brio.length).map((v, i) =>
    twoEnded(s.id + v.suffix, s.name + v.label, [s.brio[i]], 'straight', straightPath(s.length), v.ends),
  ),
);

const CURVES = [
  { id: 'curve-large', name: 'Large curve', radius: D.LARGE_CURVE_RADIUS, brio: 'E' },
  { id: 'curve-short', name: 'Short curve', radius: D.SHORT_CURVE_RADIUS, brio: 'E1' },
];

// Curves also come with two pegs or two holes; those variants have no
// letter of their own in the guide.
const curves: PieceDef[] = CURVES.flatMap((c) =>
  GENDER_VARIANTS.map((v, i) =>
    twoEnded(
      c.id + v.suffix,
      c.name + v.label,
      i === 0 ? [c.brio] : [],
      'curve',
      arcPath(c.radius, D.CURVE_ANGLE),
      v.ends,
    ),
  ),
);

/**
 * N ascending track: a long straight that climbs one level from its `a` end
 * to its `b` end. Turned end for end it goes down. N has a peg and a hole
 * (which end has which is UNCONFIRMED; we put the hole at the bottom), N1
 * two pegs.
 */
const ramps: PieceDef[] = [
  { suffix: '', name: 'Ramp', brio: 'N', ends: ['hole', 'peg'] as Ends },
  { suffix: '-pp', name: 'Ramp, two pegs', brio: 'N1', ends: ['peg', 'peg'] as Ends },
].map((v) =>
  twoEnded('ramp' + v.suffix, v.name, [v.brio], 'ramp', { ...straightPath(D.RAMP_LENGTH), rise: D.RAMP_RISE }, v.ends),
);

/**
 * A piece with one trunk end at the origin and several branch ends. Brio
 * sells each switch shape as a pair that differ only in which way round the
 * pegs are; which letter has the peg on the trunk is not confirmed.
 */
function branching(
  id: string,
  name: string,
  brioIds: [string, string],
  routes: TrackPath[][],
): PieceDef[] {
  const paths = routes.flat();
  const make = (suffix: string, label: string, brio: string, trunk: Gender, branch: Gender): PieceDef => ({
    id: id + suffix,
    name: name + label,
    brioIds: [brio],
    category: 'switch',
    paths,
    connectors: [
      startOf(routes[0][0], 'trunk', trunk),
      ...routes.map((r, i) => endOf(r[r.length - 1], `branch${i}`, branch)),
    ],
  });
  return [
    make('', ', hole trunk', brioIds[0], 'hole', 'peg'),
    make('-peg', ', peg trunk', brioIds[1], 'peg', 'hole'),
  ];
}

/** An S-bend that ends parallel to its start, `offset` to the left. */
function sBend(length: number, offset: number): TrackPath[] {
  const turn = 2 * Math.atan(offset / length);
  const radius = length / (2 * Math.sin(turn));
  const first = arcPath(radius, turn);
  return [first, arcPath(radius, -turn, pathEnd(first))];
}

const switches: PieceDef[] = [
  ...branching('switch-parallel', 'Parallel switch', ['F', 'G'], [
    [straightPath(D.PARALLEL_SWITCH_LENGTH)],
    sBend(D.PARALLEL_SWITCH_LENGTH, D.PARALLEL_SWITCH_OFFSET),
  ]),
  ...branching('switch-curved', 'Curved switch', ['L', 'M'], [
    [straightPath(D.MEDIUM_STRAIGHT)],
    [arcPath(D.LARGE_CURVE_RADIUS, D.CURVE_ANGLE)],
  ]),
  ...branching('switch-three-way', 'Three-way switch', ['I', 'J'], [
    [straightPath(D.MEDIUM_STRAIGHT)],
    [arcPath(D.LARGE_CURVE_RADIUS, D.CURVE_ANGLE)],
    [arcPath(D.LARGE_CURVE_RADIUS, -D.CURVE_ANGLE)],
  ]),
  ...branching('switch-short-curved', 'Short curved switch', ['O1', 'P1'], [
    [straightPath(D.SHORT_STRAIGHT)],
    [arcPath(D.SHORT_CURVE_RADIUS, D.CURVE_ANGLE)],
  ]),
];

/**
 * T switch: a D straight across the top, and two quarter curves from the
 * trunk that run into its ends, so a train from the trunk turns left or
 * right, and one along the top can carry straight on or turn down the trunk.
 * Genders are UNCONFIRMED; like the other switches it comes both ways round.
 */
function tSwitch(): PieceDef[] {
  const r = D.T_SWITCH_RADIUS;
  const left = arcPath(r, Math.PI / 2);
  const right = arcPath(r, -Math.PI / 2);
  const top = straightPath(D.T_SWITCH_LENGTH, { x: r, y: -r, angle: Math.PI / 2 });
  const make = (suffix: string, label: string, trunk: Gender, ends: Gender): PieceDef => ({
    id: 'switch-t' + suffix,
    name: 'T switch' + label,
    brioIds: suffix ? [] : ['T'],
    category: 'switch',
    paths: [left, right, top],
    connectors: [startOf(left, 'trunk', trunk), endOf(left, 'branch0', ends), endOf(right, 'branch1', ends)],
  });
  return [make('', ', hole trunk', 'hole', 'peg'), make('-peg', ', peg trunk', 'peg', 'hole')];
}

/**
 * X star switch: two D straights crossing at right angles, with a quarter
 * curve joining every pair of neighbouring ends, so from any end a train
 * can go straight on or turn either way. Genders are UNCONFIRMED; we give
 * each straight a peg and a hole, like the criss cross.
 */
function starSwitch(): PieceDef {
  const r = D.T_SWITCH_RADIUS;
  const main = straightPath(D.T_SWITCH_LENGTH);
  const across = straightPath(D.T_SWITCH_LENGTH, { x: r, y: -r, angle: Math.PI / 2 });
  const back: Pose = { x: 2 * r, y: 0, angle: Math.PI };
  return {
    id: 'switch-star',
    name: 'Star switch',
    brioIds: ['X'],
    category: 'switch',
    paths: [main, across, arcPath(r, Math.PI / 2), arcPath(r, -Math.PI / 2), arcPath(r, Math.PI / 2, back), arcPath(r, -Math.PI / 2, back)],
    connectors: [startOf(main, 'a', 'hole'), endOf(main, 'b', 'peg'), startOf(across, 'c', 'hole'), endOf(across, 'd', 'peg')],
  };
}

const bigSwitches: PieceDef[] = [...tSwitch(), starSwitch()];

/** Two straights of equal length crossing at their midpoints. */
function crossing(
  id: string,
  name: string,
  brio: string,
  length: number,
  angle: number,
  genders: [Ends, Ends],
): PieceDef {
  const half = length / 2;
  const main = straightPath(length);
  const across = straightPath(length, {
    x: half - half * Math.cos(angle),
    y: -half * Math.sin(angle),
    angle,
  });
  return {
    id,
    name,
    brioIds: [brio],
    category: 'crossing',
    paths: [main, across],
    connectors: [
      startOf(main, 'a', genders[0][0]),
      endOf(main, 'b', genders[0][1]),
      startOf(across, 'c', genders[1][0]),
      endOf(across, 'd', genders[1][1]),
    ],
  };
}

const crossings: PieceDef[] = [
  // The guide says H1's ends are peg-to-peg and hole-to-hole.
  crossing('cross', 'Cross', 'H1', D.CROSS_LENGTH, deg(90), [
    ['peg', 'peg'],
    ['hole', 'hole'],
  ]),
  crossing('criss-cross', 'Criss cross', 'H2', D.CRISS_CROSS_LENGTH, D.CRISS_CROSS_ANGLE, [
    ['hole', 'peg'],
    ['hole', 'peg'],
  ]),
];

function bufferStop(id: string, name: string, brio: string, gender: Gender): PieceDef {
  const path = straightPath(D.BUFFER_STOP_LENGTH);
  return { id, name, brioIds: [brio], category: 'buffer', paths: [path], connectors: [startOf(path, 'a', gender)] };
}

const buffers: PieceDef[] = [
  bufferStop('buffer', 'Buffer stop, hole', 'R', 'hole'),
  bufferStop('buffer-peg', 'Buffer stop, peg', 'S', 'peg'),
];

const loose = (id: string, name: string): PieceDef => ({
  id,
  name,
  brioIds: [],
  category: 'scenery',
  paths: [],
  connectors: [],
  model: id,
});

/** Generic versions of the accessories wooden railway brands sell alongside track. */
const scenery: PieceDef[] = [
  {
    ...twoEnded('level-crossing', 'Level crossing', [], 'scenery', straightPath(D.MEDIUM_STRAIGHT), ['hole', 'peg']),
    model: 'level-crossing',
  },
  {
    ...twoEnded('lift-bridge', 'Lifting bridge', [], 'scenery', straightPath(D.LIFT_BRIDGE_LENGTH), ['hole', 'peg']),
    model: 'lift-bridge',
    liftSpan: [D.LIFT_SPAN_FROM, D.LIFT_SPAN_TO],
  },
  { ...loose('tunnel', 'Tunnel'), seatsOnTrack: true },
  { ...loose('station', 'Station'), seatsOnTrack: true },
  { ...loose('bridge-pier', 'Bridge pier'), seatsOnTrack: true, holdsTrackAt: D.LEVEL_HEIGHT },
  { ...loose('cargo-loader', 'Cargo loader'), seatsOnTrack: true },
  loose('crane', 'Magnetic crane'),
  loose('signal', 'Signal'),
  loose('leafy-tree', 'Leafy tree'),
  loose('pine-tree', 'Pine tree'),
  loose('cottage', 'Cottage'),
];

/** Places beside the track that trains stop at; see src/trains/stops.ts. Each sits over a straight. */
const trackside: PieceDef[] = PLACES.filter((p) => p.id !== 'station').map((p) => ({
  ...loose(p.id, p.name),
  category: 'trackside',
  seatsOnTrack: true,
}));

export const CATALOG: readonly PieceDef[] = [...straights, ...curves, ...ramps, ...switches, ...bigSwitches, ...crossings, ...buffers, ...scenery, ...trackside];

const byId = new Map(CATALOG.map((p) => [p.id, p]));

export function getPiece(id: string): PieceDef {
  const piece = byId.get(id);
  if (!piece) throw new Error(`Unknown piece: ${id}`);
  return piece;
}

const mirrorPose = (p: Pose): Pose => ({ x: p.x, y: -p.y, angle: normalizeAngle(-p.angle) });

/** The same piece flipped over: left turns become right turns. */
export function mirrorPiece(piece: PieceDef): PieceDef {
  return {
    ...piece,
    mirrored: !piece.mirrored,
    paths: piece.paths.map((p) =>
      p.kind === 'arc' ? { ...p, from: mirrorPose(p.from), sweep: -p.sweep } : { ...p, from: mirrorPose(p.from) },
    ),
    connectors: piece.connectors.map((c) => ({ ...c, pose: mirrorPose(c.pose) })),
  };
}
