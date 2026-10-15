import { describe, expect, it } from 'vitest';
import { poseAt } from '../geometry/path';
import { IDENTITY, type Pose } from '../geometry/pose';
import { TrackNetwork } from '../trains/network';
import { TrainSim } from '../trains/sim';
import { autoPlaceBuildings, BUILDING_INTERVALS, DEFAULT_BUILDINGS, placeBuildings, type BuildingOptions } from './buildings';
import { addPiece, baseOf, EMPTY_LAYOUT, extendFrom, type EndRef, type Layout } from './layout';

const options = (ids = ['coaling-stage'], extra: Partial<BuildingOptions> = {}): BuildingOptions => ({ ids, spacing: 1, supplyChain: false, ...extra });

function line(n: number, base = EMPTY_LAYOUT, at: Pose = IDENTITY, z = 0): Layout {
  let { layout, uid } = addPiece(base, 'straight-long', at, false, z);
  for (let i = 1; i < n; i++) {
    const next = extendFrom(layout, { uid, connectorId: 'b' }, 'straight-long')!;
    layout = next.layout;
    uid = next.uid;
  }
  return layout;
}

function oval(n = 4): Layout {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
  for (const id of [...Array(n - 1).fill('straight-long'), ...Array(4).fill('curve-large'), ...Array(n).fill('straight-long'), ...Array(4).fill('curve-large')]) {
    const next = extendFrom(layout, { uid, connectorId: 'b' }, id)!;
    layout = next.layout;
    uid = next.uid;
  }
  return layout;
}

