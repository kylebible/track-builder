import * as THREE from 'three';
import * as D from '../pieces/dimensions';

// Scenery models, built from simple solids at real size in millimetres.
// `npm run scenery` exports each one to public/models/scenery/<name>.glb,
// which is what the app loads, so a model can be reworked in Blender and
// re-exported over the generated file.
//
// Frame: three.js axes, y up, floor at y = 0. Models that belong on the
// track are centred on the track centerline with the track running along x;
// the rest are centred on their footprint. The designs are generic, in the
// style of painted wooden railway accessories, with no brand markings.

const PAINT = {
  wood: 0xd9b47c,
  darkWood: 0x8a5a33,
  red: 0xc8352b,
  white: 0xf5f1e8,
  cream: 0xf0e2c0,
  grass: 0x5f9e45,
  pine: 0x2f6b34,
  leaf: 0x4f9a3c,
  stone: 0x9a968c,
  road: 0x6d6a66,
  yellow: 0xe8b33a,
  black: 0x2b2620,
  glass: 0x3d5a80,
  signalRed: 0xe0362b,
  signalGreen: 0x2fbf5a,
} as const;

type Paint = keyof typeof PAINT;

/** One material per paint, shared so exported files stay small. */
const materials = new Map<Paint, THREE.MeshStandardMaterial>();
function paint(name: Paint): THREE.MeshStandardMaterial {
  let m = materials.get(name);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ name, color: PAINT[name], roughness: name === 'glass' ? 0.3 : 0.7 });
    materials.set(name, m);
  }
  return m;
}

type V3 = [number, number, number];

/** A box of size [x, y, z] whose bottom face is centred on `at`. */
function box(name: Paint, size: V3, at: V3): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), paint(name));
  mesh.position.set(at[0], at[1] + size[1] / 2, at[2]);
  return mesh;
}

/** An upright cylinder (or cone, with `top` 0) standing on `at`. */
function cylinder(name: Paint, radius: number, height: number, at: V3, top = radius, segments = 16): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, radius, height, segments), paint(name));
  mesh.position.set(at[0], at[1] + height / 2, at[2]);
  return mesh;
}

/**
 * A shape drawn across the track (u sideways, v up) and extruded `length`
 * along x, centred on x = `x`.
 */
function extrudeAlongX(name: Paint, shape: THREE.Shape, length: number, x = 0): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: 12 });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(x - length / 2, 0, 0);
  return new THREE.Mesh(geometry, paint(name));
}

/** A gable roof: a triangle `width` wide and `height` tall, `length` long. */
function gableRoof(name: Paint, width: number, height: number, length: number, at: V3): THREE.Mesh {
  const shape = new THREE.Shape().moveTo(-width / 2, 0).lineTo(width / 2, 0).lineTo(0, height).closePath();
  const roof = extrudeAlongX(name, shape, length, at[0]);
  roof.position.set(0, at[1], at[2]);
  return roof;
}

function group(name: string, ...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.add(...children);
  return g;
}

// ---- tunnel ---------------------------------------------------------------

export const TUNNEL = {
  length: D.MEDIUM_STRAIGHT,
  width: 130,
  height: 115,
  /** Opening: wide and tall enough for a wooden engine with room to spare. */
  openingWidth: 64,
  openingHeight: 92,
};

/** A grassy hill with a stone-faced arch through it, as long as a medium straight. */
export function tunnel(): THREE.Group {
  const { length, width, height, openingWidth, openingHeight } = TUNNEL;
  const w = width / 2;
  const r = openingWidth / 2;
  const springing = openingHeight - r;
  const shoulder = height - 40;
  const hill = new THREE.Shape()
    .moveTo(-w, 0)
    .lineTo(-r, 0)
    .lineTo(-r, springing)
    .absarc(0, springing, r, Math.PI, 0, true)
    .lineTo(r, 0)
    .lineTo(w, 0)
    .lineTo(w, shoulder);
  hill.absellipse(0, shoulder, w, height - shoulder, 0, Math.PI, false);
  hill.closePath();

  const band = 12;
  const portalShape = new THREE.Shape()
    .moveTo(-r - band, 0)
    .lineTo(-r, 0)
    .lineTo(-r, springing)
    .absarc(0, springing, r, Math.PI, 0, true)
    .lineTo(r, 0)
    .lineTo(r + band, 0)
    .lineTo(r + band, springing)
    .absarc(0, springing, r + band, 0, Math.PI, false)
    .closePath();
  const portalDepth = 5;
  const portals = [-1, 1].map((side) =>
    extrudeAlongX('stone', portalShape, portalDepth, side * (length / 2 + portalDepth / 2 - 1)),
  );
  return group('tunnel', extrudeAlongX('grass', hill, length), ...portals);
}

