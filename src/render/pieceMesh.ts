import * as THREE from 'three';
import { pathLength, poseAt } from '../geometry/path';
import { applyPose, type Pose } from '../geometry/pose';
import * as D from '../pieces/dimensions';
import type { Connector, PieceDef, TrackPath } from '../pieces/types';
import { sceneryModel } from './sceneryModels';

// Plan coordinates (x, y) in mm map to three.js (x, height, -y), so a
// counter-clockwise turn in plan is counter-clockwise seen from above.
export const toWorld = (x: number, y: number, height = 0): THREE.Vector3 => new THREE.Vector3(x, height, -y);

/** Track cross-section (sideways offset, height), with the two grooves. */
const PROFILE: [number, number][] = (() => {
  const w = D.TRACK_WIDTH / 2;
  const h = D.TRACK_HEIGHT;
  const g0 = D.GROOVE_SPACING / 2 - D.GROOVE_WIDTH / 2;
  const g1 = D.GROOVE_SPACING / 2 + D.GROOVE_WIDTH / 2;
  const floor = h - D.GROOVE_DEPTH;
  return [
    [-w, 0], [w, 0], [w, h], [g1, h], [g1, floor], [g0, floor], [g0, h],
    [-g0, h], [-g0, floor], [-g1, floor], [-g1, h], [-w, h],
  ];
})();

const SAMPLE_STEP_MM = 3;

/** Faint beech grain, running along the track. Multiplied by the wood colour. */
function grainTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // A fixed seed keeps every load looking the same.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const y = rand() * canvas.height;
    const wobble = 1 + rand() * 3;
    const phase = rand() * Math.PI * 2;
    g.strokeStyle = `rgba(120, 80, 30, ${0.04 + rand() * 0.08})`;
    g.lineWidth = 0.6 + rand() * 1.6;
    g.beginPath();
    for (let x = 0; x <= canvas.width; x += 8) {
      const yy = y + Math.sin((x / canvas.width) * Math.PI * 2 * 2 + phase) * wobble;
      x ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The beech grain, shared with anything else made of wood. */
export const WOOD_GRAIN = grainTexture();

const woodMaterial = new THREE.MeshStandardMaterial({
  color: 0xe8c590,
  map: WOOD_GRAIN,
  vertexColors: true,
  roughness: 0.68,
  flatShading: true,
});
const pegMaterial = new THREE.MeshStandardMaterial({ color: 0xe0bb83, map: woodMaterial.map, roughness: 0.68 });
const holeMaterial = new THREE.MeshStandardMaterial({ color: 0x5a4026, roughness: 1 });
const bufferMaterial = new THREE.MeshStandardMaterial({ color: 0xc8352b, roughness: 0.6 });
const stripeMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f1e8, roughness: 0.6 });

function profileAt(pose: Pose): THREE.Vector3[] {
  return PROFILE.map(([u, h]) => {
    const p = applyPose(pose, { x: 0, y: u, angle: 0 });
    return toWorld(p.x, p.y, h);
  });
}

/** Profile edges that are groove walls or floors, shaded darker like worn grooves. */
const GROOVE_EDGES = new Set([3, 4, 5, 7, 8, 9]);
const GROOVE_SHADE = 0.8;
const END_GRAIN_SHADE = 0.86;
/** Grain texture repeat, in mm along and across the track. */
const GRAIN_ALONG = 160;
const GRAIN_ACROSS = 40;

interface Buffers {
  positions: number[];
  uvs: number[];
  colors: number[];
}

function push(out: Buffers, v: THREE.Vector3, u: number, w: number, shade: number): void {
  out.positions.push(v.x, v.y, v.z);
  out.uvs.push(u, w);
  out.colors.push(shade, shade, shade);
}

/** An end face. The far end faces forward, the start faces back. */
function capTriangles(ring: THREE.Vector3[], out: Buffers, facingBack: boolean): void {
  const shape = PROFILE.map(([u, h]) => new THREE.Vector2(u, h));
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(shape, [])) {
    for (const i of facingBack ? [a, c, b] : [a, b, c]) push(out, ring[i], PROFILE[i][0] / GRAIN_ACROSS, PROFILE[i][1] / GRAIN_ACROSS, END_GRAIN_SHADE);
  }
}

