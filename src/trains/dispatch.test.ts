import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Extension, type Layout } from '../layout/layout';
import { layoutFromJson } from '../planning/file';
import { getTemplate } from '../templates/templates';
import { DISPATCH, RouteGraph, headingKey } from './dispatch';
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

describe('single lines', () => {
  it('a train takes on a single line whole, however long, never stopping its claim partway along', () => {
    // 40 long straights, 8.6 m: longer than a usual stretch of reservation.
    const sim = new TrainSim(build('straight-long', Array(39).fill('straight-long')));
    sim.setAutoroute(true);
    const t = put(sim, engine(), 'p1:0', 100);
    sim.setThrottle(t.id, 1);
    run(sim, 0.2);
    const held = [...sim.dispatcher.holds].filter(([, id]) => id === t.id).map(([uid]) => uid);
    expect(held).toHaveLength(40);
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

describe('keeping clear where lines come close', () => {
  const extend = (layout: Layout, from: EndRef, ids: string[]): Layout => {
    let end: EndRef | null = from;
    for (const id of ids) {
      const ext: Extension = extendFrom(layout, end!, id)!;
      layout = ext.layout;
      end = ext.next;
    }
    return layout;
  };
  const points = (t: Train) => t.vehicles.flatMap((v) => [v.geo.center, v.geo.aheadFace, v.geo.behindFace]);
  const closest = (a: Train, b: Train) => Math.min(...points(a).flatMap((p) => points(b).map((q) => Math.hypot(p.x - q.x, p.y - q.y))));

  function sideBySide(gap: number): Layout {
    const first = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    let layout = extend(first.layout, { uid: first.uid, connectorId: 'b' }, ['straight-long', 'straight-long', 'straight-long']);
    const second = addPiece(layout, 'straight-long', { x: 0, y: gap, angle: 0 });
    return extend(second.layout, { uid: second.uid, connectorId: 'b' }, ['straight-long', 'straight-long', 'straight-long']);
  }

  it('counts lines too close to pass as one, but not double track', () => {
    expect(new RouteGraph(new TrainSim(sideBySide(30)).network).conflicts.get('p1')?.has('p5')).toBe(true);
    expect(new RouteGraph(new TrainSim(sideBySide(46)).network).conflicts.size).toBe(0);
  });

  it('trains meeting on lines too close to pass wait instead of brushing past', () => {
    const sim = new TrainSim(sideBySide(30));
    sim.setAutoroute(true);
    const a = put(sim, engine(), 'p1:0', 100);
    const b = put(sim, engine(), 'p8:0', 100, true);
    sim.setThrottle(a.id, 1);
    sim.setThrottle(b.id, 1);
    run(sim, 20, () => crashed(sim));
    expect(crashed(sim)).toBe(false);
    expect(closest(a, b)).toBeGreaterThan(60);
    for (const t of [a, b]) expect(t.waitReason).toMatch(/Waiting for Train/);
  });

  it('a train coming off one side of a switch keeps clear of a train standing just past it on the other', () => {
    const sw = addPiece(EMPTY_LAYOUT, 'switch-short-curved', IDENTITY);
    let layout = extend(sw.layout, { uid: sw.uid, connectorId: 'trunk' }, ['straight-long', 'straight-long']);
    layout = extend(layout, { uid: sw.uid, connectorId: 'branch0' }, ['straight-long', 'straight-long']);
    layout = extend(layout, { uid: sw.uid, connectorId: 'branch1' }, ['curve-short', 'straight-long', 'straight-long']);
    const sim = new TrainSim(layout);
    sim.setAutoroute(true);
    const a = put(sim, [car('steam-engine'), car('tender')], 'p2:0', 60);
    const b = put(sim, [car('battery-engine'), car('hopper'), car('hopper')], 'p5:0', 150, true);
    // A runs through onto the curved side and stops with its tail by the switch.
    expect(sim.routeTo(a.id, { kind: 'track', edgeKey: 'p7:0', s: 60 }, { align: 'front' })).toBeNull();
    run(sim, 15, () => a.dispatch?.state === 'arrived');
    expect(a.dispatch?.state).toBe('arrived');
    // B comes in off the straight side, past A's tail.
    expect(sim.routeTo(b.id, { kind: 'track', edgeKey: 'p2:0', s: 100 })).toBeNull();
    let nearest = Infinity;
    for (let i = 0; i < 20 * 30 && !crashed(sim); i++) {
      sim.advance(1 / 30);
      nearest = Math.min(nearest, closest(a, b));
    }
    expect(crashed(sim)).toBe(false);
    expect(nearest).toBeGreaterThan(DISPATCH.clearMm + 1);
  });

  it('a ramp coming down past a lower line counts as too close where a car on it is still low enough to hit', () => {
    // From a layout where trains hit each other: a ramp drops from the upper level beside a curve on the floor.
    const layout = layoutFromJson(
      JSON.stringify({
        format: 'track-builder-layout',
        version: 2,
        pieces: [
          { piece: 'ramp-pp', x: -1456, y: 419.714, angle: 180 },
          { piece: 'curve-large', x: -1672, y: 419.714, angle: 180, z: 64 },
          { piece: 'curve-large', x: -1651.978, y: 477.128, angle: -133.9416 },
        ],
      }),
    );
    const graph = new RouteGraph(new TrainSim(layout).network);
    const [ramp, top, floor] = layout.pieces.map((p) => p.uid);
    // The ramp's high end passes right by the floor curve, but a car standing there tilts down to the floor's level.
    expect(graph.conflicts.get(ramp)?.has(floor)).toBe(true);
    // Fully up a level, cars pass over.
    expect(graph.conflicts.get(top)?.has(floor) ?? false).toBe(false);
  });
});
