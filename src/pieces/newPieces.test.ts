import { describe, expect, it } from 'vitest';
import { heightAt, pathLength } from '../geometry/path';
import { distance, IDENTITY, normalizeAngle } from '../geometry/pose';
import { flipFor, SHAPES, turnFrom, variantFor } from '../builder/variants';
import { addPiece, EMPTY_LAYOUT, extendFrom, findJoints, openEnds, reshapePiece, swapEnd, worldEnd, type Layout } from '../layout/layout';
import { supportsOf } from '../layout/supports';
import { checkLayout } from '../planning/check';
import { layoutFromJson, layoutToJson } from '../planning/file';
import { partsList } from '../planning/parts';
import { TrackNetwork } from '../trains/network';
import { TrainSim, type Train } from '../trains/sim';
import { BENDY_IDS, getPiece } from './catalog';
import * as D from './dimensions';

const shape = (id: string) => SHAPES.find((s) => s.ids.includes(id))!;

describe('middle straight', () => {
  it('is A3, half an A', () => {
    const piece = getPiece('straight-middle');
    expect(piece.brioIds).toEqual(['A3']);
    expect(pathLength(piece.paths[0])).toBe(D.MEDIUM_STRAIGHT / 2);
    expect(shape('straight-middle').ids).toEqual(['straight-middle']);
  });
});

describe('bendy track', () => {
  it('keeps its length however far it bends, up to an eighth of a circle', () => {
    for (const id of BENDY_IDS) expect(pathLength(getPiece(id).paths[0])).toBeCloseTo(D.BENDY_LENGTH, 9);
    const last = getPiece(BENDY_IDS[BENDY_IDS.length - 1]);
    expect(last.bend).toBe(45);
    expect(normalizeAngle(last.connectors[1].pose.angle)).toBeCloseTo(D.CURVE_ANGLE, 9);
  });

  it('is one palette tile', () => {
    expect(shape('bendy').ids).toEqual(BENDY_IDS);
    expect(variantFor(shape('bendy'), 'mixed', null)).toBe('bendy');
  });

  it('counts as one piece on the parts list however it is bent', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'bendy', IDENTITY).layout;
    layout = addPiece(layout, 'bendy-b3', { x: 0, y: 400, angle: 0 }).layout;
    layout = addPiece(layout, 'bendy-b6', { x: 0, y: 800, angle: 0 }, true).layout;
    const list = partsList(layout);
    expect(list.lines).toHaveLength(1);
    expect(list.lines[0]).toMatchObject({ pieceId: 'bendy', name: 'Bendy track', count: 3 });
  });

  it('bends about the end it is joined by, the way asked', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'bendy')!;
    layout = ext.layout;
    const id = 'bendy-b6';
    const bent = reshapePiece(layout, ext.uid, id, (anchor) => flipFor(id, anchor, 'right'));
    expect(findJoints(bent)).toHaveLength(1);
    const far = worldEnd(bent, { uid: ext.uid, connectorId: 'b' }).connector.pose;
    expect(normalizeAngle(far.angle)).toBeCloseTo(-D.CURVE_ANGLE, 9);
    expect(far.y).toBeLessThan(0);
  });

  it('saves and loads each bend', () => {
    const layout = addPiece(EMPTY_LAYOUT, 'bendy-b2', IDENTITY, true).layout;
    expect(layoutFromJson(layoutToJson(layout)).pieces[0]).toMatchObject({ pieceId: 'bendy-b2', flipped: true });
  });
});

