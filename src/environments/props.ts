import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Toy-like props that dress the scenes: trees, houses, cars, boats, ducks,
// snowmen. Built from simple solids at real size in millimetres, painted in
// flat colours like wooden railway accessories, so they sit happily next to
// the track and the scenery pieces.
//
// Each builder returns a group in its own frame: y up, standing on y = 0,
// front facing +z. `Props` places them in plan coordinates and bakes the
// lot into one mesh per colour, so a scene with hundreds of props still
// draws quickly.

export const COLOURS = {
  trunk: 0x8a5a33,
  leaf: 0x4f9a3c,
  leafLight: 0x77b347,
  leafDark: 0x2f7a3a,
  pine: 0x2f6b34,
  palm: 0x5aa83e,
  snow: 0xf7fafc,
  stone: 0x9a968c,
  stoneDark: 0x7d7a72,
  wood: 0xd9b47c,
  darkWood: 0x6e4a2c,
  red: 0xc8352b,
  blue: 0x2f6fd6,
  navy: 0x2f4a6b,
  yellow: 0xe8b33a,
  orange: 0xe07a2b,
  green: 0x3e9b5a,
  pink: 0xe58fb0,
  purple: 0x8a63c4,
  white: 0xf5f1e8,
  cream: 0xf0e2c0,
  peach: 0xf2c49b,
  mint: 0xa8dcc4,
  sky: 0x8cc4e8,
  glass: 0x3d5a80,
  black: 0x2b2620,
  grey: 0x8f8f8f,
  sand: 0xe2cc98,
  ice: 0xcfe6f4,
  carrot: 0xf08a24,
} as const;

export type Colour = keyof typeof COLOURS;

const materials = new Map<number, THREE.MeshStandardMaterial>();
function paint(colour: Colour | number): THREE.MeshStandardMaterial {
  const hex = typeof colour === 'number' ? colour : COLOURS[colour];
  let m = materials.get(hex);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: hex, roughness: hex === COLOURS.glass ? 0.3 : 0.75, side: THREE.DoubleSide });
    materials.set(hex, m);
  }
  return m;
}

type V3 = [number, number, number];

/** A box of size [x, y, z] whose bottom face is centred on `at`. */
function box(colour: Colour, size: V3, at: V3 = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), paint(colour));
  mesh.position.set(at[0], at[1] + size[1] / 2, at[2]);
  return mesh;
}

/** An upright cylinder (a cone with `top` 0) standing on `at`. */
function cyl(colour: Colour, radius: number, height: number, at: V3 = [0, 0, 0], top = radius, segments = 12): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, radius, height, segments), paint(colour));
  mesh.position.set(at[0], at[1] + height / 2, at[2]);
  return mesh;
}

/** A lumpy ball centred on `at`. */
function ball(colour: Colour, radius: number, at: V3, detail = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, detail), paint(colour));
  mesh.position.set(...at);
  return mesh;
}

/** A gable roof `width` across (z), `height` tall, `length` along x, its eaves at `y`. */
function roof(colour: Colour, width: number, height: number, length: number, y: number, z = 0): THREE.Mesh {
  const shape = new THREE.Shape().moveTo(-width / 2, 0).lineTo(width / 2, 0).lineTo(0, height).closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-length / 2, y, z);
  return new THREE.Mesh(geometry, paint(colour));
}

function group(...children: THREE.Object3D[]): THREE.Group {
  return new THREE.Group().add(...children);
}

/** A random source, so scenes come out the same every time. */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];

// ---- nature -----------------------------------------------------------------

export function roundTree(rand: () => number, snowy = false): THREE.Group {
  const h = 70 + rand() * 60;
  const r = 30 + rand() * 18;
  const g = group(cyl('trunk', 6, h, [0, 0, 0], 4.5, 8));
  const greens: Colour[] = ['leaf', 'leafLight', 'leafDark'];
  const crown = pick(rand, greens);
  g.add(ball(crown, r, [0, h + r * 0.55, 0]));
  for (let i = 0; i < 2; i++) {
    const a = rand() * Math.PI * 2;
    g.add(ball(crown, r * (0.6 + rand() * 0.2), [Math.cos(a) * r * 0.6, h + r * (0.2 + rand() * 0.5), Math.sin(a) * r * 0.6]));
  }
  if (snowy) g.add(ball('snow', r * 0.75, [0, h + r * 1.05, 0]));
  return g;
}

