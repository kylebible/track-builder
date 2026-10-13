import * as THREE from 'three';
import * as D from '../pieces/dimensions';
import { MAGNET_DEPTH, polesOf, WHEEL_RADIUS, type StockDef } from './stock';

// Simple wooden-toy models of the rolling stock, built in each vehicle's own
// frame: +x toward its front (north magnet), y up from the floor, z across.

export const AXLE_HEIGHT = D.TRACK_HEIGHT - D.GROOVE_DEPTH + WHEEL_RADIUS;
const CHASSIS_BOTTOM = AXLE_HEIGHT - 2;
const CHASSIS_HEIGHT = 9;
const DECK = CHASSIS_BOTTOM + CHASSIS_HEIGHT;

const materials = new Map<number, THREE.MeshStandardMaterial>();
function paint(color: number, roughness = 0.55): THREE.MeshStandardMaterial {
  let m = materials.get(color);
  if (!m) materials.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness })));
  return m;
}

const WOOD = 0xe0bb83;
const BLACK = 0x2b2622;
const WHEEL = 0xa3262a;
export const POLE_COLOR = { N: 0xd8432f, S: 0x3a6fd8 } as const;

function box(w: number, h: number, d: number, color: number, x: number, y: number, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), paint(color));
  mesh.position.set(x, y + h / 2, z);
  return mesh;
}

/** A cylinder lying along x. */
function barrel(radius: number, length: number, color: number, x: number, y: number, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 28), paint(color));
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

/** A cylinder standing up. */
function post(radius: number, height: number, color: number, x: number, y: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 20), paint(color));
  mesh.position.set(x, y + height / 2, 0);
  return mesh;
}

function body(def: StockDef): THREE.Object3D[] {
  const L = def.length - 2 * MAGNET_DEPTH;
  const W = def.width;
  const c = def.color;
  const top = CHASSIS_BOTTOM + def.height;
  switch (def.look) {
    case 'engine': {
      const cab = L * 0.38;
      return [
        box(cab, top - DECK, W, c, -L / 2 + cab / 2, DECK),
        box(cab + 6, 4, W + 4, BLACK, -L / 2 + cab / 2, top),
        barrel(W * 0.42, L - cab, c, cab / 2, DECK + W * 0.42),
        post(5, 14, BLACK, L / 2 - 14, DECK + W * 0.8),
      ];
    }
    case 'steam': {
      const cab = L * 0.3;
      return [
        box(cab, top - DECK, W, c, -L / 2 + cab / 2, DECK),
        box(cab + 6, 4, W + 4, BLACK, -L / 2 + cab / 2, top),
        barrel(W * 0.44, L - cab, BLACK, cab / 2, DECK + W * 0.44),
        barrel(W * 0.46, 6, c, -L / 2 + cab + 10, DECK + W * 0.44),
        barrel(W * 0.46, 6, c, L / 2 - 12, DECK + W * 0.44),
        post(6, 18, BLACK, L / 2 - 16, DECK + W * 0.8),
        post(6, 8, 0xd9a441, 0, DECK + W * 0.84),
      ];
    }
    case 'tender':
      return [box(L, top - DECK, W, c, 0, DECK), box(L - 6, 4, W - 6, BLACK, 0, top - 2)];
    case 'wagon': {
      const h = top - DECK;
      const t = 3;
      return [
        box(L, 3, W, c, 0, DECK),
        box(L, h, t, c, 0, DECK, W / 2 - t / 2),
        box(L, h, t, c, 0, DECK, -W / 2 + t / 2),
        box(t, h, W, c, L / 2 - t / 2, DECK),
        box(t, h, W, c, -L / 2 + t / 2, DECK),
      ];
    }
    case 'coach': {
      const h = top - DECK - 5;
      const parts = [box(L, h, W, c, 0, DECK), box(L + 4, 5, W + 4, WOOD, 0, DECK + h)];
      for (const side of [1, -1]) {
        for (let i = 0; i < 4; i++) {
          const x = -L / 2 + (L / 4) * (i + 0.5);
          parts.push(box(L / 4 - 8, h * 0.4, 0.6, 0xf5f1e8, x, DECK + h * 0.45, side * (W / 2 + 0.3)));
        }
      }
      return parts;
    }
    case 'timber': {
      const parts = [box(L, 3, W, c, 0, DECK)];
      for (const x of [-L / 2 + 4, L / 2 - 4]) parts.push(box(3, 16, W, c, x, DECK));
      for (const [z, y] of [[-8, 7], [8, 7], [0, 20]] as const) parts.push(barrel(7, L - 12, WOOD, 0, DECK + y, z));
      return parts;
    }
  }
}

/** A vehicle model, facing +x. A vehicle turned round is the same model turned round. */
export function buildVehicle(def: StockDef): THREE.Group {
  const group = new THREE.Group();
  const L = def.length - 2 * MAGNET_DEPTH;
  group.add(box(L, CHASSIS_HEIGHT, def.width - 6, def.motor ? BLACK : WOOD, 0, CHASSIS_BOTTOM));
  group.add(...body(def));
  for (const x of [def.wheelbase / 2, -def.wheelbase / 2]) {
    for (const z of [D.GROOVE_SPACING / 2, -D.GROOVE_SPACING / 2]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 4, 24), paint(WHEEL, 0.5));
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, AXLE_HEIGHT, z + Math.sign(z) * 3);
      group.add(wheel);
    }
  }
  // Magnets, coloured by pole so it's easy to see which way round a car is.
  const poles = polesOf({ reversed: false });
  for (const [x, pole] of [[def.length / 2 - MAGNET_DEPTH / 2, poles.front], [-def.length / 2 + MAGNET_DEPTH / 2, poles.back]] as const) {
    group.add(barrel(6, MAGNET_DEPTH, POLE_COLOR[pole], x, CHASSIS_BOTTOM + CHASSIS_HEIGHT / 2));
  }
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}
