import { PLAYMAT } from './environments';
import { random } from './props';

// The children's play mat print: a road loop with a roundabout, a river
// with bridges, a farm, a school, shops, houses, a pond and a beach, seen
// from above like the real ones. Drawn in mat millimetres, x across and y
// down the print, with the top edge to the north.

/** Print resolution, pixels per mm. */
const PX = 0.8;

type Ctx = CanvasRenderingContext2D;
type Pt = [number, number];

const ROAD = 120;
const LOOP = { x0: 170, y0: 170, x1: 2230, y1: 1430, r: 220 };
const STREET_X = 1560;
const STREET_Y = 1100;
const ROUNDABOUT = { x: STREET_X, y: 760, r: 115 };

/** The river's course, as cubic Bézier segments from the top edge to the bottom. */
const RIVER_PATH: [Pt, Pt, Pt, Pt][] = [
  [[430, -20], [400, 260], [230, 420], [320, 620]],
  [[320, 620], [400, 800], [700, 860], [640, 1080]],
  [[640, 1080], [590, 1260], [470, 1400], [520, 1620]],
];
const RIVER_WIDTH = 105;

function bez(seg: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const [a, b, c, d] = seg;
  return [0, 1].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]) as Pt;
}

/** Where the river crosses the horizontal line y, if it does. */
function riverCrossing(y: number): Pt | null {
  for (const seg of RIVER_PATH) {
    let prev = bez(seg, 0);
    for (let i = 1; i <= 200; i++) {
      const p = bez(seg, i / 200);
      if ((prev[1] - y) * (p[1] - y) <= 0) return p;
      prev = p;
    }
  }
  return null;
}

function riverStroke(g: Ctx): void {
  g.beginPath();
  g.moveTo(...RIVER_PATH[0][0]);
  for (const [, b, c, d] of RIVER_PATH) g.bezierCurveTo(...b, ...c, ...d);
}

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function tree(g: Ctx, x: number, y: number, r: number, shade = '#3f8a3a'): void {
  g.fillStyle = 'rgba(30, 60, 20, 0.25)';
  g.beginPath();
  g.arc(x + r * 0.25, y + r * 0.3, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = shade;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.18)';
  g.beginPath();
  g.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
  g.fill();
}

/** A house seen from above: a pitched roof, its ridge along the longer side. */
function house(g: Ctx, x: number, y: number, w: number, h: number, colour: string): void {
  g.fillStyle = 'rgba(30, 40, 20, 0.25)';
  g.fillRect(x + 6, y + 8, w, h);
  g.fillStyle = colour;
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(0, 0, 0, 0.18)';
  if (w >= h) g.fillRect(x, y + h / 2, w, h / 2);
  else g.fillRect(x + w / 2, y, w / 2, h);
  g.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  g.lineWidth = 2;
  g.strokeRect(x, y, w, h);
}

