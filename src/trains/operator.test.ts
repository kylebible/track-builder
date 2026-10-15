import { describe, expect, it } from 'vitest';
import { poseAt } from '../geometry/path';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Extension, type Layout } from '../layout/layout';
import { ECONOMY } from './economy';
import { TrackNetwork } from './network';
import { OPERATOR } from './operator';
import { TrainSim } from './sim';

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
/** A big oval, three long straights a side, with places on its straights. */
function withPlaces(...ids: string[]): Layout {
  let layout = build('straight-long', ['straight-long', 'straight-long', ...quarter, 'straight-long', 'straight-long', 'straight-long', ...quarter]);
  const straights = new TrackNetwork(layout).edges.filter((e) => e.pieceId === 'straight-long');
  ids.forEach((id, i) => (layout = addPiece(layout, id, poseAt(straights[i].path, straights[i].length / 2)).layout));
  return layout;
}

function run(sim: TrainSim, seconds: number): void {
  for (let i = 0; i < seconds * 30; i++) sim.advance(1 / 30);
}

describe('running the jobs by themselves', () => {
  it('does nothing until switched on', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    run(sim, 10);
    expect(sim.trains).toHaveLength(0);
  });

  it('does not send freight trains to collect goods from an empty storage depot', () => {
    const sim = new TrainSim(withPlaces('station', 'depot'));
    expect([...sim.operator.wanted().keys()]).toEqual(['workers']);
    sim.economy.all('depot')[0].stock.coal = 6;
    expect([...sim.operator.wanted().keys()]).toEqual(['workers']);
    // Stored goods can supply a real consumer even when there is no mine.
    const supplied = new TrainSim(withPlaces('station', 'depot', 'power-station'));
    supplied.economy.all('depot')[0].stock.coal = 6;
    expect([...supplied.operator.wanted().keys()].sort()).toEqual(['coal', 'workers']);
  });

  it('puts on trains for the jobs the places have, one at a time, no more than the track has room for', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    sim.operator.setOn(true);
    run(sim, 1);
    expect(sim.trains).toHaveLength(1);
    run(sim, 3 * OPERATOR.addGapSeconds);
    const jobs = sim.trains.map((t) => t.job).sort();
    expect(jobs).toContain('coal');
    expect(jobs).toContain('workers');
    expect(sim.trains.length).toBeLessThanOrEqual(sim.operator.trainCap);
    // Nothing else makes or takes goods here, so no trains for other jobs.
    expect(jobs.every((j) => j === 'coal' || j === 'workers')).toBe(true);
  });

  it('couples another engine on a job train that stalls', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    sim.operator.setOn(true);
    const engines = () => train.vehicles.filter((v) => v.def.motor).length;
    expect(engines()).toBe(1);
    train.status = { kind: 'stuck', stuck: 'stalled', message: 'stalled', at: train.vehicles[0].geo.center };
    sim.operator.tick(0.01);
    sim.time += OPERATOR.stallSeconds;
    sim.operator.tick(0.01);
    expect(engines()).toBe(2);
    expect(sim.notices.at(-1)?.message).toMatch(/another engine/);
  });

  it('lifts off a job train that has come off the rails', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    sim.operator.setOn(true);
    train.wrecked = true;
    train.status = { kind: 'stuck', stuck: 'derailed', message: 'off', at: train.vehicles[0].geo.center };
    sim.operator.tick(0.01);
    sim.time += OPERATOR.wreckSeconds;
    sim.operator.tick(0.01);
    expect(sim.trains).not.toContain(train);
  });

  it('tops up a job train that has run dry', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    const train = sim.addJobTrain('coal');
    if (typeof train === 'string') throw new Error(train);
    sim.operator.setOn(true);
    train.consist[0].water = 0;
    train.status = { kind: 'stuck', stuck: 'no-water', message: 'dry', at: train.vehicles[0].geo.center };
    sim.operator.tick(0.01);
    sim.time += OPERATOR.stallSeconds;
    sim.operator.tick(0.01);
    expect(train.consist[0].water).toBeGreaterThan(0.5);
  });

  it('leaves trains you added by hand alone', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    const mine = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: sim.network.edges[0].key, s: 100, reversed: false });
    if (typeof mine === 'string') throw new Error(mine);
    sim.operator.setOn(true);
    mine.wrecked = true;
    mine.status = { kind: 'stuck', stuck: 'derailed', message: 'off', at: mine.vehicles[0].geo.center };
    sim.operator.tick(0.01);
    sim.time += OPERATOR.wreckSeconds * 2;
    sim.operator.tick(0.01);
    expect(sim.trains).toContain(mine);
  });

  it('makes shifts longer on a big layout, and puts them back when switched off', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage'));
    const track = sim.network.edges.reduce((s, e) => s + e.length, 0);
    sim.operator.setOn(true);
    expect(sim.economy.shiftScale).toBeCloseTo(Math.max(1, (OPERATOR.shiftLaps * track) / OPERATOR.lapSpeed / ECONOMY.shiftSeconds), 5);
    sim.operator.setOn(false);
    expect(sim.economy.shiftScale).toBe(1);
  });

  it('keeps a small town going for five minutes with nobody touching it', () => {
    const sim = new TrainSim(withPlaces('coal-mine', 'station', 'coaling-stage', 'water-tower', 'farm', 'market'));
    sim.operator.setOn(true);
    run(sim, 300);
    expect(sim.trains.some((t) => t.wrecked)).toBe(false);
    expect(Object.values(sim.delivered).reduce((a, b) => a + (b ?? 0), 0)).toBeGreaterThan(3);
    const staff = [...sim.economy.sites.values()].reduce((n, s) => n + (s.place.staff ?? 0), 0);
    const crew = [...sim.economy.sites.values()].reduce((n, s) => n + s.crew.length, 0);
    expect(crew).toBeGreaterThan(staff / 2);
  }, 120000);
});
