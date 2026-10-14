import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as D from '../pieces/dimensions';
import { WOOD_GRAIN } from '../render/pieceMesh';
import { polesOf, supplyLevel, WHEEL_RADIUS, type ConsistEntry, type StockDef } from './stock';

// Models of the rolling stock in the style of real Brio: a narrow beech
// chassis block with the wheels on its outside, a wider painted body on top,
// glossy paint, and a round magnet on a short neck at each end. Each is
// built in the vehicle's own frame: +x toward its front (north magnet), y up
// from the floor, z across. Proportions follow photos of the real ones.

export const AXLE_HEIGHT = D.TRACK_HEIGHT - D.GROOVE_DEPTH + WHEEL_RADIUS;
/** Top of the wheels: the painted body sits on this. */
const DECK = AXLE_HEIGHT + WHEEL_RADIUS;
/** The beech block between the wheels. */
const BLOCK_BOTTOM = D.TRACK_HEIGHT + 2.5;
const BLOCK_HALF_WIDTH = D.GROOVE_SPACING / 2 - 2.6;
/** Magnet face to the end of the body. */
const COUPLER_REACH = 8;
const MAGNET_RADIUS = 6;
const MAGNET_HEIGHT = AXLE_HEIGHT + 2;

export const POLE_COLOR = { N: 0xd8432f, S: 0x3a6fd8 } as const;

const GOLD = 0xe2b33c;
const BLACK = 0x26221f;
const RED = 0xc8352b;
const CREAM = 0xf3ead3;

// ---- materials ---------------------------------------------------------------

const paints = new Map<number, THREE.Material>();
/** Glossy painted wood. */
function paint(color: number): THREE.Material {
  let m = paints.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.22 });
    paints.set(color, m);
  }
  return m;
}

const wood = new THREE.MeshStandardMaterial({ color: 0xe9c592, map: WOOD_GRAIN, roughness: 0.66 });
const darkWood = new THREE.MeshStandardMaterial({ color: 0xb98a55, map: WOOD_GRAIN, roughness: 0.7 });
const glass = new THREE.MeshPhysicalMaterial({ color: 0x23303a, roughness: 0.08, metalness: 0.1, clearcoat: 1 });
const metal = new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.35, metalness: 0.8 });
const wheelPlastic = new THREE.MeshPhysicalMaterial({ color: 0xb3242a, roughness: 0.35, clearcoat: 0.5 });
const magnetFace = new THREE.MeshPhysicalMaterial({ color: 0x3a3a3c, roughness: 0.3, metalness: 0.6 });
const coal = new THREE.MeshStandardMaterial({ color: 0x1c1b1a, roughness: 0.9, flatShading: true });
const skin = new THREE.MeshStandardMaterial({ color: 0xf0c9a0, roughness: 0.6 });
const crateWood = new THREE.MeshStandardMaterial({ color: 0xd2a868, map: WOOD_GRAIN, roughness: 0.75 });
const cowWhite = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.7 });
const cowBlack = new THREE.MeshStandardMaterial({ color: 0x2a2624, roughness: 0.7 });

/** Log ends: rings of end grain. */
const endGrain = (() => {
  if (typeof document === 'undefined') return wood;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  if (!g) return wood;
  g.fillStyle = '#e7c48f';
  g.fillRect(0, 0, 128, 128);
  for (let r = 6; r < 64; r += 6 + (r % 5)) {
    g.strokeStyle = `rgba(140, 90, 40, ${0.25 + (r % 3) * 0.08})`;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(64, 64, r, 0, Math.PI * 2);
    g.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 });
})();

// ---- shapes ------------------------------------------------------------------

type At = [x: number, y: number, z?: number];

/** A rounded block, `y` its bottom. */
function block(size: [number, number, number], at: At, material: THREE.Material, radius = 2.5): THREE.Mesh {
  const r = Math.min(radius, ...size.map((s) => s / 2 - 0.01));
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 3, r), material);
  mesh.position.set(at[0], at[1] + size[1] / 2, at[2] ?? 0);
  return mesh;
}

/** A cylinder lying along x, centred on `at`. */
function barrel(radius: number, length: number, at: At, material: THREE.Material, segments = 36): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material);
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(at[0], at[1], at[2] ?? 0);
  return mesh;
}

