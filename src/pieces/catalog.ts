import { pathEnd } from '../geometry/path';
import { deg, normalizeAngle, type Pose } from '../geometry/pose';
import * as D from './dimensions';
import { PLACES } from '../trains/stops';
import type { BridgeStyle, Connector, Gender, PieceCategory, PieceDef, TrackPath } from './types';

// Every piece is defined in its own frame: the first connector sits at the
// origin facing -x, and the track runs along +x. Pieces with a turn are
// defined turning left; the right-hand version is the same piece flipped
// over (Brio track is grooved on both faces), see `mirrorPiece`.

const ORIGIN: Pose = { x: 0, y: 0, angle: 0 };

const startOf = (path: TrackPath, id: string, gender: Gender): Connector => ({
  id,
  gender,
  pose: { x: path.from.x, y: path.from.y, angle: normalizeAngle(path.from.angle + Math.PI) },
  ...(path.z ? { z: path.z } : {}),
});

const endOf = (path: TrackPath, id: string, gender: Gender): Connector => {
  const z = (path.z ?? 0) + (path.rise ?? 0);
  const end = pathEnd(path);
  return { id, gender, pose: { ...end, angle: normalizeAngle(end.angle) }, ...(z ? { z } : {}) };
};

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
  { id: 'straight-middle', name: 'Middle straight', length: D.MIDDLE_STRAIGHT, brio: ['A3'] },
  { id: 'straight-short', name: 'Short straight', length: D.SHORT_STRAIGHT, brio: ['A1', 'B1', 'C1'] },
  { id: 'straight-medium', name: 'Medium straight', length: D.MEDIUM_STRAIGHT, brio: ['A', 'B', 'C'] },
  { id: 'straight-long', name: 'Long straight', length: D.LONG_STRAIGHT, brio: ['D'] },
];

const straights: PieceDef[] = STRAIGHTS.flatMap((s) =>
  // Brio letters: A = peg and hole, B = two pegs, C = two holes.
  GENDER_VARIANTS.filter((_, i) => i < s.brio.length).map((v, i) => ({
    ...twoEnded(s.id + v.suffix, s.name + v.label, [s.brio[i]], 'straight', straightPath(s.length), v.ends),
    // A3 is retired and rare: auto-fill sticks to the common lengths.
    ...(s.brio[i] === 'A3' ? { noFill: true } : {}),
  })),
);

/**
 * Bendy track: one piece in several shapes, from straight to bent as far as
 * a curve. Each bend is its own catalog entry so layouts, the check and the
 * trains treat it like any other piece; the parts list counts them all as
 * one bendy track, and Bend (B) on the floor swaps between them.
 */
const BENDY_STEPS = Math.round(D.BENDY_MAX_BEND / D.BENDY_STEP);
export const BENDY_IDS: readonly string[] = Array.from({ length: BENDY_STEPS + 1 }, (_, i) => (i ? `bendy-b${i}` : 'bendy'));

const bendy: PieceDef[] = BENDY_IDS.map((id, i) => {
  const bend = i * D.BENDY_STEP;
  const path = i ? arcPath(D.BENDY_LENGTH / bend, bend) : straightPath(D.BENDY_LENGTH);
  return {
    ...twoEnded(id, 'Bendy track', [], 'straight', path, ['hole', 'peg']),
    bend: Math.round((bend * 180) / Math.PI * 10) / 10,
    ...(i ? { partOf: 'bendy' } : {}),
  };
});

/** Bumpy track: a straight with humps that rock a train going over. Generic. */
const bumpy: PieceDef = twoEnded(
  'bumpy',
  'Bumpy track',
  [],
  'straight',
  { ...straightPath(D.BUMPY_LENGTH), bumps: D.BUMPY_COUNT },
  ['hole', 'peg'],
);

const CURVES = [
  { id: 'curve-large', name: 'Large curve', radius: D.LARGE_CURVE_RADIUS, angle: D.CURVE_ANGLE, brio: 'E' },
  { id: 'curve-short', name: 'Short curve', radius: D.SHORT_CURVE_RADIUS, angle: D.CURVE_ANGLE, brio: 'E1' },
  // Half curves aren't Brio pieces; other wooden railway brands sell them.
  { id: 'curve-large-half', name: 'Large half curve', radius: D.LARGE_CURVE_RADIUS, angle: D.HALF_CURVE_ANGLE, brio: '' },
  { id: 'curve-short-half', name: 'Short half curve', radius: D.SHORT_CURVE_RADIUS, angle: D.HALF_CURVE_ANGLE, brio: '' },
];

