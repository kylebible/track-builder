import * as THREE from 'three';
import * as D from '../pieces/dimensions';

// Places beside the track that trains stop at (see src/trains/stops.ts),
// built like the other scenery models: simple solids at real size in mm,
// y up, the track running along x through the origin, and everything
// standing on the train's left (-z), clear of the track, like the station.
// Things that reach over the train (a water spout, a coal chute) clear the
// tallest engine.

const COLORS = {
  wood: 0xd9b47c,
  darkWood: 0x8a5a33,
  red: 0xc8352b,
  white: 0xf5f1e8,
  cream: 0xf0e2c0,
  grass: 0x5f9e45,
  pine: 0x2f6b34,
  stone: 0x9a968c,
  yellow: 0xe8b33a,
  black: 0x2b2620,
  glass: 0x3d5a80,
  brick: 0xa8452f,
  slate: 0x55606b,
  steel: 0x8c9096,
  blue: 0x2f6fd6,
  hay: 0xe3c15a,
  green: 0x2b8a4b,
  coal: 0x1f1d1b,
  sky: 0x6fb3e0,
  orange: 0xe07b2b,
} as const;

type Color = keyof typeof COLORS;
type V3 = [number, number, number];

const materials = new Map<Color, THREE.MeshStandardMaterial>();
function paint(name: Color): THREE.MeshStandardMaterial {
  let m = materials.get(name);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ name, color: COLORS[name], roughness: name === 'glass' || name === 'steel' ? 0.35 : 0.7, metalness: name === 'steel' ? 0.5 : 0 });
    materials.set(name, m);
  }
  return m;
}

/** A box of size [x, y, z] whose bottom face is centred on `at`. */
function box(name: Color, size: V3, at: V3): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), paint(name));
  mesh.position.set(at[0], at[1] + size[1] / 2, at[2]);
  return mesh;
}

/** An upright cylinder (or cone, with `top` 0) standing on `at`. */
function cylinder(name: Color, radius: number, height: number, at: V3, top = radius, segments = 16): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, radius, height, segments), paint(name));
  mesh.position.set(at[0], at[1] + height / 2, at[2]);
  return mesh;
}

/** A cylinder lying along x (or z), centred on `at`. */
function lying(name: Color, radius: number, length: number, at: V3, axis: 'x' | 'z' = 'x', segments = 16): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), paint(name));
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  else mesh.rotation.x = Math.PI / 2;
  mesh.position.set(...at);
  return mesh;
}

/** A gable roof along x: a triangle `width` (z) wide and `height` tall, `length` long, its eaves at `at`. */
function gableRoof(name: Color, width: number, height: number, length: number, at: V3): THREE.Mesh {
  const shape = new THREE.Shape().moveTo(-width / 2, 0).lineTo(width / 2, 0).lineTo(0, height).closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(at[0] - length / 2, at[1], at[2]);
  return new THREE.Mesh(geometry, paint(name));
}

/** A gable roof whose ridge runs across the track (along z). */
function crossRoof(name: Color, width: number, height: number, length: number, at: V3): THREE.Mesh {
  const roof = gableRoof(name, width, height, length, [0, 0, 0]);
  roof.rotation.y = Math.PI / 2;
  roof.position.set(...at);
  return roof;
}

function group(name: string, ...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.add(...children);
  return g;
}

/** The near edge of things beside the track: the track's side plus a gap. */
const FACE = D.TRACK_WIDTH / 2 + 6;
/** Clears the tallest engine's chimney. */
const OVERHEAD = D.TRACK_HEIGHT + 90;

/** A grassy base along the track side, `depth` deep from the face. */
function base(length: number, depth: number, color: Color = 'grass'): THREE.Mesh {
  return box(color, [length, 3, depth], [0, 0, -(FACE + depth / 2)]);
}

// ---- engine supplies ---------------------------------------------------------

