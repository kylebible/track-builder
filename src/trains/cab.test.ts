import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Layout } from '../layout/layout';
import { cabPose, EYE_ABOVE_ROOF, travelWay } from './cab';
import { TrainSim, type Train } from './sim';
import { AXLE_HEIGHT } from './trainMesh';

function line(n: number): Layout {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
  let end: EndRef = { uid, connectorId: 'b' };
  for (let i = 1; i < n; i++) {
    const ext = extendFrom(layout, end, 'straight-long')!;
    layout = ext.layout;
    end = ext.next!;
  }
  return layout;
}

function train(): { sim: TrainSim; t: Train } {
  const sim = new TrainSim(line(6));
  const t = sim.addTrain([{ stockId: 'wagon', reversed: false }, { stockId: 'battery-engine', reversed: false }, { stockId: 'wagon', reversed: false }], { edgeKey: 'p3:0', s: 50, reversed: false });
  if (typeof t === 'string') throw new Error(t);
  return { sim, t };
}

const angleBetween = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('riding along', () => {
  it('rides on whichever vehicle leads, above its roof', () => {
    const { t } = train();
    const pose = cabPose(t, 1);
    expect(pose.vehicle).toBe(t.vehicles[0]);
    expect(pose.z).toBeCloseTo(pose.vehicle.geo.z + AXLE_HEIGHT + pose.vehicle.def.height + EYE_ABOVE_ROOF);
    expect(cabPose(t, -1).vehicle).toBe(t.vehicles[2]);
  });

  it('sits over an engine’s cab, at its own back, whichever way it goes', () => {
    const sim = new TrainSim(line(4));
    const t = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p2:0', s: 100, reversed: false });
    if (typeof t === 'string') throw new Error(t);
    const { center, heading } = t.vehicles[0].geo;
    for (const way of [1, -1] as const) {
      const pose = cabPose(t, way);
      // Behind the middle, measured along the engine's own front.
      expect((pose.x - center.x) * Math.cos(heading) + (pose.y - center.y) * Math.sin(heading)).toBeLessThan(-5);
    }
  });

  it('looks the way the train goes, and turns round when it backs up', () => {
    const { sim, t } = train();
    sim.setThrottle(t.id, 1);
    for (let i = 0; i < 60; i++) sim.advance(1 / 60);
    const way = travelWay(t, 1);
    const front = t.vehicles[0].geo.center;
    const back = t.vehicles[t.vehicles.length - 1].geo.center;
    const forwardHeading = Math.atan2(front.y - back.y, front.x - back.x);
    // Going: whichever way the engine pushes, the view faces that way.
    const going = cabPose(t, way);
    const step = sim.train(t.id)!.vehicles.map((v) => v.u);
    sim.advance(0.1);
    const moved = sim.train(t.id)!.vehicles[0].u - step[0];
    expect(Math.sign(moved)).toBe(way);
    expect(angleBetween(going.heading, way === 1 ? forwardHeading : forwardHeading + Math.PI)).toBeLessThan(0.05);

    sim.setThrottle(t.id, -1);
    for (let i = 0; i < 120; i++) sim.advance(1 / 60);
    const back2 = travelWay(t, way);
    expect(back2).toBe(-way);
    expect(angleBetween(cabPose(t, back2).heading, going.heading + Math.PI)).toBeLessThan(0.05);
  });

  it('keeps facing the last way when the train stands still', () => {
    const { t } = train();
    expect(travelWay(t, -1)).toBe(-1);
    expect(travelWay(t, 1)).toBe(1);
  });
});
