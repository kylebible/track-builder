import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Extension, type Layout } from '../layout/layout';
import { getTemplate } from '../templates/templates';
import { RouteGraph, headingKey } from './dispatch';
import { TrainSim, type Train } from './sim';
import type { ConsistEntry } from './stock';

const car = (stockId: string, reversed = false): ConsistEntry => ({ stockId, reversed });
const engine = (reversed = false) => [car('battery-engine', reversed), car('wagon', reversed)];

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
const oval = () => build('straight-long', [...Array(4).fill('curve-large'), 'straight-long', ...Array(4).fill('curve-large')]);

function put(sim: TrainSim, consist: ConsistEntry[], edgeKey: string, s: number, reversed = false): Train {
  const t = sim.addTrain(consist, { edgeKey, s, reversed });
  if (typeof t === 'string') throw new Error(t);
  return t;
}

function run(sim: TrainSim, seconds: number, until?: () => boolean): void {
  for (let i = 0; i < seconds * 30; i++) {
    sim.advance(1 / 30);
    if (until?.()) return;
  }
}

const crashed = (sim: TrainSim) => sim.trains.some((t) => t.wrecked);

describe('autoroute keeps trains apart', () => {
  it('two trains running at each other on an oval run into each other without it', () => {
    const sim = new TrainSim(oval());
    const a = put(sim, engine(), 'p1:0', 100);
    const b = put(sim, engine(true), 'p6:0', 100);
    sim.setThrottle(a.id, 1);
    sim.setThrottle(b.id, 1);
    run(sim, 20, () => crashed(sim) || sim.trains.length < 2);
    // Crashed, or snapped together nose to nose.
    expect(crashed(sim) || sim.trains.length < 2).toBe(true);
  });

  it('with it, they both stop short and wait', () => {
    const sim = new TrainSim(oval());
    sim.setAutoroute(true);
    const a = put(sim, engine(), 'p1:0', 100);
    const b = put(sim, engine(true), 'p6:0', 100);
    sim.setThrottle(a.id, 1);
    sim.setThrottle(b.id, 1);
    run(sim, 20);
    expect(crashed(sim)).toBe(false);
    for (const t of [a, b]) {
      expect(t.status.kind).toBe('waiting');
      expect(t.waitReason).toMatch(/Waiting for Train/);
    }
  });

  it('a train catching up on one stopped ahead waits behind it, then follows when it moves', () => {
    const sim = new TrainSim(oval());
    sim.setAutoroute(true);
    const lead = put(sim, engine(), 'p6:0', 100);
    const follower = put(sim, engine(), 'p1:0', 100);
    sim.setThrottle(follower.id, 1);
    run(sim, 15);
    expect(crashed(sim)).toBe(false);
    expect(follower.status).toMatchObject({ kind: 'waiting', message: `Waiting for ${lead.name}` });
    sim.setThrottle(lead.id, 1);
    run(sim, 3);
    expect(follower.status.kind).toBe('running');
    run(sim, 30);
    expect(crashed(sim)).toBe(false);
    expect(sim.trains).toHaveLength(2);
  });

  it('on passing loops, a train takes the free side to get past one standing on the other', () => {
    const layout = getTemplate('passing-loops').build();
    const sim = new TrainSim(layout);
    sim.setAutoroute(true);
    // The straights between the parallel switches: two loops, two sides each.
    const sides = layout.pieces.filter((p) => p.pieceId === 'straight-long').map((p) => `${p.uid}:0`);
    expect(sides).toHaveLength(4);
    // Stand one train on the side the levers point down.
    const network = sim.network;
    const firstWay = network.switches().flatMap((sw) => sw.choices[0].edge.uid);
    const curve = layout.pieces.find((p) => p.pieceId === 'curve-large')!;
    const parked = sides.find((k) => {
      const t = sim.addTrain(engine(), { edgeKey: k, s: 108, reversed: false });
      if (typeof t === 'string') return false;
      const r = t.route;
      const onLever = r.segments.some((s) => firstWay.includes(s.edge.uid));
      sim.removeTrain(t.id);
      return onLever;
    })!;
    const standing = put(sim, engine(), parked, 108);
    const runner = put(sim, engine(), `${curve.uid}:0`, 40);
    sim.setThrottle(runner.id, 1);
    let passed = false;
    for (let i = 0; i < 60 * 30 && !crashed(sim); i++) {
      sim.advance(1 / 30);
      if (runner.route.segments.some((s) => sides.includes(s.edge.key) && s.edge.key !== parked) && runner.status.kind === 'running') passed = true;
    }
    expect(crashed(sim)).toBe(false);
    expect(passed).toBe(true);
    // Well over a lap: it got past.
    expect(runner.odometer).toBeGreaterThan(3000);
    expect(standing.vehicles[0].v).toBe(0);
  });
  it('on passing loops, trains going opposite ways pass each other at the loops, lap after lap', () => {
    const layout = getTemplate('passing-loops').build();
    const sim = new TrainSim(layout);
    sim.setAutoroute(true);
    const sides = sim.network.edges.filter((e) => e.pieceId === 'straight-long');
    const east = put(sim, engine(), sides[0].key, 108);
    const west = put(sim, engine(), sides[2].key, 108, true);
    sim.setThrottle(east.id, 1);
    sim.setThrottle(west.id, 1);
    run(sim, 90, () => crashed(sim));
    expect(crashed(sim)).toBe(false);
    expect(sim.trains).toHaveLength(2);
    // A lap is about 2.3 m: several laps each, so many meetings.
    expect(east.odometer).toBeGreaterThan(8000);
    expect(west.odometer).toBeGreaterThan(8000);
  });
});

