import { describe, expect, it } from 'vitest';
import { poseAt } from '../geometry/path';
import { IDENTITY, type Pose } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Extension, type Layout } from '../layout/layout';
import { TrainSim, type Train } from './sim';
import type { ConsistEntry } from './stock';

function build(start: string, rest: string[]): Layout {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, start, IDENTITY);
  let end: EndRef | null = { uid, connectorId: 'b' };
  for (const id of rest) {
    const ext: Extension = extendFrom(layout, end!, id)!;
    layout = ext.layout;
    end = ext.next;
  }
  return layout;
}

const curves = Array<string>(4).fill('curve-large');
/** A large oval; `far` is the piece on the far side, p6. */
const oval = (far = 'straight-long') => build('straight-long', [...curves, far, ...curves]);
const car = (stockId: string): ConsistEntry => ({ stockId, reversed: false });

/** The middle of a piece's first path, in plan. */
function middleOf(layout: Layout, uid: string): Pose {
  const sim = new TrainSim(layout);
  const edge = sim.network.edge(`${uid}:0`)!;
  return poseAt(edge.path, edge.length / 2);
}

function place(layout: Layout, pieceId: string, pose: Pose): { layout: Layout; uid: string } {
  return addPiece(layout, pieceId, pose);
}

function start(layout: Layout, consist: ConsistEntry[], s = 60): { sim: TrainSim; train: Train } {
  const sim = new TrainSim(layout);
  const train = sim.addTrain(consist, { edgeKey: 'p1:0', s, reversed: false });
  if (typeof train === 'string') throw new Error(train);
  sim.setThrottle(train.id, 1);
  return { sim, train };
}

/** Run until `until` holds or time runs out; returns whether it held. */
function runUntil(sim: TrainSim, seconds: number, until: () => boolean = () => false): boolean {
  for (let i = 0; i < seconds * 60; i++) {
    sim.advance(1 / 60);
    if (until()) return true;
  }
  return false;
}

describe('signals', () => {
  it('a red signal stops a train coming toward it, and green lets it go', () => {
    const { layout, uid } = place(oval(), 'signal', { x: 190, y: -50, angle: Math.PI });
    const { sim, train } = start(layout, [car('battery-engine'), car('wagon')]);
    expect(sim.accessories.map((a) => a.kind)).toEqual(['signal']);
    sim.toggleAccessory(uid);
    runUntil(sim, 4);
    expect(train.status).toEqual({ kind: 'waiting', message: 'Waiting at the red signal' });
    // Front stopped just short of the signal.
    const front = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
    expect(190 - front).toBeGreaterThan(5);
    expect(190 - front).toBeLessThan(25);
    sim.toggleAccessory(uid);
    runUntil(sim, 2);
    expect(train.status.kind).toBe('running');
  });

  it('a red signal facing the other way lets trains pass', () => {
    const { layout, uid } = place(oval(), 'signal', { x: 190, y: -50, angle: 0 });
    const { sim, train } = start(layout, [car('battery-engine')]);
    sim.toggleAccessory(uid);
    runUntil(sim, 4);
    expect(train.status.kind).toBe('running');
  });
});

describe('stations', () => {
  it('a train stops at a station for a while, then carries on and stops again next time round', () => {
    let layout = oval();
    const mid = middleOf(layout, 'p6');
    layout = place(layout, 'station', mid).layout;
    const { sim, train } = start(layout, [car('battery-engine'), car('coach')]);
    const stopped = () => train.status.kind === 'waiting';
    expect(runUntil(sim, 20, stopped)).toBe(true);
    expect(train.status).toEqual({ kind: 'waiting', message: 'Stopped at the station' });
    const middle = (train.vehicles[0].geo.center.x + train.vehicles[1].geo.center.x) / 2;
    expect(Math.abs(middle - mid.x)).toBeLessThan(10);
    expect(runUntil(sim, 6, () => train.status.kind === 'running')).toBe(true);
    // Round again to the same station.
    expect(runUntil(sim, 30, stopped)).toBe(true);
  });
});

describe('cargo', () => {
  it('the loader fills each empty wagon and the crane lifts the crates off', () => {
    let layout = oval();
    const near = middleOf(layout, 'p1');
    const far = middleOf(layout, 'p6');
    layout = place(layout, 'cargo-loader', near).layout;
    // The crane outside the oval, beside the far straight.
    const out = Math.sign(far.y - near.y);
    const placed = place(layout, 'crane', { x: far.x, y: far.y + out * 90, angle: 0 });
    const { sim, train } = start(placed.layout, [car('battery-engine'), car('wagon'), car('wagon')], 30);
    expect(sim.accessories.map((a) => a.kind).sort()).toEqual(['crane', 'loader']);
    const loaded = () => train.consist.filter((c) => c.load).length;
    expect(runUntil(sim, 20, () => loaded() === 2)).toBe(true);
    expect(runUntil(sim, 40, () => sim.piles.get(placed.uid) === 2)).toBe(true);
    expect(loaded()).toBe(0);
    expect(train.wrecked).toBe(false);
  });
});

describe('lifting bridge', () => {
  it('trains wait at a raised bridge and cross once it is down', () => {
    const layout = oval('lift-bridge');
    const { sim, train } = start(layout, [car('battery-engine'), car('wagon')]);
    expect(sim.toggleAccessory('p6')).toBeNull();
    runUntil(sim, 15);
    expect(train.status).toEqual({ kind: 'waiting', message: 'Waiting for the bridge' });
    expect(sim.toggleAccessory('p6')).toBeNull();
    runUntil(sim, 3);
    expect(sim.bridgeOpen('p6')).toBe(false);
    expect(runUntil(sim, 10, () => train.route.segmentAt(train.vehicles[1].u).edge.uid === 'p7')).toBe(true);
    expect(train.wrecked).toBe(false);
  });

  it("won't lift with a train on it", () => {
    const layout = oval('lift-bridge');
    const sim = new TrainSim(layout);
    const train = sim.addTrain([car('battery-engine')], { edgeKey: 'p6:0', s: 108, reversed: false });
    expect(typeof train).not.toBe('string');
    expect(sim.toggleAccessory('p6')).toMatch(/on the bridge/);
  });
});
