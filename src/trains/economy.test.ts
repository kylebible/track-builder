import { describe, expect, it } from 'vitest';
import { poseAt } from '../geometry/path';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Extension, type Layout } from '../layout/layout';
import { getTemplate } from '../templates/templates';
import { ECONOMY, Economy } from './economy';
import { jobConsist, needs, nextStop } from './jobs';
import { TrackNetwork } from './network';
import { TrainSim } from './sim';
import type { ConsistEntry } from './stock';
import { doWork, getPlace, planWork } from './stops';

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

const quarter = Array<string>(4).fill('curve-large');
/** An oval with two long straights a side. */
const oval = () => build('straight-long', ['straight-long', ...quarter, 'straight-long', 'straight-long', ...quarter]);

/** The oval with places on its straights, in order: the first two on the near side, the next two on the far side. */
function withPlaces(...ids: (string | null)[]): Layout {
  let layout = oval();
  const straights = new TrackNetwork(layout).edges.filter((e) => e.pieceId === 'straight-long');
  ids.forEach((id, i) => {
    if (id) layout = addPiece(layout, id, poseAt(straights[i].path, straights[i].length / 2)).layout;
  });
  return layout;
}

const car = (stockId: string, extra: Partial<ConsistEntry> = {}): ConsistEntry => ({ stockId, reversed: false, ...extra });

function runUntil(sim: TrainSim, seconds: number, until: () => boolean = () => false): boolean {
  for (let i = 0; i < seconds * 30; i++) {
    sim.advance(1 / 30);
    if (until()) return true;
  }
  return false;
}

const site = (sim: TrainSim, placeId: string) => sim.economy.all(placeId)[0];

describe('places in the economy', () => {
  it('a mine digs coal only while miners are at work', () => {
    const sim = new TrainSim(withPlaces('coal-mine'));
    const mine = site(sim, 'coal-mine');
    mine.stock.coal = 0;
    sim.economy.tick(10);
    expect(mine.stock.coal).toBeCloseTo((6 * 10) / 60, 5);
    mine.crew.length = 0;
    sim.economy.tick(10);
    expect(mine.stock.coal).toBeCloseTo(1, 5);
  });

  it('workers tire and wait for a ride, and the place stops without them', () => {
    const sim = new TrainSim(withPlaces('coal-mine'));
    const mine = site(sim, 'coal-mine');
    sim.economy.tick(ECONOMY.shiftSeconds);
    expect(mine.crew).toEqual([]);
    expect(mine.tired).toBe(2);
    const work = planWork(getPlace('coal-mine')!, [car('steam-engine'), car('hopper')], Math.random, { economy: sim.economy, site: mine, job: 'free' });
    expect(work).toBeNull();
  });

  it('a sawmill turns logs into planks, two to a log', () => {
    const sim = new TrainSim(withPlaces('sawmill'));
    const mill = site(sim, 'sawmill');
    mill.stock = { logs: 1, crates: 0 };
    sim.economy.tick(60);
    expect(mill.stock.crates).toBeCloseTo(2, 5);
    expect(mill.stock.logs).toBeCloseTo(0, 5);
  });

  it('a coaling stage tops engines up from its pile, and stops when the pile runs out', () => {
    const sim = new TrainSim(withPlaces('coaling-stage'));
    const stage = site(sim, 'coaling-stage');
    stage.stock.coal = 0.5;
    const consist = [car('steam-engine', { coal: 0 })];
    const work = planWork(getPlace('coaling-stage')!, consist, Math.random, { economy: sim.economy, site: stage, job: 'free' })!;
    for (let i = 0; i < 100; i++) doWork(work, consist, 0.1, () => {});
    expect(consist[0].coal).toBeCloseTo(0.5 / ECONOMY.unitsPerStore, 5);
    expect(stage.stock.coal).toBeCloseTo(0, 5);
    expect(planWork(getPlace('coaling-stage')!, consist, Math.random, { economy: sim.economy, site: stage, job: 'free' })).toBeNull();
  });

  it('charging posts only work while a power station has coal', () => {
    const sim = new TrainSim(withPlaces('charging-post', 'power-station'));
    expect(site(sim, 'charging-post').blocked).toBeNull();
    site(sim, 'power-station').stock.coal = 0;
    sim.economy.tick(0.1);
    expect(site(sim, 'charging-post').blocked).toMatch(/no power/i);
  });

  it('a pump house needs to be by the water where there is water', () => {
    const sim = new TrainSim(withPlaces('pump-house'));
    sim.economy.waterNear = () => false;
    sim.economy.tick(0.1);
    expect(site(sim, 'pump-house').blocked).toMatch(/water/);
    sim.economy.waterNear = () => null;
    sim.economy.tick(0.1);
    expect(site(sim, 'pump-house').blocked).toBeNull();
  });
});

