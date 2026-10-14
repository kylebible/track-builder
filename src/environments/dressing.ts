import { LAKE, lakeShore, PLAYMAT, RIVER, riverCentre, RUG, TABLE, TOWN } from './environments';
import * as P from './props';

// What each scene has in it besides the ground: trees, houses, boats,
// snowmen. Everything is laid out once from a fixed seed, so a scene looks
// the same every visit. The middle of each scene is left clear, because
// that's where layouts start; props fill in round it.

/** The clear middle, plan mm: an oval this wide (x) and deep (y). */
const CLEAR = { x: 1150, y: 850 };
const inClear = (x: number, y: number, margin = 0) => (x / (CLEAR.x + margin)) ** 2 + (y / (CLEAR.y + margin)) ** 2 < 1;

/** Far enough out that the fog has them. */
const FAR = 4300;

const nearRiver = (x: number, y: number, margin: number) => Math.abs(y - riverCentre(x)) < RIVER.width / 2 + margin;

function lakeMargin(x: number, y: number, margin: number): boolean {
  const dx = x - LAKE.x;
  const dy = y - LAKE.y;
  const a = Math.atan2(dy / LAKE.ry, dx / LAKE.rx);
  const r = lakeShore(a);
  return Math.hypot(dx / (LAKE.rx * r + margin), dy / (LAKE.ry * r + margin)) < 1;
}

/** Trees, bushes and flowers over a ring, avoiding the clear middle and anything `ok` rules out. */
function meadow(props: P.Props, rand: () => number, ok: (x: number, y: number) => boolean, snowy = false): void {
  const pines = snowy ? 0.8 : 0.4;
  for (const s of P.scatter(rand, 170, 950, FAR, 140, ok, 1.8)) props.add(rand() < pines ? P.pineTree(rand, snowy) : P.roundTree(rand, snowy), s.x, s.y, rand() * 6);
  if (snowy) return;
  for (const s of P.scatter(rand, 90, 950, FAR * 0.8, 100, ok, 1.8)) props.add(P.bush(rand), s.x, s.y, rand() * 6);
  for (const s of P.scatter(rand, 110, 950, FAR * 0.7, 90, ok, 1.8)) props.add(P.flowers(rand), s.x, s.y, rand() * 6);
  for (const s of P.scatter(rand, 25, 950, FAR, 180, ok, 1.5)) props.add(P.rock(rand), s.x, s.y);
}

/** A little flock grazing round (x, y). */
function flock(props: P.Props, rand: () => number, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) props.add(P.sheep(rand), x + (rand() - 0.5) * 500, y + (rand() - 0.5) * 360);
}

export function dressGrass() {
  const rand = P.random(101);
  const props = new P.Props();
  const free = (x: number, y: number) => !inClear(x, y) && Math.hypot(x - 2100, y - 1500) > 450 && Math.hypot(x + 2300, y - 1700) > 500;
  meadow(props, rand, free);
  props.add(P.playground(), 2000, 1500, Math.PI);
  props.add(P.bench(), 1750, 1250, Math.PI).add(P.bench(), 2350, 1250, Math.PI);
  flock(props, rand, -2300, 1700, 7);
  props.add(P.barn(), -2650, 2150, 0);
  return props.bake();
}

export function dressRiver() {
  const rand = P.random(202);
  const props = new P.Props();
  const dry = (x: number, y: number) => !inClear(x, y) && !nearRiver(x, y, 90) && Math.hypot(x - 2300, y - 1900) > 450 && Math.hypot(x + 2400, y + 1600) > 650;
  meadow(props, rand, dry);
  // Reeds along both banks, away from the middle.
  for (let x = -FAR; x < FAR; x += 90 + rand() * 220) {
    if (Math.abs(x) < CLEAR.x + 200) continue;
    const side = rand() < 0.5 ? -1 : 1;
    props.add(P.reeds(rand), x, riverCentre(x) + side * (RIVER.width / 2 + 25));
  }
  for (const x of [-2300, 2600, -3600]) props.add(P.rowingBoat(rand), x, riverCentre(x) + (rand() - 0.5) * 80, 0.3, -6);
  for (let i = 0; i < 5; i++) {
    const x = -1700 + i * 45 + rand() * 30;
    props.add(P.duck(rand), x, riverCentre(x) - 60 + rand() * 120, 0, -6);
  }
  props.add(P.windmill(), 2300, 1900, Math.PI);
  props.add(P.barn(), -2550, -1500, 0);
  flock(props, rand, -2300, -2000, 8);
  return props.bake();
}

