import * as THREE from 'three';
import { LAKE, lakeShore, PLAYMAT, RIVER, riverCentre, RUG, TABLE, TOWN, type EnvironmentId } from './environments';
import { dressGrass, dressLake, dressRiver, dressRoom, dressSnow, dressTown, ROOM_KEEP_OUT } from './dressing';
import { playmatCanvas } from './playmat';

// The three.js side of environments: the surface under the track and
// everything around it, plus the sky colour and light that suit it. Each
// one is built the first time it's picked and kept for switching back.
// Textures are drawn on canvases, so there's nothing to download.

export interface EnvironmentLook {
  background: number;
  /** Where the fog starts and is complete, mm from the camera. */
  fog: [number, number];
  /** Hemisphere light: sky colour, ground colour, intensity. */
  hemisphere: [number, number, number];
  sun: number;
}

/** How far surfaces that go on and on reach; the fog hides the edge. */
const FLOOR = 12000;

const LOOKS: Record<EnvironmentId, EnvironmentLook> = {
  table: { background: 0xf3ece0, fog: [2600, 7500], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  playmat: { background: 0xf3ece0, fog: [2600, 7500], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  rug: { background: 0xf3ece0, fog: [2600, 7500], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  floor: { background: 0xf3ece0, fog: [2600, 7500], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  grass: { background: 0xcfe5f3, fog: [3000, 9000], hemisphere: [0xe6f3ff, 0x9fb27a, 1.45], sun: 2.3 },
  grid: { background: 0xf6f1e7, fog: [2600, 7000], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  town: { background: 0xd7e7f2, fog: [3000, 9000], hemisphere: [0xf0f6ff, 0xb8b4a8, 1.5], sun: 2.2 },
  river: { background: 0xcfe5f3, fog: [3000, 9000], hemisphere: [0xe6f3ff, 0x9fb27a, 1.45], sun: 2.3 },
  lake: { background: 0xd4ebf7, fog: [3000, 9000], hemisphere: [0xeef7ff, 0xd8c9a4, 1.45], sun: 2.3 },
  snow: { background: 0xe3eaf1, fog: [2600, 8000], hemisphere: [0xf4f8fc, 0xdfe6ee, 1.7], sun: 2.1 },
};

export function lookOf(id: EnvironmentId): EnvironmentLook {
  return LOOKS[id];
}

// ---- drawing helpers --------------------------------------------------------

/** A seeded random source, so textures come out the same every load. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')!];
}

/** A texture covering `sizeMm` (width, depth) of surface, repeating to fill `areaMm`. */
function texture(c: HTMLCanvasElement, sizeMm: [number, number], areaMm: [number, number]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(areaMm[0] / sizeMm[0], areaMm[1] / sizeMm[1]);
  t.anisotropy = 8;
  return t;
}

/** Offsets that draw a mark on a 512 px tile again across every edge and corner, so the tile wraps. */
const WRAP = [-512, 0, 512].flatMap((ox) => [-512, 0, 512].map((oy) => [ox, oy]));

const shade = (base: [number, number, number], k: number) => `rgb(${base.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(',')})`;

/** Oak boards, 140 mm wide, staggered; one tile is 8 boards by 2.4 m. */
function boardsCanvas(): HTMLCanvasElement {
  const PX = 0.5; // pixels per mm
  const board = 140;
  const [c, g] = canvas(8 * board * PX, 2400 * PX);
  const rand = random(7);
  const base: [number, number, number] = [192, 156, 116];
  for (let col = 0; col < 8; col++) {
    const x = col * board * PX;
    // Boards of 600 to 1200 mm, each row starting at a different offset.
    let y = -rand() * 1200 * PX;
    while (y < c.height) {
      const len = (600 + rand() * 600) * PX;
      const k = 0.9 + rand() * 0.14;
      g.fillStyle = shade(base, k);
      g.fillRect(x, y, board * PX, len);
      // Grain: thin, slightly wavy streaks along the board.
      for (let i = 0; i < 14; i++) {
        g.strokeStyle = shade(base, k * (0.82 + rand() * 0.12));
        g.globalAlpha = 0.25 + rand() * 0.3;
        g.lineWidth = 0.6 + rand() * 1.2;
        const gx = x + rand() * board * PX;
        g.beginPath();
        g.moveTo(gx, y);
        g.bezierCurveTo(gx + (rand() - 0.5) * 6, y + len / 3, gx + (rand() - 0.5) * 6, y + (2 * len) / 3, gx + (rand() - 0.5) * 4, y + len);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(70, 45, 20, 0.55)';
      g.fillRect(x, y, board * PX, 1);
      y += len;
    }
    g.fillStyle = 'rgba(70, 45, 20, 0.6)';
    g.fillRect(x, 0, 1, c.height);
  }
  // Wrap the stagger cleanly: the canvas height is the tile, so the top
  // and bottom rows meet. The odd seam is no worse than real flooring.
  return c;
}

/** A cheerful woven rug: a patterned border round a lattice field. */
function rugCanvas(): HTMLCanvasElement {
  const PX = 0.5;
  const [c, g] = canvas(RUG.width * PX, RUG.depth * PX);
  const W = c.width;
  const H = c.height;
  const cream = '#efe3cb';
  const rust = '#b8573a';
  const navy = '#2f4a6b';
  const mustard = '#d8a64a';
  g.fillStyle = rust;
  g.fillRect(0, 0, W, H);
  const band = (inset: number, colour: string) => {
    g.fillStyle = colour;
    g.fillRect(inset, inset, W - 2 * inset, H - 2 * inset);
  };
  band(14, cream);
  band(22, navy);
  band(70, cream);
  band(78, mustard);
  band(86, '#f3e9d6');
  // Little diamonds along the navy border.
  g.fillStyle = cream;
  const diamond = (x: number, y: number, r: number) => {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.fill();
  };
  for (let x = 46; x < W - 30; x += 40) {
    diamond(x, 46, 11);
    diamond(x, H - 46, 11);
  }
  for (let y = 86; y < H - 70; y += 40) {
    diamond(46, y, 11);
    diamond(W - 46, y, 11);
  }
  // A soft lattice across the field.
  g.save();
  g.beginPath();
  g.rect(86, 86, W - 172, H - 172);
  g.clip();
  g.strokeStyle = 'rgba(184, 87, 58, 0.22)';
  g.lineWidth = 3;
  const step = 70;
  for (let d = -H; d < W + H; d += step) {
    g.beginPath();
    g.moveTo(d, 0);
    g.lineTo(d + H, H);
    g.moveTo(d, H);
    g.lineTo(d + H, 0);
    g.stroke();
  }
  g.fillStyle = 'rgba(47, 74, 107, 0.28)';
  for (let x = 86; x < W; x += step) for (let y = 86 + (((x - 86) / step) % 2) * (step / 2); y < H; y += step) diamond(x, y, 6);
  g.restore();
  // Woven texture: faint speckle everywhere.
  const rand = random(3);
  for (let i = 0; i < W * H * 0.05; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
  }
  return c;
}

/** Lawn: a 1 m tile of blotchy greens with blades of grass. */
function grassCanvas(): HTMLCanvasElement {
  const [c, g] = canvas(512, 512);
  const rand = random(11);
  g.fillStyle = '#6f9a45';
  g.fillRect(0, 0, 512, 512);
  // Big soft patches, drawn three times over so the tile wraps.
  for (let i = 0; i < 60; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 30 + rand() * 70;
    const light = rand() < 0.5;
    for (const [ox, oy] of WRAP) {
      const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grad.addColorStop(0, light ? 'rgba(150, 190, 90, 0.16)' : 'rgba(70, 110, 40, 0.16)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
    }
  }
  for (let i = 0; i < 9000; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const k = rand();
    g.strokeStyle = k < 0.4 ? 'rgba(60, 95, 35, 0.55)' : k < 0.8 ? 'rgba(130, 170, 75, 0.5)' : 'rgba(175, 200, 110, 0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * 3, y - 2 - rand() * 4);
    g.stroke();
  }
  return c;
}

/**
 * One town block, 1.5 m square, with half a street down each side, so tiles
 * meet in a grid of streets: asphalt, a dashed centre line, pavements, and
 * zebra crossings at every junction.
 */
function townCanvas(): HTMLCanvasElement {
  const PX = 0.4;
  const S = TOWN.block * PX;
  const [c, g] = canvas(S, S);
  const road = TOWN.road * PX;
  const walk = TOWN.pavement * PX;
  const rand = random(5);
  // The block: a lawn with a paved border.
  g.fillStyle = '#d8d4cb';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#9fc47e';
  g.fillRect(road / 2 + walk, road / 2 + walk, S - road - 2 * walk, S - road - 2 * walk);
  for (let i = 0; i < 2000; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(80,120,50,0.18)' : 'rgba(200,230,150,0.18)';
    g.fillRect(road / 2 + walk + rand() * (S - road - 2 * walk), road / 2 + walk + rand() * (S - road - 2 * walk), 2, 2);
  }
  // Paving joints.
  g.strokeStyle = 'rgba(120, 112, 100, 0.35)';
  g.lineWidth = 1;
  for (let d = road / 2; d < S - road / 2; d += 16) {
    for (const [x0, y0, x1, y1] of [[d, road / 2, d, road / 2 + walk], [d, S - road / 2 - walk, d, S - road / 2], [road / 2, d, road / 2 + walk, d], [S - road / 2 - walk, d, S - road / 2, d]]) {
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }
  // Streets along all four edges (half of each), with kerbs.
  g.fillStyle = '#595c62';
  for (const [x, y, w, h] of [[0, 0, S, road / 2], [0, S - road / 2, S, road / 2], [0, 0, road / 2, S], [S - road / 2, 0, road / 2, S]]) g.fillRect(x, y, w, h);
  for (let i = 0; i < 5000; i++) {
    const x = rand() * S;
    const y = rand() * S;
    if (x > road / 2 && x < S - road / 2 && y > road / 2 && y < S - road / 2) continue;
    g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.1)';
    g.fillRect(x, y, 1.5, 1.5);
  }
  g.strokeStyle = '#b9b4aa';
  g.lineWidth = 2;
  g.strokeRect(road / 2, road / 2, S - road, S - road);
  // Dashed centre lines along each edge, stopping short of the junctions.
  g.fillStyle = '#f2efe6';
  const junction = road / 2 + walk + 40 * PX;
  for (let d = junction; d < S - junction - 30 * PX; d += 90 * PX) {
    const len = Math.min(50 * PX, S - junction - d);
    g.fillRect(d, -1.5, len, 3);
    g.fillRect(d, S - 1.5, len, 3);
    g.fillRect(-1.5, d, 3, len);
    g.fillRect(S - 1.5, d, 3, len);
  }
  // Zebra crossings just outside each corner junction.
  const stripe = 12 * PX;
  for (const cx of [0, S]) {
    for (const cy of [0, S]) {
      const inward = (v: number) => (v === 0 ? 1 : -1);
      for (let k = -road / 2 + 3; k < road / 2 - stripe; k += 2 * stripe) {
        // Crossing the street that runs along x, and the one along y.
        g.fillRect(cx + inward(cx) * (road / 2 + 4) + (inward(cx) < 0 ? -24 * PX : 0), cy + k, 24 * PX, stripe);
        g.fillRect(cx + k, cy + inward(cy) * (road / 2 + 4) + (inward(cy) < 0 ? -24 * PX : 0), stripe, 24 * PX);
      }
    }
  }
  return c;
}

/** Fine pale sand, a 1 m tile. */
function sandCanvas(): HTMLCanvasElement {
  const [c, g] = canvas(512, 512);
  const rand = random(17);
  g.fillStyle = '#e6d3a8';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 40; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 40 + rand() * 90;
    for (const [ox, oy] of WRAP) {
      const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grad.addColorStop(0, rand() < 0.5 ? 'rgba(250, 236, 200, 0.14)' : 'rgba(200, 175, 125, 0.1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
    }
  }
  for (let i = 0; i < 26000; i++) {
    const k = rand();
    g.fillStyle = k < 0.45 ? 'rgba(160, 130, 85, 0.35)' : k < 0.9 ? 'rgba(255, 248, 225, 0.45)' : 'rgba(110, 95, 75, 0.4)';
    g.fillRect(rand() * 512, rand() * 512, 1, 1);
  }
  return c;
}

/** Soft snow with faint blue drifts, a 1 m tile. */
function snowCanvas(): HTMLCanvasElement {
  const [c, g] = canvas(512, 512);
  const rand = random(23);
  g.fillStyle = '#fafcff';
  g.fillRect(0, 0, 512, 512);
  // Long, low drifts: wide ellipses of the faintest blue.
  for (let i = 0; i < 14; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const rx = 80 + rand() * 120;
    for (const [ox, oy] of WRAP) {
      g.save();
      g.translate(x + ox, y + oy);
      g.scale(1, 0.35);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      grad.addColorStop(0, 'rgba(200, 218, 238, 0.28)');
      grad.addColorStop(1, 'rgba(200, 218, 238, 0)');
      g.fillStyle = grad;
      g.fillRect(-rx, -rx, 2 * rx, 2 * rx);
      g.restore();
    }
  }
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(185, 202, 222, 0.35)' : 'rgba(255, 255, 255, 1)';
    g.fillRect(rand() * 512, rand() * 512, 1, 1);
  }
  return c;
}

/** Ripples on water, a 1 m tile; the texture drifts slowly to look alive. */
function waterCanvas(): HTMLCanvasElement {
  const [c, g] = canvas(512, 512);
  const rand = random(29);
  g.fillStyle = '#4489b6';
  g.fillRect(0, 0, 512, 512);
  g.lineCap = 'round';
  for (let i = 0; i < 700; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const len = 8 + rand() * 30;
    g.strokeStyle = rand() < 0.7 ? 'rgba(200, 232, 250, 0.35)' : 'rgba(30, 80, 120, 0.3)';
    g.lineWidth = 1 + rand() * 1.5;
    for (const [ox, oy] of WRAP) {
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.quadraticCurveTo(x + ox + len / 2, y + oy - 3, x + ox + len, y + oy);
      g.stroke();
    }
  }
  return c;
}

// ---- environments ---------------------------------------------------------

function receive<T extends THREE.Mesh>(mesh: T): T {
  mesh.receiveShadow = true;
  return mesh;
}

function cast<T extends THREE.Mesh>(mesh: T): T {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A flat surface reaching to the fog, its top at height `y`. */
function ground(material: THREE.Material, y: number): THREE.Mesh {
  const mesh = receive(new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR), material));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

let boards: THREE.MeshStandardMaterial | null = null;
function boardsMaterial(): THREE.MeshStandardMaterial {
  boards ??= new THREE.MeshStandardMaterial({ map: texture(boardsCanvas(), [8 * 140, 2400], [FLOOR, FLOOR]), roughness: 0.65 });
  return boards;
}

/** Light birch plywood, for the table. */
function birch(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xe6cfa6, roughness: 0.7 });
}

function buildTable(): THREE.Group {
  const group = new THREE.Group();
  const { width, depth, rim, rimHeight, top, height } = TABLE;
  const wood = birch();
  const edge = new THREE.MeshStandardMaterial({ color: 0xd2b285, roughness: 0.65 });

  const slab = cast(new THREE.Mesh(new THREE.BoxGeometry(width, top, depth), wood));
  slab.position.y = -top / 2;
  group.add(slab);

  // The rim stands up round the edge so trains (and track) stay on.
  const long = new THREE.BoxGeometry(width, rimHeight, rim);
  const short = new THREE.BoxGeometry(rim, rimHeight, depth - 2 * rim);
  for (const s of [-1, 1]) {
    const a = cast(new THREE.Mesh(long, edge));
    a.position.set(0, rimHeight / 2, s * (depth / 2 - rim / 2));
    const b = cast(new THREE.Mesh(short, edge));
    b.position.set(s * (width / 2 - rim / 2), rimHeight / 2, 0);
    group.add(a, b);
  }

  // Apron under the top, and four square legs down to the floor.
  const apronH = 70;
  const leg = 55;
  const apronLong = new THREE.BoxGeometry(width - 80, apronH, 18);
  const apronShort = new THREE.BoxGeometry(18, apronH, depth - 80);
  for (const s of [-1, 1]) {
    const a = cast(new THREE.Mesh(apronLong, edge));
    a.position.set(0, -top - apronH / 2, s * (depth / 2 - 40));
    const b = cast(new THREE.Mesh(apronShort, edge));
    b.position.set(s * (width / 2 - 40), -top - apronH / 2, 0);
    group.add(a, b);
  }
  const legGeometry = new THREE.BoxGeometry(leg, height - top, leg);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const l = cast(new THREE.Mesh(legGeometry, edge));
      l.position.set(sx * (width / 2 - 40), -top - (height - top) / 2, sz * (depth / 2 - 40));
      group.add(l);
    }
  }

  group.add(ground(boardsMaterial(), -height), dressRoom(-height, ROOM_KEEP_OUT.table));
  return group;
}

function buildRug(): THREE.Group {
  const group = new THREE.Group();
  const face = new THREE.MeshStandardMaterial({ map: texture(rugCanvas(), [RUG.width, RUG.depth], [RUG.width, RUG.depth]), roughness: 1 });
  const side = new THREE.MeshStandardMaterial({ color: 0xa24c33, roughness: 1 });
  // Box faces: +x, -x, +y (top), -y, +z, -z.
  const rug = receive(new THREE.Mesh(new THREE.BoxGeometry(RUG.width, RUG.thickness, RUG.depth), [side, side, face, side, side, side]));
  rug.position.y = -RUG.thickness / 2;
  group.add(rug, ground(boardsMaterial(), -RUG.thickness), dressRoom(-RUG.thickness, ROOM_KEEP_OUT.rug));
  return group;
}

function buildPlaymat(): THREE.Group {
  const group = new THREE.Group();
  const face = new THREE.MeshStandardMaterial({ map: texture(playmatCanvas(), [PLAYMAT.width, PLAYMAT.depth], [PLAYMAT.width, PLAYMAT.depth]), roughness: 0.95 });
  const side = new THREE.MeshStandardMaterial({ color: 0x2f4a6b, roughness: 1 });
  const mat = receive(new THREE.Mesh(new THREE.BoxGeometry(PLAYMAT.width, PLAYMAT.thickness, PLAYMAT.depth), [side, side, face, side, side, side]));
  mat.position.y = -PLAYMAT.thickness / 2;
  group.add(mat, ground(boardsMaterial(), -PLAYMAT.thickness), dressRoom(-PLAYMAT.thickness, ROOM_KEEP_OUT.playmat));
  return group;
}

function buildFloor(): THREE.Group {
  return new THREE.Group().add(ground(boardsMaterial(), 0), dressRoom(0, ROOM_KEEP_OUT.floor));
}

function buildGrass(): THREE.Group {
  const lawn = new THREE.MeshStandardMaterial({ map: texture(grassCanvas(), [1000, 1000], [FLOOR, FLOOR]), roughness: 1 });
  return new THREE.Group().add(ground(lawn, 0), dressGrass());
}

/** The original planning mat: 100 mm squares with a heavier line every metre. */
function buildGrid(): THREE.Group {
  const mat = ground(new THREE.MeshStandardMaterial({ color: 0xe6eadc, roughness: 1 }), -1);
  const fine = new THREE.GridHelper(FLOOR, FLOOR / 100, 0xd6ddc8, 0xd6ddc8);
  fine.position.y = -0.6;
  const metre = new THREE.GridHelper(FLOOR, FLOOR / 1000, 0xbcc6ac, 0xbcc6ac);
  metre.position.y = -0.4;
  return new THREE.Group().add(mat, fine, metre);
}

function buildTown(): THREE.Group {
  const t = texture(townCanvas(), [TOWN.block, TOWN.block], [FLOOR, FLOOR]);
  // FLOOR is a whole number of blocks, so the tile edges (the streets) would
  // cross in the middle; shift half a block so a layout started there sits
  // in a block instead.
  t.offset.set(0.5, 0.5);
  return new THREE.Group().add(ground(new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }), 0), dressTown());
}