/** A turned shape standing up, from a profile of [radius, height] points. */
function turned(profile: [number, number][], at: At, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 32), material);
  mesh.position.set(at[0], at[1], at[2] ?? 0);
  return mesh;
}

/** A thin panel on the side of a body, facing ±z (or ±x with `facing: 'x'`). */
function panel(w: number, h: number, at: At, material: THREE.Material, facing: 'z' | 'x' = 'z'): THREE.Mesh {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(facing === 'z' ? w : 0.8, h, facing === 'z' ? 0.8 : w, 2, 0.35), material);
  mesh.position.set(at[0], at[1] + h / 2, at[2] ?? 0);
  return mesh;
}

/** A band round a boiler at `x`. */
function band(radius: number, x: number, y: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.9, 8, 40), material);
  mesh.rotation.y = Math.PI / 2;
  mesh.position.set(x, y, 0);
  return mesh;
}

/** Windows on both sides of a body whose sides are at ±half. */
function sideWindows(xs: number[], w: number, h: number, y: number, half: number, frame = paint(CREAM)): THREE.Mesh[] {
  return xs.flatMap((x) =>
    [1, -1].flatMap((side) => [
      panel(w + 2.4, h + 2.4, [x, y - 1.2, side * (half + 0.15)], frame),
      panel(w, h, [x, y, side * (half + 0.45)], glass),
    ]),
  );
}

const wheelGeometry = (() => {
  const r = WHEEL_RADIUS;
  // Tread, a small flange that runs in the groove, then the hub.
  const profile: [number, number][] = [
    [0, -2.2], [r - 1.2, -2.2], [r, -1.6], [r, 1.2], [r + 0.6, 1.6], [r + 0.6, 2.2], [3, 2.2], [3, 2.9], [0, 2.9],
  ];
  return new THREE.LatheGeometry(profile.map(([a, b]) => new THREE.Vector2(a, b)), 36);
})();

function wheels(def: StockDef): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const x of [def.wheelbase / 2, -def.wheelbase / 2]) {
    for (const side of [1, -1]) {
      const wheel = new THREE.Mesh(wheelGeometry, wheelPlastic);
      // The lathe's axis is y; turn it to run across the track, flange inward.
      wheel.rotation.x = side * -Math.PI / 2;
      wheel.position.set(x, AXLE_HEIGHT, side * (D.GROOVE_SPACING / 2));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), metal);
      cap.rotation.x = side * Math.PI / 2;
      cap.position.set(x, AXLE_HEIGHT, side * (D.GROOVE_SPACING / 2 + 2.9));
      out.push(wheel, cap);
    }
  }
  return out;
}

/** The beech block the wheels hang on, and a magnet on a neck at each end. */
function chassis(def: StockDef, bodyLength: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [block([bodyLength - 4, DECK + 1 - BLOCK_BOTTOM, BLOCK_HALF_WIDTH * 2], [0, BLOCK_BOTTOM], wood, 2.5)];
  const poles = polesOf({ reversed: false });
  for (const [sign, pole] of [[1, poles.front], [-1, poles.back]] as const) {
    const end = sign * (def.length / 2);
    out.push(barrel(2.6, COUPLER_REACH, [end - sign * COUPLER_REACH / 2, MAGNET_HEIGHT], metal, 16));
    out.push(barrel(MAGNET_RADIUS, 3.2, [end - sign * 1.6, MAGNET_HEIGHT], magnetFace));
    // A coloured ring shows the pole: red north, blue south.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(MAGNET_RADIUS - 0.4, 0.8, 8, 28), paint(POLE_COLOR[pole]));
    ring.rotation.y = Math.PI / 2;
    ring.position.set(end + sign * 0.1, MAGNET_HEIGHT, 0);
    out.push(ring);
  }
  return out;
}

// ---- vehicles ------------------------------------------------------------------