/** A tank on four legs, with a spout that swings over the track. */
export function waterTower(): THREE.Group {
  const z = -(FACE + 30);
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => cylinder('darkWood', 2.6, 92, [sx * 16, 3, z + sz * 16], 2.6, 8)));
  const braces = [-1, 1].map((sz) => box('darkWood', [34, 3, 2], [0, 40, z + sz * 16]));
  const tankY = 95;
  const spoutZ = 0;
  return group(
    'water-tower',
    base(90, 64, 'stone'),
    ...legs,
    ...braces,
    box('darkWood', [44, 4, 44], [0, tankY - 4, z]),
    cylinder('blue', 24, 32, [0, tankY, z], 24, 28),
    ...[6, 18, 30].map((y) => cylinder('steel', 24.6, 1.5, [0, tankY + y, z], 24.6, 28)),
    cylinder('red', 27, 18, [0, tankY + 32, z], 0, 28),
    // The arm and the spout hanging over the track.
    lying('black', 3, Math.abs(z - spoutZ) + 4, [0, OVERHEAD + 10, (z + spoutZ) / 2], 'z', 10),
    cylinder('black', 4, 14, [0, OVERHEAD - 4, spoutZ], 3, 10),
    cylinder('black', 2, OVERHEAD - 20, [26, 3, -(FACE + 4)], 2, 8),
  );
}

/** A brick pump house with a pipe running back to the water, a tank, and a pipe over the track to fill tank cars. */
export function pumpHouse(): THREE.Group {
  const z = -(FACE + 34);
  const tankZ = -(FACE + 16);
  return group(
    'pump-house',
    base(100, 76, 'stone'),
    box('brick', [44, 40, 36], [-20, 3, z]),
    gableRoof('slate', 40, 16, 48, [-20, 43, z]),
    box('glass', [14, 12, 1], [-20, 22, z + 18.2]),
    box('darkWood', [10, 20, 1], [-34, 3, z + 18.2]),
    // The intake pipe, out of the back toward the river or lake.
    lying('steel', 4, 40, [-20, 10, z - 36], 'z', 10),
    // A wheel on the pump.
    lying('red', 9, 3, [4, 24, z], 'z', 18),
    // The tank it pumps into, and the pipe that reaches over the train.
    cylinder('sky', 15, 34, [26, 3, tankZ - 10], 15, 24),
    cylinder('steel', 15.6, 1.5, [26, 30, tankZ - 10], 15.6, 24),
    lying('black', 3, Math.abs(tankZ - 10) + 4, [26, OVERHEAD + 6, (tankZ - 10) / 2], 'z', 10),
    cylinder('black', 2, OVERHEAD + 6 - 37, [26, 37, tankZ - 10], 2, 8),
    cylinder('black', 4, 12, [26, OVERHEAD - 6, 0], 3, 10),
  );
}

/** A wooden coal bunker with a chute over the track. */
export function coalingStage(): THREE.Group {
  const z = -(FACE + 26);
  const top = OVERHEAD + 14;
  return group(
    'coaling-stage',
    base(96, 56, 'stone'),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box('darkWood', [5, top, 5], [sx * 26, 3, z + sz * 20]))),
    box('wood', [60, 30, 46], [0, top - 30, z]),
    ...[0, 10, 20].map((y) => box('darkWood', [61, 1.5, 47], [0, top - 28 + y, z])),
    ...Array.from({ length: 14 }, (_, i) => {
      const lump = new THREE.Mesh(new THREE.DodecahedronGeometry(5 + (i % 3), 0), paint('coal'));
      lump.position.set(((i * 37) % 44) - 22, top + 1 + (i % 4), z + ((i * 23) % 30) - 15);
      lump.rotation.set(i, i * 2, i * 3);
      return lump;
    }),
    // The chute, sloping down over the track.
    (() => {
      const chute = box('steel', [16, 3, 44], [0, 0, 0]);
      chute.position.set(0, top - 22, z / 2 + 4);
      chute.rotation.x = -0.35;
      return chute;
    })(),
    box('slate', [70, 5, 54], [0, top, z]),
  );
}

