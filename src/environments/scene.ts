import * as THREE from 'three';
import { RUG, TABLE, type EnvironmentId } from './environments';

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
  rug: { background: 0xf3ece0, fog: [2600, 7500], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  floor: { background: 0xf3ece0, fog: [2600, 7500], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
  grass: { background: 0xcfe5f3, fog: [3000, 9000], hemisphere: [0xe6f3ff, 0x9fb27a, 1.45], sun: 2.3 },
  grid: { background: 0xf6f1e7, fog: [2600, 7000], hemisphere: [0xffffff, 0xcfc4b0, 1.5], sun: 2.0 },
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
    for (const [ox, oy] of [[0, 0], [-512, 0], [512, 0], [0, -512], [0, 512]]) {
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

  group.add(ground(boardsMaterial(), -height));
  return group;
}

function buildRug(): THREE.Group {
  const group = new THREE.Group();
  const face = new THREE.MeshStandardMaterial({ map: texture(rugCanvas(), [RUG.width, RUG.depth], [RUG.width, RUG.depth]), roughness: 1 });
  const side = new THREE.MeshStandardMaterial({ color: 0xa24c33, roughness: 1 });
  // Box faces: +x, -x, +y (top), -y, +z, -z.
  const rug = receive(new THREE.Mesh(new THREE.BoxGeometry(RUG.width, RUG.thickness, RUG.depth), [side, side, face, side, side, side]));
  rug.position.y = -RUG.thickness / 2;
  group.add(rug, ground(boardsMaterial(), -RUG.thickness));
  return group;
}

function buildFloor(): THREE.Group {
  return new THREE.Group().add(ground(boardsMaterial(), 0));
}

function buildGrass(): THREE.Group {
  const lawn = new THREE.MeshStandardMaterial({ map: texture(grassCanvas(), [1000, 1000], [FLOOR, FLOOR]), roughness: 1 });
  return new THREE.Group().add(ground(lawn, 0));
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

const BUILDERS: Record<EnvironmentId, () => THREE.Group> = {
  table: buildTable,
  rug: buildRug,
  floor: buildFloor,
  grass: buildGrass,
  grid: buildGrid,
};

/** Shows one environment at a time in a scene, with its sky and light. */
export class EnvironmentScene {
  private readonly built = new Map<EnvironmentId, THREE.Group>();
  private shown: THREE.Group | null = null;

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
    this.scene.background = new THREE.Color(look.background);
    this.scene.fog = new THREE.Fog(look.background, look.fog[0], look.fog[1]);
    this.hemisphere.color.set(look.hemisphere[0]);
    this.hemisphere.groundColor.set(look.hemisphere[1]);
    this.hemisphere.intensity = look.hemisphere[2];
    this.sun.intensity = look.sun;
  }
}