/** A steam-outline engine: cab at the back, boiler forward. Used for both engines. */
function engine(def: StockDef, B: number, big: boolean): THREE.Object3D[] {
  const W = def.width;
  const body = paint(def.color);
  const trim = paint(big ? RED : GOLD);
  const top = DECK + 4;
  const cabLength = big ? 34 : 32;
  const cabBack = -B / 2;
  const cabFront = cabBack + cabLength;
  const cabTop = DECK + def.height - 8;
  const r = big ? 14 : 12.5;
  const boilerY = top + r + 1;
  const boilerFront = B / 2 - 6;
  const boilerLength = boilerFront - cabFront;
  const mid = cabFront + boilerLength / 2;
  const parts: THREE.Object3D[] = [
    // Footplate, with a red buffer beam across the front.
    block([B, 4, W], [0, DECK], darkWood, 1.5),
    block([4, 9, W + 2], [B / 2 - 2, DECK - 4], paint(RED), 1.2),
    // Cab with windows front and sides, and an overhanging roof.
    block([cabLength, cabTop - top, W - 2], [cabBack + cabLength / 2, top], body, 3),
    block([cabLength + 8, 3.5, W + 4], [cabBack + cabLength / 2 - 1, cabTop], paint(BLACK), 1.6),
    ...sideWindows([cabBack + cabLength / 2], cabLength - 14, 11, cabTop - 17, W / 2 - 1),
    panel(8, 9, [cabFront + 0.2, cabTop - 15, 7.5], glass, 'x'),
    panel(8, 9, [cabFront + 0.2, cabTop - 15, -7.5], glass, 'x'),
    // Boiler with a black smokebox and round door on the front.
    barrel(r, boilerLength, [mid, boilerY], body, 40),
    // Proud of the boiler's end, so the two faces don't fight.
    barrel(r + 0.4, 10.6, [boilerFront - 4.7, boilerY], paint(BLACK), 40),
    barrel(r * 0.72, 1.2, [boilerFront + 1.1, boilerY], metal, 32),
    band(r + 0.3, cabFront + 3, boilerY, trim),
    band(r + 0.3, mid + 2, boilerY, trim),
    // Chimney, flared at the top, and a dome.
    turned([[0, 0], [4.5, 0], [4, 6], [4.2, 11], [6, 13.5], [6, 15], [0, 15]], [boilerFront - 7, boilerY + r - 2], paint(BLACK)),
    turned([[0, 0], [6, 0], [6, 3], [5, 6], [3, 8], [0, 8.6]], [mid - 4, boilerY + r - 2.5], paint(GOLD)),
    // A lamp on the buffer beam.
    barrel(2.8, 4, [B / 2 + 0.5, DECK + 7.5, 9], paint(CREAM), 16),
    // A stripe along the footplate.
    panel(B - 8, 1.4, [0, DECK + 1.3, W / 2 + 0.2], trim),
    panel(B - 8, 1.4, [0, DECK + 1.3, -W / 2 - 0.2], trim),
  ];
  if (big) {
    parts.push(turned([[0, 0], [5.5, 0], [5.5, 2.5], [4.5, 5], [2.6, 6.6], [0, 7]], [mid + 14, boilerY + r - 2.5], paint(GOLD)));
    // Cowcatcher under the buffer beam.
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(9, 0), new THREE.Vector2(0, 8)]);
    const plough = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: W - 6, bevelEnabled: false }), paint(RED));
    plough.position.set(B / 2, D.TRACK_HEIGHT + 3, -(W - 6) / 2);
    parts.push(plough);
  }
  return parts;
}

function tender(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const top = DECK + def.height - 12;
  const parts: THREE.Object3D[] = [
    block([B, 4, W], [0, DECK], darkWood, 1.5),
    block([B - 2, top - DECK - 4, W - 2], [0, DECK + 4], paint(def.color), 3),
    panel(B - 10, 2, [0, top - 7, W / 2 - 0.6], paint(GOLD)),
    panel(B - 10, 2, [0, top - 7, -W / 2 + 0.6], paint(GOLD)),
  ];
  // A heap of coal on top, that goes down as the engine burns it.
  const heap = cargoGroup('coal');
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 16; i++) {
    const lump = new THREE.Mesh(new THREE.DodecahedronGeometry(3 + rand() * 2.5, 0), coal);
    lump.position.set((rand() - 0.5) * (B - 18), top + 1 + rand() * 3, (rand() - 0.5) * (W - 12));
    lump.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    heap.add(lump);
  }
  // Lowest first, so the top of the heap goes first.
  heap.children.sort((a, b) => a.position.y - b.position.y);
  parts.push(heap);
  return parts;
}