/** A charging post with a yellow flash on it and a cable. */
export function chargingPost(): THREE.Group {
  const z = -(FACE + 12);
  const flash = new THREE.Shape([
    new THREE.Vector2(2, 10), new THREE.Vector2(-4, 0), new THREE.Vector2(0, 0), new THREE.Vector2(-2, -10), new THREE.Vector2(4, 0), new THREE.Vector2(0, 0),
  ]);
  const bolt = new THREE.Mesh(new THREE.ExtrudeGeometry(flash, { depth: 1, bevelEnabled: false }), paint('yellow'));
  bolt.position.set(0, 52, z + 7.5);
  const cable = new THREE.Mesh(new THREE.TorusGeometry(10, 1.4, 8, 24, Math.PI), paint('black'));
  cable.rotation.y = Math.PI / 2;
  cable.position.set(9, 34, z + 4);
  return group(
    'charging-post',
    base(44, 30, 'stone'),
    box('green', [22, 70, 14], [0, 3, z]),
    box('white', [18, 26, 1], [0, 40, z + 7]),
    bolt,
    box('black', [6, 8, 6], [9, 28, z + 9]),
    cable,
    box('green', [26, 4, 18], [0, 73, z]),
  );
}

// ---- goods ----------------------------------------------------------------------

/** A pit head: a tower with a winding wheel, a shed and a heap of coal, and a chute over the track. */
export function coalMine(): THREE.Group {
  const z = -(FACE + 44);
  const legs = [-1, 1].map((s) => {
    const leg = box('darkWood', [5, 150, 5], [0, 0, 0]);
    leg.position.set(s * 18, 75, z);
    leg.rotation.z = s * 0.12;
    return leg;
  });
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(14, 2, 8, 32), paint('red'));
  wheel.position.set(0, 148, z + 4);
  const spokes = [0, 1, 2].map((i) => {
    const spoke = box('red', [28, 1.6, 1.6], [0, 0, 0]);
    spoke.position.set(0, 148, z + 4);
    spoke.rotation.z = (i * Math.PI) / 3;
    return spoke;
  });
  const heap = new THREE.Mesh(new THREE.ConeGeometry(30, 34, 12), paint('coal'));
  heap.position.set(-60, 20, z + 6);
  const chute = box('steel', [16, 3, 50], [0, 0, 0]);
  chute.position.set(30, OVERHEAD - 4, z / 2 + 6);
  chute.rotation.x = -0.3;
  return group(
    'coal-mine',
    base(190, 90, 'stone'),
    ...legs,
    box('darkWood', [44, 5, 8], [0, 135, z]),
    wheel,
    ...spokes,
    box('brick', [60, 44, 46], [55, 3, z - 6]),
    gableRoof('slate', 52, 20, 66, [55, 47, z - 6]),
    heap,
    ...[-1, 1].map((s) => box('darkWood', [5, OVERHEAD + 6, 5], [30 + s * 10, 3, z / 2 - 8])),
    chute,
  );
}

/** A power station with a tall striped chimney, and a coal drop by the track. */
export function powerStation(): THREE.Group {
  const z = -(FACE + 56);
  return group(
    'power-station',
    base(200, 112, 'stone'),
    box('brick', [130, 70, 70], [-20, 3, z]),
    box('slate', [134, 6, 74], [-20, 73, z]),
    ...[-60, -20, 20].map((x) => box('glass', [24, 26, 1], [x, 30, z + 35.5])),
    cylinder('white', 13, 190, [70, 3, z], 9, 24),
    ...[150, 172].map((y) => cylinder('red', 12.2 - (y - 150) * 0.03, 11, [70, y, z], 11.4 - (y - 150) * 0.03, 24)),
    // A grid over the coal drop pit beside the rails.
    box('black', [80, 4, 20], [-20, 0.5, -(FACE + 10)]),
    ...[-50, -35, -20, -5, 10].map((x) => box('steel', [2, 4.6, 20], [x, 0.5, -(FACE + 10)])),
  );
}

/** A cow standing in a field, facing +x. */
function cow(x: number, z: number, turn: number): THREE.Group {
  const g = group(
    'cow',
    box('white', [26, 13, 12], [0, 9, 0]),
    box('black', [9, 7, 12.4], [4, 15, 0]),
    box('white', [10, 9, 8], [16, 14, 0]),
    ...[-8, 8].flatMap((dx) => [-4, 4].map((dz) => box('black', [3, 9, 3], [dx, 0, dz]))),
  );
  g.position.set(x, 3, z);
  g.rotation.y = turn;
  return g;
}