describe('automatically placing job buildings', () => {
  it('covers a long line for all three supplies, preserves the track, and can be run again without duplicates', () => {
    const base = line(100);
    const original = structuredClone(base);
    const result = autoPlaceBuildings(base, DEFAULT_BUILDINGS);
    expect(result.uids.length).toBeGreaterThan(10);
    expect(result.uncovered).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(base).toEqual(original);
    expect(result.layout.pieces.filter((p) => !result.uids.includes(p.uid))).toEqual(base.pieces);
    for (const c of result.coverage) {
      expect(c.longestGap).not.toBeNull();
      expect(c.longestGap!).toBeLessThanOrEqual(BUILDING_INTERVALS[c.id]);
      const xs = result.layout.pieces.filter((p) => p.pieceId === c.id).map((p) => p.pose.x).sort((a, b) => a - b);
      expect(xs[0] * 2).toBeLessThanOrEqual(c.interval);
      expect((100 * 216 - xs[xs.length - 1]) * 2).toBeLessThanOrEqual(c.interval);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThanOrEqual(c.interval);
    }
    const sim = new TrainSim(result.layout);
    for (const id of ['coaling-stage', 'water-tower', 'charging-post', 'coal-mine', 'pump-house']) {
      expect(sim.places.filter((p) => p.place.id === id)).toHaveLength(result.layout.pieces.filter((p) => p.pieceId === id).length);
      expect(sim.places.some((p) => p.place.id === id)).toBe(true);
    }
    expect(sim.economy.all('station')).toHaveLength(1);
    expect(autoPlaceBuildings(result.layout, DEFAULT_BUILDINGS).uids).toEqual([]);
  });

  it('checks the whole run round a loop, rather than the nearest building in plan or a shortcut backwards', () => {
    const result = autoPlaceBuildings(oval(25), options());
    expect(result.coverage[0].added).toBeGreaterThanOrEqual(3);
    expect(result.coverage[0].longestGap).toBeLessThanOrEqual(BUILDING_INTERVALS['coaling-stage']);
    expect(result.uncovered).toEqual([]);
    const sim = new TrainSim(result.layout);
    const offsets = new Map<string, number>();
    let total = 0;
    for (const edge of sim.network.edges) { offsets.set(edge.key, total); total += edge.length; }
    const along = sim.places.filter((p) => p.place.id === 'coaling-stage').map((p) => offsets.get(p.edgeKey)! + p.s).sort((a, b) => a - b);
    for (let i = 0; i < along.length; i++) expect((along[(i + 1) % along.length] + (i === along.length - 1 ? total : 0)) - along[i]).toBeLessThanOrEqual(BUILDING_INTERVALS['coaling-stage']);
  });

  it('services both roads of double track without treating them as joined or putting a building over the other road', () => {
    const base = addPiece(EMPTY_LAYOUT, 'double-straight', IDENTITY).layout;
    const result = autoPlaceBuildings(base, options(['charging-post']));
    expect(result.coverage[0].added).toBe(2);
    expect(result.uncovered).toEqual([]);
    const places = new TrainSim(result.layout).places;
    expect(new Set(places.map((p) => p.edgeKey)).size).toBe(2);
    const posts = result.layout.pieces.filter((p) => p.pieceId === 'charging-post');
    expect(Math.cos(posts.find((p) => p.pose.y === 0)!.pose.angle)).toBeCloseTo(1);
    expect(Math.cos(posts.find((p) => p.pose.y < 0)!.pose.angle)).toBeCloseTo(-1);
  });

  it('checks every switch branch and includes the return from dead-end roads', () => {
    let { layout, uid } = addPiece(EMPTY_LAYOUT, 'switch-curved', IDENTITY);
    for (const connectorId of ['trunk', 'branch0', 'branch1']) {
      let end: EndRef = { uid, connectorId };
      for (let i = 0; i < 30; i++) {
        const next = extendFrom(layout, end, 'straight-long')!;
        layout = next.layout;
        end = next.next!;
      }
    }
    const result = autoPlaceBuildings(layout, options());
    expect(result.uncovered).toEqual([]);
    expect(result.coverage[0].longestGap).toBeLessThanOrEqual(BUILDING_INTERVALS['coaling-stage']);
    expect(result.coverage[0].added).toBeGreaterThanOrEqual(6);
  });

  it('gives separate sections their own services and supply buildings', () => {
    const base = line(12, line(12), { x: 0, y: 700, angle: 0 });
    const result = autoPlaceBuildings(base, DEFAULT_BUILDINGS);
    expect(result.uncovered).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const id of [...DEFAULT_BUILDINGS.ids, 'coal-mine', 'pump-house', 'station']) {
      const pieces = result.layout.pieces.filter((p) => p.pieceId === id);
      expect(pieces.some((p) => p.pose.y < 350)).toBe(true);
      expect(pieces.some((p) => p.pose.y > 350)).toBe(true);
    }
  });

  it('keeps disconnected tracks at different heights separate and seats buildings at the correct height', () => {
    const base = line(15, line(15), { x: 0, y: 0, angle: 0 }, 64);
    const result = autoPlaceBuildings(base, options(['water-tower']));
    const buildings = result.layout.pieces.filter((p) => result.uids.includes(p.uid));
    expect(result.uncovered).toEqual([]);
    expect(buildings.some((p) => baseOf(p) === 0)).toBe(true);
    expect(buildings.some((p) => baseOf(p) === 64)).toBe(true);
    expect(new TrainSim(result.layout).places.filter((p) => p.place.id === 'water-tower')).toHaveLength(buildings.length);
  });

  it('counts existing working buildings, including a stop away from the middle of a straight', () => {
    const base = oval(2), net = new TrackNetwork(base);
    const edge = net.edges.find((e) => e.pieceId === 'straight-long')!;
    const at = poseAt(edge.path, edge.length * 0.75);
    const layout = addPiece(base, 'charging-post', at).layout;
    const result = autoPlaceBuildings(layout, options(['charging-post']));
    expect(result.uids).toEqual([]);
    expect(result.coverage[0].existing).toBe(1);
    expect(result.uncovered).toEqual([]);
  });

  it('reports curved track with no seat, while still covering another section', () => {
    let { layout, uid } = addPiece(EMPTY_LAYOUT, 'curve-large', IDENTITY);
    for (let i = 1; i < 8; i++) {
      const next = extendFrom(layout, { uid, connectorId: 'b' }, 'curve-large')!;
      layout = next.layout;
      uid = next.uid;
    }
    const result = autoPlaceBuildings(line(10, layout, { x: 4000, y: 0, angle: 0 }), options());
    expect(result.coverage[0].added).toBeGreaterThan(0);
    expect(result.coverage[0].longestGap).toBeNull();
    expect(result.uncovered).toHaveLength(8);
  });

  it('honours environment and pump-water restrictions and reports missing supply buildings', () => {
    const base = line(20);
    const blocked = autoPlaceBuildings(base, DEFAULT_BUILDINGS, { allowed: () => false });
    expect(blocked.uids).toEqual([]);
    expect(blocked.uncovered).toHaveLength(20);
    const dry = autoPlaceBuildings(base, options(['water-tower'], { supplyChain: true }), { waterNear: () => false });
    expect(dry.layout.pieces.some((p) => p.pieceId === 'pump-house')).toBe(false);
    expect(dry.warnings.some((s) => s.includes('pump house'))).toBe(true);
    expect(dry.layout.pieces.some((p) => p.pieceId === 'station')).toBe(true);
    const withDryPump = addPiece(base, 'pump-house', { x: 108, y: 0, angle: 0 }).layout;
    const repaired = autoPlaceBuildings(withDryPump, options(['water-tower'], { supplyChain: true }), { waterNear: (at) => at.x > 1200 });
    expect(repaired.layout.pieces.some((p) => repaired.uids.includes(p.uid) && p.pieceId === 'pump-house' && p.pose.x > 1200)).toBe(true);
    expect(repaired.warnings.some((s) => s.includes('existing pump house'))).toBe(true);
  });

  it('supports selected job buildings, closer intervals, and a bounded batch', () => {
    const base = line(80);
    const normal = autoPlaceBuildings(base, options(['farm', 'market']));
    const closer = autoPlaceBuildings(base, options(['farm', 'market'], { spacing: 0.25 }));
    expect(normal.uncovered).toEqual([]);
    expect(closer.uncovered).toEqual([]);
    expect(closer.uids.length).toBeGreaterThan(normal.uids.length);
    expect(normal.layout.pieces.filter((p) => normal.uids.includes(p.uid)).every((p) => ['farm', 'market'].includes(p.pieceId))).toBe(true);
    const limited = autoPlaceBuildings(base, DEFAULT_BUILDINGS, { maxAdded: 2 });
    expect(limited.uids).toHaveLength(2);
    expect(limited.limited).toBe(true);
    expect(limited.uncovered.length).toBeGreaterThan(0);
  });

  it('handles empty track, no selection, and a canceled preview without editing the input', () => {
    expect(autoPlaceBuildings(EMPTY_LAYOUT).uids).toEqual([]);
    expect(autoPlaceBuildings(line(10), options([])).uids).toEqual([]);
    const base = line(50), original = structuredClone(base);
    const search = placeBuildings(base, DEFAULT_BUILDINGS);
    expect(search.next().value.uids).toEqual([]);
    const next = search.next();
    expect(next.value.uids.length).toBeGreaterThan(0);
    search.return(next.value);
    expect(base).toEqual(original);
  });

  it('places a charger that a running battery engine actually stops at and uses', () => {
    const result = autoPlaceBuildings(oval(4), options(['charging-post']));
    const sim = new TrainSim(result.layout);
    sim.useSupplies = true;
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false, charge: 0.3 }], { edgeKey: 'p1:0', s: 108, reversed: false });
    if (typeof train === 'string') throw new Error(train);
    sim.setThrottle(train.id, 1);
    for (let i = 0; i < 60 * 60 && (train.consist[0].charge ?? 0) < 0.98; i++) sim.advance(1 / 60);
    expect(train.consist[0].charge).toBeGreaterThanOrEqual(0.98);
  });
});
