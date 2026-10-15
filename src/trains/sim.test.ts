import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, transformPieces, type EndRef, type Extension, type Layout } from '../layout/layout';
import { TrackNetwork } from './network';
import { TrainSim, type Train } from './sim';
import { attracts, type ConsistEntry } from './stock';
import { jobConsist } from './jobs';

/** Keep adding pieces from the open end the last one left. */
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

const curves = (id: string, n: number) => Array<string>(n).fill(id);
/** An oval: two long straights joined by half circles. */
const oval = (curve: string) => build('straight-long', [...curves(curve, 4), 'straight-long', ...curves(curve, 4)]);
const car = (stockId: string, reversed = false): ConsistEntry => ({ stockId, reversed });
const wagons = (n: number) => Array.from({ length: n }, () => car('wagon'));

function start(layout: Layout, consist: ConsistEntry[], edgeKey = 'p1:0', s = 100): { sim: TrainSim; train: Train } {
  const sim = new TrainSim(layout);
  const train = sim.addTrain(consist, { edgeKey, s, reversed: false });
  if (typeof train === 'string') throw new Error(train);
  sim.setThrottle(train.id, 1);
  return { sim, train };
}

/** Run for `seconds`, returning how far the front of the train travelled. */
function run(sim: TrainSim, train: Train, seconds: number): number {
  let travelled = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const before = train.vehicles[0].u;
    sim.advance(1 / 60);
    travelled += Math.abs(train.vehicles[0].u - before);
    if (train.wrecked) break;
  }
  return travelled;
}

describe('the track as a network', () => {
  it('a closed oval has no dead ends: every path leads on to another', () => {
    const net = new TrackNetwork(oval('curve-large'));
    for (const edge of net.edges) {
      for (const end of [0, 1] as const) expect(net.onward(edge, end, () => 0).kind).toBe('edge');
    }
  });

  it('a switch offers two ways on from its trunk and one back from each branch', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'switch-curved', IDENTITY);
    const net = new TrackNetwork(layout);
    const [sw] = net.switches();
    expect(sw.choices).toHaveLength(2);
  });

  it('two ends a few mm apart count as a gap to bridge, not a joint', () => {
    let layout = build('straight-long', []);
    layout = addPiece(layout, 'straight-long', { x: 216 + 5, y: 0, angle: 0 }).layout;
    const net = new TrackNetwork(layout);
    const next = net.onward(net.edge('p1:0')!, 1, () => 0);
    expect(next.kind).toBe('edge');
    if (next.kind === 'edge') expect(next.fit).toMatchObject({ unjoined: true, gapMm: 5 });
  });
});

describe('magnets', () => {
  it('cars facing the same way hold; one turned round pushes away', () => {
    expect(attracts(car('battery-engine'), car('wagon'))).toBe(true);
    expect(attracts(car('battery-engine'), car('wagon', true))).toBe(false);
    expect(attracts(car('wagon', true), car('wagon', true))).toBe(true);
  });

  it('a long train with two engines pulls apart on real magnets, but not with forgiving ones or kept coupled', () => {
    const consist = [car('battery-engine'), car('battery-engine'), ...wagons(14)];
    const whole = (setup: (sim: TrainSim) => void) => {
      const { sim, train } = start(oval('curve-large'), consist);
      setup(sim);
      run(sim, train, 10);
      return sim.trains.length === 1 && train.couplings.every((c) => c.coupled);
    };
    expect(whole(() => {})).toBe(false);
    expect(whole((sim) => (sim.realMagnets = false))).toBe(true);
    expect(whole((sim) => (sim.keepCoupled = true))).toBe(true);
  });

  it('a car turned the wrong way is left behind', () => {
    const { sim, train } = start(oval('curve-large'), [car('battery-engine'), car('wagon', true)]);
    run(sim, train, 3);
    expect(train.couplings[0].coupled).toBe(false);
    expect(train.vehicles[0].u - train.vehicles[1].u).toBeGreaterThan(200);
  });
});