// Curves also come with two pegs or two holes; those variants have no
// letter of their own in the guide.
const curves: PieceDef[] = CURVES.flatMap((c) =>
  GENDER_VARIANTS.map((v, i) => ({
    ...twoEnded(
      c.id + v.suffix,
      c.name + v.label,
      i === 0 && c.brio ? [c.brio] : [],
      'curve',
      arcPath(c.radius, c.angle),
      v.ends,
    ),
    // Auto-fill sticks to Brio's own curves.
    ...(c.brio ? {} : { noFill: true }),
  })),
);

/**
 * Double track: two tracks side by side, a peg and a hole on each, the
 * second track on the right (the outside, on a curve). EE and EE1 are
 * retired but still about; K1 is two D straights side by side.
 */
function doubleTrack(id: string, name: string, brio: string, make: (from: Pose, outer: boolean) => TrackPath): PieceDef {
  const near = make(ORIGIN, false);
  const far = make({ x: 0, y: -D.DOUBLE_TRACK_SPACING, angle: 0 }, true);
  return {
    id,
    name,
    brioIds: [brio],
    category: 'double',
    paths: [near, far],
    connectors: [startOf(near, 'a', 'hole'), endOf(near, 'b', 'peg'), startOf(far, 'c', 'hole'), endOf(far, 'd', 'peg')],
  };
}

/**
 * K switching and crossing: a double straight with an S-bend crossover
 * from the near track's start to the far track's end, so trains can change
 * tracks. Its crossover runs the full D length.
 */
function doubleCrossover(): PieceDef {
  const near = straightPath(D.LONG_STRAIGHT);
  const far = straightPath(D.LONG_STRAIGHT, { x: 0, y: -D.DOUBLE_TRACK_SPACING, angle: 0 });
  return {
    id: 'double-crossover',
    name: 'Double crossover',
    brioIds: ['K'],
    category: 'double',
    paths: [near, far, ...sBend(D.LONG_STRAIGHT, -D.DOUBLE_TRACK_SPACING)],
    connectors: [startOf(near, 'a', 'hole'), endOf(near, 'b', 'peg'), startOf(far, 'c', 'hole'), endOf(far, 'd', 'peg')],
  };
}

const doubles: PieceDef[] = [
  doubleTrack('double-straight', 'Double straight', 'K1', (from) => straightPath(D.LONG_STRAIGHT, from)),
  doubleTrack('double-curve-large', 'Large double curve', 'EE', (from, outer) =>
    arcPath(D.LARGE_CURVE_RADIUS + (outer ? D.DOUBLE_TRACK_SPACING : 0), D.CURVE_ANGLE, from),
  ),
  doubleTrack('double-curve-short', 'Short double curve', 'EE1', (from, outer) =>
    arcPath(D.SHORT_CURVE_RADIUS + (outer ? D.DOUBLE_TRACK_SPACING : 0), D.CURVE_ANGLE, from),
  ),
  doubleCrossover(),
];

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
 * Curved ramp: a quarter turn on the E curve's radius that climbs a level,
 * a peg and a hole like N, or two pegs like N1. Generic, not lettered.
 */
const curvedRamps: PieceDef[] = [
  { suffix: '', name: 'Curved ramp', ends: ['hole', 'peg'] as Ends },
  { suffix: '-pp', name: 'Curved ramp, two pegs', ends: ['peg', 'peg'] as Ends },
].map((v) => ({
  ...twoEnded('ramp-curve' + v.suffix, v.name, [], 'ramp', { ...arcPath(D.LARGE_CURVE_RADIUS, D.CURVED_RAMP_SWEEP), rise: D.RAMP_RISE }, v.ends),
  noFill: true,
}));

/**
 * Helix tower: turns round a central column on the E curve's radius,
 * climbing a level each turn, and comes out over where it went in. The
 * column holds it up, so it needs no support blocks.
 */
