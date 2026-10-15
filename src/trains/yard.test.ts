import { describe, expect, it } from 'vitest';
import { getTemplate } from '../templates/templates';
import { TrainSim, type Train } from './sim';
import { getStock } from './stock';
import { getPlace } from './stops';

const town = () => {
  const sim = new TrainSim(getTemplate('full-town').build());
  sim.useEconomy = true;
  sim.setAutoroute(true);
  return sim;
};

function runUntil(sim: TrainSim, until: () => boolean, seconds = 180): void {
  for (let i = 0; i < seconds * 10 && !until(); i++) sim.advance(0.1);
}

function coalTown(): TrainSim {
  const source = getTemplate('full-town').build();
  const sim = new TrainSim({ ...source, pieces: source.pieces.filter((p) => !getPlace(p.pieceId) || ['coal-mine', 'coaling-stage', 'car-sidings'].includes(p.pieceId)) });
  sim.setAutoroute(true);
  sim.useSupplies = false;
  sim.keepCoupled = true;
  for (const site of sim.economy.sites.values()) {
    if (site.place.id === 'coal-mine') { site.stock.coal = 0; site.crew = []; }
    if (site.place.id === 'coaling-stage') { site.stock.coal = site.place.holds!.coal!; site.crew = [1]; }
  }
  return sim;
}

