import * as THREE from 'three';
import * as D from '../pieces/dimensions';
import type { BridgeStyle } from '../pieces/types';

// The structure of a bridge span: what holds the deck up, and what stands
// round it. Drawn in the piece's own frame, three.js axes: the deck runs
// along +x from 0 to `length`, its bottom `deck` mm up, and plan +y is -z.
// Through bridges (truss, covered) leave room for the tallest train.

/** Inside clearance of a through bridge: half width and height above the deck bottom. */
const CLEAR_HALF_WIDTH = 26;
const CLEAR_HEIGHT = D.TRACK_HEIGHT + 66 + 10;

const material = (color: number, roughness = 0.75, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const STONE = material(0xb3aa98, 0.9);
const STONE_DARK = material(0x8f8676, 0.95);
const STEEL_RED = material(0xb23a2e, 0.5, 0.3);
const STEEL_GREY = material(0x5d6670, 0.45, 0.5);
const CABLE = material(0x2e3238, 0.4, 0.6);
const BARN_RED = material(0xa8392c, 0.8);
const ROOF = material(0x4a3b33, 0.85);
const TIMBER = material(0xc89a62, 0.75);

function box(mat: THREE.Material, size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...at);
  return mesh;
}

/** A bar of square section `thickness` from `a` to `b`. */
function bar(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.Mesh {
  const length = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, length, thickness), mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

/**
 * Stone viaduct: a wall under the deck pierced by round arches, with a
 * parapet each side. `arches` arches share the span evenly.
 */
function viaduct(length: number, deck: number, arches: number): THREE.Object3D[] {
  const width = D.TRACK_WIDTH + 8;
  const pier = 18;
  const span = (length - pier) / arches - pier;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(length, 0);
  shape.lineTo(length, deck);
  shape.lineTo(0, deck);
  shape.lineTo(0, 0);
  const radius = span / 2;
  const spring = Math.max(deck - 14 - radius, 4);
  for (let i = 0; i < arches; i++) {
    const x0 = pier + i * (span + pier);
    const hole = new THREE.Path();
    hole.moveTo(x0, 0);
    hole.lineTo(x0, spring);
    hole.absarc(x0 + radius, spring, radius, Math.PI, 0, true);
    hole.lineTo(x0 + span, 0);
    hole.lineTo(x0, 0);
    shape.holes.push(hole);
  }
  const wall = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  wall.translate(0, 0, -width / 2);
  const parts: THREE.Object3D[] = [new THREE.Mesh(wall, STONE)];
  // Parapets clear of the track, and a darker band (the string course) under them.
  for (const side of [-1, 1]) {
    parts.push(box(STONE, [length, 10, 5], [length / 2, deck + D.TRACK_HEIGHT + 5, side * (width / 2 - 2.5 + 3)]));
    parts.push(box(STONE_DARK, [length, 4, 6], [length / 2, deck - 2, side * (width / 2 + 1)]));
  }
  return parts;
}

/** Suspension bridge: two towers, main cables sagging between them, and hangers to the deck. */
function suspension(length: number, deck: number): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const towerAt = [length * 0.18, length * 0.82];
  const towerTop = deck + 150;
  const half = CLEAR_HALF_WIDTH + 6;
  for (const x of towerAt) {
    for (const side of [-1, 1]) parts.push(box(STEEL_RED, [10, towerTop, 8], [x, towerTop / 2, side * half]));
    // Portal beams, high enough for trains to pass under.
    for (const y of [deck + CLEAR_HEIGHT + 8, towerTop - 8]) parts.push(box(STEEL_RED, [10, 8, 2 * half + 8], [x, y, 0]));
  }
  // Deck girders along each side.
  for (const side of [-1, 1]) parts.push(box(STEEL_GREY, [length, 8, 4], [length / 2, deck - 4, side * (D.TRACK_WIDTH / 2 + 2)]));
  // Main cables: a parabola between the towers, running down to anchors at the ends.
  const [a, b] = towerAt;
  const low = deck + D.TRACK_HEIGHT + 14;
  const cableY = (x: number) => {
    if (x <= a) return deck + ((towerTop - deck) * x) / a;
    if (x >= b) return deck + ((towerTop - deck) * (length - x)) / (length - b);
    const t = (x - (a + b) / 2) / ((b - a) / 2);
    return low + (towerTop - low) * t * t;
  };
  const steps = 40;
  for (const side of [-1, 1]) {
    const z = side * half;
    for (let i = 0; i < steps; i++) {
      const x0 = (length * i) / steps;
      const x1 = (length * (i + 1)) / steps;
      parts.push(bar(CABLE, new THREE.Vector3(x0, cableY(x0), z), new THREE.Vector3(x1, cableY(x1), z), 2.5));
    }
    for (let x = a + 18; x < b - 9; x += 18) {
      parts.push(bar(CABLE, new THREE.Vector3(x, deck, z), new THREE.Vector3(x, cableY(x), z), 1.2));
    }
  }
  // Stone abutments under each end, and piers under the towers.
  for (const x of [8, length - 8]) parts.push(box(STONE, [16, deck, D.TRACK_WIDTH + 10], [x, deck / 2, 0]));
  for (const x of towerAt) parts.push(box(STONE, [18, deck, 2 * half + 12], [x, deck / 2, 0]));
  return parts;
}