const helix: PieceDef = {
  ...twoEnded(
    'helix',
    'Helix tower',
    [],
    'ramp',
    { ...arcPath(D.LARGE_CURVE_RADIUS, 2 * Math.PI * D.HELIX_TURNS), rise: D.HELIX_TURNS * D.LEVEL_HEIGHT, spiral: true },
    ['hole', 'peg'],
  ),
  structure: 'helix',
};

/**
 * Arch bridge: up a level, across, and back down, on its own legs. Track a
 * level below can run under the flat top. Not a lettered Brio piece.
 */
function archBridge(): PieceDef {
  const slope = D.ARCH_BRIDGE_SLOPE;
  const up: TrackPath = { ...straightPath(slope), rise: D.LEVEL_HEIGHT };
  const top: TrackPath = { ...straightPath(D.ARCH_BRIDGE_TOP, { x: slope, y: 0, angle: 0 }), z: D.LEVEL_HEIGHT };
  const down: TrackPath = {
    ...straightPath(slope, { x: slope + D.ARCH_BRIDGE_TOP, y: 0, angle: 0 }),
    z: D.LEVEL_HEIGHT,
    rise: -D.LEVEL_HEIGHT,
  };
  return {
    id: 'arch-bridge',
    name: 'Arch bridge',
    brioIds: [],
    category: 'ramp',
    paths: [up, top, down],
    connectors: [startOf(up, 'a', 'hole'), endOf(down, 'b', 'peg')],
  };
}

/**
 * A level bridge span a level up. Two holes, like the C straight in an up
 * and over: an N ramp climbs to one end and an N1 comes down from the other,
 * both peg end up.
 */
function bridgeSpan(id: string, name: string, style: BridgeStyle, length: number): PieceDef {
  const deck: TrackPath = { ...straightPath(length), z: D.LEVEL_HEIGHT };
  return {
    id,
    name,
    brioIds: [],
    category: 'ramp',
    bridge: style,
    paths: [deck],
    connectors: [startOf(deck, 'a', 'hole'), endOf(deck, 'b', 'hole')],
  };
}

/** A viaduct span along a curve, a level up, two holes like the straight spans. */
function curvedViaduct(): PieceDef {
  const deck: TrackPath = { ...arcPath(D.CURVED_VIADUCT_RADIUS, D.CURVED_VIADUCT_SWEEP), z: D.LEVEL_HEIGHT };
  return {
    id: 'bridge-viaduct-curved',
    name: 'Curved viaduct',
    brioIds: [],
    category: 'ramp',
    bridge: 'viaduct',
    paths: [deck],
    connectors: [startOf(deck, 'a', 'hole'), endOf(deck, 'b', 'hole')],
  };
}

const bridges: PieceDef[] = [
  ...curvedRamps,
  helix,
  archBridge(),
  bridgeSpan('bridge-viaduct', 'Stone viaduct', 'viaduct', D.VIADUCT_LENGTH),
  bridgeSpan('bridge-suspension', 'Suspension bridge', 'suspension', D.SUSPENSION_LENGTH),
  bridgeSpan('bridge-truss', 'Truss bridge', 'truss', D.TRUSS_LENGTH),
  bridgeSpan('bridge-covered', 'Covered bridge', 'covered', D.COVERED_BRIDGE_LENGTH),
  curvedViaduct(),
];

/**
 * A piece with one trunk end at the origin and several branch ends. Brio
 * sells each switch shape as a pair that differ only in which way round the
 * pegs are; which letter has the peg on the trunk is not confirmed.
 */