describe('double track', () => {
  it('has two tracks the guide spacing apart', () => {
    for (const id of ['double-straight', 'double-curve-large', 'double-curve-short']) {
      const piece = getPiece(id);
      const [a, , c] = piece.connectors;
      expect(distance(a.pose, c.pose), id).toBeCloseTo(D.DOUBLE_TRACK_SPACING, 9);
      expect(piece.category).toBe('double');
    }
    expect(['double-straight', 'double-curve-large', 'double-curve-short'].map((id) => getPiece(id).brioIds[0])).toEqual(['K1', 'EE', 'EE1']);
  });

  it('curves keep the second track outside the first, both turning an eighth', () => {
    const piece = getPiece('double-curve-large');
    const [inner, outer] = piece.paths;
    expect(inner.kind === 'arc' && inner.radius).toBe(D.LARGE_CURVE_RADIUS);
    expect(outer.kind === 'arc' && outer.radius).toBe(D.LARGE_CURVE_RADIUS + D.DOUBLE_TRACK_SPACING);
    const [, b, , d] = piece.connectors;
    expect(b.pose.angle).toBeCloseTo(D.CURVE_ANGLE, 9);
    expect(d.pose.angle).toBeCloseTo(D.CURVE_ANGLE, 9);
    // Entered by either track, it turns left an eighth, not muddled by the other start.
    expect(turnFrom(piece, 'a')).toBeCloseTo(2 * D.CURVE_ANGLE, 9);
    expect(flipFor(piece.id, 'a', 'right')).toBe(true);
    expect(flipFor(piece.id, 'c', 'left')).toBe(false);
  });

  it('joins single track on either track, and Reverse moves it across', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    const ext = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'double-straight')!;
    layout = ext.layout;
    expect(ext.attached).toBe('a');
    const swapped = swapEnd(layout, ext.uid)!;
    expect(findJoints(swapped)).toEqual([{ a: { uid: 'p1', connectorId: 'b' }, b: { uid: ext.uid, connectorId: 'c' } }]);
  });

  it('runs a train down each track without crossing over', () => {
    const layout = addPiece(EMPTY_LAYOUT, 'double-straight', IDENTITY).layout;
    const net = new TrackNetwork(layout);
    expect(net.edges).toHaveLength(2);
    expect(net.switches()).toEqual([]);
    const onward = net.onward(net.edges[0], 1, () => 0);
    expect(onward.kind).toBe('open');
  });

  it('is on the parts list under double track', () => {
    const layout = addPiece(EMPTY_LAYOUT, 'double-curve-short', IDENTITY).layout;
    expect(partsList(layout).lines[0]).toMatchObject({ name: 'Short double curve', brioIds: ['EE1'], category: 'double', count: 1 });
  });
});

describe('arch bridge', () => {
  const bridge = getPiece('arch-bridge');

  it('goes up a level, across and back down, with both ends on the floor', () => {
    expect(bridge.connectors.map((c) => c.z ?? 0)).toEqual([0, 0]);
    const [up, top, down] = bridge.paths;
    expect(heightAt(up, 0)).toBe(0);
    expect(heightAt(up, pathLength(up))).toBeCloseTo(D.LEVEL_HEIGHT, 9);
    expect(heightAt(top, 0)).toBe(D.LEVEL_HEIGHT);
    expect(heightAt(top, pathLength(top))).toBe(D.LEVEL_HEIGHT);
    expect(heightAt(down, 0)).toBe(D.LEVEL_HEIGHT);
    expect(heightAt(down, pathLength(down))).toBeCloseTo(0, 9);
  });

  it('stands on its own legs: no support blocks', () => {
    const layout = addPiece(EMPTY_LAYOUT, 'arch-bridge', IDENTITY).layout;
    expect(supportsOf(layout)).toEqual([]);
    expect(partsList(layout).supports).toBe(0);
  });

  /** An arch bridge with a long straight crossing square under the point `along` it. */
  function under(along: number): Layout {
    let layout = addPiece(EMPTY_LAYOUT, 'arch-bridge', IDENTITY).layout;
    const half = D.LONG_STRAIGHT / 2;
    layout = addPiece(layout, 'straight-long', { x: along, y: -half, angle: Math.PI / 2 }).layout;
    return layout;
  }

  it('track can run under the top', () => {
    const issues = checkLayout(under(D.ARCH_BRIDGE_SLOPE + D.ARCH_BRIDGE_TOP / 2));
    expect(issues.filter((i) => i.kind !== 'open-end')).toEqual([]);
  });

  it('track under the slope is too low', () => {
    const issues = checkLayout(under(D.ARCH_BRIDGE_SLOPE / 2));
    expect(issues.some((i) => i.kind === 'overlap' && /too low/.test(i.message))).toBe(true);
  });

  it('a battery engine runs up and over it', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    layout = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'arch-bridge')!.layout;
    expect(openEnds(layout)).toHaveLength(2);
    const sim = new TrainSim(layout);
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p1:0', s: 100, reversed: false }) as Train;
    sim.setThrottle(train.id, 1);
    let highest = 0;
    for (let i = 0; i < 60 * 30 && !train.wrecked && train.status.kind !== 'stuck'; i++) {
      sim.advance(1 / 60);
      highest = Math.max(highest, train.vehicles[0].geo.z);
    }
    expect(highest).toBeCloseTo(D.LEVEL_HEIGHT, 0);
    expect(train.status).toMatchObject({ stuck: 'ran-off' });
  });
});