describe('sending a train somewhere', () => {
  it('finds a way into a siding, sets the switches, and stops with its middle on the spot', () => {
    const layout = getTemplate('goods-yard').build();
    const sim = new TrainSim(layout);
    const buffers = layout.pieces.filter((p) => p.pieceId === 'buffer');
    expect(buffers.length).toBe(2);
    // A siding: a straight a train can only leave by coming back out.
    const graph = new RouteGraph(sim.network);
    const sidings = sim.network.edges.filter((e) => e.pieceId === 'straight-medium').filter((e) => [0, 1].some((leave) => !graph.live.has(headingKey({ edge: e, leave: leave as 0 | 1 }))));
    expect(sidings.length).toBeGreaterThan(0);
    const target = sidings[0];
    const start = layout.pieces[0];
    const train = put(sim, engine(), `${start.uid}:0`, 108);
    const error = sim.routeTo(train.id, { kind: 'track', edgeKey: target.key, s: target.length / 2 });
    expect(error).toBeNull();
    expect(sim.autoroute).toBe(true);
    run(sim, 60, () => train.dispatch?.state === 'arrived' || train.wrecked);
    expect(train.wrecked).toBe(false);
    expect(train.dispatch?.state).toBe('arrived');
    expect(train.throttle).toBe(0);
    expect(sim.arrivals.at(-1)).toMatchObject({ trainId: train.id, uid: null });
    // Its middle is on the spot.
    const front = Math.max(...train.vehicles.map((v) => v.u + v.def.length / 2));
    const back = Math.min(...train.vehicles.map((v) => v.u - v.def.length / 2));
    const seg = train.route.segmentAt((front + back) / 2);
    expect(seg.edge.key).toBe(target.key);
    const s = seg.reversed ? seg.edge.length - ((front + back) / 2 - seg.u0) : (front + back) / 2 - seg.u0;
    expect(Math.abs(s - target.length / 2)).toBeLessThan(4);
  });

  it('backs up when the spot is behind it on a line with no way round', () => {
    const layout = build('straight-long', ['straight-long', 'straight-long', 'straight-long']);
    const sim = new TrainSim(layout);
    const train = put(sim, engine(), 'p3:0', 108);
    expect(sim.routeTo(train.id, { kind: 'track', edgeKey: 'p1:0', s: 108 })).toBeNull();
    // Engine first and facing forward: backing up is reverse.
    expect(train.throttle).toBe(-1);
    run(sim, 30, () => train.dispatch?.state === 'arrived' || train.wrecked);
    expect(train.dispatch?.state).toBe('arrived');
  });

  it('says so when there is no way there', () => {
    let layout = build('straight-long', []);
    layout = addPiece(layout, 'straight-long', { x: 0, y: 500, angle: 0 }).layout;
    const sim = new TrainSim(layout);
    const train = put(sim, engine(), 'p1:0', 108);
    expect(sim.routeTo(train.id, { kind: 'track', edgeKey: 'p2:0', s: 50 })).toMatch(/no way/);
  });

  it('stops before running off an open end', () => {
    const layout = build('straight-long', ['straight-long']);
    const sim = new TrainSim(layout);
    sim.setAutoroute(true);
    const train = put(sim, engine(), 'p1:0', 108);
    sim.setThrottle(train.id, 1);
    run(sim, 10);
    expect(train.wrecked).toBe(false);
    expect(train.status).toMatchObject({ kind: 'waiting', message: 'Stopped before the end of the track' });
  });
});

describe('switches a waiting train can foul', () => {
  it('a curved switch counts, a parallel one does not', () => {
    const yard = new TrainSim(getTemplate('goods-yard').build());
    const curved = yard.network.layout.pieces.filter((p) => p.pieceId.startsWith('switch-curved')).map((p) => p.uid);
    expect(curved.length).toBeGreaterThan(0);
    expect([...new RouteGraph(yard.network).foulUids].sort()).toEqual(curved.sort());
    const loops = new TrainSim(getTemplate('passing-loops').build());
    expect(new RouteGraph(loops.network).foulUids.size).toBe(0);
  });

  it('a busy full town runs a train for every job without trains touching', () => {
    const sim = new TrainSim(getTemplate('full-town').build());
    sim.useEconomy = true;
    for (const job of ['coal', 'water', 'farm', 'timber', 'goods', 'mail', 'workers', 'coal', 'water', 'farm'] as const) sim.addJobTrain(job);
    for (let i = 0; i < 90 * 10; i++) sim.advance(0.1);
    expect(sim.trains.filter((t) => t.wrecked).map((t) => t.name)).toEqual([]);
  }, 120000);
});