describe('running', () => {
  it('an engine and three cars run round a large oval without trouble', () => {
    const { sim, train } = start(oval('curve-large'), [car('battery-engine'), car('wagon'), car('coach'), car('wagon')]);
    const travelled = run(sim, train, 20);
    expect(train.status.kind).toBe('running');
    expect(train.couplings.every((c) => c.coupled)).toBe(true);
    expect(travelled).toBeGreaterThan(1500);
  });

  it('runs off an open end', () => {
    const { sim, train } = start(build('straight-long', ['straight-long']), [car('battery-engine')]);
    run(sim, train, 10);
    expect(train.status).toMatchObject({ kind: 'stuck', stuck: 'ran-off' });
  });

  it('stops at a buffer stop', () => {
    const { sim, train } = start(build('straight-long', ['straight-long', 'buffer']), [car('battery-engine'), car('wagon')]);
    run(sim, train, 10);
    expect(train.status).toMatchObject({ kind: 'stuck', stuck: 'buffer' });
    expect(train.wrecked).toBe(false);
  });

  it('a long heavy train binds on tight curves where a short one gets round', () => {
    const light = start(oval('curve-short'), [car('battery-engine'), ...wagons(3)]);
    run(light.sim, light.train, 15);
    expect(light.train.status.kind).toBe('running');

    const heavy = start(oval('curve-short'), [car('battery-engine'), car('timber'), car('timber'), car('timber'), car('timber'), car('timber')]);
    run(heavy.sim, heavy.train, 15);
    expect(heavy.train.status).toMatchObject({ kind: 'stuck', stuck: 'stalled' });
    if (heavy.train.status.kind === 'stuck') expect(heavy.train.status.message).toMatch(/short curve/);
  });

  it('the same load that stalls on short curves gets round large ones', () => {
    const { sim, train } = start(oval('curve-large'), [car('battery-engine'), car('timber'), car('timber'), car('timber'), car('timber'), car('timber')]);
    run(sim, train, 15);
    expect(train.status.kind).toBe('running');
  });

  it('a wide gap derails the train; a narrow, straight one is bridged', () => {
    const gapped = (mm: number, sideways = 0) => {
      let layout = build('straight-long', []);
      layout = addPiece(layout, 'straight-long', { x: 216 + mm, y: sideways, angle: 0 }).layout;
      layout = extendFrom(layout, { uid: 'p2', connectorId: 'b' }, 'buffer')!.layout;
      return layout;
    };
    const narrow = start(gapped(3), [car('battery-engine'), car('wagon')], 'p1:0', 60);
    run(narrow.sim, narrow.train, 10);
    expect(narrow.train.status).toMatchObject({ stuck: 'buffer' });

    const offset = start(gapped(4, 4), [car('battery-engine'), car('wagon')], 'p1:0', 60);
    run(offset.sim, offset.train, 10);
    expect(offset.train.status).toMatchObject({ stuck: 'derailed' });
  });

  it('follows the switch lever into a siding', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    // Trunk is a hole, so attach the switch by it to the straight's peg end.
    const sw = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'switch-curved')!;
    layout = sw.layout;
    layout = extendFrom(layout, { uid: sw.uid, connectorId: 'branch0' }, 'straight-long')!.layout;
    layout = extendFrom(layout, { uid: sw.uid, connectorId: 'branch1' }, 'buffer')!.layout;
    const main = start(layout, [car('battery-engine')], 'p1:0', 60);
    run(main.sim, main.train, 10);
    expect(main.train.status).toMatchObject({ stuck: 'ran-off' });

    const siding = start(layout, [car('battery-engine')], 'p1:0', 60);
    siding.sim.toggleLever(sw.uid);
    run(siding.sim, siding.train, 10);
    expect(siding.train.status).toMatchObject({ stuck: 'buffer' });
  });

  it('a train too long for its loop is refused', () => {
    const sim = new TrainSim(build('curve-large', curves('curve-large', 7)));
    expect(sim.addTrain([car('battery-engine'), ...wagons(16)], { edgeKey: 'p1:0', s: 30, reversed: false })).toMatch(/longer than the loop/);
    expect(sim.addTrain([car('battery-engine'), ...wagons(6)], { edgeKey: 'p1:0', s: 30, reversed: false })).not.toBeTypeOf('string');
  });

  it('moving track under a train takes it off; editing elsewhere does not', () => {
    const layout = oval('curve-large');
    const { sim, train } = start(layout, [car('battery-engine')], 'p1:0', 100);
    run(sim, train, 0.5);
    const far = train.route.uids().has('p6') ? 'p8' : 'p6';
    expect(sim.setLayout(transformPieces(layout, new Set([far]), { x: 0, y: 500, angle: 0 }))).toEqual([]);
    expect(sim.setLayout(transformPieces(layout, new Set(['p1']), { x: 0, y: 500, angle: 0 }))).toEqual([train.name]);
    expect(sim.trains).toHaveLength(0);
  });
});