function wagon(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const h = def.height - 6;
  const t = 3.2;
  const color = paint(def.color);
  const parts: THREE.Object3D[] = [
    block([B, 5, W], [0, DECK], darkWood, 1.5),
    block([B, h, t], [0, DECK + 4, W / 2 - t / 2], color, 1.4),
    block([B, h, t], [0, DECK + 4, -W / 2 + t / 2], color, 1.4),
    block([t, h, W - 2 * t + 0.4], [B / 2 - t / 2, DECK + 4], color, 1.4),
    block([t, h, W - 2 * t + 0.4], [-B / 2 + t / 2, DECK + 4], color, 1.4),
  ];
  // Planks picked out on the sides.
  for (const y of [DECK + 4 + h / 3, DECK + 4 + (2 * h) / 3]) {
    for (const side of [1, -1]) parts.push(panel(B - 6, 0.7, [0, y, side * (W / 2 + 0.1)], paint(BLACK)));
  }
  return parts;
}

function coach(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const roofY = DECK + def.height - 8;
  const parts: THREE.Object3D[] = [
    block([B, 4, W], [0, DECK], darkWood, 1.5),
    block([B - 2, roofY - DECK - 4, W - 2], [0, DECK + 4], paint(def.color), 3),
    // A cream band under the windows, and the windows.
    panel(B - 6, 3, [0, DECK + 10, W / 2 - 0.6], paint(CREAM)),
    panel(B - 6, 3, [0, DECK + 10, -W / 2 + 0.6], paint(CREAM)),
    ...sideWindows([-B / 3, -B / 9, B / 9, B / 3].map((x) => x * 0.95), B / 6.5, 10, DECK + 17, W / 2 - 1),
  ];
  // Passengers looking out of the windows, one per window.
  const people = cargoGroup();
  const windows = [-B / 3, -B / 9, B / 9, B / 3].map((x) => x * 0.95);
  for (const side of [1, -1]) {
    for (const x of side > 0 ? windows : [...windows].reverse()) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(3.4, 16, 12), skin);
      head.position.set(x, DECK + 21, side * (W / 2 - 1.2));
      head.scale.set(1, 1, 0.45);
      people.add(head);
    }
  }
  // Fill alternate sides, so a half-full coach shows heads on both.
  const order = [0, 4, 1, 5, 2, 6, 3, 7].map((i) => people.children[i]);
  people.children.splice(0, people.children.length, ...order);
  parts.push(people);
  // A rounded roof: a flattened cylinder along the coach.
  const roof = barrel(W / 2 + 1, B + 2, [0, roofY - 1], paint(CREAM), 40);
  // Its local x is the world's up once laid along the coach.
  roof.scale.set(0.3, 1, 1);
  parts.push(roof);
  return parts;
}

function timber(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const parts: THREE.Object3D[] = [block([B, 5, W], [0, DECK], darkWood, 1.5)];
  // Red stakes along both sides hold the logs.
  for (const x of [-B / 2 + 6, 0, B / 2 - 6]) {
    for (const side of [1, -1]) {
      const stake = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 22, 12), paint(RED));
      stake.position.set(x, DECK + 5 + 11, side * (W / 2 - 2));
      parts.push(stake);
    }
  }
  const logLength = B - 8;
  const logs = cargoGroup();
  for (const [z, y, r] of [[-7.5, 7, 6.5], [7.5, 7, 6.5], [0, 18, 6.8]] as const) {
    const unit = new THREE.Group();
    unit.add(barrel(r, logLength, [0, DECK + 5 + y, z], wood, 24));
    for (const side of [1, -1]) {
      const end = new THREE.Mesh(new THREE.CircleGeometry(r - 0.2, 24), endGrain);
      end.rotation.y = side * Math.PI / 2;
      end.position.set(side * (logLength / 2 + 0.05), DECK + 5 + y, z);
      unit.add(end);
    }
    logs.add(unit);
  }
  parts.push(logs);
  return parts;
}

// ---- cargo -------------------------------------------------------------------

/** The cargo a car carries, one child per unit, shown as many as it holds. */
function cargoGroup(name = 'cargo'): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  return g;
}