/** A red barn, a fenced yard with cows, hay bales, and milk churns on a stand by the track. */
export function farm(): THREE.Group {
  const z = -(FACE + 60);
  const fence: THREE.Object3D[] = [];
  for (let x = -100; x <= -10; x += 15) fence.push(box('white', [3, 18, 3], [x, 3, -(FACE + 8)]));
  fence.push(box('white', [92, 3, 2], [-55, 10, -(FACE + 8)]), box('white', [92, 3, 2], [-55, 17, -(FACE + 8)]));
  return group(
    'farm',
    base(220, 120),
    box('red', [80, 52, 60], [55, 3, z]),
    crossRoof('slate', 68, 34, 88, [55, 55, z]),
    box('white', [24, 34, 1], [55, 3, z + 30.5]),
    ...[-1, 1].map((s) => {
      const cross = box('white', [2, 40, 1.2], [0, 0, 0]);
      cross.position.set(55, 20, z + 31);
      cross.rotation.z = s * 0.6;
      return cross;
    }),
    ...fence,
    cow(-80, z + 20, 0.4),
    cow(-40, z + 2, -2.4),
    ...[-100, -70].map((x) => lying('hay', 12, 18, [x, 15, z - 30], 'z', 20)),
    // A stand of milk churns by the track.
    box('wood', [36, 16, 22], [5, 3, -(FACE + 14)]),
    ...[-8, 4, 16].map((x) => cylinder('white', 5, 14, [x - 2, 19, -(FACE + 14)], 4, 12)),
  );
}

/** A market hall: posts, a striped awning and stalls. */
export function market(): THREE.Group {
  const z = -(FACE + 40);
  const stripes = Array.from({ length: 8 }, (_, i) => gableRoof(i % 2 ? 'white' : 'red', 76, 26, 20, [-70 + i * 20, 62, z]));
  const fruit = (x: number, color: Color) => Array.from({ length: 5 }, (_, i) => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(4, 10, 8), paint(color));
    ball.position.set(x - 10 + i * 5, 27, z + 8 + (i % 2) * 4);
    return ball;
  });
  return group(
    'market',
    base(180, 84, 'stone'),
    ...[-80, 0, 80].flatMap((x) => [-1, 1].map((s) => cylinder('darkWood', 3, 60, [x, 3, z + s * 30], 3, 8))),
    ...stripes,
    ...[-45, 0, 45].map((x) => box('wood', [34, 20, 16], [x, 3, z + 10])),
    ...fruit(-45, 'red'),
    ...fruit(0, 'hay'),
    ...fruit(45, 'green'),
    box('darkWood', [34, 20, 16], [0, 3, z - 18]),
  );
}

/** A small post office with a pillar box and a bench of mail sacks by the track. */
export function postOffice(): THREE.Group {
  const z = -(FACE + 44);
  return group(
    'post-office',
    base(130, 90, 'stone'),
    box('red', [80, 50, 50], [-10, 3, z]),
    gableRoof('slate', 58, 24, 88, [-10, 53, z]),
    box('yellow', [50, 10, 1], [-10, 40, z + 25.5]),
    box('darkWood', [16, 28, 1], [-10, 3, z + 25.5]),
    ...[-36, 16].map((x) => box('glass', [14, 14, 1], [x, 18, z + 25.5])),
    // Pillar box.
    cylinder('red', 7, 30, [50, 3, -(FACE + 16)], 7, 18),
    (() => {
      const top = new THREE.Mesh(new THREE.SphereGeometry(7.6, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), paint('red'));
      top.position.set(50, 33, -(FACE + 16));
      return top;
    })(),
    box('black', [8, 1.6, 1], [50, 26, -(FACE + 8.8)]),
    // Sacks waiting on a trolley.
    box('darkWood', [30, 8, 16], [10, 3, -(FACE + 12)]),
    ...[2, 12, 22].map((x) => cylinder('cream', 6, 14, [x - 2, 11, -(FACE + 12)], 4, 10)),
  );
}

