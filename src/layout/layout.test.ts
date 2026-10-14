import { describe, expect, it } from 'vitest';
import { jointError } from '../geometry/joint';
import { deg, IDENTITY, type Pose } from '../geometry/pose';
import { LEVEL_HEIGHT } from '../pieces/dimensions';
import { History } from './history';
import {
  addPiece,
  canExtend,
  dragContext,
  EMPTY_LAYOUT,
  extendFrom,
  findJoints,
  findSeat,
  findSnap,
  flipPiece,
  mirrorPieces,
  openEnds,
  raisePieces,
  removePieces,
  rotatePieces,
  sectionOf,
  swapEnd,
  transformPieces,
  worldEnd,
  type EndRef,
  type Layout,
} from './layout';

/** Keep adding pieces from the open end the last one left. */
function build(start: string, rest: (string | [string, 'flipped'])[]): { layout: Layout; uids: string[]; end: EndRef | null } {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, start, IDENTITY);
  const uids = [uid];
  let end: EndRef | null = { uid, connectorId: 'b' };
  for (const item of rest) {
    const [id, flipped] = typeof item === 'string' ? [item, false] : [item[0], true];
    const ext = extendFrom(layout, end!, id, flipped);
    if (!ext) throw new Error(`could not add ${id}`);
    ({ layout } = ext);
    uids.push(ext.uid);
    end = ext.next;
  }
  return { layout, uids, end };
}

const curves = (n: number) => Array<string>(n).fill('curve-large');

describe('extending from an open end', () => {
  it('eight curves laid end to end close a circle with no open ends', () => {
    const { layout, end } = build('curve-large', curves(7));
    expect(openEnds(layout)).toHaveLength(0);
    expect(findJoints(layout)).toHaveLength(8);
    expect(end).toBeNull();
  });

  it('attaches peg into hole and continues from the far end', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'curve-large')!;
    expect(ext.attached).toBe('a');
    expect(ext.next).toEqual({ uid: ext.uid, connectorId: 'b' });
    const placed = worldEnd(ext.layout, { uid: ext.uid, connectorId: 'a' }).connector.pose;
    expect(placed.x).toBeCloseTo(144, 9);
  });

  it('attaches by the peg end when extending from a hole', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'a' }, 'straight-short')!;
    expect(ext.attached).toBe('b');
    expect(ext.next).toEqual({ uid: ext.uid, connectorId: 'a' });
  });

  it('refuses a piece with no end that fits', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const peg = { uid: 'p1', connectorId: 'b' };
    expect(canExtend(layout, peg, 'straight-medium-pp')).toBe(false);
    expect(extendFrom(layout, peg, 'straight-medium-pp')).toBeNull();
  });

  it('lays an oval with a siding', () => {
    // Oval: four curves, a curved switch on the straight, four curves and a
    // medium straight. The switch is flipped so its branch leaves the oval
    // on the outside; the siding straightens out and ends at a buffer stop.
    const oval = build('curve-large', [...curves(3), ['switch-curved', 'flipped'], ...curves(4), 'straight-medium']);
    const switchUid = oval.uids[4];
    let layout = oval.layout;
    expect(openEnds(layout).map((e) => `${e.uid}:${e.connectorId}`)).toEqual([`${switchUid}:branch1`]);

    for (const id of ['curve-large', 'straight-long', 'buffer']) {
      const from = openEnds(layout)[0];
      layout = extendFrom(layout, from, id)!.layout;
    }
    expect(openEnds(layout)).toHaveLength(0);
    expect(layout.pieces).toHaveLength(13);

    // The switch sits on the far straight (y = two curve radii, running
    // toward -x); the siding runs parallel to it, outside the oval.
    const buffer = layout.pieces.at(-1)!;
    expect(Math.abs(buffer.pose.angle)).toBeCloseTo(Math.PI, 9);
    expect(buffer.pose.y).toBeGreaterThan(2 * 202 + 40);
  });
});