/** A small heap of coal lumps, centred on `at`, `seed` to vary it. */
function coalHeap(at: At, spread: [number, number], count: number, seed: number): THREE.Group {
  const heap = new THREE.Group();
  let n = seed;
  const rand = () => ((n = (n * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const lump = new THREE.Mesh(new THREE.DodecahedronGeometry(2.6 + rand() * 2.2, 0), coal);
    lump.position.set(at[0] + (rand() - 0.5) * spread[0], at[1] + rand() * 3, (at[2] ?? 0) + (rand() - 0.5) * spread[1]);
    lump.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    heap.add(lump);
  }
  return heap;
}

const loadParts = new WeakMap<THREE.Object3D, { cargo?: THREE.Object3D; coal?: THREE.Object3D }>();

/** Show as much of a vehicle's cargo, and its tender coal, as it carries now. */
export function showLoad(model: THREE.Object3D, def: StockDef, entry: ConsistEntry): void {
  let found = loadParts.get(model);
  if (!found) loadParts.set(model, (found = { cargo: model.getObjectByName('cargo'), coal: model.getObjectByName('coal') }));
  const { cargo, coal } = found;
  if (cargo && def.cargo) {
    const units = Math.round(((entry.units ?? 0) / def.cargo.capacity) * cargo.children.length);
    cargo.children.forEach((c, i) => (c.visible = i < units));
  }
  if (coal) {
    const lumps = Math.ceil(supplyLevel(entry, 'coal') * coal.children.length);
    coal.children.forEach((c, i) => (c.visible = i < lumps));
  }
}

// ---- more cars -----------------------------------------------------------------

/** A coal hopper: an open box with sloping sides, filled in heaps. */
function hopper(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const h = def.height - 4;
  const color = paint(def.color);
  const shape = new THREE.Shape()
    .moveTo(-W / 2 + 6, 0)
    .lineTo(W / 2 - 6, 0)
    .lineTo(W / 2, h - 8)
    .lineTo(W / 2, h - 4)
    .lineTo(W / 2 - 3, h - 4)
    .lineTo(W / 2 - 9, 4)
    .lineTo(-W / 2 + 9, 4)
    .lineTo(-W / 2 + 3, h - 4)
    .lineTo(-W / 2, h - 4)
    .lineTo(-W / 2, h - 8)
    .closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: B - 6, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-(B - 6) / 2, DECK + 4, 0);
  const parts: THREE.Object3D[] = [block([B, 5, W - 8], [0, DECK], darkWood, 1.5), new THREE.Mesh(geometry, color)];
  for (const x of [-B / 2 + 4, B / 2 - 4]) parts.push(block([4, h - 4, W], [x, DECK + 4], color, 1.2));
  for (const side of [1, -1]) parts.push(panel(B - 14, 1.6, [0, DECK + h - 6, side * (W / 2 + 0.2)], paint(GOLD)));
  const load = cargoGroup();
  const xs = [-B / 3, 0, B / 3];
  // Bottom layer first, then heaped up.
  xs.forEach((x, i) => load.add(coalHeap([x, DECK + h - 14], [B / 3 - 4, W - 12], 7, 11 + i)));
  xs.forEach((x, i) => load.add(coalHeap([x, DECK + h - 9], [B / 3 - 8, W - 18], 5, 31 + i)));
  parts.push(load);
  return parts;
}

/** A tank car: a round tank on a flat car, with a dome on top. Its cargo is out of sight. */
function tank(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const r = W / 2 - 1;
  const y = DECK + 5 + r;
  const body = paint(def.color);
  const trim = paint(def.cargo?.kind === 'milk' ? 0x3a6fd8 : CREAM);
  const parts: THREE.Object3D[] = [
    block([B, 5, W], [0, DECK], darkWood, 1.5),
    barrel(r, B - 6, [0, y], body, 40),
    ...[-1, 1].map((side) => {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), body);
      cap.scale.set(1, 0.25, 1);
      cap.rotation.z = -side * Math.PI / 2;
      cap.position.set(side * ((B - 6) / 2), y, 0);
      return cap;
    }),
    band(r + 0.3, -B / 4, y, trim),
    band(r + 0.3, B / 4, y, trim),
    turned([[0, 0], [6, 0], [6, 4], [4.5, 6], [0, 6.5]], [0, y + r - 1.5], trim),
    // A walkway rail along the top.
    barrel(0.9, B - 20, [0, y + r + 4, W / 2 - 6], metal, 8),
  ];
  for (const x of [-(B - 20) / 2, (B - 20) / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 6, 8), metal);
    post.position.set(x, y + r + 1, W / 2 - 6);
    parts.push(post);
  }
  return parts;
}

