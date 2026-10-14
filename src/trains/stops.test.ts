import { describe, expect, it } from 'vitest';
import { poseAt } from '../geometry/path';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Extension, type Layout } from '../layout/layout';
import { getPiece } from '../pieces/catalog';
import { TrackNetwork } from './network';
import { SUPPLIES, TrainSim, type Train } from './sim';
import { STOCK, type ConsistEntry } from './stock';
import { doWork, getPlace, PLACES, planWork } from './stops';

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

const oval = () => build('straight-long', [...Array<string>(4).fill('curve-large'), 'straight-long', ...Array<string>(4).fill('curve-large')]);

/** The oval with `pieceId` sat on the middle of its far straight. */
function withPlace(pieceId: string): Layout {
  const layout = oval();
  const net = new TrackNetwork(layout);
  const far = net.edges.filter((e) => e.pieceId === 'straight-long')[1];
  return addPiece(layout, pieceId, poseAt(far.path, far.length / 2)).layout;
}

const car = (stockId: string, extra: Partial<ConsistEntry> = {}): ConsistEntry => ({ stockId, reversed: false, ...extra });

function start(layout: Layout, consist: ConsistEntry[]): { sim: TrainSim; train: Train } {
  const sim = new TrainSim(layout);
  const train = sim.addTrain(consist, { edgeKey: 'p1:0', s: 140, reversed: false });
  if (typeof train === 'string') throw new Error(train);
  sim.setThrottle(train.id, 1);
  return { sim, train };
}

/** Run until `until` is true or `seconds` pass. */
function runUntil(sim: TrainSim, seconds: number, until: () => boolean = () => false): boolean {
  for (let i = 0; i < seconds * 60; i++) {
    sim.advance(1 / 60);
    if (until()) return true;
  }
  return false;
}

describe('places beside the track', () => {
  it('every place has a catalog piece and every car a known cargo', () => {
    for (const place of PLACES) expect(getPiece(place.id).model).toBe(place.id);
    for (const def of STOCK) if (def.cargo) expect(def.cargo.capacity).toBeGreaterThan(0);
  });

  it('a water tower fills a steam engine and a water tank car, and has nothing for a battery engine', () => {
    const tower = getPlace('water-tower')!;
    const work = planWork(tower, [car('steam-engine', { water: 0.3 }), car('tender'), car('water-tank')])!;
    expect(work.queues[0]).toEqual([{ action: 'refill', what: 'water', amount: 1 }]);
    expect(work.queues[1]).toEqual([]);
    expect(work.queues[2]).toEqual([{ action: 'load', what: 'water', amount: 8 }]);
    expect(planWork(tower, [car('battery-engine'), car('coach')])).toBeNull();
  });

  it('a sawmill takes logs off one car and puts crates on another', () => {
    const work = planWork(getPlace('sawmill')!, [car('battery-engine'), car('timber', { load: 3 }), car('wagon')])!;
    expect(work.queues[1]).toEqual([{ action: 'unload', what: 'logs', amount: 3 }]);
    expect(work.queues[2]).toEqual([{ action: 'load', what: 'crates', amount: 4 }]);
    expect(work.summary).toBe('Unloading 3 logs, loading 4 crates');
  });

  it('at a station some passengers get off and some get on, and it always stops', () => {
    const station = getPlace('station')!;
    expect(planWork(station, [car('battery-engine')])).not.toBeNull();
    const consist = [car('battery-engine'), car('coach', { load: 5 })];
    const work = planWork(station, consist, () => 0.5)!;
    const delivered: number[] = [];
    let done = false;
    for (let t = 0; t < 20 && !done; t += 0.05) done = doWork(work, consist, 0.05, (_, n) => delivered.push(n));
    expect(done).toBe(true);
    // Half of five, rounded down, plus one get off; then some get on.
    expect(delivered.length).toBe(3);
    expect(consist[1].load).toBe(2 + 5);
  });

  it('a train stops at a station, swaps passengers, then carries on', () => {
    const { sim, train } = start(withPlace('station'), [car('battery-engine'), car('coach', { load: 4 })]);
    expect(sim.places).toHaveLength(1);
    expect(runUntil(sim, 20, () => train.stop?.phase === 'dwell')).toBe(true);
    // Stopped with the coach by the station.
    expect(train.vehicles.every((v) => v.v === 0)).toBe(true);
    const placeAt = sim.places[0].at;
    const coach = train.vehicles[1].geo.center;
    expect(Math.hypot(coach.x - placeAt.x, coach.y - placeAt.y)).toBeLessThan(3);
    expect(runUntil(sim, 10, () => train.stop === null)).toBe(true);
    expect(sim.delivered.passengers).toBeGreaterThan(0);
    const u = train.vehicles[0].u;
    runUntil(sim, 1);
    expect(train.vehicles[0].u).toBeGreaterThan(u + 50);
    expect(train.wrecked).toBe(false);
  });

  it('a train with nothing to do at a coal mine runs straight past it', () => {
    const { sim, train } = start(withPlace('coal-mine'), [car('battery-engine'), car('coach')]);
    expect(runUntil(sim, 12, () => train.stop !== null)).toBe(false);
  });

  it('a coal hopper is filled at the mine and emptied at the power station', () => {
    let layout = withPlace('coal-mine');
    const net = new TrackNetwork(layout);
    const near = net.edges.find((e) => e.pieceId === 'straight-long')!;
    layout = addPiece(layout, 'power-station', poseAt(near.path, near.length / 2 + 60)).layout;
    const { sim, train } = start(layout, [car('battery-engine'), car('hopper')]);
    expect(runUntil(sim, 30, () => train.consist[1].load === 6)).toBe(true);
    expect(runUntil(sim, 30, () => (sim.delivered.coal ?? 0) >= 6)).toBe(true);
    expect(train.consist[1].load).toBe(0);
  });

  it('a train leaving one stop still stops at the next one close behind it', () => {
    const quarter = Array<string>(4).fill('curve-large');
    let layout = build('straight-long', ['straight-long', ...quarter, 'straight-long', 'straight-long', ...quarter]);
    const net = new TrackNetwork(layout);
    const [first, second] = net.edges.filter((e) => e.pieceId === 'straight-long');
    layout = addPiece(layout, 'station', poseAt(first.path, first.length / 2)).layout;
    layout = addPiece(layout, 'coal-mine', poseAt(second.path, second.length / 2)).layout;
    const sim = new TrainSim(layout);
    const train = sim.addTrain([car('battery-engine'), car('hopper')], { edgeKey: 'p7:0', s: 100, reversed: false });
    if (typeof train === 'string') throw new Error(train);
    sim.setThrottle(train.id, 1);
    const seen: string[] = [];
    runUntil(sim, 30, () => {
      if (train.stop && seen[seen.length - 1] !== train.stop.place.id) seen.push(train.stop.place.id);
      return seen.includes('coal-mine');
    });
    expect(seen).toEqual(['station', 'coal-mine']);
  });

  it('a whistle board makes engines whistle as they pass, without stopping', () => {
    const { sim, train } = start(withPlace('whistle-board'), [car('battery-engine')]);
    expect(runUntil(sim, 12, () => sim.events.length > 0)).toBe(true);
    expect(sim.events[0]).toMatchObject({ trainId: train.id, kind: 'whistle' });
    expect(train.stop).toBeNull();
  });
});

