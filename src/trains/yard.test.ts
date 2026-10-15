import { describe, expect, it } from 'vitest';
import { getTemplate } from '../templates/templates';
import { TrainSim } from './sim';

const town = () => {
  const sim = new TrainSim(getTemplate('full-town').build());
  sim.useEconomy = true;
  sim.setAutoroute(true);
  return sim;
};

describe('yard', () => {
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