describe('flip, swap, rotate, delete', () => {
  it('flipping a just-added curve turns it the other way, keeping its joint', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'curve-large')!;
    const before = worldEnd(ext.layout, { uid: ext.uid, connectorId: 'b' }).connector.pose;
    const flipped = flipPiece(ext.layout, ext.uid);
    const after = worldEnd(flipped, { uid: ext.uid, connectorId: 'b' }).connector.pose;
    expect(before.y).toBeGreaterThan(0);
    expect(after.y).toBeCloseTo(-before.y, 9);
    expect(findJoints(flipped)).toHaveLength(1);
    expect(flipPiece(flipped, ext.uid).pieces).toEqual(ext.layout.pieces.map((p) => expect.objectContaining(p)));
  });

  it('a switch added onto a hole merges by a branch, and swapping picks the other branch', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium-hh', IDENTITY);
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'switch-curved')!;
    expect(ext.attached).toBe('branch0');
    const swapped = swapEnd(ext.layout, ext.uid)!;
    expect(findJoints(swapped)).toEqual([
      { a: { uid: 'p1', connectorId: 'b' }, b: { uid: ext.uid, connectorId: 'branch1' } },
    ]);
    expect(findJoints(swapEnd(swapped, ext.uid)!)).toEqual(findJoints(ext.layout));
  });

  it('a peg-and-hole straight has no other way round', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'straight-short')!;
    expect(swapEnd(ext.layout, ext.uid)).toBeNull();
  });

  it('rotating a section a full turn in eighths brings it back', () => {
    const { layout, uids } = build('straight-long', ['curve-large', 'curve-large']);
    const all = new Set(uids);
    let turned = layout;
    for (let i = 0; i < 8; i++) turned = rotatePieces(turned, all, deg(45), { x: 50, y: 20 });
    turned.pieces.forEach((p, i) => {
      expect(p.pose.x).toBeCloseTo(layout.pieces[i].pose.x, 6);
      expect(p.pose.y).toBeCloseTo(layout.pieces[i].pose.y, 6);
    });
    expect(findJoints(turned)).toHaveLength(2);
  });

  it('flipping a whole section mirrors it and keeps it joined', () => {
    const { layout, uids } = build('straight-long', ['curve-large', 'curve-large', 'switch-curved']);
    const mirrored = mirrorPieces(layout, new Set(uids));
    expect(findJoints(mirrored)).toHaveLength(3);
    // The curves now turn right: the end of the run is below where it started.
    const last = worldEnd(mirrored, { uid: uids[3], connectorId: 'branch0' }).connector.pose;
    const lastBefore = worldEnd(layout, { uid: uids[3], connectorId: 'branch0' }).connector.pose;
    expect(last.angle).toBeCloseTo(-lastBefore.angle, 9);
  });

  it('deleting a middle piece splits the section', () => {
    const { layout, uids } = build('straight-long', ['straight-long', 'straight-long']);
    expect(sectionOf(layout, uids[0]).size).toBe(3);
    const split = removePieces(layout, new Set([uids[1]]));
    expect(sectionOf(split, uids[0])).toEqual(new Set([uids[0]]));
    expect(openEnds(split)).toHaveLength(4);
  });
});

describe('snapping while dragging', () => {
  const twoPieces = (): Layout => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    ({ layout } = addPiece(layout, 'straight-medium', { x: 400, y: 0, angle: 0 }));
    return layout;
  };
  const moving = new Set(['p2']);

  it('pulls a nearby hole onto a peg and seats it exactly', () => {
    const layout = twoPieces();
    // Drag p2 so its hole lands 12 mm short and 10 degrees off the peg at x=144.
    const drag: Pose = { x: 144 + 12 - 400, y: 8, angle: 0 };
    const tilted = rotatePieces(transformPieces(layout, moving, drag), moving, deg(10), { x: 156, y: 8 });
    const context = dragContext(tilted, moving);
    const snap = findSnap(context, IDENTITY)!;
    expect(snap).toEqual(expect.objectContaining({ moving: expect.objectContaining({ connectorId: 'a' }) }));
    const seated = transformPieces(tilted, moving, snap.transform);
    const joint = jointError(
      worldEnd(seated, { uid: 'p1', connectorId: 'b' }).connector.pose,
      worldEnd(seated, { uid: 'p2', connectorId: 'a' }).connector.pose,
    );
    expect(joint.gapMm).toBeLessThan(1e-9);
    expect(joint.angleDeg).toBeLessThan(1e-9);
  });

  it('does not snap from far away or peg to peg', () => {
    const layout = twoPieces();
    expect(findSnap(dragContext(layout, moving), { x: -200, y: 0, angle: 0 })).toBeNull();
    // Turned end for end and dragged up, p2's peg meets p1's peg head on.
    const reversed = rotatePieces(layout, moving, deg(180));
    expect(findSnap(dragContext(reversed, moving), { x: 144 - 400, y: 0, angle: 0 })).toBeNull();
  });

  it('closing a loop by dragging joins both ends that meet', () => {
    // Two half circles, dragged together: one end snaps, the other lands
    // within play and joins too.
    const half = build('curve-large', curves(3)).layout;
    let layout = half;
    for (const p of half.pieces) layout = addPiece(layout, p.pieceId, p.pose).layout;
    const second = new Set(['p5', 'p6', 'p7', 'p8']);
    // Rotate the copy half a turn about the circle's center, then nudge it off.
    const center = { x: 0, y: 202 };
    layout = rotatePieces(layout, second, deg(180), center);
    layout = transformPieces(layout, second, { x: 9, y: -6, angle: 0 });
    expect(openEnds(layout)).toHaveLength(4);
    const snap = findSnap(dragContext(layout, second), IDENTITY)!;
    const closed = transformPieces(layout, second, snap.transform);
    expect(openEnds(closed)).toHaveLength(0);
  });
});