/** Through truss: a Warren girder each side (diagonals in a zigzag), braced across the top. */
function truss(length: number, deck: number): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const top = deck + CLEAR_HEIGHT;
  const panels = Math.max(3, Math.round(length / 48));
  const panel = length / panels;
  for (const side of [-1, 1]) {
    const z = side * CLEAR_HALF_WIDTH;
    parts.push(bar(STEEL_GREY, new THREE.Vector3(0, deck + 2, z), new THREE.Vector3(length, deck + 2, z), 6));
    parts.push(bar(STEEL_GREY, new THREE.Vector3(panel / 2, top, z), new THREE.Vector3(length - panel / 2, top, z), 6));
    for (let i = 0; i < panels; i++) {
      const x0 = i * panel;
      const mid = x0 + panel / 2;
      parts.push(bar(STEEL_GREY, new THREE.Vector3(x0, deck + 2, z), new THREE.Vector3(mid, top, z), 4));
      parts.push(bar(STEEL_GREY, new THREE.Vector3(mid, top, z), new THREE.Vector3(x0 + panel, deck + 2, z), 4));
    }
  }
  // Top bracing between the two girders.
  for (let i = 0; i < panels; i++) {
    const x = (i + 0.5) * panel;
    parts.push(box(STEEL_GREY, [4, 4, 2 * CLEAR_HALF_WIDTH], [x, top, 0]));
  }
  // Floor beams under the deck, and stone abutments at the ends.
  for (let i = 0; i <= panels; i++) parts.push(box(STEEL_GREY, [5, 5, 2 * CLEAR_HALF_WIDTH + 6], [i * panel, deck - 2.5, 0]));
  for (const x of [8, length - 8]) parts.push(box(STONE, [16, deck - 5, 2 * CLEAR_HALF_WIDTH + 10], [x, (deck - 5) / 2, 0]));
  return parts;
}

/** Covered bridge: plank walls with windows, a pitched roof, on timber trestles. */
function covered(length: number, deck: number): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const wallTop = deck + CLEAR_HEIGHT;
  const half = CLEAR_HALF_WIDTH + 2;
  const window = { w: 26, h: 18, y: deck + D.TRACK_HEIGHT + 34 };
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0, deck);
    shape.lineTo(length, deck);
    shape.lineTo(length, wallTop);
    shape.lineTo(0, wallTop);
    shape.lineTo(0, deck);
    const count = Math.max(1, Math.floor(length / 72));
    for (let i = 0; i < count; i++) {
      const cx = ((i + 0.5) * length) / count;
      const hole = new THREE.Path();
      hole.moveTo(cx - window.w / 2, window.y);
      hole.lineTo(cx + window.w / 2, window.y);
      hole.lineTo(cx + window.w / 2, window.y + window.h);
      hole.lineTo(cx - window.w / 2, window.y + window.h);
      hole.lineTo(cx - window.w / 2, window.y);
      shape.holes.push(hole);
    }
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false });
    geometry.translate(0, 0, side > 0 ? half : -half - 4);
    parts.push(new THREE.Mesh(geometry, BARN_RED));
  }
  // Pitched roof: two sloping boards meeting over the middle, overhanging the walls.
  const rise = 26;
  const slope = Math.hypot(half + 8, rise);
  const pitch = Math.atan2(rise, half + 8);
  for (const side of [-1, 1]) {
    const board = box(ROOF, [length + 16, 3, slope], [length / 2, wallTop + rise / 2, (side * (half + 8)) / 2]);
    board.rotation.x = side * pitch;
    parts.push(board);
  }
  // Gable ends.
  for (const x of [0, length]) {
    const gable = new THREE.Shape();
    gable.moveTo(-half - 4, 0);
    gable.lineTo(half + 4, 0);
    gable.lineTo(0, rise);
    gable.lineTo(-half - 4, 0);
    const g = new THREE.Mesh(new THREE.ExtrudeGeometry(gable, { depth: 3, bevelEnabled: false }), BARN_RED);
    g.rotation.y = Math.PI / 2;
    g.position.set(x - (x ? 0 : -3), wallTop, 0);
    parts.push(g);
  }
  // Timber trestles: posts with cross braces.
  const bents = Math.max(2, Math.round(length / 72) + 1);
  for (let i = 0; i < bents; i++) {
    const x = 6 + ((length - 12) * i) / (bents - 1);
    for (const side of [-1, 1]) parts.push(box(TIMBER, [7, deck, 7], [x, deck / 2, side * (half - 4)]));
    parts.push(bar(TIMBER, new THREE.Vector3(x, 4, -(half - 4)), new THREE.Vector3(x, deck - 4, half - 4), 3));
    parts.push(box(TIMBER, [8, 6, 2 * half], [x, deck - 3, 0]));
  }
  return parts;
}

/** The structure for a bridge span `length` mm long with its deck bottom `deck` mm up. */
export function bridgeStructure(style: BridgeStyle, length: number, deck: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `bridge-${style}`;
  const parts =
    style === 'viaduct' ? viaduct(length, deck, Math.max(2, Math.round(length / 144)))
    : style === 'suspension' ? suspension(length, deck)
    : style === 'truss' ? truss(length, deck)
    : covered(length, deck);
  group.add(...parts);
  return group;
}
