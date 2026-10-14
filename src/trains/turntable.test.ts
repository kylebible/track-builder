import { describe, expect, it } from 'vitest';
import { IDENTITY, normalizeAngle } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type Layout } from '../layout/layout';
import * as D from '../pieces/dimensions';
import { TrainSim, type Train } from './sim';
import type { ConsistEntry } from './stock';
import { findTurntables, headingToward, lineAt, lineToward } from './turntable';

const R = D.TURNTABLE_DIAMETER / 2;
const car = (stockId: string): ConsistEntry => ({ stockId, reversed: false });

/**
 * A turntable, p1, with its pivot at (R, 0): a long straight off the end
 * on line 0's far side (p2), one off its near side (p3), and one off the
 * bottom end of line 2, a quarter turn round (p4).
 */
function yard(): Layout {
  let layout = addPiece(EMPTY_LAYOUT, 'turntable', IDENTITY).layout;
  for (const end of ['e4', 'e0', 'e2']) layout = extendFrom(layout, { uid: 'p1', connectorId: end }, 'straight-long')!.layout;
  return layout;
}

function runUntil(sim: TrainSim, seconds: number, until: () => boolean = () => false): boolean {
  for (let i = 0; i < seconds * 60; i++) {
    sim.advance(1 / 60);
    if (until()) return true;
  }
  return false;
}

function put(sim: TrainSim, consist: ConsistEntry[], edgeKey: string, s: number, reversed = false): Train {
  const train = sim.addTrain(consist, { edgeKey, s, reversed });
  if (typeof train === 'string') throw new Error(train);
  return train;
}

const front = (t: Train) => Math.max(...t.vehicles.map((v) => v.u + v.def.length / 2));
const back = (t: Train) => Math.min(...t.vehicles.map((v) => v.u - v.def.length / 2));
const bottomEnd = { x: R, y: -R + 5 };

describe('turntable', () => {
  it('finds the pivot and the four lines, and picks the line toward a tap', () => {
    const [table] = findTurntables(yard());
    expect(table.center.x).toBeCloseTo(R, 9);
    expect(table.center.y).toBeCloseTo(0, 9);
    expect(table.lines.map((l) => l.edgeKey)).toEqual(['p1:0', 'p1:1', 'p1:2', 'p1:3']);
    expect(lineToward(table, bottomEnd, 0)).toBe(2);
    expect(lineToward(table, { x: R, y: R - 5 }, 0)).toBe(2);
    expect(lineToward(table, { x: 5, y: 0 }, 0)).toBe(0);
    // By the pivot: on to the next line round.
    expect(lineToward(table, { x: R + 5, y: 0 }, 0)).toBe(1);
    // Line 3 is three eighths of a turn round: from line 0 the bridge turns the short way, back an eighth.
    expect(headingToward(table, 3, 0)).toBeCloseTo(-Math.PI / 4, 9);
    expect(lineAt(table, Math.PI)).toBe(0);
  });

  it('a train waits at the pit until the bridge turns to it, then runs across', () => {
    const sim = new TrainSim(yard());
    expect(sim.turnTurntable('p1', bottomEnd)).toBeNull();
    // p2 runs away from the pit: reversed, the train heads back toward it.
    const train = put(sim, [car('battery-engine')], 'p2:0', 150, true);
    sim.setThrottle(train.id, 1);
    runUntil(sim, 5);
    expect(train.status).toEqual({ kind: 'waiting', message: 'Waiting for the turntable' });
    // Its front stands just short of the pit edge, at u = 0 of p2 along its route.
    const seg = train.route.segments.find((s) => s.edge.key === 'p2:0')!;
    const pitEdge = seg.u0 + seg.edge.length;
    expect(pitEdge - front(train)).toBeGreaterThan(3);
    expect(pitEdge - front(train)).toBeLessThan(20);
    sim.turnTurntable('p1', { x: 2 * R - 5, y: 0 });
    // Still turning back: it keeps waiting until the bridge comes to rest.
    runUntil(sim, 0.5);
    expect(train.status.kind).toBe('waiting');
    expect(runUntil(sim, 4, () => train.route.uids().has('p1') && back(train) > pitEdge)).toBe(true);
  });

  it('a train wholly on the bridge turns round with it and drives off down the new line', () => {
    const sim = new TrainSim(yard());
    const train = put(sim, [car('battery-engine')], 'p1:0', R);
    const before = train.vehicles[0].geo.heading;
    expect(sim.turnTurntable('p1', bottomEnd)).toBeNull();
    runUntil(sim, 0.6);
    expect(train.status).toEqual({ kind: 'waiting', message: 'Turning on the turntable' });
    const mid = train.vehicles[0].geo.heading;
    expect(Math.abs(normalizeAngle(mid - before))).toBeGreaterThan(0.2);
    runUntil(sim, 2);
    expect(train.route.segments.map((s) => s.edge.key)).toContain('p1:2');
    expect(Math.abs(Math.sin(train.vehicles[0].geo.heading - before))).toBeCloseTo(1, 6);
    expect(train.vehicles[0].geo.center.x).toBeCloseTo(R, 3);
    // On it goes, off one end of line 2 or the other: down onto p4 or off the open top end.
    sim.setThrottle(train.id, 1);
    runUntil(sim, 3, () => train.wrecked || train.route.uids().has('p4'));
    expect(train.route.uids().has('p4') || train.status.kind === 'stuck').toBe(true);
  });

  it("won't turn with a train partly on the bridge", () => {
    const sim = new TrainSim(yard());
    const train = put(sim, [car('battery-engine'), car('wagon')], 'p1:0', 2 * R);
    expect(sim.turnTurntable('p1', bottomEnd)).toMatch(/partly on the turntable/);
    expect(sim.linedUp('p1', 0)).toBe(true);
    expect(train.status.kind).toBe('stopped');
  });

  it('only puts trains on the line the bridge lies along', () => {
    const sim = new TrainSim(yard());
    expect(sim.addTrain([car('wagon')], { edgeKey: 'p1:2', s: R, reversed: false })).toBe('Turn the turntable to that line first.');
    expect(typeof sim.addTrain([car('wagon')], { edgeKey: 'p1:0', s: R, reversed: false })).not.toBe('string');
  });
});