export function pineTree(rand: () => number, snowy = false): THREE.Group {
  const s = 0.8 + rand() * 0.8;
  const g = group(cyl('trunk', 5 * s, 24 * s, [0, 0, 0], 4 * s, 8));
  const tiers: V3[] = [[34, 46, 18], [27, 42, 44], [19, 38, 70]];
  for (const [r, h, y] of tiers) {
    g.add(cyl('pine', r * s, h * s, [0, y * s, 0], 0, 10));
    if (snowy) g.add(cyl('snow', r * s * 0.55, h * s * 0.45, [0, (y + h * 0.55) * s, 0], 0, 10));
  }
  return g;
}

export function palmTree(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  const lean = (rand() - 0.5) * 0.3;
  let y = 0;
  let x = 0;
  for (let i = 0; i < 6; i++) {
    const seg = cyl('trunk', 7 - i * 0.6, 26, [x, y, 0], 6.4 - i * 0.6, 8);
    seg.rotation.z = lean;
    g.add(seg);
    y += 25;
    x -= Math.sin(lean) * 25;
  }
  for (let i = 0; i < 7; i++) {
    const leaf = box('palm', [70, 3, 16]);
    leaf.geometry.translate(35, 0, 0);
    leaf.position.set(x, y + 4, 0);
    leaf.rotation.order = 'YZX';
    leaf.rotation.set(0, (i / 7) * Math.PI * 2 + rand(), -0.35);
    g.add(leaf);
  }
  g.add(ball('trunk', 7, [x + 6, y - 2, 4]), ball('trunk', 7, [x - 4, y - 3, -5]));
  return g;
}

export function bush(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  const c = pick(rand, ['leaf', 'leafDark', 'leafLight'] as Colour[]);
  for (let i = 0; i < 3; i++) g.add(ball(c, 14 + rand() * 8, [(rand() - 0.5) * 30, 10, (rand() - 0.5) * 30]));
  return g;
}

export function flowers(rand: () => number): THREE.Group {
  const g = group(ball('leafDark', 18, [0, 2, 0]));
  g.children[0].scale.set(1.3, 0.35, 1.1);
  const heads: Colour[] = ['red', 'yellow', 'pink', 'white', 'purple', 'orange'];
  for (let i = 0; i < 9; i++) {
    const x = (rand() - 0.5) * 40;
    const z = (rand() - 0.5) * 34;
    const h = 10 + rand() * 10;
    g.add(cyl('leaf', 1.2, h, [x, 0, z], 1.2, 5), ball(pick(rand, heads), 4.5, [x, h + 2, z], 0));
  }
  return g;
}

export function rock(rand: () => number, snowy = false): THREE.Group {
  const r = 14 + rand() * 22;
  const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), paint(rand() < 0.5 ? 'stone' : 'stoneDark'));
  stone.scale.set(1.2, 0.6, 1);
  stone.rotation.y = rand() * 6;
  stone.position.y = r * 0.25;
  const g = group(stone);
  if (snowy) {
    const cap = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 0.8, 0), paint('snow'));
    cap.scale.set(1.15, 0.35, 0.95);
    cap.position.y = r * 0.5;
    g.add(cap);
  }
  return g;
}

export function reeds(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const x = (rand() - 0.5) * 30;
    const z = (rand() - 0.5) * 30;
    const h = 40 + rand() * 30;
    const stem = cyl('leafDark', 1.5, h, [x, 0, z], 1, 5);
    stem.rotation.z = (rand() - 0.5) * 0.25;
    g.add(stem, cyl('darkWood', 3, 12, [x, h - 4, z], 3, 6));
  }
  return g;
}

export function sheep(rand: () => number): THREE.Group {
  const g = group(ball('white', 22, [0, 32, 0]), ball('black', 10, [24, 38, 0], 0));
  g.children[0].scale.set(1.3, 1, 1);
  for (const [x, z] of [[-14, -10], [-14, 10], [14, -10], [14, 10]]) g.add(cyl('black', 3, 18, [x, 0, z], 3, 6));
  g.rotation.y = rand() * Math.PI * 2;
  return g;
}

export function duck(rand: () => number): THREE.Group {
  const g = group(ball('yellow', 11, [0, 6, 0]), ball('yellow', 7, [9, 16, 0]), cyl('orange', 3, 6, [16, 14, 0], 0, 6));
  g.children[0].scale.set(1.3, 0.8, 1);
  g.children[2].rotation.z = -Math.PI / 2;
  g.rotation.y = rand() * Math.PI * 2;
  return g;
}

// ---- buildings ------------------------------------------------------------

const WALLS: Colour[] = ['cream', 'white', 'peach', 'mint', 'sky', 'yellow', 'pink'];
const ROOFS: Colour[] = ['red', 'navy', 'darkWood', 'orange', 'green'];