/** Sweep the track profile along one running path. */
function sweepGeometry(path: TrackPath): THREE.BufferGeometry {
  const length = pathLength(path);
  const steps = path.kind === 'straight' ? 1 : Math.max(2, Math.ceil(length / SAMPLE_STEP_MM));
  const rings = Array.from({ length: steps + 1 }, (_, i) => profileAt(poseAt(path, (length * i) / steps)));
  const out: Buffers = { positions: [], uvs: [], colors: [] };
  // Across-the-track texture coordinate: sideways offset plus height, so
  // both the top and the sides get grain.
  const across = PROFILE.map(([u, h]) => (u + h) / GRAIN_ACROSS);
  for (let i = 0; i < steps; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    const s0 = (length * i) / steps / GRAIN_ALONG;
    const s1 = (length * (i + 1)) / steps / GRAIN_ALONG;
    for (let j = 0; j < PROFILE.length; j++) {
      const k = (j + 1) % PROFILE.length;
      const shade = GROOVE_EDGES.has(j) ? GROOVE_SHADE : 1;
      // Wound so faces point out of the wood; the profile runs anticlockwise.
      push(out, r0[j], s0, across[j], shade);
      push(out, r1[k], s1, across[k], shade);
      push(out, r1[j], s1, across[j], shade);
      push(out, r0[j], s0, across[j], shade);
      push(out, r0[k], s0, across[k], shade);
      push(out, r1[k], s1, across[k], shade);
    }
  }
  capTriangles(rings[0], out, true);
  capTriangles(rings[steps], out, false);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(out.uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(out.colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A peg sticking out of the end, or a dark hole set into the top. */
function connectorMesh(c: Connector): THREE.Object3D {
  const group = new THREE.Group();
  const { x, y, angle } = c.pose;
  group.position.copy(toWorld(x, y));
  group.rotation.y = angle;
  if (c.gender === 'peg') {
    const neck = new THREE.Mesh(new THREE.BoxGeometry(D.PEG_NECK_LENGTH, D.TRACK_HEIGHT - 2, D.PEG_NECK_WIDTH), pegMaterial);
    neck.position.set(D.PEG_NECK_LENGTH / 2, (D.TRACK_HEIGHT - 2) / 2, 0);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(D.PEG_DIAMETER / 2, D.PEG_DIAMETER / 2, D.TRACK_HEIGHT - 2, 32), pegMaterial);
    head.position.set(D.PEG_NECK_LENGTH + D.PEG_DIAMETER / 2, (D.TRACK_HEIGHT - 2) / 2, 0);
    group.add(neck, head);
  } else {
    const throat = 5;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(D.HOLE_DIAMETER / 2, 32), holeMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(-(throat + D.HOLE_DIAMETER / 2), D.TRACK_HEIGHT + 0.05, 0);
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(throat + 0.5, D.PEG_NECK_WIDTH + 1), holeMaterial);
    slot.rotation.x = -Math.PI / 2;
    slot.position.set(-throat / 2, D.TRACK_HEIGHT + 0.05, 0);
    group.add(disc, slot);
  }
  return group;
}

/** The red and white barrier on a buffer stop's dead end. */
function bufferBarrier(piece: PieceDef): THREE.Object3D {
  const end = poseAt(piece.paths[0], pathLength(piece.paths[0]));
  const group = new THREE.Group();
  group.position.copy(toWorld(end.x, end.y));
  group.rotation.y = end.angle;
  const thickness = 10;
  const height = 40;
  const board = new THREE.Mesh(new THREE.BoxGeometry(thickness, height, D.TRACK_WIDTH), bufferMaterial);
  board.position.set(-thickness / 2, D.TRACK_HEIGHT + height / 2, 0);
  group.add(board);
  for (const h of [0.3, 0.7]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(thickness + 0.4, height / 8, D.TRACK_WIDTH + 0.4), stripeMaterial);
    stripe.position.set(-thickness / 2, D.TRACK_HEIGHT + height * h, 0);
    group.add(stripe);
  }
  return group;
}

/** A three.js object for one catalog piece, in its own plan frame. */
export function buildPieceObject(piece: PieceDef): THREE.Group {
  const group = new THREE.Group();
  group.name = piece.id;
  piece.paths.forEach((path, i) => {
    // Paths of a switch overlap near the trunk; nudge later paths' depth so
    // the shared top surface doesn't flicker.
    const material = i === 0 ? woodMaterial : woodMaterial.clone();
    if (i > 0) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -i;
      material.polygonOffsetUnits = -i;
    }
    group.add(new THREE.Mesh(sweepGeometry(path), material));
  });
  for (const c of piece.connectors) group.add(connectorMesh(c));
  if (piece.category === 'buffer') group.add(bufferBarrier(piece));
  if (piece.model) {
    const model = sceneryModel(piece.model);
    // Turned over, the model mirrors across the piece's own x axis.
    if (piece.mirrored) model.scale.z = -1;
    group.add(model);
  }
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}