describe('engine supplies', () => {
  it('a steam engine burns water and coal, and stops when the boiler runs dry', () => {
    const { sim, train } = start(oval(), [car('steam-engine', { water: 0.02 })]);
    runUntil(sim, 15, () => train.status.kind === 'stuck');
    expect(train.status).toMatchObject({ kind: 'stuck', stuck: 'no-water' });
    expect(train.consist[0].coal).toBeLessThan(1);
  });

  it('a tender’s coal is burned before the engine’s own', () => {
    const { sim, train } = start(oval(), [car('steam-engine'), car('tender')]);
    runUntil(sim, 3);
    expect(train.consist[0].coal ?? 1).toBe(1);
    expect(train.consist[1].coal).toBeLessThan(1);
  });

  it('a water tank car tops up the boiler', () => {
    const { sim, train } = start(oval(), [car('steam-engine', { water: SUPPLIES.topUpBelow - 0.01 }), car('water-tank', { load: 2 })]);
    runUntil(sim, 0.5);
    expect(train.consist[1].load).toBe(1);
    expect(train.consist[0].water).toBeGreaterThan(SUPPLIES.topUpBelow);
  });

  it('a flat battery engine is charged at a charging post', () => {
    const { sim, train } = start(withPlace('charging-post'), [car('battery-engine', { charge: 0.1 })]);
    expect(runUntil(sim, 20, () => train.stop?.phase === 'dwell')).toBe(true);
    expect(runUntil(sim, 10, () => train.stop === null)).toBe(true);
    expect(train.consist[0].charge).toBeGreaterThan(0.99);
  });

  it('a long train stops with its engine, at the front, under the water tower', () => {
    const { sim, train } = start(withPlace('water-tower'), [car('steam-engine', { water: 0.5 }), car('tender'), car('coach'), car('coach'), car('coach')]);
    expect(runUntil(sim, 30, () => train.stop?.phase === 'dwell')).toBe(true);
    const engine = train.vehicles[0].geo.center;
    expect(Math.hypot(engine.x - sim.places[0].at.x, engine.y - sim.places[0].at.y)).toBeLessThan(3);
    expect(runUntil(sim, 10, () => train.stop === null)).toBe(true);
    expect(train.consist[0].water).toBeGreaterThan(0.99);
  });

  it('can be switched off', () => {
    const { sim, train } = start(oval(), [car('steam-engine', { water: 0 })]);
    sim.useSupplies = false;
    runUntil(sim, 2);
    expect(train.status.kind).toBe('running');
  });

  it('reset puts trains back with full stores and empty cars', () => {
    const { sim, train } = start(oval(), [car('battery-engine', { charge: 0.2 }), car('coach', { load: 3 })]);
    sim.reset();
    expect(train.consist).toEqual([car('battery-engine'), car('coach')]);
  });
});