// ---- station --------------------------------------------------------------

export const STATION = {
  length: D.LONG_STRAIGHT,
  platformHeight: 22,
  platformDepth: 48,
  /** Gap between the track's edge and the platform's face. */
  clearance: 4,
};

/** A platform and station building beside the track, on its left (-z). */
export function station(): THREE.Group {
  const { length, platformHeight: ph, platformDepth: pd, clearance } = STATION;
  const face = D.TRACK_WIDTH / 2 + clearance;
  const pz = -(face + pd / 2);
  const platform = box('stone', [length, ph, pd], [0, 0, pz]);
  const edge = box('yellow', [length, 0.6, 4], [0, ph, -(face + 4)]);

  const bw = 120;
  const bh = 50;
  const bd = 30;
  const bz = -(face + pd - bd / 2 - 4);
  const front = bz + bd / 2;
  const walls = box('cream', [bw, bh, bd], [0, ph, bz]);
  const roof = gableRoof('red', bd + 10, 20, bw + 10, [0, ph + bh, bz]);
  const door = box('darkWood', [16, 28, 1], [0, ph, front + 0.5]);
  const windows = [-36, 36].map((x) => box('glass', [18, 16, 1], [x, ph + 18, front + 0.5]));
  const clock = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 1, 20), paint('white'));
  clock.rotation.x = Math.PI / 2;
  clock.position.set(0, ph + 40, front + 0.5);
  // A canopy over the platform, on two posts.
  const canopyDepth = pd - bd - 2;
  const canopyZ = front + canopyDepth / 2;
  const canopy = box('red', [bw - 10, 3, canopyDepth + 4], [0, ph + 44, canopyZ]);
  const posts = [-45, 45].map((x) => cylinder('white', 1.8, 44, [x, ph, front + canopyDepth - 2], 1.8, 8));
  const bench = box('darkWood', [26, 6, 6], [-70, ph, front + 4]);

  return group('station', platform, edge, walls, roof, door, ...windows, clock, canopy, ...posts, bench);
}

// ---- level crossing ---------------------------------------------------------

export const LEVEL_CROSSING = {
  length: D.MEDIUM_STRAIGHT,
  roadWidth: 64,
  roadReach: 90,
};

/**
 * Road boards and barriers for a level crossing piece. The track itself is
 * drawn from the piece's path, so this frame starts at the piece's first
 * end and runs along +x.
 */
export function levelCrossing(): THREE.Group {
  const { length, roadWidth, roadReach } = LEVEL_CROSSING;
  const cx = length / 2;
  const inner = D.TRACK_WIDTH / 2 + 1;
  const side = roadReach - inner;
  const parts: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const z = s * (inner + side / 2);
    parts.push(box('road', [roadWidth, D.TRACK_HEIGHT, side], [cx, 0, z]));
    for (const e of [-1, 1]) parts.push(box('white', [2, 0.4, side], [cx + e * (roadWidth / 2 - 4), D.TRACK_HEIGHT, z]));
  }
  // Boards between the grooves and outside them, flush with the track top.
  const g0 = D.GROOVE_SPACING / 2 - D.GROOVE_WIDTH / 2;
  parts.push(box('road', [roadWidth, 0.6, 2 * g0 - 1], [cx, D.TRACK_HEIGHT, 0]));

  // Two barriers on opposite corners, lowered across the road.
  const armHeight = 40;
  const armLength = roadWidth - 4;
  for (const s of [-1, 1]) {
    const postX = cx - s * (roadWidth / 2 + 8);
    const postZ = s * (roadReach - 10);
    parts.push(box('black', [12, 6, 12], [postX, 0, postZ]));
    parts.push(cylinder('white', 3, armHeight + 6, [postX, 6, postZ], 3, 12));
    const stripes = 6;
    for (let i = 0; i < stripes; i++) {
      const len = armLength / stripes;
      const x = postX + s * (6 + len * (i + 0.5));
      parts.push(box(i % 2 ? 'white' : 'red', [len, 4, 3], [x, armHeight, postZ]));
    }
  }
  return group('level-crossing', ...parts);
}