describe('train jobs', () => {
  it('a standard job train is an engine, a tender and three cars', () => {
    expect(jobConsist('coal').map((c) => c.stockId)).toEqual(['steam-engine', 'tender', 'hopper', 'hopper', 'hopper']);
    expect(jobConsist('farm', 4).map((c) => c.stockId)).toEqual(['steam-engine', 'tender', 'milk-tank', 'livestock', 'milk-tank', 'livestock']);
  });

  it('a coal train fetches coal when empty and takes it where it is lowest when loaded', () => {
    const economy = new Economy();
    const at = { x: 0, y: 0 };
    economy.sync([
      { uid: 'mine', place: getPlace('coal-mine')!, at },
      { uid: 'stage', place: getPlace('coaling-stage')!, at },
      { uid: 'power', place: getPlace('power-station')!, at },
    ]);
    economy.site('stage')!.stock.coal = 1;
    const far = () => 500;
    expect(nextStop('coal', jobConsist('coal'), economy, [], far, null)).toBe('mine');
    const loaded = jobConsist('coal').map((c) => (c.stockId === 'hopper' ? { ...c, units: 6 } : c));
    expect(nextStop('coal', loaded, economy, [], far, null)).toBe('stage');
  });

  it('a coal train only handles coal, even at a station-like stop with other cars', () => {
    const work = planWork(getPlace('farm')!, [car('steam-engine'), car('milk-tank')], Math.random, { economy: new Economy(), site: undefined as never, job: 'coal' });
    // No site: just the job filter.
    expect(work).toBeNull();
  });

  it('a coal train keeps the coaling stage stocked from the mine', () => {
    const sim = new TrainSim(withPlaces('coal-mine', null, 'coaling-stage'));
    site(sim, 'coaling-stage').stock.coal = 0;
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    expect(runUntil(sim, 60, () => (site(sim, 'coaling-stage').stock.coal ?? 0) >= 6)).toBe(true);
    expect(sim.delivered.coal).toBeGreaterThanOrEqual(6);
  });

  it('a workers train brings fresh workers from the station to a mine with nobody, and takes the tired home', () => {
    const sim = new TrainSim(withPlaces('station', null, 'coal-mine'));
    const mine = site(sim, 'coal-mine');
    mine.crew.length = 0;
    mine.tired = 2;
    const train = sim.addJobTrain('workers');
    if (typeof train === 'string') throw new Error(train);
    expect(runUntil(sim, 90, () => mine.crew.length === 2 && mine.tired === 0)).toBe(true);
    // Then home with the tired ones.
    expect(runUntil(sim, 90, () => train.consist.every((c) => !c.tired))).toBe(true);
  });

  it('a job train throws the levers to reach a place on a passing loop', () => {
    const layout = getTemplate('passing-loops').build();
    const net = new TrackNetwork(layout);
    // Each straight between the switches, main line and loop.
    const straights = net.edges.filter((e) => e.pieceId === 'straight-long');
    expect(straights.length).toBeGreaterThanOrEqual(4);
    let thrown = 0;
    for (const edge of straights) {
      const withMine = addPiece(layout, 'coal-mine', poseAt(edge.path, edge.length / 2)).layout;
      // Start on the far side of the oval, each way round.
      const mid = poseAt(edge.path, edge.length / 2);
      const curves = net.edges.filter((e) => e.pieceId === 'curve-large');
      const far = curves.reduce((a, b) => {
        const d = (e: typeof a) => Math.hypot(poseAt(e.path, e.length / 2).x - mid.x, poseAt(e.path, e.length / 2).y - mid.y);
        return d(b) > d(a) ? b : a;
      });
      for (const reversed of [false, true]) {
        const sim = new TrainSim(withMine);
        const train = sim.addTrain(jobConsist('coal'), { edgeKey: far.key, s: far.length / 2, reversed }, 'Coal', 'coal');
        if (typeof train === 'string') throw new Error(train);
        sim.setThrottle(train.id, 1);
        expect(runUntil(sim, 90, () => train.consist.some((c) => (c.units ?? 0) > 0))).toBe(true);
        thrown += sim.leverVersion;
      }
    }
    expect(thrown).toBeGreaterThan(0);
  });

  it('a train for every job keeps the full town going without a jam', () => {
    const sim = new TrainSim(getTemplate('full-town').build());
    const jobs = ['coal', 'water', 'workers', 'timber', 'farm', 'goods', 'mail'] as const;
    const trains = jobs.map((job) => sim.addJobTrain(job));
    for (const t of trains) if (typeof t === 'string') throw new Error(t);
    // All one way round, so none ever meets another head on.
    const all = trains as Exclude<(typeof trains)[number], string>[];
    for (const t of all.slice(1)) expect(sim.dispatcher.sameWayRound(all[0], t)).toBe(true);
    const visited = new Map(all.map((t) => [t.id, new Set<string>()]));
    for (let i = 0; i < 1200; i++) {
      sim.advance(0.1);
      for (const t of all) if (t.lastStop) visited.get(t.id)!.add(t.lastStop);
    }
    expect(sim.trains.length).toBe(jobs.length);
    for (const t of all) {
      expect(t.wrecked, t.name).toBe(false);
      expect(t.status.kind, t.name).not.toBe('stuck');
      expect(visited.get(t.id)!.size, `${t.name} got round`).toBeGreaterThan(0);
    }
  }, 60000);

  it('a coach with no seats left takes no more workers on', () => {
    const sim = new TrainSim(withPlaces('station', null, 'coal-mine'));
    const mine = site(sim, 'coal-mine');
    mine.tired = 3;
    const work = planWork(getPlace('coal-mine')!, [{ stockId: 'coach', reversed: false, units: 9, crew: 0, tired: 9 }], Math.random, { economy: sim.economy, site: mine, job: 'workers' });
    expect(work === null || work.queues.flat().every((j) => j.amount > 0)).toBe(true);
  });

  it('flags what each place needs, and says when no train is on it', () => {
    const sim = new TrainSim(withPlaces('coaling-stage'));
    site(sim, 'coaling-stage').stock.coal = 0;
    const list = needs(sim.economy, () => false, false);
    expect(list).toEqual([expect.objectContaining({ what: 'coal', job: 'coal', urgent: true, message: expect.stringMatching(/out of coal.*no coal mine/) })]);
  });
});