/** A cow, a white block with black patches, facing +x, standing on `at`. */
function cow(at: At, turn: number): THREE.Group {
  const g = new THREE.Group();
  g.add(block([22, 11, 10], [0, 7], cowWhite, 3));
  g.add(block([8, 6, 10.4], [3, 11], cowBlack, 2));
  g.add(block([9, 8, 7], [13, 11], cowWhite, 2.5));
  g.add(block([4, 3, 7.4], [17, 11], skin, 1));
  for (const x of [-7, 7]) for (const z of [-3, 3]) g.add(block([2.6, 7, 2.6], [x, 0, z], cowBlack, 0.8));
  g.position.set(at[0], at[1], at[2] ?? 0);
  g.rotation.y = turn;
  return g;
}

/** A cattle car: slatted sides you can see the cows through, and a roof. */
function livestock(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const top = DECK + def.height - 8;
  const color = paint(def.color);
  const parts: THREE.Object3D[] = [block([B, 4, W], [0, DECK], darkWood, 1.5)];
  // Corner and middle posts, end walls, and slats with gaps between.
  for (const x of [-B / 2 + 2.5, 0, B / 2 - 2.5]) for (const side of [1, -1]) parts.push(block([4, top - DECK - 4, 3], [x, DECK + 4, side * (W / 2 - 1.5)], color, 1));
  for (const x of [-B / 2 + 1.6, B / 2 - 1.6]) parts.push(block([3.2, top - DECK - 4, W - 2], [x, DECK + 4], color, 1));
  for (let y = DECK + 8; y < top - 4; y += 7) for (const side of [1, -1]) parts.push(block([B - 4, 3.2, 1.6], [0, y, side * (W / 2 - 0.8)], color, 0.6));
  const roof = barrel(W / 2 + 1.5, B + 2, [0, top], paint(BLACK), 40);
  roof.scale.set(0.25, 1, 1);
  parts.push(roof);
  const herd = cargoGroup();
  for (const [x, z, turn] of [[-B / 4, -6.5, 0], [B / 4, 6.5, Math.PI], [B / 4, -6.5, 0], [-B / 4, 6.5, Math.PI]] as const) herd.add(cow([x, DECK + 4, z], turn));
  herd.scale.set(1, 1, 0.9);
  parts.push(herd);
  return parts;
}

/** A closed van with a sliding door; the mail is inside, out of sight. */
function van(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const roofY = DECK + def.height - 8;
  const parts: THREE.Object3D[] = [
    block([B, 4, W], [0, DECK], darkWood, 1.5),
    block([B - 2, roofY - DECK - 4, W - 2], [0, DECK + 4], paint(def.color), 3),
  ];
  for (const side of [1, -1]) {
    parts.push(panel(22, roofY - DECK - 12, [0, DECK + 7, side * (W / 2 - 0.4)], paint(BLACK)));
    parts.push(panel(B - 8, 3, [0, roofY - 10, side * (W / 2 - 0.6)], paint(GOLD)));
    // A post horn badge on each side.
    const badge = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 0.8, 24), paint(GOLD));
    badge.rotation.x = Math.PI / 2;
    badge.position.set(-B / 3 + 2, DECK + 20, side * (W / 2 - 0.2));
    parts.push(badge);
  }
  const roof = barrel(W / 2 + 1, B + 2, [0, roofY - 1], paint(CREAM), 40);
  roof.scale.set(0.3, 1, 1);
  parts.push(roof, cargoGroup());
  return parts;
}