function buildSnow(): THREE.Group {
  const snow = new THREE.MeshStandardMaterial({ map: texture(snowCanvas(), [1000, 1000], [FLOOR, FLOOR]), roughness: 0.95 });
  return new THREE.Group().add(ground(snow, 0), dressSnow());
}

/** Water lies this far below the land, inside banks this deep. */
const WATER_LEVEL = -6;
const BANK = 14;

let water: THREE.MeshStandardMaterial | null = null;
function waterMaterial(): THREE.MeshStandardMaterial {
  water ??= new THREE.MeshStandardMaterial({ map: texture(waterCanvas(), [1000, 1000], [FLOOR, FLOOR]), roughness: 0.18, metalness: 0.05 });
  return water;
}

/** Land with water showing through wherever its shapes leave gaps. */
function landAndWater(land: THREE.Shape[], banks: THREE.Vector2[][], landMaterial: THREE.Material, bankColour: number): THREE.Group {
  const group = new THREE.Group();
  // Shape coordinates are plan mm, and so are its UVs: scale textures to suit.
  const mesh = receive(new THREE.Mesh(new THREE.ShapeGeometry(land, 1), landMaterial));
  mesh.rotation.x = -Math.PI / 2;
  group.add(mesh);
  const bank = new THREE.MeshStandardMaterial({ color: bankColour, roughness: 1, side: THREE.DoubleSide });
  for (const line of banks) {
    const positions: number[] = [];
    for (let i = 0; i < line.length - 1; i++) {
      const [a, b] = [line[i], line[i + 1]];
      positions.push(a.x, 0, -a.y, b.x, 0, -b.y, b.x, -BANK, -b.y, a.x, 0, -a.y, b.x, -BANK, -b.y, a.x, -BANK, -a.y);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    group.add(receive(new THREE.Mesh(geometry, bank)));
  }
  group.add(ground(waterMaterial(), WATER_LEVEL));
  return group;
}

/** A texture whose repeat suits ShapeGeometry's plan-mm UVs. */
function planTexture(c: HTMLCanvasElement, tileMm: number): THREE.CanvasTexture {
  const t = texture(c, [tileMm, tileMm], [1, 1]);
  return t;
}

function buildRiver(): THREE.Group {
  const H = FLOOR / 2;
  const north: THREE.Vector2[] = [];
  const south: THREE.Vector2[] = [];
  for (let x = -H; x <= H; x += 40) {
    north.push(new THREE.Vector2(x, riverCentre(x) + RIVER.width / 2));
    south.push(new THREE.Vector2(x, riverCentre(x) - RIVER.width / 2));
  }
  const northBank = new THREE.Shape([...north, new THREE.Vector2(H, H), new THREE.Vector2(-H, H)]);
  const southBank = new THREE.Shape([...south, new THREE.Vector2(H, -H), new THREE.Vector2(-H, -H)]);
  const lawn = new THREE.MeshStandardMaterial({ map: planTexture(grassCanvas(), 1000), roughness: 1 });
  return landAndWater([northBank, southBank], [north, south], lawn, 0x7a6248).add(dressRiver());
}

function buildLake(): THREE.Group {
  const H = FLOOR / 2;
  const shore: THREE.Vector2[] = [];
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * 2 * Math.PI;
    const r = lakeShore(a);
    shore.push(new THREE.Vector2(LAKE.x + LAKE.rx * r * Math.cos(a), LAKE.y + LAKE.ry * r * Math.sin(a)));
  }
  const beach = new THREE.Shape([new THREE.Vector2(-H, -H), new THREE.Vector2(H, -H), new THREE.Vector2(H, H), new THREE.Vector2(-H, H)]);
  beach.holes.push(new THREE.Path(shore));
  const sand = new THREE.MeshStandardMaterial({ map: planTexture(sandCanvas(), 1000), roughness: 1 });
  return landAndWater([beach], [shore], sand, 0xc9b183).add(dressLake());
}