describe('scenery', () => {
  it('never joins anything and rotates and flips where it stands', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    ({ layout } = addPiece(layout, 'cottage', { x: 72, y: 0, angle: 0 }));
    expect(findJoints(layout)).toHaveLength(0);
    expect(openEnds(layout)).toHaveLength(2);
    const turned = rotatePieces(layout, new Set(['p2']), deg(45));
    expect(turned.pieces[1].pose).toEqual(expect.objectContaining({ x: 72, y: 0 }));
    const flipped = flipPiece(layout, 'p2');
    expect(flipped.pieces[1]).toEqual(expect.objectContaining({ flipped: true, pose: layout.pieces[1].pose }));
  });

  it('seats a tunnel over the middle of a nearby straight, lined up with it', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', { x: 0, y: 0, angle: deg(45) });
    ({ layout } = addPiece(layout, 'tunnel', { x: 0, y: 0, angle: deg(-130) }));
    const mid = { x: 72 * Math.cos(deg(45)), y: 72 * Math.sin(deg(45)) };
    const seat = findSeat(layout, 'p2', { x: mid.x + 10, y: mid.y - 8, angle: 0 })!;
    const pose = transformPieces(layout, new Set(['p2']), seat.transform).pieces[1].pose;
    expect(pose.x).toBeCloseTo(mid.x, 9);
    expect(pose.y).toBeCloseTo(mid.y, 9);
    // It was turned nearer the track's backward heading, so it stays that way round.
    expect(pose.angle).toBeCloseTo(deg(-135), 9);
    expect(findSeat(layout, 'p2', { x: 300, y: 0, angle: 0 })).toBeNull();
  });

  it('seats a tunnel on raised track at its level, and a pier only under raised track', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    ({ layout } = addPiece(layout, 'tunnel', { x: 200, y: 200, angle: 0 }));
    ({ layout } = addPiece(layout, 'bridge-pier', { x: 200, y: 200, angle: 0 }));
    const near = { x: 72 - 200, y: -200, angle: 0 };
    expect(findSeat(layout, 'p2', near)!.dz).toBe(0);
    expect(findSeat(layout, 'p3', near)).toBeNull();
    const raised = raisePieces(layout, new Set(['p1']), LEVEL_HEIGHT)!;
    expect(findSeat(raised, 'p2', near)!.dz).toBe(LEVEL_HEIGHT);
    expect(findSeat(raised, 'p3', near)!.dz).toBe(0);
  });

  it("doesn't seat scenery that stands beside the track", () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    ({ layout } = addPiece(layout, 'leafy-tree', { x: 72, y: 5, angle: 0 }));
    expect(findSeat(layout, 'p2', IDENTITY)).toBeNull();
  });
});

describe('history', () => {
  it('undoes and redoes', () => {
    const h = new History(EMPTY_LAYOUT);
    const one = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    h.push(one);
    expect(h.undo()).toBe(EMPTY_LAYOUT);
    expect(h.redo()).toBe(one);
    h.undo();
    h.push(addPiece(EMPTY_LAYOUT, 'curve-large', IDENTITY).layout);
    expect(h.canRedo).toBe(false);
  });
});