// ---- bridge pier -----------------------------------------------------------

export const PIER = {
  /** Height of the track bed, the top of the cradle the track sits in. */
  bedHeight: 64,
  footprint: [40, 64] as [number, number],
};

/** A pier that holds a track up off the floor in a cradle. */
export function bridgePier(): THREE.Group {
  const { bedHeight: h, footprint } = PIER;
  const [fx, fz] = footprint;
  const slot = D.TRACK_WIDTH + 1;
  const lip = 6;
  return group(
    'bridge-pier',
    box('darkWood', [fx, 8, fz], [0, 0, 0]),
    box('wood', [fx - 8, h - 14, fz - 14], [0, 8, 0]),
    box('wood', [fx, 6, slot + 2 * lip], [0, h - 6, 0]),
    ...[-1, 1].map((s) => box('wood', [fx, 10, lip], [0, h, s * (slot / 2 + lip / 2)])),
  );
}

// ---- signal -----------------------------------------------------------------

export const SIGNAL = {
  /** Lamp centres in the model's frame. */
  red: [5, 120, 0] as V3,
  green: [5, 108, 0] as V3,
  lampRadius: 4.5,
};

/** A colour light signal on a post. Its lamps face +x, toward the train. */
export function signal(): THREE.Group {
  const postHeight = 100;
  const head = box('black', [10, 34, 16], [0, postHeight - 4, 0]);
  const lamps = (
    [
      ['signalRed', postHeight + 20],
      ['signalGreen', postHeight + 8],
    ] as const
  ).map(([name, y]) => {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(4.5, 12, 8), paint(name));
    lamp.position.set(5, y, 0);
    return lamp;
  });
  return group(
    'signal',
    box('darkWood', [26, 6, 26], [0, 0, 0]),
    cylinder('white', 2.5, postHeight, [0, 6, 0], 2.5, 10),
    head,
    ...lamps,
  );
}

// ---- trees ----------------------------------------------------------------

/** A round leafy tree on a peg-style base. */
export function leafyTree(): THREE.Group {
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(32, 1), paint('leaf'));
  crown.position.y = 88;
  crown.scale.set(1, 1.1, 1);
  return group(
    'leafy-tree',
    cylinder('grass', 20, 5, [0, 0, 0], 20, 20),
    cylinder('darkWood', 5, 60, [0, 5, 0], 4, 10),
    crown,
  );
}

/** A tall pine tree of three stacked cones. */
export function pineTree(): THREE.Group {
  const tiers: [number, number, number][] = [
    [30, 45, 25],
    [24, 40, 52],
    [17, 36, 80],
  ];
  return group(
    'pine-tree',
    cylinder('grass', 20, 5, [0, 0, 0], 20, 20),
    cylinder('darkWood', 4, 30, [0, 5, 0], 4, 10),
    ...tiers.map(([r, h, y]) => cylinder('pine', r, h, [0, y, 0], 0, 12)),
  );
}

// ---- cottage ----------------------------------------------------------------

/** A small house with a gable roof. Its door faces +z. */
export function cottage(): THREE.Group {
  const w = 80;
  const d = 60;
  const h = 50;
  const front = d / 2;
  return group(
    'cottage',
    box('cream', [w, h, d], [0, 0, 0]),
    gableRoof('red', d + 10, 32, w + 10, [0, h, 0]),
    box('red', [10, 24, 10], [22, h + 8, -10]),
    box('darkWood', [16, 28, 1], [0, 0, front + 0.5]),
    ...[-26, 26].map((x) => box('glass', [14, 14, 1], [x, 22, front + 0.5])),
    ...[-26, 26].map((x) => box('white', [18, 2, 2], [x, 20, front + 1])),
  );
}

// ---- cargo --------------------------------------------------------------

export const CRATE = { size: 22, height: 24 };