function windows(w: number, d: number, rows: number[], gap: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const y of rows) for (let x = -w / 2 + gap; x <= w / 2 - gap + 0.1; x += gap) out.push(box('glass', [12, 14, 1], [x, y, d / 2 + 0.5]));
  return out;
}

/** A house with a gable roof, door and windows; its door faces +z. */
export function house(rand: () => number, snowy = false): THREE.Group {
  const w = 80 + Math.round(rand() * 3) * 20;
  const d = 60 + rand() * 20;
  const h = 45 + rand() * 25;
  const g = group(
    box(pick(rand, WALLS), [w, h, d]),
    roof(snowy ? 'snow' : pick(rand, ROOFS), d + 12, 28 + rand() * 12, w + 12, h),
    box('darkWood', [16, 28, 1], [0, 0, d / 2 + 0.5]),
    box('red', [10, 26, 10], [w / 4, h + 10, -d / 6]),
    ...windows(w, d, [h * 0.45], 28).filter((m) => Math.abs(m.position.x) > 14),
  );
  return g;
}

/** A row of shops: a flat roof and a striped awning. */
export function shop(rand: () => number): THREE.Group {
  const w = 120 + rand() * 60;
  const d = 70;
  const h = 55 + rand() * 20;
  const awning = pick(rand, ['red', 'green', 'blue', 'orange'] as Colour[]);
  const g = group(box(pick(rand, WALLS), [w, h, d]), box('stoneDark', [w + 6, 5, d + 6], [0, h, 0]), box('glass', [w - 30, 26, 1], [0, 6, d / 2 + 0.5]));
  for (let x = -w / 2; x < w / 2 - 1; x += 20) {
    const stripe = box(Math.round((x + w / 2) / 20) % 2 ? 'white' : awning, [20, 2, 22], [x + 10, 38, d / 2 + 9]);
    stripe.rotation.x = 0.35;
    g.add(stripe);
  }
  return g;
}

/** A block of flats, three to five storeys. */
export function flats(rand: () => number): THREE.Group {
  const floors = 3 + Math.floor(rand() * 3);
  const w = 140;
  const d = 100;
  const h = floors * 34;
  const rows = Array.from({ length: floors }, (_, i) => 12 + i * 34);
  const g = group(box(pick(rand, WALLS), [w, h, d]), box('stoneDark', [w + 6, 6, d + 6], [0, h, 0]), ...windows(w, d, rows, 30));
  const back = windows(w, d, rows, 30);
  for (const m of back) m.position.z = -m.position.z;
  g.add(...back);
  return g;
}

export function barn(): THREE.Group {
  return group(box('red', [160, 80, 110]), roof('darkWood', 124, 55, 172, 80), box('white', [50, 60, 1], [0, 0, 55.5]), box('white', [54, 4, 2], [0, 30, 56]));
}

export function windmill(): THREE.Group {
  const g = group(cyl('white', 45, 170, [0, 0, 0], 32, 12), cyl('red', 36, 40, [0, 170, 0], 0, 12));
  const hub = new THREE.Group();
  hub.position.set(0, 165, 40);
  for (let i = 0; i < 4; i++) {
    const blade = box('wood', [16, 110, 3], [0, 0, 0]);
    blade.geometry.translate(0, 0, 0);
    blade.rotation.z = (i * Math.PI) / 2 + 0.3;
    hub.add(blade);
  }
  return g.add(hub);
}

export function cabin(): THREE.Group {
  const g = group(box('darkWood', [130, 60, 90]), roof('snow', 110, 50, 146, 60), box('trunk', [20, 32, 1], [0, 0, 45.5]), box('stoneDark', [18, 40, 18], [40, 60, -15]));
  g.add(...windows(130, 90, [26], 40).filter((m) => Math.abs(m.position.x) > 20));
  return g;
}

// ---- town things --------------------------------------------------------------

export function car(rand: () => number): THREE.Group {
  const colour = pick(rand, ['red', 'blue', 'yellow', 'green', 'white', 'orange'] as Colour[]);
  const g = group(box(colour, [80, 20, 38], [0, 8, 0]), box(colour, [44, 16, 34], [-4, 28, 0]), box('glass', [46, 11, 35], [-4, 30, 0]));
  for (const x of [-26, 26]) {
    for (const z of [-19, 19]) {
      const wheel = cyl('black', 9, 6, [0, 0, 0], 9, 12);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 9, z);
      g.add(wheel);
    }
  }
  return g;
}