/** A log cabin, a pile of logs and pine trees. */
export function lumberCamp(): THREE.Group {
  const z = -(FACE + 56);
  const cabin: THREE.Object3D[] = [];
  for (let i = 0; i < 6; i++) {
    cabin.push(lying('wood', 4, 64, [40, 7 + i * 7.5, z - 20], 'x', 10));
    cabin.push(lying('wood', 4, 64, [40, 7 + i * 7.5, z + 20], 'x', 10));
    cabin.push(lying('wood', 4, 48, [10, 10 + i * 7.5, z], 'z', 10));
    cabin.push(lying('wood', 4, 48, [70, 10 + i * 7.5, z], 'z', 10));
  }
  const pile: THREE.Object3D[] = [];
  const rows = [4, 3, 2];
  rows.forEach((n, row) => {
    for (let i = 0; i < n; i++) pile.push(lying('darkWood', 7, 70, [-50, 10 + row * 12, -(FACE + 14) - (i - (n - 1) / 2) * 14 - 12], 'x', 14));
  });
  const pine = (x: number, zz: number) => [
    cylinder('darkWood', 4, 20, [x, 3, zz], 4, 8),
    cylinder('pine', 22, 34, [x, 20, zz], 0, 10),
    cylinder('pine', 16, 30, [x, 42, zz], 0, 10),
  ];
  return group(
    'lumber-camp',
    base(200, 112),
    ...cabin,
    gableRoof('darkWood', 54, 22, 72, [40, 52, z]),
    ...pile,
    ...pine(-90, z - 30),
    ...pine(85, z - 40),
    // A stump with an axe.
    cylinder('wood', 8, 10, [-10, 3, z + 10], 8, 12),
    box('steel', [2, 14, 6], [-10, 13, z + 10]),
  );
}

/** A shed with a big round saw, and stacks of planks. */
export function sawmill(): THREE.Group {
  const z = -(FACE + 46);
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 1.6, 24), paint('steel'));
  blade.rotation.x = Math.PI / 2;
  blade.position.set(-40, 32, z + 26);
  const planks = Array.from({ length: 6 }, (_, i) => box('wood', [60, 3, 26], [55, 3 + i * 3.4, -(FACE + 18)]));
  return group(
    'sawmill',
    base(180, 94),
    box('wood', [90, 46, 54], [-10, 3, z - 4]),
    gableRoof('red', 62, 24, 98, [-10, 49, z - 4]),
    box('darkWood', [40, 12, 20], [-40, 3, z + 32]),
    blade,
    cylinder('steel', 3, 4, [-40, 30.4, z + 27], 3, 10),
    ...planks,
    box('darkWood', [60, 3, 26], [55, 23.4, -(FACE + 18)]),
  );
}

/** A brick toy factory with a saw-tooth roof and a chimney. */
export function toyFactory(): THREE.Group {
  const z = -(FACE + 52);
  const teeth = [0, 1, 2, 3].map((i) => {
    const shape = new THREE.Shape().moveTo(0, 0).lineTo(30, 0).lineTo(30, 22).closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 70, bevelEnabled: false });
    geometry.translate(-60 + i * 30, 58, z - 35);
    return new THREE.Mesh(geometry, paint(i % 2 ? 'sky' : 'slate'));
  });
  const blocks = (['red', 'yellow', 'blue', 'green'] as Color[]).map((c, i) => box(c, [12, 12, 12], [-50 + i * 16, 3, -(FACE + 12)]));
  return group(
    'toy-factory',
    base(170, 104, 'stone'),
    box('brick', [120, 55, 70], [0, 3, z]),
    ...teeth,
    ...[-40, 0, 40].map((x) => box('glass', [22, 20, 1], [x, 22, z + 35.5])),
    box('yellow', [60, 8, 1], [0, 46, z + 35.5]),
    cylinder('brick', 8, 120, [70, 3, z - 20], 6, 16),
    ...blocks,
    box('blue', [26, 10, 14], [40, 3, -(FACE + 12)]),
  );
}