function branching(
  id: string,
  name: string,
  brioIds: [string, string?],
  routes: TrackPath[][],
): PieceDef[] {
  const paths = routes.flat();
  const make = (suffix: string, label: string, brio: string | undefined, trunk: Gender, branch: Gender): PieceDef => ({
    id: id + suffix,
    name: name + label,
    brioIds: brio ? [brio] : [],
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

/** An S-bend that ends parallel to its start, `offset` to the left (negative: right). */
function sBend(length: number, offset: number, from: Pose = ORIGIN): TrackPath[] {
  const turn = 2 * Math.atan(Math.abs(offset) / length);
  const radius = length / (2 * Math.sin(turn));
  const side = Math.sign(offset);
  const first = arcPath(radius, side * turn, from);
  return [first, arcPath(radius, -side * turn, pathEnd(first))];
}

const switches: PieceDef[] = [
  ...branching('switch-parallel-new', 'Parallel switch (A length)', ['F1', 'G1'], [
    [straightPath(D.PARALLEL_SWITCH_NEW_LENGTH)],
    sBend(D.PARALLEL_SWITCH_NEW_LENGTH, D.PARALLEL_SWITCH_NEW_OFFSET),
  ]),
  ...branching('switch-parallel-triple', 'Triple parallel switch', ['F2', 'G2'], [
    [straightPath(D.PARALLEL_SWITCH_NEW_LENGTH)],
    sBend(D.PARALLEL_SWITCH_NEW_LENGTH, D.PARALLEL_SWITCH_NEW_OFFSET),
    sBend(D.PARALLEL_SWITCH_NEW_LENGTH, -D.PARALLEL_SWITCH_NEW_OFFSET),
  ]),
  ...branching('switch-five-point', 'Five-point switch', ['Q'], [
    [straightPath(D.MEDIUM_STRAIGHT)],
    [arcPath(D.LARGE_CURVE_RADIUS, D.CURVE_ANGLE)],
    [arcPath(D.LARGE_CURVE_RADIUS, -D.CURVE_ANGLE)],
    [arcPath(D.FIVE_POINT_INNER_RADIUS, D.FIVE_POINT_INNER_ANGLE)],
    [arcPath(D.FIVE_POINT_INNER_RADIUS, -D.FIVE_POINT_INNER_ANGLE)],
  ]),
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

/**
 * Turntable: a pit with eight track ends round it, an eighth of a turn
 * apart. The bridge across it turns to line up any end with the one
 * opposite. The track is all four lines across; which one the bridge lies
 * along is the trains' business (src/trains/turntable.ts), so a train only
 * runs over the line it's turned to. Each line has a hole one end and a peg the other.
 */
function turntable(): PieceDef {
  const r = D.TURNTABLE_DIAMETER / 2;
  const lines = [0, 1, 2, 3].map((i) => {
    const angle = (i * Math.PI) / 4;
    return straightPath(D.TURNTABLE_DIAMETER, { x: r - r * Math.cos(angle), y: -r * Math.sin(angle), angle });
  });
  return {
    id: 'turntable',
    name: 'Turntable',
    brioIds: [],
    category: 'switch',
    structure: 'turntable',
    paths: lines,
    connectors: lines.flatMap((line, i) => [startOf(line, `e${i}`, 'hole'), endOf(line, `e${i + 4}`, 'peg')]),
  };
}

const bigSwitches: PieceDef[] = [...tSwitch(), starSwitch(), turntable()];

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

/**
 * H3 curved crossing: two E curves turning opposite ways that cross in the
 * middle, both entered from the same side. The second starts across from
 * the first by the distance the curve moves sideways, so their far ends
 * swap sides.
 */
function curvedCrossing(): PieceDef {
  const left = arcPath(D.LARGE_CURVE_RADIUS, D.CURVE_ANGLE);
  const shift = pathEnd(left).y;
  const right = arcPath(D.LARGE_CURVE_RADIUS, -D.CURVE_ANGLE, { x: 0, y: shift, angle: 0 });
  return {
    id: 'cross-curved',
    name: 'Curved crossing',
    brioIds: ['H3'],
    category: 'crossing',
    paths: [left, right],
    connectors: [startOf(left, 'a', 'hole'), endOf(left, 'b', 'peg'), startOf(right, 'c', 'hole'), endOf(right, 'd', 'peg')],
  };
}

const crossings: PieceDef[] = [
  curvedCrossing(),
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
  { ...loose('engine-shed', 'Engine shed'), seatsOnTrack: true },
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

export const CATALOG: readonly PieceDef[] = [...straights, ...bendy, bumpy, ...curves, ...doubles, ...ramps, ...bridges, ...switches, ...bigSwitches, ...crossings, ...buffers, ...scenery, ...trackside];

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