export function bus(): THREE.Group {
  const g = group(box('red', [200, 60, 50], [0, 8, 0]));
  for (let x = -80; x <= 80; x += 32) for (const z of [-25.5, 25.5]) g.add(box('glass', [24, 18, 1], [x, 38, z]));
  for (const x of [-65, 65]) {
    for (const z of [-25, 25]) {
      const wheel = cyl('black', 12, 6, [0, 0, 0], 12, 12);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 12, z);
      g.add(wheel);
    }
  }
  return g;
}

export function lamppost(): THREE.Group {
  return group(cyl('black', 3, 110, [0, 0, 0], 2.5, 8), ball('yellow', 8, [0, 114, 0], 1));
}

export function bench(): THREE.Group {
  return group(box('wood', [60, 4, 18], [0, 16, 0]), box('wood', [60, 16, 4], [0, 20, -9]), box('black', [4, 16, 16], [-26, 0, 0]), box('black', [4, 16, 16], [26, 0, 0]));
}

export function playground(): THREE.Group {
  const slide = box('red', [90, 4, 26], [0, 0, 0]);
  slide.rotation.z = -0.55;
  slide.position.set(10, 30, 0);
  const g = group(box('yellow', [30, 70, 30], [-50, 0, 0]), box('blue', [36, 6, 36], [-50, 70, 0]), slide);
  // A swing: an A-frame and two seats.
  for (const x of [80, 170]) {
    for (const z of [-24, 24]) {
      const leg = cyl('blue', 3, 90, [0, 0, 0], 3, 6);
      leg.position.set(x, 44, z);
      leg.rotation.x = z > 0 ? 0.25 : -0.25;
      g.add(leg);
    }
  }
  const bar = cyl('blue', 3, 96, [0, 0, 0], 3, 6);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(125, 86, 0);
  g.add(bar, box('red', [18, 3, 12], [105, 24, 0]), box('green', [18, 3, 12], [145, 24, 0]));
  return g;
}

// ---- seaside and water --------------------------------------------------------

export function rowingBoat(rand: () => number): THREE.Group {
  const colour = pick(rand, ['red', 'blue', 'white', 'yellow'] as Colour[]);
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), paint(colour));
  hull.scale.set(70, 22, 26);
  hull.position.y = 14;
  return group(hull, box('wood', [12, 3, 46], [-10, 10, 0]), box('wood', [12, 3, 46], [25, 10, 0]));
}

export function sailboat(rand: () => number): THREE.Group {
  const g = rowingBoat(rand);
  g.add(cyl('wood', 2.5, 150, [5, 10, 0], 2, 6));
  const sail = new THREE.Shape().moveTo(0, 0).lineTo(0, 130).lineTo(-70, 0).closePath();
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(sail), paint(pick(rand, ['white', 'red', 'yellow'] as Colour[])));
  mesh.position.set(2, 28, 0);
  g.add(mesh);
  return g;
}

export function jetty(length: number): THREE.Group {
  const g = new THREE.Group();
  for (let x = 0; x < length; x += 22) g.add(box('wood', [18, 4, 90], [x + 11, 10, 0]));
  for (let x = 20; x < length; x += 80) for (const z of [-40, 40]) g.add(cyl('darkWood', 4, 24, [x, -10, z], 4, 6));
  return g;
}

export function umbrella(rand: () => number): THREE.Group {
  const colour = pick(rand, ['red', 'blue', 'yellow', 'pink', 'green', 'orange'] as Colour[]);
  const g = group(cyl('white', 2.5, 120, [0, 0, 0], 2.5, 6), cyl(colour, 70, 26, [0, 108, 0], 0, 8), box(pick(rand, ['blue', 'pink', 'yellow', 'mint'] as Colour[]), [110, 1, 55], [60, 0, 40]));
  g.children[2].rotation.y = rand() * 0.6;
  return g;
}

export function sandcastle(): THREE.Group {
  const g = group(box('sand', [70, 30, 70]), cyl('sand', 14, 30, [0, 30, 0], 12, 10), cyl('red', 1, 30, [0, 60, 0], 1, 4));
  for (const x of [-35, 35]) for (const z of [-35, 35]) g.add(cyl('sand', 12, 46, [x, 0, z], 10, 10), cyl('sand', 11, 14, [x, 46, z], 0, 10));
  return g;
}

export function lifeguardTower(): THREE.Group {
  const g = new THREE.Group();
  for (const x of [-30, 30]) for (const z of [-30, 30]) g.add(cyl('white', 3, 120, [x, 0, z], 3, 6));
  g.add(box('red', [80, 50, 80], [0, 120, 0]), box('white', [96, 6, 96], [0, 170, 0]), box('glass', [60, 22, 1], [0, 140, 40.5]));
  return g;
}