const BUILDERS: Record<EnvironmentId, () => THREE.Group> = {
  table: buildTable,
  rug: buildRug,
  playmat: buildPlaymat,
  floor: buildFloor,
  grid: buildGrid,
  grass: buildGrass,
  town: buildTown,
  river: buildRiver,
  lake: buildLake,
  snow: buildSnow,
};

/** Shows one environment at a time in a scene, with its sky and light. */
export class EnvironmentScene {
  private readonly built = new Map<EnvironmentId, THREE.Group>();
  private shown: THREE.Group | null = null;
  private look: EnvironmentLook | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly hemisphere: THREE.HemisphereLight,
    private readonly sun: THREE.DirectionalLight,
  ) {}

  show(id: EnvironmentId): void {
    let group = this.built.get(id);
    if (!group) {
      group = BUILDERS[id]();
      group.name = `environment:${id}`;
      this.built.set(id, group);
    }
    if (this.shown) this.scene.remove(this.shown);
    this.scene.add(group);
    this.shown = group;

    const look = LOOKS[id];
    this.look = look;
    this.scene.background = new THREE.Color(look.background);
    this.scene.fog = new THREE.Fog(look.background, look.fog[0], look.fog[1]);
    this.hemisphere.color.set(look.hemisphere[0]);
    this.hemisphere.groundColor.set(look.hemisphere[1]);
    this.hemisphere.intensity = look.hemisphere[2];
    this.sun.intensity = look.sun;
  }

  /**
   * Push the fog back when the camera is far from what it looks at, so a
   * big layout framed whole doesn't fade away; call once a frame.
   */
  reach(distance: number): void {
    const fog = this.scene.fog;
    if (!(fog instanceof THREE.Fog) || !this.look) return;
    fog.near = Math.max(this.look.fog[0], distance * 0.9);
    fog.far = Math.max(this.look.fog[1], distance + 3000);
  }

  /** Let the water drift; call once a frame with the time in ms. */
  tick(time: number): void {
    if (!water?.map) return;
    water.map.offset.set(Math.sin(time / 9000) * 0.02, time / 400000);
  }
}