describe('building trains on the track', () => {
  const straight = () => build('straight-long', ['straight-long', 'straight-long', 'straight-long']);

  it('a car added to an end turns to couple and sits nose to tail', () => {
    const { sim, train } = start(straight(), [car('battery-engine', true)], 'p2:0', 100);
    expect(sim.attach(train.id, 'back', 'wagon')).toBeNull();
    expect(train.consist).toEqual([car('battery-engine', true), car('wagon', true)]);
    expect(train.couplings[0].coupled).toBe(true);
    const gap = train.vehicles[0].u - train.vehicles[0].def.length / 2 - (train.vehicles[1].u + train.vehicles[1].def.length / 2);
    expect(Math.abs(gap)).toBeLessThan(0.5);
  });

  it('lifting a car out of the middle leaves two trains where they stood', () => {
    const { sim, train } = start(straight(), [car('battery-engine'), car('wagon'), car('coach'), car('wagon')], 'p2:0', 150);
    const before = train.vehicles.map((v) => v.geo.center);
    expect(sim.detach(train.id, 1)).toEqual(car('wagon'));
    expect(sim.trains).toHaveLength(2);
    const [front, back] = sim.trains;
    expect(front.consist.map((c) => c.stockId)).toEqual(['battery-engine']);
    expect(back.consist.map((c) => c.stockId)).toEqual(['coach', 'wagon']);
    expect(front.vehicles[0].geo.center.x).toBeCloseTo(before[0].x, 3);
    expect(back.vehicles[1].geo.center.x).toBeCloseTo(before[3].x, 3);
  });

  it('an engine running into a parked car picks it up', () => {
    const sim = new TrainSim(straight());
    const engine = sim.addTrain([car('battery-engine')], { edgeKey: 'p1:0', s: 100, reversed: false }) as Train;
    sim.addTrain([car('wagon')], { edgeKey: 'p3:0', s: 100, reversed: false });
    sim.setThrottle(engine.id, 1);
    run(sim, engine, 6);
    expect(sim.trains).toHaveLength(1);
    expect(engine.consist.map((c) => c.stockId)).toEqual(['wagon', 'battery-engine']);
    // The engine's north nose met the wagon's south tail: they hold.
    expect(engine.couplings[0].coupled).toBe(true);
  });

  it('turning a car round where it stands flips its magnets', () => {
    const { sim, train } = start(straight(), [car('battery-engine'), car('wagon')], 'p2:0', 100);
    sim.turnVehicle(train.id, 1);
    expect(train.consist[1].reversed).toBe(true);
    expect(train.couplings[0].attract).toBe(false);
  });

  describe('job trains outside Basic mode', () => {
    const loop = () => build('straight-long', [...curves('straight-long', 12), ...curves('curve-short', 4), ...curves('straight-long', 13), ...curves('curve-short', 4)]);
    function jobTrain(cars: number, jobPower: boolean) {
      const sim = new TrainSim(loop());
      Object.assign(sim, { realMagnets: false, keepCoupled: true, useSupplies: false, jobPower });
      const train = sim.addTrain(jobConsist('coal', cars), { edgeKey: 'p1:0', s: 100, reversed: false }, 'Coal train', 'coal');
      if (typeof train === 'string') throw new Error(train);
      sim.setThrottle(train.id, 1);
      return { sim, train };
    }

    it('pull harder with more cars, so a train that stalls on its own engine gets round', { timeout: 30000 }, () => {
      const weak = jobTrain(16, false);
      run(weak.sim, weak.train, 60);
      expect(weak.train.status).toMatchObject({ kind: 'stuck', stuck: 'stalled' });
      expect(weak.sim.notices.at(-1)?.stuck).toBe('stalled');

      const strong = jobTrain(16, true);
      expect(strong.sim.powerBoost(strong.train)).toBeGreaterThan(1);
      run(strong.sim, strong.train, 60);
      expect(strong.train.status.kind).toBe('running');
    });

    it('a stalled train gets going again with an engine added at the front', { timeout: 30000 }, () => {
      const { sim, train } = jobTrain(20, true);
      run(sim, train, 60);
      expect(train.status).toMatchObject({ kind: 'stuck', stuck: 'stalled' });
      expect(sim.addEngine(train.id)).toBeNull();
      expect(train.consist.slice(0, 2).map((c) => c.stockId)).toEqual(['steam-engine', 'steam-engine']);
      expect(attracts(train.consist[0], train.consist[1])).toBe(true);
      run(sim, train, 20);
      expect(train.status.kind).toBe('running');
      expect(train.couplings[0].coupled).toBe(true);
    });

    it('free trains keep their usual pull', () => {
      const { sim, train } = jobTrain(20, true);
      sim.setJob(train.id, 'free');
      expect(sim.powerBoost(train)).toBe(1);
    });
  });
});