describe('bridge spans', () => {
  const SPANS = ['bridge-viaduct', 'bridge-suspension', 'bridge-truss', 'bridge-covered'];

  /** A long straight, an N ramp up, the span, and an N1 ramp back down by its top end. */
  function overSpan(id: string): { layout: Layout; span: string } {
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    const up = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'ramp')!;
    const span = extendFrom(up.layout, up.next!, id)!;
    const down = extendFrom(span.layout, span.next!, 'ramp-pp', false, 'b')!;
    return { layout: down.layout, span: span.uid };
  }

  it('carry level track a level up, end to end', () => {
    for (const id of SPANS) {
      const piece = getPiece(id);
      expect(piece.bridge, id).toBeTruthy();
      expect(piece.connectors.map((c) => c.z), id).toEqual([D.LEVEL_HEIGHT, D.LEVEL_HEIGHT]);
    }
  });

  it("join raised track but can't go on at floor level", () => {
    const layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    expect(extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'bridge-truss')).toBeNull();
    const { layout: over, span } = overSpan('bridge-truss');
    expect(findJoints(over).filter((j) => j.a.uid === span || j.b.uid === span)).toHaveLength(2);
    expect(openEnds(over)).toHaveLength(2);
  });

  it('need no support blocks, even under the ramp tops joined to them', () => {
    for (const id of SPANS) expect(supportsOf(overSpan(id).layout), id).toEqual([]);
  });

  it('let floor track run underneath', () => {
    const { layout, span } = overSpan('bridge-suspension');
    const piece = layout.pieces.find((p) => p.uid === span)!;
    const mid = D.SUSPENSION_LENGTH / 2;
    const at = { x: piece.pose.x + mid * Math.cos(piece.pose.angle), y: piece.pose.y + mid * Math.sin(piece.pose.angle) };
    const crossed = addPiece(layout, 'straight-long', { x: at.x, y: at.y - D.LONG_STRAIGHT / 2, angle: Math.PI / 2 }).layout;
    expect(checkLayout(crossed).filter((i) => i.kind !== 'open-end')).toEqual([]);
  });

  it('a battery engine runs up, across and down', () => {
    const { layout } = overSpan('bridge-viaduct');
    const sim = new TrainSim(layout);
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p1:0', s: 100, reversed: false }) as Train;
    sim.setThrottle(train.id, 1);
    for (let i = 0; i < 60 * 40 && !train.wrecked && train.status.kind !== 'stuck'; i++) sim.advance(1 / 60);
    expect(train.status).toMatchObject({ stuck: 'ran-off' });
  });

  it('show on the parts list under ramps and bridges', () => {
    const lines = partsList(overSpan('bridge-covered').layout).lines;
    expect(lines.find((l) => l.pieceId === 'bridge-covered')).toMatchObject({ name: 'Covered bridge', category: 'ramp', count: 1 });
  });
});