/** A wooden crate with a metal plate on top, for magnets to lift. Bottom centred on the origin. */
export function crate(): THREE.Group {
  const { size, height } = CRATE;
  return group(
    'crate',
    box('wood', [size, height, size], [0, 0, 0]),
    ...[0.3, 0.7].map((h) => box('darkWood', [size + 0.6, 2.4, size + 0.6], [0, height * h, 0])),
    cylinder('stone', 5, 1, [0, height, 0], 5, 12),
  );
}

// ---- magnetic crane ---------------------------------------------------------

export const CRANE = {
  /** Height of the arm's pivot, on top of the tower. */
  pivotHeight: 150,
  boomLength: 160,
  /** The hook reaches track this close to and this far from the crane's middle. */
  minReach: 50,
  maxReach: 150,
  /** Where it stacks what it unloads, out from its middle. */
  pileReach: 82,
  /** How far below the boom the magnet hangs at rest. */
  restDrop: 34,
  magnetHeight: 8,
};

/** The crane's base and tower. The arm on top turns, so it is built separately: `craneArm`. */
export function crane(): THREE.Group {
  const { pivotHeight } = CRANE;
  return group(
    'crane',
    cylinder('darkWood', 34, 8, [0, 0, 0], 34, 28),
    cylinder('yellow', 26, 6, [0, 8, 0], 26, 28),
    box('yellow', [18, pivotHeight - 22, 18], [0, 14, 0]),
    ...[-1, 1].flatMap((s) => [box('black', [19, 3, 2], [0, 50, s * 9.5]), box('black', [19, 3, 2], [0, 100, s * 9.5])]),
    cylinder('black', 12, 8, [0, pivotHeight - 8, 0], 12, 20),
  );
}

/**
 * The crane's turning arm: cab, boom along +x and counterweight, with the
 * hook hanging from a trolley. Named parts: `crane-hook` (moved along the
 * boom), `crane-rope` (one unit long, stretched to length) and
 * `crane-magnet` (moved down the rope). Sits at the pivot height.
 */
export function craneArm(): THREE.Group {
  const { boomLength, restDrop, magnetHeight } = CRANE;
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1, 6), paint('black'));
  rope.geometry.translate(0, -0.5, 0);
  rope.name = 'crane-rope';
  rope.scale.y = restDrop;
  const magnet = group('crane-magnet', cylinder('red', 9, magnetHeight, [0, -magnetHeight, 0], 9, 18), cylinder('black', 9.4, 2, [0, -magnetHeight, 0], 9.4, 18));
  magnet.position.y = -restDrop;
  const hook = group('crane-hook', box('black', [12, 5, 14], [0, -5, 0]), rope, magnet);
  hook.position.x = boomLength - 20;
  const arm = group(
    'crane-arm',
    box('red', [34, 28, 28], [-4, 0, 0]),
    box('glass', [1, 12, 20], [13.5, 10, 0]),
    gableRoof('red', 32, 8, 38, [-4, 28, 0]),
    box('yellow', [boomLength, 8, 10], [boomLength / 2, 18, 0]),
    box('yellow', [boomLength * 0.6, 4, 4], [boomLength * 0.32, 30, 0]),
    box('darkWood', [26, 22, 26], [-34, 4, 0]),
    hook,
  );
  hook.position.y = 18;
  arm.position.y = CRANE.pivotHeight;
  return arm;
}

// ---- cargo loader ---------------------------------------------------------

export const LOADER = {
  /** The chute's mouth, over the track's middle. */
  chuteHeight: 96,
  length: 80,
};

/** A hopper of crates on four legs over the track, which drops one into an open wagon stopped under it. */
export function cargoLoader(): THREE.Group {
  const { chuteHeight, length } = LOADER;
  const legZ = D.TRACK_WIDTH / 2 + 12;
  const legX = length / 2 - 6;
  const top = chuteHeight + 26;
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => box('darkWood', [8, top, 8], [sx * legX, 0, sz * legZ])));
  const braces = [-1, 1].map((sz) => box('darkWood', [length - 4, 6, 6], [0, chuteHeight - 30, sz * legZ]));
  // A funnel narrowing down to the chute.
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(38, 14, 24, 4, 1), paint('yellow'));
  funnel.rotation.y = Math.PI / 4;
  funnel.position.set(0, chuteHeight + 14, 0);
  const bin = box('yellow', [length, 34, 2 * legZ + 8], [0, top, 0]);
  const rim = box('red', [length + 4, 4, 2 * legZ + 12], [0, top + 34, 0]);
  const chute = box('red', [18, 8, 18], [0, chuteHeight - 2, 0]);
  const heap = [-18, 0, 18].map((x, i) => box('wood', [16, 14, 16], [x, top + 30 + (i % 2) * 3, (i - 1) * 8]));
  return group('cargo-loader', ...legs, ...braces, funnel, bin, rim, chute, ...heap);
}