/** A little toy car, in one of a few colours, facing +x. */
function toyCar(at: At, color: number): THREE.Group {
  const g = new THREE.Group();
  g.add(block([30, 8, 16], [0, 3], paint(color), 3));
  g.add(block([16, 7, 14], [-2, 10.5], paint(color), 3));
  g.add(block([16.4, 4, 14.4], [-2, 12], glass, 1.5));
  for (const x of [-9, 9]) for (const z of [-7.5, 7.5]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 2.4, 16), paint(BLACK));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 3.2, z);
    g.add(wheel);
  }
  g.position.set(at[0], at[1], at[2] ?? 0);
  return g;
}

/** A long flat car with low rails, carrying toy cars. */
function carrier(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const parts: THREE.Object3D[] = [block([B, 5, W], [0, DECK], paint(def.color), 1.5)];
  for (const side of [1, -1]) parts.push(block([B - 4, 3, 2], [0, DECK + 5, side * (W / 2 - 1)], paint(GOLD), 0.8));
  const cars = cargoGroup();
  [0xd8432f, 0x2f6fd6, 0xe2b33c].forEach((color, i) => cars.add(toyCar([(i - 1) * (B / 3), DECK + 5], color)));
  parts.push(cars);
  return parts;
}

/** A flat car with low sides and crates two by two. */
function flat(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const parts: THREE.Object3D[] = [block([B, 5, W], [0, DECK], paint(def.color), 1.5)];
  for (const side of [1, -1]) parts.push(block([B, 4, 2.4], [0, DECK + 5, side * (W / 2 - 1.2)], paint(CREAM), 0.8));
  const crates = cargoGroup();
  const cw = (B - 6) / 2;
  const cd = (W - 6) / 2;
  for (const [x, z] of [[-1, -1], [1, 1], [1, -1], [-1, 1]]) crates.add(block([cw - 1, 16, cd - 1], [(x * cw) / 2, DECK + 5, (z * cd) / 2], crateWood, 0.8));
  parts.push(crates);
  return parts;
}

/** A brake van for the back of a goods train: a cabin with an open end and a stove pipe. */
function brakeVan(def: StockDef, B: number): THREE.Object3D[] {
  const W = def.width;
  const roofY = DECK + def.height - 8;
  const cabin = B - 16;
  const parts: THREE.Object3D[] = [
    block([B, 4, W], [0, DECK], darkWood, 1.5),
    block([cabin, roofY - DECK - 4, W - 2], [-8, DECK + 4], paint(def.color), 3),
    ...sideWindows([-8], 12, 10, DECK + 20, W / 2 - 1),
    block([B + 2, 3, W + 3], [0, roofY], paint(BLACK), 1.4),
    // Open veranda posts and a rail at the front.
    ...[1, -1].map((side) => block([2.4, roofY - DECK - 4, 2.4], [B / 2 - 2, DECK + 4, side * (W / 2 - 2)], paint(CREAM), 0.6)),
    block([2, 2, W - 4], [B / 2 - 2, DECK + 14], paint(CREAM), 0.6),
    turned([[0, 0], [2, 0], [2, 9], [3, 10], [0, 10]], [-B / 3, roofY + 3], paint(BLACK)),
    // A red tail lamp at the back.
    barrel(2.8, 3, [-B / 2 - 0.5, DECK + 9, 9], paint(0xe0362b), 16),
  ];
  return parts;
}

const templates = new Map<string, THREE.Group>();

/** A vehicle model, facing +x. A vehicle turned round is the same model turned round. */
export function buildVehicle(def: StockDef): THREE.Group {
  let template = templates.get(def.id);
  if (!template) {
    template = new THREE.Group();
    const B = def.length - 2 * COUPLER_REACH;
    template.add(...chassis(def, B), ...wheels(def));
    const look = {
      engine: () => engine(def, B, false),
      steam: () => engine(def, B, true),
      tender: () => tender(def, B),
      wagon: () => wagon(def, B),
      coach: () => coach(def, B),
      timber: () => timber(def, B),
      hopper: () => hopper(def, B),
      tank: () => tank(def, B),
      livestock: () => livestock(def, B),
      van: () => van(def, B),
      carrier: () => carrier(def, B),
      flat: () => flat(def, B),
      brake: () => brakeVan(def, B),
    }[def.look];
    template.add(...look());
    template.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    templates.set(def.id, template);
  }
  return template.clone(true);
}
