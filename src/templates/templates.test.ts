import { describe, expect, it } from 'vitest';
import { checkLayout } from '../planning/check';
import { getEnvironment, offArea } from '../environments/environments';
import { getPlace, PLACES } from '../trains/stops';
import { TrainSim } from '../trains/sim';
import { getTemplate, TEMPLATES } from './templates';

describe('templates', () => {
  for (const t of TEMPLATES) {
    it(`${t.name} passes the layout check`, () => {
      const layout = t.build();
      expect(checkLayout(layout).map((i) => i.message)).toEqual([]);
    });
    it(`${t.name} fits on ${t.environment ? 'its scene' : 'the play table'}`, () => {
      expect(offArea(t.build(), getEnvironment(t.environment ?? 'table'))).toBeNull();
    });
  }

  it('the full town has every trackside place, every accessory, and every kind of scenery', () => {
    const layout = getTemplate('full-town').build();
    const ids = new Set(layout.pieces.map((p) => p.pieceId));
    for (const place of PLACES) expect(ids, place.id).toContain(place.id);
    for (const id of ['signal', 'crane', 'cargo-loader', 'lift-bridge', 'level-crossing', 'tunnel', 'engine-shed', 'cottage', 'leafy-tree', 'pine-tree', 'bridge-viaduct', 'ramp', 'turntable']) expect(ids, id).toContain(id);
    // And each one is where a train can use it.
    const sim = new TrainSim(layout);
    expect(sim.places.length).toBe(layout.pieces.filter((p) => getPlace(p.pieceId) && p.pieceId !== 'station').length);
    expect(new Set(sim.accessories.map((a) => a.kind))).toEqual(new Set(['signal', 'station', 'bridge', 'loader', 'crane', 'turntable']));
  });
});