export function dressLake() {
  const rand = P.random(303);
  const props = new P.Props();
  const beach = (x: number, y: number) => !inClear(x, y) && !lakeMargin(x, y, 120);
  for (const s of P.scatter(rand, 70, 1000, FAR, 220, beach, 1.8)) props.add(P.palmTree(rand), s.x, s.y, rand() * 6);
  for (const s of P.scatter(rand, 20, 1000, FAR, 200, beach, 1.5)) props.add(P.rock(rand), s.x, s.y);
  // A row of beach huts to the north.
  const huts = P.random(9);
  for (let k = -5; k <= 5; k++) props.add(P.house(huts), k * 170, 1500, Math.PI);
  // Umbrellas and towels along the shore, outside the clear middle.
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = lakeShore(a) + 0.32;
    const x = LAKE.x + LAKE.rx * r * Math.cos(a);
    const y = LAKE.y + LAKE.ry * r * Math.sin(a);
    if (inClear(x, y, 150) || rand() < 0.45) continue;
    props.add(rand() < 0.7 ? P.umbrella(rand) : P.sandcastle(), x, y, rand() * 6);
  }
  for (const s of P.scatter(rand, 6, 1000, 2600, 300, beach)) props.add(rand() < 0.5 ? P.beachBall(rand) : P.sandcastle(), s.x, s.y);
  for (const [dx, dy] of [[0.25, 0.3], [-0.2, -0.35], [0.45, -0.2]]) props.add(P.sailboat(rand), LAKE.x + dx * LAKE.rx, LAKE.y + dy * LAKE.ry, rand() * 6, -6);
  props.add(P.rowingBoat(rand), LAKE.x + 0.1 * LAKE.rx, LAKE.y - 0.05 * LAKE.ry, 1, -6);
  for (let i = 0; i < 4; i++) props.add(P.duck(rand), LAKE.x - 0.3 * LAKE.rx + i * 40, LAKE.y + 0.5 * LAKE.ry + rand() * 30, 0, -6);
  // A jetty out from the east shore, and a lifeguard watching.
  const east = LAKE.x + LAKE.rx * lakeShore(0);
  props.add(P.jetty(260), east + 80, LAKE.y, Math.PI);
  props.add(P.lifeguardTower(), LAKE.x + 0.3 * LAKE.rx, LAKE.y + LAKE.ry * lakeShore(Math.PI / 2) + 260, Math.PI);
  return props.bake();
}

export function dressSnow() {
  const rand = P.random(404);
  const props = new P.Props();
  const pond = { x: -2300, y: -1500 };
  const free = (x: number, y: number) => !inClear(x, y) && Math.hypot((x - pond.x) / 1.5, y - pond.y) > 330 && Math.hypot(x - 2400, y - 1700) > 400;
  meadow(props, rand, free, true);
  for (const s of P.scatter(rand, 25, 1000, FAR, 220, free, 1.5)) props.add(P.rock(rand, true), s.x, s.y);
  for (const s of P.scatter(rand, 12, 1050, 3000, 350, free, 1.5)) props.add(P.snowman(rand), s.x, s.y, rand() * 6);
  props.add(P.icePond(420, 260), pond.x, pond.y, 0, 0.3);
  for (const [x, y, a] of [[2400, 1700, Math.PI], [2750, 1350, Math.PI * 0.8], [-1900, 2100, Math.PI * 1.1]]) props.add(P.cabin(), x, y, a);
  for (const [x, y, a] of [[2150, 1350, 0.4], [-2050, -1250, 1.2], [-2500, -1350, 2.4]]) props.add(P.sled(), x, y, a);
  const village = P.random(13);
  for (let k = 0; k < 6; k++) props.add(P.house(village, true), -2600 + k * 190, 1700 + (k % 2) * 60, Math.PI);
  return props.bake();
}

/** Town blocks are centred on multiples of the block size, plan mm. */
const blockCentre = (i: number) => i * TOWN.block;
/** Half the lawn inside a block, short of the pavement. */
const LOT = TOWN.block / 2 - TOWN.road / 2 - TOWN.pavement - 30;