/** A long goods shed with a wide door to the track, and crates on its dock. */
export function goodsShed(): THREE.Group {
  const z = -(FACE + 40);
  const crates = [[-50, 0], [-36, 0], [-43, 1], [40, 0], [54, 0]].map(([x, row]) => box('wood', [13, 13, 13], [x, 21 + row * 13, -(FACE + 10)]));
  return group(
    'goods-shed',
    base(190, 84, 'stone'),
    // A loading dock at wagon floor height.
    box('stone', [170, 18, 22], [0, 3, -(FACE + 11)]),
    box('wood', [130, 50, 50], [0, 3, z - 6]),
    box('darkWood', [44, 36, 1], [0, 21, z + 19.5]),
    gableRoof('slate', 70, 22, 140, [0, 53, z - 2]),
    ...crates,
  );
}

/** A tall brick warehouse with a wide door to the track, a hoist over it, and spare goods stacked on the dock. */
export function depot(): THREE.Group {
  const z = -(FACE + 56);
  const stack = [[-80, 0, 'wood'], [-66, 0, 'wood'], [-73, 1, 'wood'], [60, 0, 'coal'], [76, 0, 'wood']] as [number, number, Color][];
  return group(
    'depot',
    base(200, 112, 'stone'),
    // A dock at wagon floor height, with goods waiting on it.
    box('stone', [180, 18, 24], [0, 3, -(FACE + 12)]),
    ...stack.map(([x, row, c]) => box(c, [13, 13, 13], [x, 21 + row * 13, -(FACE + 12)])),
    ...[-40, -28].map((x) => cylinder('orange', 6, 14, [x, 21, -(FACE + 10)], 6, 12)),
    box('brick', [150, 72, 64], [0, 3, z]),
    gableRoof('slate', 76, 20, 160, [0, 75, z]),
    // Two big doors on the track side and a row of small windows above.
    ...[-36, 36].map((x) => box('darkWood', [40, 44, 1], [x, 21, z + 32.5])),
    ...[-54, -18, 18, 54].map((x) => box('glass', [12, 10, 1], [x, 56, z + 32.5])),
    // The hoist beam and its hook.
    box('darkWood', [6, 6, 30], [0, 66, z + 44]),
    cylinder('black', 0.8, 18, [0, 48, z + 56], 0.8, 6),
    box('cream', [70, 10, 1], [0, 3 + 62, z + 32.6]),
  );
}

// ---- signs -----------------------------------------------------------------------

/** A board on a post at the track side. */
function signPost(name: string, board: THREE.Object3D[]): THREE.Group {
  const z = -(FACE + 4);
  return group(name, box('darkWood', [16, 4, 16], [0, 0, z]), cylinder('white', 1.8, 52, [0, 4, z], 1.8, 8), ...board.map((b) => {
    b.position.z += z;
    return b;
  }));
}

/** A round white board with a black W: engines whistle here. */
export function whistleBoard(): THREE.Group {
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 2, 24), paint('white'));
  disc.rotation.z = Math.PI / 2;
  disc.position.set(0, 60, 0);
  const strokes = [[-6, 0.35], [-2, -0.35], [2, 0.35], [6, -0.35]].map(([x, tilt]) => {
    const s = box('black', [1, 14, 2.4], [0, 0, 0]);
    s.position.set(1.2, 60, x);
    s.rotation.x = tilt;
    return s;
  });
  return signPost('whistle-board', [disc, ...strokes]);
}

/** A yellow diamond with a black band: trains slow down. */
export function slowBoard(): THREE.Group {
  const board = box('yellow', [2, 18, 18], [0, 0, 0]);
  board.position.set(0, 62, 0);
  board.rotation.x = Math.PI / 4;
  const bar = box('black', [2.4, 4, 20], [0, 0, 0]);
  bar.position.set(0, 60, 0);
  return signPost('slow-board', [board, bar]);
}

export const TRACKSIDE_MODELS: Record<string, () => THREE.Group> = {
  'water-tower': waterTower,
  'pump-house': pumpHouse,
  'coaling-stage': coalingStage,
  'charging-post': chargingPost,
  'coal-mine': coalMine,
  'power-station': powerStation,
  farm,
  market,
  'post-office': postOffice,
  'lumber-camp': lumberCamp,
  sawmill,
  'toy-factory': toyFactory,
  'goods-shed': goodsShed,
  depot,
  'whistle-board': whistleBoard,
  'slow-board': slowBoard,
};