export function beachBall(rand: () => number): THREE.Group {
  return group(ball(pick(rand, ['red', 'blue', 'yellow'] as Colour[]), 18, [0, 18, 0], 2));
}

// ---- winter -------------------------------------------------------------------

export function snowman(rand: () => number): THREE.Group {
  const g = group(ball('snow', 34, [0, 30, 0], 2), ball('snow', 24, [0, 80, 0], 2), ball('snow', 17, [0, 117, 0], 2));
  const nose = cyl('carrot', 4, 18, [0, 0, 0], 0, 8);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 118, 24);
  g.add(nose, cyl('black', 14, 4, [0, 130, 0], 14, 12), cyl('black', 10, 18, [0, 133, 0], 10, 12));
  g.add(ball('black', 2.5, [-6, 124, 15], 0), ball('black', 2.5, [6, 124, 15], 0));
  const scarf = cyl(pick(rand, ['red', 'blue', 'green'] as Colour[]), 19, 8, [0, 98, 0], 19, 12);
  g.add(scarf);
  g.rotation.y = (rand() - 0.5) * 1.2;
  return g;
}

export function sled(): THREE.Group {
  return group(box('red', [90, 6, 40], [0, 10, 0]), box('darkWood', [100, 3, 4], [0, 0, -16]), box('darkWood', [100, 3, 4], [0, 0, 16]));
}

/** A flat frozen pond, a hair above the snow. */
export function icePond(rx: number, rz: number): THREE.Group {
  const ice = cyl('ice', 1, 1, [0, 0, 0], 1, 40);
  ice.scale.set(rx, 1, rz);
  return group(ice);
}

// ---- indoors ------------------------------------------------------------------

export function toyBlocks(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  const colours: Colour[] = ['red', 'blue', 'yellow', 'green', 'orange'];
  let y = 0;
  for (let i = 0; i < 2 + Math.floor(rand() * 3); i++) {
    const b = box(pick(rand, colours), [40, 40, 40], [(rand() - 0.5) * 8, y, (rand() - 0.5) * 8]);
    b.rotation.y = rand();
    g.add(b);
    y += 40;
  }
  g.add(box(pick(rand, colours), [40, 40, 40], [55, 0, 10]));
  return g;
}

export function toyBox(): THREE.Group {
  return group(box('blue', [300, 200, 200]), box('yellow', [310, 12, 210], [0, 200, 0]), box('red', [80, 80, 2], [0, 60, 101]));
}

// ---- placing ------------------------------------------------------------------

/**
 * Props for one scene, placed in plan coordinates (x east, y north, mm) and
 * baked into one mesh per colour when done.
 */
export class Props {
  private readonly root = new THREE.Group();

  /** Put a prop at plan (x, y), turned `angle` (radians, anticlockwise from facing south), lifted `lift` mm. */
  add(prop: THREE.Object3D, x: number, y: number, angle = 0, lift = 0): this {
    prop.position.set(x, lift, -y);
    prop.rotation.y = angle;
    this.root.add(prop);
    return this;
  }

  /** One merged mesh per colour, casting and catching shadows. */
  bake(): THREE.Group {
    this.root.updateMatrixWorld(true);
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      g = g.applyMatrix4(o.matrixWorld);
      const list = byMaterial.get(o.material) ?? [];
      list.push(g);
      byMaterial.set(o.material, list);
    });
    const out = new THREE.Group();
    for (const [material, geometries] of byMaterial) {
      const merged = mergeGeometries(geometries);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      out.add(mesh);
    }
    return out;
  }
}

/**
 * Up to `count` spots spread over a ring round the middle, at least
 * `spacing` mm apart and passing `ok`. Plan mm. `crowd` above 1 bunches
 * them towards the inside of the ring, where they're seen up close.
 */
export function scatter(rand: () => number, count: number, inner: number, outer: number, spacing: number, ok: (x: number, y: number) => boolean = () => true, crowd = 1): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];
  for (let tries = 0; tries < count * 30 && spots.length < count; tries++) {
    const a = rand() * Math.PI * 2;
    // Even spread over the ring's area.
    const r = Math.sqrt(inner * inner + rand() ** crowd * (outer * outer - inner * inner));
    const x = Math.cos(a) * r * 1.3;
    const y = Math.sin(a) * r;
    if (!ok(x, y)) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < spacing)) continue;
    spots.push({ x, y });
  }
  return spots;
}