describe('yard', () => {
  it('automatically stores surplus loads and reuses the wagons instead of spawning replacements', () => {
    const sim = coalTown();
    // The initial spare wagons have already been used elsewhere; the roads are free for returns.
    sim.yard.stock();
    for (const train of [...sim.trains]) sim.removeTrain(train.id);
    sim.operator.setOn(true);
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    for (const entry of train.consist) if (getStock(entry.stockId).cargo?.kind === 'coal') entry.units = 2;
    const parked = () => sim.trains.find((t) => t.name === 'Parked coal wagons');
    runUntil(sim, () => !!parked() && !sim.yard.busy);
    expect(parked()?.consist.map((c) => c.units)).toEqual([2, 2, 2]);
    const inventory = () => sim.places.filter((p) => p.place.spares).map((p) => sim.yard.inventory(p.uid));
    expect(inventory().find((i) => i.cars > 0)).toEqual({ cars: 3, cargo: { coal: 6 } });
    expect(sim.trains).toHaveLength(1);
    // Full consumers leave the load parked; no replacement train appears.
    runUntil(sim, () => false, 30);
    expect(sim.trains).toHaveLength(1);
    expect(sim.operator.wanted().has('coal')).toBe(false);
    const id = parked()!.id;
    // Stored cargo remains useful even after its producer disappears.
    const layout = sim.network.layout;
    sim.setLayout({ ...layout, pieces: layout.pieces.filter((p) => p.pieceId !== 'coal-mine') });
    const receiver = sim.economy.all('coaling-stage')[0];
    receiver.stock.coal = 0;
    expect(sim.operator.wanted().get('coal')).toBe(1);
    runUntil(sim, () => (receiver.stock.coal ?? 0) >= 6);
    expect(receiver.stock.coal).toBe(6);
    expect(sim.train(id)).toBeUndefined();
    // With no more coal to collect, the same three now-empty wagons go back.
    runUntil(sim, () => !!parked() && !sim.yard.busy);
    expect(sim.trains).toHaveLength(1);
    expect(parked()?.consist.map((c) => c.units)).toEqual([0, 0, 0]);
    expect(inventory().find((i) => i.cars > 0)).toEqual({ cars: 3, cargo: {} });
    expect(sim.trains.some((t) => t.wrecked)).toBe(false);
  }, 120000);

  it('does not reserve occupied siding space or lose wagons when a return is canceled', () => {
    const sim = town();
    for (const point of sim.places.filter((p) => p.place.spares)) {
      const blocker = sim.addTrain(Array.from({ length: 8 }, () => ({ stockId: 'hopper', reversed: false })), { edgeKey: point.edgeKey, s: point.s, reversed: false });
      expect(typeof blocker).not.toBe('string');
    }
    const train = sim.addJobTrain('coal') as Train;
    const cars = train.consist.map((c) => ({ ...c }));
    expect(sim.yard.park(train)).toBe(false);
    expect(train.consist).toEqual(cars);
    for (const other of [...sim.trains]) if (other !== train) sim.removeTrain(other.id);
    expect(sim.yard.park(train)).toBe(true);
    sim.yard.stop();
    expect(sim.yard.busy).toBe(0);
    expect(train.errand).toBe(false);
    expect(train.consist).toEqual(cars);
    expect(sim.yard.park(train)).toBe(true);
  });

  it('calls off a return when its siding marker is removed, keeping the loaded train intact', () => {
    const sim = coalTown();
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    for (const entry of train.consist) if (getStock(entry.stockId).cargo) entry.units = 2;
    expect(sim.yard.park(train)).toBe(true);
    const layout = sim.network.layout;
    sim.setLayout({ ...layout, pieces: layout.pieces.filter((p) => p.pieceId !== 'car-sidings') });
    sim.advance(0.1);
    expect(sim.yard.busy).toBe(0);
    expect(train.errand).toBe(false);
    expect(train.consist.filter((c) => c.stockId === 'hopper').map((c) => c.units)).toEqual([2, 2, 2]);
    expect(sim.trains).toHaveLength(1);
  });

  it('keeps ordinary freight working when sidings have no engine shed to fetch cars from', () => {
    const sim = coalTown();
    const layout = sim.network.layout;
    sim.setLayout({ ...layout, pieces: layout.pieces.filter((p) => p.pieceId !== 'engine-shed') });
    const mine = sim.economy.all('coal-mine')[0];
    mine.stock.coal = 6;
    mine.crew = [1];
    sim.economy.all('coaling-stage')[0].stock.coal = 0;
    sim.operator.setOn(true);
    expect(sim.yard.spares().get('coal')).toBeGreaterThan(0);
    sim.advance(0.1);
    const train = sim.trains.find((t) => t.job === 'coal');
    expect(train).toBeDefined();
    expect(train!.vehicles.some((v) => v.def.motor)).toBe(true);
    expect(sim.yard.park(train!)).toBe(false);
  });

  it('parks loaded wagons, keeps their cargo, then fetches and delivers them when a consumer runs low', () => {
    const sim = coalTown();
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    for (const entry of train.consist) if (getStock(entry.stockId).cargo?.kind === 'coal') entry.units = 2;
    expect(sim.yard.park(train)).toBe(true);
    for (let i = 0; i < 1800 && sim.yard.busy; i++) sim.advance(0.1);
    expect(sim.yard.busy, JSON.stringify(sim.trains.map((t) => ({ name: t.name, status: t.status, dispatch: t.dispatch, errand: t.errand })))).toBe(0);
    const parked = sim.trains.find((t) => t.name === 'Parked coal wagons')!;
    expect(parked).toBeDefined();
    expect(parked.consist.map((c) => c.units)).toEqual([2, 2, 2]);
    expect(parked.vehicles.some((v) => v.def.motor)).toBe(false);
    expect(sim.train(train.id)).toBeUndefined();
    expect(sim.yard.fetch('coal')).toBeNull();
    const receiver = sim.economy.all('coaling-stage')[0];
    receiver.stock.coal = 0;
    const engine = sim.yard.fetch('coal');
    expect(engine).not.toBeNull();
    for (let i = 0; i < 1800 && engine!.errand; i++) sim.advance(0.1);
    expect(engine!.consist.filter((c) => c.stockId === 'hopper').map((c) => c.units)).toEqual([2, 2, 2]);
    expect(sim.train(parked.id)).toBeUndefined();
    for (let i = 0; i < 1800 && (receiver.stock.coal ?? 0) < 6; i++) sim.advance(0.1);
    expect(receiver.stock.coal).toBe(6);
    expect(sim.trains.some((t) => t.wrecked)).toBe(false);
  }, 120000);

  it('parks rakes of spare cars at the car sidings, one job each', () => {
    const sim = town();
    expect(sim.places.filter((p) => p.place.spares).length).toBe(2);
    const n = sim.yard.stock();
    expect(n).toBeGreaterThanOrEqual(3);
    const rakes = sim.trains;
    expect(rakes.length).toBe(n);
    expect(rakes.every((t) => t.job === 'free' && !t.vehicles.some((v) => v.def.motor))).toBe(true);
    expect(new Set([...sim.yard.spares().keys()]).size).toBe(n);
    // Parked apart: none has coupled onto another.
    sim.advance(0.1);
    expect(sim.trains.length).toBe(n);
  });

  it('releases reserved cars when the engine fetching them is removed', () => {
    const sim = town();
    sim.yard.stock();
    const before = sim.yard.spares();
    const job = [...before.keys()].find((j) => sim.yard.fetch(j))!;
    const engine = sim.trains.find((t) => t.errand)!;
    expect(engine).toBeDefined();
    expect(sim.yard.spares().has(job)).toBe(false);
    sim.removeTrain(engine.id);
    sim.advance(0.1);
    expect(sim.yard.spares()).toEqual(before);
  });

  it('stocks newly loaded sidings with hands-off mode already on, without duplicating cars on later edits', () => {
    const sim = new TrainSim(getTemplate('oval').build());
    sim.operator.setOn(true);
    expect(sim.yard.spares().size).toBe(0);
    const layout = getTemplate('full-town').build();
    sim.setLayout(layout);
    expect(sim.yard.spares().size).toBeGreaterThan(0);
    const ids = sim.trains.map((t) => t.id);
    sim.setLayout(layout);
    expect(sim.trains.map((t) => t.id)).toEqual(ids);
  });

  it('leaves occupied siding space alone when stocking spare cars', () => {
    const source = town();
    source.yard.stock();
    const parked = source.trains[0];
    const sim = town();
    const existing = sim.addTrain(parked.consist, parked.placement);
    if (typeof existing === 'string') throw new Error(existing);
    const added = sim.yard.stock();
    expect(sim.trains).toHaveLength(added + 1);
    sim.advance(0.1);
    expect(sim.trains).toHaveLength(added + 1);
    expect(sim.trains.some((t) => t.wrecked)).toBe(false);
  });

  it('an engine comes out of the shed, turns on the turntable, backs onto its cars and goes to work', () => {
    const sim = town();
    sim.yard.stock();
    const job = [...sim.yard.spares().keys()].find((j) => sim.yard.fetch(j))!;
    expect(job).toBeTruthy();
    const engine = sim.trains.find((t) => t.errand)!;
    expect(engine.consist.map((c) => c.stockId)).toEqual(['steam-engine', 'tender']);
    // The shed's turntable: the one nearest the engine.
    const at = engine.vehicles[0].geo.center;
    const table = [...sim.turntables].sort((a, b) => Math.hypot(a.center.x - at.x, a.center.y - at.y) - Math.hypot(b.center.x - at.x, b.center.y - at.y))[0];
    const turned = new Set<number>();
    for (let i = 0; i < 1200 && engine.errand; i++) {
      sim.advance(0.1);
      turned.add(Math.round(sim.tables.get(table.uid)!.angle * 100));
    }
    expect(engine.errand).toBe(false);
    expect(sim.train(engine.id)).toBe(engine);
    expect(engine.job).toBe(job);
    expect(engine.consist.length).toBe(5);
    expect(engine.consist.slice(2).every((c) => !c.reversed)).toBe(true);
    expect(sim.notices.some((n) => n.message.includes('coupled up to its cars'))).toBe(true);
    // The bridge turned: once to the shed, once to send the engine out.
    expect(turned.size).toBeGreaterThan(2);
    // And it goes on to work, the right way round.
    for (let i = 0; i < 300; i++) sim.advance(0.1);
    expect(engine.destination).not.toBeNull();
    expect(sim.trains.some((t) => t.wrecked)).toBe(false);
  }, 60000);

  it('running hands off, the full town fetches cars from the yard without trains touching', () => {
    const sim = new TrainSim(getTemplate('full-town').build());
    sim.useEconomy = true;
    sim.operator.setOn(true);
    for (let i = 0; i < 150 * 10; i++) sim.advance(0.1);
    expect(sim.notices.filter((n) => n.message.includes('came out of the engine shed')).length).toBeGreaterThanOrEqual(2);
    expect(sim.notices.filter((n) => n.message.includes('coupled up to its cars')).length).toBeGreaterThanOrEqual(2);
    expect(sim.trains.filter((t) => t.wrecked).map((t) => t.name)).toEqual([]);
  }, 180000);
});