// ---- lifting bridge -------------------------------------------------------

export const LIFT_BRIDGE = {
  towerHeight: 190,
  /** The control box's knob, in the piece's frame. */
  control: [D.LIFT_SPAN_FROM - 18, 40, -(D.TRACK_WIDTH / 2 + 30)] as V3,
  /** Warning lamps on the towers, in the piece's frame. */
  lamps: [D.LIFT_SPAN_FROM - 8, D.LIFT_SPAN_TO + 8].flatMap((x) => [-1, 1].map((s) => [x, 70, s * (D.TRACK_WIDTH / 2 + 16)] as V3)),
};

/**
 * Two towers either side of the span of a lifting bridge piece. The track
 * and the span are drawn from the piece; this frame starts at its first
 * end and runs along +x.
 */
export function liftBridge(): THREE.Group {
  const { towerHeight } = LIFT_BRIDGE;
  const z = D.TRACK_WIDTH / 2 + 10;
  const parts: THREE.Object3D[] = [];
  for (const x of [D.LIFT_SPAN_FROM - 8, D.LIFT_SPAN_TO + 8]) {
    for (const s of [-1, 1]) {
      parts.push(box('stone', [18, 6, 18], [x, 0, s * z]));
      parts.push(box('red', [10, towerHeight, 10], [x, 6, s * z]));
      parts.push(box('darkWood', [6, 30, 6], [x, towerHeight - 70, s * (z + 8)]));
      parts.push(box('black', [6, 8, 6], [x, LIFT_BRIDGE.lamps[0][1] - 4, s * (z + 6)]));
    }
    parts.push(box('red', [12, 12, 2 * z + 10], [x, towerHeight, 0]));
    parts.push(cylinder('black', 6, 4, [x, towerHeight + 12, 0], 6, 12));
  }
  // Beams joining the tower tops, and the control box by the first tower.
  for (const s of [-1, 1]) parts.push(box('red', [D.LIFT_SPAN_TO - D.LIFT_SPAN_FROM + 16, 8, 6], [(D.LIFT_SPAN_FROM + D.LIFT_SPAN_TO) / 2, towerHeight - 4, s * z]));
  const [cx, , cz] = LIFT_BRIDGE.control;
  parts.push(box('cream', [20, 26, 16], [cx, 0, cz]), box('red', [22, 3, 18], [cx, 26, cz]));
  return group('lift-bridge', ...parts);
}

/** Girders along the lifting span, which rise with its track. Built at runtime with the span. */
export function liftSpanGirders(): THREE.Group {
  const length = D.LIFT_SPAN_TO - D.LIFT_SPAN_FROM - 2;
  const x = (D.LIFT_SPAN_FROM + D.LIFT_SPAN_TO) / 2;
  return group(
    'lift-girders',
    ...[-1, 1].flatMap((s) => [
      box('red', [length, 14, 3], [x, 0, s * (D.TRACK_WIDTH / 2 + 1.5)]),
      box('white', [length - 10, 2, 3.4], [x, 7, s * (D.TRACK_WIDTH / 2 + 1.5)]),
    ]),
  );
}

/** Every scenery model by file name, for the exporter. */
export const SCENERY_MODELS: Record<string, () => THREE.Group> = {
  tunnel,
  station,
  'level-crossing': levelCrossing,
  'bridge-pier': bridgePier,
  signal,
  'leafy-tree': leafyTree,
  'pine-tree': pineTree,
  cottage,
  crane,
  'cargo-loader': cargoLoader,
  'lift-bridge': liftBridge,
};

/** Parts built at runtime alongside a model because they move, by model name. */
export const MOVING_PARTS: Record<string, () => THREE.Group> = {
  crane: craneArm,
  'lift-bridge': liftSpanGirders,
};
