import { describe, expect, it } from 'vitest';
import { canMate, DEFAULT_PLAY, jointError } from '../geometry/joint';
import { applyPose, deg, IDENTITY, rotationAbout, type Vec2 } from '../geometry/pose';
import { flexContext, flexDrag, UNCLIP_MM } from './flex';
import { addPiece, EMPTY_LAYOUT, extendFrom, findJoints, openEnds, worldEnd, worldEnds, type EndRef, type Extension, type Layout } from './layout';

/** Keep adding pieces from the open end the last one left. */
function build(start: string, rest: string[]): { layout: Layout; uids: string[] } {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, start, IDENTITY);
  const uids = [uid];
  let end: EndRef | null = { uid, connectorId: 'b' };
  for (const id of rest) {
    const ext: Extension = extendFrom(layout, end!, id)!;
    layout = ext.layout;
    uids.push(ext.uid);
    end = ext.next;
  }
  return { layout, uids };
}

const middle = (layout: Layout, uid: string): Vec2 => {
  const ends = worldEnds(layout.pieces.find((p) => p.uid === uid)!).map((e) => e.connector.pose);
  return { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 };
};

/** Every joint the flexed layout should still have, still within play. */
function expectJointsHeld(before: Layout, after: Layout): void {
  for (const j of findJoints(before)) {
    expect(canMate(worldEnd(after, j.a).connector, worldEnd(after, j.b).connector)).toBe(true);
  }
}

describe('flexing joints while dragging', () => {
  it('pieces with no joints have nothing to flex', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    expect(flexContext(layout, new Set(['p1']), { x: 72, y: 0 })).toBeNull();
  });

  it('pulling the end of a straight run gives only the joints play, then stops', () => {
    const { layout } = build('straight-medium', ['straight-medium', 'straight-medium']);
    const grab = middle(layout, 'p3');
    const context = flexContext(layout, new Set(['p3']), grab)!;
    const flexed = flexDrag(context, { x: grab.x + 15, y: grab.y })!;
    const moved = middle(flexed.layout, 'p3').x - grab.x;
    // Two joints, each opening by at most the play.
    expect(moved).toBeGreaterThan(DEFAULT_PLAY.mm);
    expect(moved).toBeLessThanOrEqual(2 * DEFAULT_PLAY.mm);
    expect(flexed.atLimit.length).toBeGreaterThan(0);
    expectJointsHeld(layout, flexed.layout);
    // The far end holds still.
    expect(flexed.layout.pieces[0].pose).toEqual(layout.pieces[0].pose);
  });

  it('swings sideways further, since a little angle at each joint adds up', () => {
    const { layout } = build('straight-medium', ['straight-medium', 'straight-medium']);
    const grab = worldEnd(layout, { uid: 'p3', connectorId: 'b' }).connector.pose;
    const context = flexContext(layout, new Set(['p3']), grab)!;
    const flexed = flexDrag(context, { x: grab.x, y: grab.y + 20 })!;
    const tip = worldEnd(flexed.layout, { uid: 'p3', connectorId: 'b' }).connector.pose;
    expect(tip.y).toBeGreaterThan(8);
    expectJointsHeld(layout, flexed.layout);
  });

  it('unclips when pulled well past the limit', () => {
    const { layout } = build('straight-medium', ['straight-medium', 'straight-medium']);
    const grab = middle(layout, 'p3');
    const context = flexContext(layout, new Set(['p3']), grab)!;
    expect(flexDrag(context, { x: grab.x + UNCLIP_MM + 10, y: grab.y })).toBeNull();
  });

  it('nudges a loop that nearly meets until it closes', () => {
    // A circle of eight curves with the last three turned out by 1.8
    // degrees at one joint: every joint is within play except the last,
    // which misses by several mm.
    const circle = build('curve-large', Array<string>(7).fill('curve-large')).layout;
    const pivot = worldEnd(circle, { uid: 'p6', connectorId: 'a' }).connector.pose;
    const turn = rotationAbout(pivot, deg(-1.8));
    let layout: Layout = {
      pieces: circle.pieces.map((p) => (['p6', 'p7', 'p8'].includes(p.uid) ? { ...p, pose: applyPose(turn, p.pose) } : p)),
    };
    const miss = jointError(
      worldEnd(layout, { uid: 'p1', connectorId: 'a' }).connector.pose,
      worldEnd(layout, { uid: 'p8', connectorId: 'b' }).connector.pose,
    );
    expect(miss.gapMm).toBeGreaterThan(5);
    expect(openEnds(layout)).toHaveLength(2);

    const grab = middle(layout, 'p8');
    const context = flexContext(layout, new Set(['p8']), grab)!;
    const flexed = flexDrag(context, { x: grab.x + 2, y: grab.y - 2 })!;
    expect(flexed.closed).not.toBeNull();
    layout = flexed.layout;
    expect(openEnds(layout)).toHaveLength(0);
    expect(findJoints(layout)).toHaveLength(8);
  });

  it('closes an oval whose sides come up 18 mm short', () => {
    // A long straight one side, medium plus mini (198 mm) the other.
    const { layout } = build('straight-long', [
      ...Array<string>(4).fill('curve-large'),
      'straight-medium',
      'straight-mini',
      ...Array<string>(4).fill('curve-large'),
    ]);
    const gap = jointError(
      worldEnd(layout, { uid: 'p1', connectorId: 'a' }).connector.pose,
      worldEnd(layout, { uid: 'p11', connectorId: 'b' }).connector.pose,
    );
    expect(gap.gapMm).toBeCloseTo(18, 0);
    const grab = middle(layout, 'p11');
    const context = flexContext(layout, new Set(['p11']), grab)!;
    const flexed = flexDrag(context, { x: grab.x - 15, y: grab.y })!;
    expect(flexed.closed).not.toBeNull();
    expect(openEnds(flexed.layout)).toHaveLength(0);
  });
});