function label(g: Ctx, text: string, x: number, y: number, size: number, colour = '#ffffff'): void {
  g.font = `800 ${size}px ui-rounded, 'Nunito', system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = colour;
  g.fillText(text, x, y);
}

function topCar(g: Ctx, x: number, y: number, angle: number, colour: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(g, -27, -12, 58, 28, 8);
  g.fill();
  g.fillStyle = colour;
  roundRect(g, -30, -15, 58, 28, 8);
  g.fill();
  g.fillStyle = '#cfe3f2';
  g.fillRect(-8, -12, 10, 22);
  g.fillRect(10, -12, 7, 22);
  g.restore();
}

function roads(g: Ctx): void {
  const { x0, y0, x1, y1, r } = LOOP;
  const asphalt = '#686b72';
  const draw = (width: number, style: string, dash: number[] = []) => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.lineCap = dash.length ? 'butt' : 'round';
    roundRect(g, x0, y0, x1 - x0, y1 - y0, r);
    g.stroke();
    g.beginPath();
    g.moveTo(STREET_X, y0);
    g.lineTo(STREET_X, ROUNDABOUT.y - ROUNDABOUT.r);
    g.moveTo(STREET_X, ROUNDABOUT.y + ROUNDABOUT.r);
    g.lineTo(STREET_X, y1);
    g.moveTo(x0, STREET_Y);
    g.lineTo(STREET_X, STREET_Y);
    g.stroke();
    g.setLineDash([]);
  };
  draw(ROAD + 24, '#d9d4c8'); // pavements
  draw(ROAD, asphalt);
  // The roundabout: a ring of road round a green island with a tree.
  g.fillStyle = '#d9d4c8';
  g.beginPath();
  g.arc(ROUNDABOUT.x, ROUNDABOUT.y, ROUNDABOUT.r + ROAD / 2 + 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = asphalt;
  g.beginPath();
  g.arc(ROUNDABOUT.x, ROUNDABOUT.y, ROUNDABOUT.r + ROAD / 2, 0, Math.PI * 2);
  g.fill();
  draw(4, '#f4f1e6', [34, 30]); // centre lines
  g.fillStyle = '#f4f1e6';
  g.beginPath();
  g.arc(ROUNDABOUT.x, ROUNDABOUT.y, ROUNDABOUT.r - ROAD / 2 + 8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#7fbf4f';
  g.beginPath();
  g.arc(ROUNDABOUT.x, ROUNDABOUT.y, ROUNDABOUT.r - ROAD / 2, 0, Math.PI * 2);
  g.fill();
  tree(g, ROUNDABOUT.x, ROUNDABOUT.y, 30);
  // Zebra crossings.
  const zebra = (x: number, y: number, across: boolean) => {
    g.fillStyle = '#f4f1e6';
    for (let k = -ROAD / 2 + 10; k < ROAD / 2 - 10; k += 22) {
      if (across) g.fillRect(x + k, y - 22, 12, 44);
      else g.fillRect(x - 22, y + k, 44, 12);
    }
  };
  zebra(1050, y0, true);
  zebra(STREET_X, 470, false);
  zebra(1900, y1, true);
  zebra(x0, 700, false);
  // A few cars about town.
  topCar(g, 800, y0 - 28, 0, '#d8402f');
  topCar(g, 1350, y1 + 28, Math.PI, '#2f6fd6');
  topCar(g, x1 + 28, 820, Math.PI / 2, '#e8b33a');
  topCar(g, STREET_X - 28, 1250, Math.PI / 2, '#3e9b5a');
  topCar(g, 1050, STREET_Y + 28, Math.PI, '#ffffff');
}

/** Wooden bridge rails where the roads cross the river. */
function bridges(g: Ctx): void {
  for (const y of [LOOP.y0, STREET_Y, LOOP.y1]) {
    const at = riverCrossing(y);
    if (!at) continue;
    g.fillStyle = '#8a5a33';
    for (const side of [-1, 1]) g.fillRect(at[0] - RIVER_WIDTH / 2 - 30, y + side * (ROAD / 2 + 6) - 6, RIVER_WIDTH + 60, 12);
    g.fillStyle = '#5e3c22';
    for (const side of [-1, 1]) for (let x = at[0] - RIVER_WIDTH / 2 - 30; x <= at[0] + RIVER_WIDTH / 2 + 30; x += 30) g.fillRect(x - 4, y + side * (ROAD / 2 + 6) - 9, 8, 18);
  }
}

function farm(g: Ctx, rand: () => number): void {
  // Ploughed fields in rows.
  const fields: [number, number, number, number, string, string][] = [
    [720, 250, 260, 170, '#c99a5e', '#b28348'],
    [1000, 250, 230, 170, '#e6c95a', '#d4b443'],
    [720, 440, 260, 130, '#7fb348', '#6aa03a'],
  ];
  for (const [x, y, w, h, a, b] of fields) {
    g.fillStyle = a;
    g.fillRect(x, y, w, h);
    g.fillStyle = b;
    for (let k = 6; k < h; k += 18) g.fillRect(x, y + k, w, 7);
    g.strokeStyle = '#8a5a33';
    g.lineWidth = 4;
    g.strokeRect(x, y, w, h);
  }
  house(g, 1010, 450, 140, 95, '#c8352b');
  label(g, 'FARM', 1080, 498, 30);
  // Sheep in the meadow by the barn.
  for (let i = 0; i < 6; i++) {
    const x = 1270 + rand() * 170;
    const y = 270 + rand() * 260;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x, y, 16, 11, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2b2620';
    g.beginPath();
    g.arc(x + 15, y, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#8a5a33';
  g.lineWidth = 4;
  g.setLineDash([14, 8]);
  g.strokeRect(1255, 255, 200, 300);
  g.setLineDash([]);
}

function school(g: Ctx): void {
  // A football pitch, the school and its playground.
  g.fillStyle = '#5fae46';
  g.fillRect(1650, 245, 300, 190);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 4;
  g.strokeRect(1665, 258, 270, 164);
  g.beginPath();
  g.moveTo(1800, 258);
  g.lineTo(1800, 422);
  g.stroke();
  g.beginPath();
  g.arc(1800, 340, 34, 0, Math.PI * 2);
  g.stroke();
  g.strokeRect(1665, 305, 40, 70);
  g.strokeRect(1895, 305, 40, 70);
  house(g, 1660, 475, 300, 130, '#e8b33a');
  label(g, 'SCHOOL', 1810, 540, 46, '#7a3b10');
  // Hopscotch on the path.
  g.fillStyle = '#ffffff';
  for (let k = 0; k < 5; k++) g.fillRect(1990, 270 + k * 34, 26, 26);
  tree(g, 2120, 300, 40);
  tree(g, 2110, 560, 36, '#2f7a3a');
}

function shops(g: Ctx): void {
  const fronts: [string, string][] = [['SHOP', '#2f6fd6'], ['CAFE', '#e58fb0'], ['POLICE', '#2f4a6b'], ['FIRE', '#c8352b']];
  fronts.forEach(([name, colour], i) => {
    const x = 1650 + (i % 2) * 260;
    const y = 930 + Math.floor(i / 2) * 175;
    house(g, x, y, 230, 120, colour);
    label(g, name, x + 115, y + 60, 38);
  });
  // Parking behind the shops.
  g.fillStyle = '#7b7e85';
  g.fillRect(1650, 1290, 500, 80);
  g.fillStyle = '#ffffff';
  for (let x = 1660; x < 2150; x += 62) g.fillRect(x, 1290, 4, 50);
  ['#d8402f', '#e8b33a', '#2f6fd6', '#ffffff', '#3e9b5a'].forEach((c, i) => topCar(g, 1694 + i * 124, 1318, Math.PI / 2, c));
}

function homes(g: Ctx, rand: () => number): void {
  const roofs = ['#c8352b', '#2f4a6b', '#e07a2b', '#8a5a33', '#3e9b5a'];
  // A row along the cross street, and a pond in the park beside it.
  for (let i = 0; i < 6; i++) {
    const x = 760 + i * 120;
    if (x > 1480) break;
    house(g, x, 1180, 90, 75, roofs[i % roofs.length]);
    g.fillStyle = '#a9d57a';
    g.fillRect(x, 1262, 90, 60);
    if (rand() < 0.7) tree(g, x + 70, 1300, 18);
  }
  // Houses round the outside of the loop.
  for (let x = 330; x < 2100; x += 170) {
    if (Math.abs(x - 430) < 90) continue;
    house(g, x, 40, 95, 70, roofs[Math.floor(rand() * roofs.length)]);
  }
  for (let y = 380; y < 1100; y += 160) house(g, 2290, y, 70, 95, roofs[Math.floor(rand() * roofs.length)]);
}

function pond(g: Ctx, rand: () => number): void {
  const cx = 1080;
  const cy = 700;
  g.fillStyle = '#c9b183';
  g.beginPath();
  g.ellipse(cx, cy, 175, 110, -0.2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#4a93bf';
  g.beginPath();
  g.ellipse(cx, cy, 160, 96, -0.2, 0, Math.PI * 2);
  g.fill();
  waves(g, cx - 140, cy - 70, 280, 140, rand, 18);
  // Lily pads and ducks.
  g.fillStyle = '#3e9b5a';
  for (const [x, y] of [[1000, 660], [1150, 740], [1040, 760]]) {
    g.beginPath();
    g.arc(x, y, 14, 0.3, Math.PI * 2);
    g.lineTo(x, y);
    g.fill();
  }
  for (const [x, y] of [[1110, 650], [1150, 668], [1190, 690]]) {
    g.fillStyle = '#f2c94c';
    g.beginPath();
    g.ellipse(x, y, 13, 9, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(x + 11, y - 4, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e07a2b';
    g.fillRect(x + 16, y - 5, 6, 3);
  }
  for (const [x, y] of [[880, 630], [900, 790], [1270, 640], [1250, 800]]) tree(g, x, y, 34);
}

function waves(g: Ctx, x: number, y: number, w: number, h: number, rand: () => number, n: number): void {
  g.strokeStyle = 'rgba(220, 240, 255, 0.7)';
  g.lineWidth = 3;
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const px = x + rand() * w;
    const py = y + rand() * h;
    g.beginPath();
    g.moveTo(px, py);
    g.quadraticCurveTo(px + 9, py - 6, px + 18, py);
    g.quadraticCurveTo(px + 27, py + 6, px + 36, py);
    g.stroke();
  }
}

function seaside(g: Ctx, rand: () => number): void {
  g.fillStyle = '#ecd9a6';
  g.beginPath();
  g.moveTo(1640, 1620);
  g.bezierCurveTo(1800, 1500, 2150, 1500, 2420, 1300);
  g.lineTo(2420, 1620);
  g.fill();
  g.fillStyle = '#3f8fc4';
  g.beginPath();
  g.moveTo(1830, 1620);
  g.bezierCurveTo(1950, 1560, 2200, 1560, 2420, 1440);
  g.lineTo(2420, 1620);
  g.fill();
  waves(g, 1950, 1540, 450, 60, rand, 14);
  // A sailing boat, and beach towels.
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(2260, 1500);
  g.lineTo(2300, 1555);
  g.lineTo(2220, 1555);
  g.fill();
  g.fillStyle = '#c8352b';
  roundRect(g, 2210, 1555, 100, 18, 9);
  g.fill();
  [['#e58fb0', 1760, 1560], ['#2f6fd6', 1900, 1520], ['#e8b33a', 2050, 1480]].forEach(([c, x, y]) => {
    g.fillStyle = c as string;
    g.fillRect(x as number, y as number, 60, 30);
  });
}

function heliport(g: Ctx): void {
  g.fillStyle = '#7b7e85';
  g.beginPath();
  g.arc(2310, 1230, 70, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(2310, 1230, 58, 0, Math.PI * 2);
  g.stroke();
  label(g, 'H', 2310, 1233, 64);
}

/** The whole print, ready to use as a texture. */
export function playmatCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(PLAYMAT.width * PX);
  c.height = Math.round(PLAYMAT.depth * PX);
  const g = c.getContext('2d')!;
  g.scale(PX, PX);
  const rand = random(77);

  // Grass, with soft lighter and darker patches.
  g.fillStyle = '#8dc85a';
  g.fillRect(0, 0, PLAYMAT.width, PLAYMAT.depth);
  for (let i = 0; i < 40; i++) {
    const x = rand() * PLAYMAT.width;
    const y = rand() * PLAYMAT.depth;
    const r = 80 + rand() * 160;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rand() < 0.5 ? 'rgba(180, 220, 120, 0.35)' : 'rgba(90, 150, 60, 0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  seaside(g, rand);
  farm(g, rand);
  pond(g, rand);
  school(g);
  shops(g);

  // The river, under the roads.
  g.lineCap = 'round';
  g.lineJoin = 'round';
  riverStroke(g);
  g.strokeStyle = '#c9b183';
  g.lineWidth = RIVER_WIDTH + 22;
  g.stroke();
  riverStroke(g);
  g.strokeStyle = '#4a93bf';
  g.lineWidth = RIVER_WIDTH;
  g.stroke();
  for (const seg of RIVER_PATH) {
    for (let t = 0.05; t < 1; t += 0.12) {
      const [x, y] = bez(seg, t);
      waves(g, x - 25, y - 20, 30, 40, rand, 1);
    }
  }

  roads(g);
  bridges(g);
  homes(g, rand);
  heliport(g);

  // Trees dotted about, clear of the roads and buildings.
  for (const [x, y, r] of [[90, 300, 40], [80, 520, 34], [100, 900, 44], [70, 1180, 36], [110, 1450, 40], [1500, 60, 34], [2340, 120, 42], [2330, 300, 34], [760, 1520, 40], [1000, 1530, 34], [1250, 1510, 44], [1460, 1540, 34], [400, 1000, 30], [260, 820, 32], [1400, 900, 34], [790, 950, 30]] as [number, number, number][]) {
    tree(g, x, y, r, rand() < 0.5 ? '#3f8a3a' : '#2f7a3a');
  }

  // A stitched border, like the binding on a real mat.
  g.strokeStyle = '#2f4a6b';
  g.lineWidth = 36;
  g.strokeRect(0, 0, PLAYMAT.width, PLAYMAT.depth);
  g.strokeStyle = '#e8b33a';
  g.lineWidth = 3;
  g.setLineDash([12, 8]);
  g.strokeRect(24, 24, PLAYMAT.width - 48, PLAYMAT.depth - 48);
  g.setLineDash([]);
  return c;
}