export function dressTown() {
  const rand = P.random(505);
  const props = new P.Props();
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const cx = blockCentre(i);
      const cy = blockCentre(j);
      const ring = Math.max(Math.abs(i), Math.abs(j));
      if (ring === 0) {
        // The middle block stays clear for building; trees in its corners.
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) props.add(P.roundTree(rand), cx + sx * (LOT - 30), cy + sy * (LOT - 30));
      } else if (ring === 1) {
        park(props, rand, cx, cy, i === 1 && j === 1);
      } else {
        const kind = rand();
        if (kind < 0.45) housesBlock(props, rand, cx, cy);
        else if (kind < 0.75) shopsBlock(props, rand, cx, cy);
        else if (kind < 0.9) parkingBlock(props, rand, cx, cy);
        else park(props, rand, cx, cy, false);
      }
    }
  }
  // Street lamps along every pavement.
  const kerb = TOWN.road / 2 + TOWN.pavement / 2;
  for (let k = -3; k <= 2; k++) {
    const street = blockCentre(k) + TOWN.block / 2;
    for (let d = -4500; d <= 4500; d += 375) {
      if (Math.abs(((d % TOWN.block) + TOWN.block) % TOWN.block - TOWN.block / 2) < 250) continue;
      props.add(P.lamppost(), street + kerb, d).add(P.lamppost(), d, street - kerb);
    }
  }
  // A bus and a few cars out on the far streets.
  props.add(P.bus(), -2250 + 50, -3000, Math.PI / 2);
  for (const [x, y, a] of [[2250 + 50, 2600, Math.PI / 2], [-3000, 2250 - 50, 0], [3400, -2250 + 50, Math.PI], [-2250 - 50, 3300, -Math.PI / 2]]) props.add(P.car(rand), x, y, a);
  return props.bake();
}

/** Houses round the edge of a block, facing the streets, with garden trees. */
function housesBlock(props: P.Props, rand: () => number, cx: number, cy: number): void {
  const edge = LOT - 70;
  for (const along of [-390, -130, 130, 390]) {
    props.add(P.house(rand), cx + along, cy - edge, 0);
    props.add(P.house(rand), cx + along, cy + edge, Math.PI);
    if (Math.abs(along) < 300) {
      props.add(P.house(rand), cx + edge, cy + along, Math.PI / 2);
      props.add(P.house(rand), cx - edge, cy + along, -Math.PI / 2);
    }
  }
  for (const s of P.scatter(rand, 6, 0, 260, 120)) props.add(P.roundTree(rand), cx + s.x, cy + s.y);
}

function shopsBlock(props: P.Props, rand: () => number, cx: number, cy: number): void {
  const edge = LOT - 60;
  for (const along of [-300, 0, 300]) {
    props.add(P.shop(rand), cx + along, cy - edge, 0);
    props.add(P.shop(rand), cx + along, cy + edge, Math.PI);
  }
  props.add(P.flats(rand), cx - 250, cy, -Math.PI / 2).add(P.flats(rand), cx + 250, cy, Math.PI / 2);
}

function parkingBlock(props: P.Props, rand: () => number, cx: number, cy: number): void {
  for (let row = -1; row <= 1; row += 2) {
    for (let k = -4; k <= 4; k++) {
      if (rand() < 0.35) continue;
      props.add(P.car(rand), cx + k * 110, cy + row * 200, row > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) props.add(P.roundTree(rand), cx + sx * (LOT - 30), cy + sy * (LOT - 30));
}

/** A park: trees round the edge, flower beds, benches, maybe a playground. */
function park(props: P.Props, rand: () => number, cx: number, cy: number, playground: boolean): void {
  for (let k = -2; k <= 2; k++) {
    for (const [x, y] of [[k * 230, -LOT + 40], [k * 230, LOT - 40], [-LOT + 40, k * 230], [LOT - 40, k * 230]]) {
      if (rand() < 0.3) continue;
      props.add(rand() < 0.3 ? P.pineTree(rand) : P.roundTree(rand), cx + x, cy + y);
    }
  }
  for (const s of P.scatter(rand, 5, 80, 300, 120)) props.add(P.flowers(rand), cx + s.x, cy + s.y);
  props.add(P.bench(), cx - 150, cy + 220, Math.PI).add(P.bench(), cx + 150, cy - 220, 0);
  if (playground) props.add(P.playground(), cx - 60, cy, 0);
}

/** Toys left out round the room, on the floor `floor` mm below the track. */
export function dressRoom(floor: number, keepOut: { width: number; depth: number }) {
  const rand = P.random(606);
  const props = new P.Props();
  const out = (x: number, y: number) => Math.abs(x) > keepOut.width / 2 + 150 || Math.abs(y) > keepOut.depth / 2 + 150;
  props.add(P.toyBox(), -keepOut.width / 2 - 600, keepOut.depth / 2 + 500, 0.4, floor);
  for (const s of P.scatter(rand, 5, 900, 2600, 400, out)) props.add(P.toyBlocks(rand), s.x, s.y, rand() * 6, floor);
  props.add(P.beachBall(rand), keepOut.width / 2 + 400, -keepOut.depth / 2 - 300, 0, floor);
  return props.bake();
}

export const ROOM_KEEP_OUT = {
  table: { width: TABLE.width + 200, depth: TABLE.depth + 200 },
  rug: { width: RUG.width, depth: RUG.depth },
  playmat: { width: PLAYMAT.width, depth: PLAYMAT.depth },
  floor: { width: 2400, depth: 1800 },
};