describe('more track types', () => {
  it('half curves turn a sixteenth of a circle, with peg and hole versions', () => {
    for (const id of ['curve-large-half', 'curve-short-half']) {
      expect(getPiece(id).connectors[1].pose.angle).toBeCloseTo(D.HALF_CURVE_ANGLE, 9);
      expect(shape(id).ids).toEqual([id, `${id}-pp`, `${id}-hh`]);
    }
    // Two half curves make a curve.
    let layout = addPiece(EMPTY_LAYOUT, 'curve-large-half', IDENTITY).layout;
    layout = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'curve-large-half')!.layout;
    const end = worldEnd(layout, { uid: 'p2', connectorId: 'b' }).connector.pose;
    const curve = getPiece('curve-large').connectors[1].pose;
    expect(distance(end, curve)).toBeLessThan(1e-9);
  });

  it('the curved ramp climbs a level over a quarter turn', () => {
    const piece = getPiece('ramp-curve');
    expect(piece.connectors.map((c) => c.z ?? 0)).toEqual([0, D.LEVEL_HEIGHT]);
    expect(piece.connectors[1].pose.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(shape('ramp-curve').ids).toEqual(['ramp-curve', 'ramp-curve-pp']);
  });

  it('the helix comes out two levels right over where it went in, with no supports', () => {
    const piece = getPiece('helix');
    const [a, b] = piece.connectors;
    expect(distance(a.pose, b.pose)).toBeLessThan(1e-6);
    expect(b.z).toBe(2 * D.LEVEL_HEIGHT);
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    const up = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'helix')!;
    layout = extendFrom(up.layout, up.next!, 'straight-long')!.layout;
    expect(supportsOf(layout).filter((s) => s.uids.includes(up.uid))).toEqual([]);
    // Each turn clears the one below it.
    expect(checkLayout(layout).filter((i) => i.kind !== 'open-end')).toEqual([]);
  });

  it('a battery engine climbs the helix', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    const up = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'helix')!;
    layout = up.layout;
    const sim = new TrainSim(layout);
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p1:0', s: 100, reversed: false }) as Train;
    sim.setThrottle(train.id, 1);
    let highest = 0;
    for (let i = 0; i < 60 * 60 && !train.wrecked && train.status.kind !== 'stuck'; i++) {
      sim.advance(1 / 60);
      highest = Math.max(highest, train.vehicles[0].geo.z);
    }
    expect(highest).toBeGreaterThan(2 * D.LEVEL_HEIGHT - 2);
  });

  it('the five-point switch is Q, an A long, with five ways on', () => {
    const piece = getPiece('switch-five-point');
    expect(piece.brioIds).toEqual(['Q']);
    expect(getPiece('switch-five-point-peg').brioIds).toEqual([]);
    const angles = piece.connectors.slice(1).map((c) => (c.pose.angle * 180) / Math.PI).sort((x, y) => x - y);
    expect(angles.map((x) => Math.round(x * 10) / 10)).toEqual([-45, -22.5, 0, 22.5, 45]);
    for (const c of piece.connectors.slice(1)) expect(Math.abs(c.pose.x - D.MEDIUM_STRAIGHT)).toBeLessThan(2);
    const net = new TrackNetwork(addPiece(EMPTY_LAYOUT, 'switch-five-point', IDENTITY).layout);
    expect(net.switches()[0].choices).toHaveLength(5);
  });

  it('the newer parallel switches are an A long and line up with double track', () => {
    const single = getPiece('switch-parallel-new');
    expect(single.brioIds).toEqual(['F1']);
    expect(single.connectors[2].pose).toMatchObject({ x: expect.closeTo(D.MEDIUM_STRAIGHT, 9), y: expect.closeTo(D.DOUBLE_TRACK_SPACING, 9) });
    const triple = getPiece('switch-parallel-triple');
    expect(triple.brioIds).toEqual(['F2']);
    expect(triple.connectors.slice(1).map((c) => Math.round(c.pose.y))).toEqual([0, 46, -46]);
    for (const c of triple.connectors.slice(1)) expect(normalizeAngle(c.pose.angle)).toBeCloseTo(0, 9);
  });

  it('the curved crossing is two E curves crossing, entered from the same side', () => {
    const piece = getPiece('cross-curved');
    expect(piece.brioIds).toEqual(['H3']);
    const [a, b, c, d] = piece.connectors;
    expect(a.pose.angle).toBeCloseTo(Math.PI, 9);
    expect(c.pose.angle).toBeCloseTo(Math.PI, 9);
    expect(distance(b.pose, { ...c.pose, x: b.pose.x })).toBeLessThan(1e-9);
    expect(distance(d.pose, { ...a.pose, x: d.pose.x })).toBeLessThan(1e-9);
    expect(turnFrom(piece, 'a')).toBeCloseTo(0, 9);
  });

  it('the double crossover (K) lets a train change tracks', () => {
    const piece = getPiece('double-crossover');
    expect(piece.brioIds).toEqual(['K']);
    const net = new TrackNetwork(addPiece(EMPTY_LAYOUT, 'double-crossover', IDENTITY).layout);
    // A switch where the crossover leaves the near track, and where it joins the far one.
    expect(net.switches()).toHaveLength(2);
  });

  it('bumpy track rises and falls but starts and ends level', () => {
    const path = getPiece('bumpy').paths[0];
    const length = pathLength(path);
    expect(heightAt(path, 0)).toBe(0);
    expect(heightAt(path, length)).toBeCloseTo(0, 9);
    expect(heightAt(path, length / (2 * D.BUMPY_COUNT))).toBeCloseTo(D.BUMP_HEIGHT, 9);
    const layout = addPiece(EMPTY_LAYOUT, 'bumpy', IDENTITY).layout;
    expect(supportsOf(layout)).toEqual([]);
  });

  it('the turntable has eight ends an eighth of a turn apart, straight across from each other', () => {
    const piece = getPiece('turntable');
    expect(piece.connectors).toHaveLength(8);
    const centre = { x: D.TURNTABLE_DIAMETER / 2, y: 0 };
    for (const c of piece.connectors) expect(Math.hypot(c.pose.x - centre.x, c.pose.y - centre.y)).toBeCloseTo(D.TURNTABLE_DIAMETER / 2, 9);
    const net = new TrackNetwork(addPiece(EMPTY_LAYOUT, 'turntable', IDENTITY).layout);
    expect(net.edges).toHaveLength(4);
  });

  it('the curved viaduct is a span a level up that needs no supports', () => {
    const piece = getPiece('bridge-viaduct-curved');
    expect(piece.bridge).toBe('viaduct');
    expect(piece.connectors.map((c) => c.z)).toEqual([D.LEVEL_HEIGHT, D.LEVEL_HEIGHT]);
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    const up = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'ramp')!;
    layout = extendFrom(up.layout, up.next!, 'bridge-viaduct-curved')!.layout;
    expect(supportsOf(layout)).toEqual([]);
  });

  it('the engine shed seats over a straight', () => {
    expect(getPiece('engine-shed')).toMatchObject({ category: 'scenery', seatsOnTrack: true, model: 'engine-shed' });
  });
});
