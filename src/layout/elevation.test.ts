import { describe, expect, it } from 'vitest';
import { gradeAt, heightAt, pathLength } from '../geometry/path';
import { IDENTITY, type Pose } from '../geometry/pose';
import { attachEnd, SHAPES, variantFor } from '../builder/variants';
import { getPiece } from '../pieces/catalog';
import * as D from '../pieces/dimensions';
import { checkLayout } from '../planning/check';
import { fromSaved, layoutFromJson, layoutToJson } from '../planning/file';
import { partsList, partsText } from '../planning/parts';
import { TrackNetwork } from '../trains/network';
import { TrainSim, type Train } from '../trains/sim';
import {
  addPiece,
  dragContext,
  EMPTY_LAYOUT,
  extendFrom,
  findJoints,
  findSnap,
  openEnds,
  raisePieces,
  swapEnd,
  transformPieces,
  worldEnd,
  type EndRef,
  type Layout,
} from './layout';
import { supportsOf } from './supports';

const shape = (id: string) => SHAPES.find((s) => s.ids.includes(id))!;

/**
 * Up and over: a long straight on the floor, an N ramp up, a C straight
 * (two holes) along the top, and an N1 ramp (two pegs) back down, joined
 * by its top end. The top straight is p3.
 */
function upAndOver(): { layout: Layout; top: string; down: string } {
  let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
  const up = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'ramp')!;
  const top = extendFrom(up.layout, up.next!, 'straight-medium-hh')!;
  const down = extendFrom(top.layout, top.next!, 'ramp-pp', false, 'b')!;
  layout = down.layout;
  return { layout, top: top.uid, down: down.uid };
}

/** Plan pose of the middle of a straight piece. */
function middleOf(layout: Layout, uid: string): Pose {
  const piece = layout.pieces.find((p) => p.uid === uid)!;
  const length = pathLength(getPiece(piece.pieceId).paths[0]);
  return { x: piece.pose.x + (length / 2) * Math.cos(piece.pose.angle), y: piece.pose.y + (length / 2) * Math.sin(piece.pose.angle), angle: piece.pose.angle };
}

/** A long straight on the floor, crossing square under the point `at`. */
function crossingUnder(layout: Layout, at: Pose): Layout {
  const angle = at.angle + Math.PI / 2;
  const half = D.LONG_STRAIGHT / 2;
  return addPiece(layout, 'straight-long', { x: at.x - half * Math.cos(angle), y: at.y - half * Math.sin(angle), angle }).layout;
}

describe('ramps', () => {
  const ramp = getPiece('ramp');

  it('climb one level from end a to end b, level at both ends', () => {
    const path = ramp.paths[0];
    const length = pathLength(path);
    expect(length).toBe(D.RAMP_LENGTH);
    expect(heightAt(path, 0)).toBe(0);
    expect(heightAt(path, length)).toBeCloseTo(D.RAMP_RISE, 9);
    expect(gradeAt(path, 0)).toBe(0);
    expect(gradeAt(path, length)).toBeCloseTo(0, 9);
    expect(ramp.connectors.map((c) => c.z ?? 0)).toEqual([0, D.RAMP_RISE]);
  });

  it('climb smoothly: no jumps in height along the way', () => {
    const path = ramp.paths[0];
    for (let s = 0; s < D.RAMP_LENGTH; s += 1) {
      expect(heightAt(path, s + 1) - heightAt(path, s)).toBeGreaterThanOrEqual(0);
      expect(heightAt(path, s + 1) - heightAt(path, s)).toBeLessThan(0.5);
    }
  });

  it('come as N (peg and hole) and N1 (two pegs)', () => {
    expect(getPiece('ramp').brioIds).toEqual(['N']);
    expect(getPiece('ramp-pp').brioIds).toEqual(['N1']);
    expect(getPiece('ramp-pp').connectors.map((c) => c.gender)).toEqual(['peg', 'peg']);
  });

  it('track built on from the top stays up a level', () => {
    const { layout, top } = upAndOver();
    expect(layout.pieces.find((p) => p.uid === top)!.z).toBe(D.LEVEL_HEIGHT);
    expect(findJoints(layout)).toHaveLength(3);
    // Down again: the last ramp sits on the floor, its far end open at floor level.
    const open = openEnds(layout);
    expect(open.map((e) => e.connector.z ?? 0)).toEqual([0, 0]);
  });

  it('go on by their low end, picking N1 from a hole', () => {
    expect(variantFor(shape('ramp'), 'mixed', 'peg')).toBe('ramp');
    expect(variantFor(shape('ramp'), 'mixed', 'hole')).toBe('ramp-pp');
    expect(attachEnd('ramp-pp', 'hole', 0)).toBe('a');
  });

  it("can't go down through the floor", () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    // N1 by its top end onto a floor-level hole would put it below the floor.
    expect(extendFrom(layout, { uid: 'p1', connectorId: 'a' }, 'ramp-pp', false, 'b')).toBeNull();
    const up = extendFrom(layout, { uid: 'p1', connectorId: 'a' }, 'ramp-pp')!;
    expect(up.layout.pieces[1].z).toBeUndefined();
    // Reversed, it would go down, which it can't from the floor.
    expect(swapEnd(up.layout, up.uid)).toBeNull();
  });

  it('reverse to go down from a raised end', () => {
    const raised = raisePieces(addPiece(EMPTY_LAYOUT, 'straight-medium-hh', IDENTITY).layout, new Set(['p1']), D.LEVEL_HEIGHT)!;
    const up = extendFrom(raised, { uid: 'p1', connectorId: 'b' }, 'ramp-pp')!;
    expect(up.layout.pieces[1].z).toBe(D.LEVEL_HEIGHT);
    const down = swapEnd(up.layout, up.uid)!;
    expect(down.pieces[1].z).toBeUndefined();
    expect(findJoints(down)).toHaveLength(1);
  });
});

describe('levels', () => {
  it('ends at different heights never join, even right on top of each other', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    layout = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'straight-long')!.layout;
    expect(findJoints(layout)).toHaveLength(1);
    const lifted = raisePieces(layout, new Set(['p2']), D.LEVEL_HEIGHT)!;
    expect(findJoints(lifted)).toHaveLength(0);
  });

  it('raising stops at the floor', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    expect(raisePieces(layout, new Set(['p1']), -D.LEVEL_HEIGHT)).toBeNull();
    const up = raisePieces(layout, new Set(['p1']), D.LEVEL_HEIGHT)!;
    expect(raisePieces(up, new Set(['p1']), -D.LEVEL_HEIGHT)!.pieces[0].z).toBeUndefined();
  });

  it('a dragged piece snaps up onto a raised end', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    layout = raisePieces(layout, new Set(['p1']), D.LEVEL_HEIGHT)!;
    layout = addPiece(layout, 'straight-long', { x: D.LONG_STRAIGHT + 10, y: 5, angle: 0 }).layout;
    const moving = new Set(['p2']);
    const snap = findSnap(dragContext(layout, moving), IDENTITY)!;
    expect(snap.dz).toBe(D.LEVEL_HEIGHT);
    const joined = transformPieces(layout, moving, snap.transform, snap.dz);
    expect(findJoints(joined)).toHaveLength(1);
  });
});

describe('supports', () => {
  it('stand under every raised joint, shared by the two ends there', () => {
    const { layout, top } = upAndOver();
    const supports = supportsOf(layout);
    expect(supports).toHaveLength(2);
    for (const s of supports) {
      expect(s.height).toBe(D.LEVEL_HEIGHT);
      expect(s.blocks).toBe(1);
      expect(s.uids).toContain(top);
    }
  });

  it('stack two blocks high on the second level', () => {
    const raised = raisePieces(addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout, new Set(['p1']), 2 * D.LEVEL_HEIGHT)!;
    expect(supportsOf(raised).map((s) => s.blocks)).toEqual([2, 2]);
    expect(partsList(raised).supports).toBe(4);
  });

  it('are on the parts list', () => {
    const list = partsList(upAndOver().layout);
    expect(list.supports).toBe(2);
    expect(list.lines.filter((l) => l.category === 'ramp').map((l) => l.brioIds)).toEqual([['N'], ['N1']]);
    expect(partsText(list)).toContain(`2 × Support block (${D.LEVEL_HEIGHT} mm)`);
  });
});

describe('layout check with levels', () => {
  it('track a full level over other track is a bridge, not an overlap', () => {
    const { layout, top } = upAndOver();
    const issues = checkLayout(crossingUnder(layout, middleOf(layout, top)));
    expect(issues.filter((i) => i.kind !== 'open-end')).toEqual([]);
  });

  it('crossing over track partway up a ramp is too low', () => {
    const { layout } = upAndOver();
    const issues = checkLayout(crossingUnder(layout, middleOf(layout, 'p2')));
    const overlaps = issues.filter((i) => i.kind === 'overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].message).toMatch(/too low/);
  });

  it('a support over lower track becomes an arch, not a problem', () => {
    const { layout, top } = upAndOver();
    const joint = worldEnd(layout, { uid: top, connectorId: 'a' }).connector.pose;
    const crossed = crossingUnder(layout, joint);
    const issues = checkLayout(crossed);
    expect(issues.some((i) => i.kind === 'support')).toBe(false);
    const arch = supportsOf(crossed).find((s) => s.arch)!;
    expect(arch.uids).toContain(top);
    // Legs either side of the lower track, clear of it, with the beam over the joint.
    const under = crossed.pieces[crossed.pieces.length - 1];
    for (const leg of arch.arch!.legs) {
      const off = Math.abs((leg.x - under.pose.x) * Math.sin(under.pose.angle) - (leg.y - under.pose.y) * Math.cos(under.pose.angle));
      expect(off).toBeGreaterThanOrEqual(D.ARCH_CLEARANCE + D.SUPPORT_LENGTH / 2 - 1);
    }
    expect(arch.blocks).toBe(2);
    const list = partsList(crossed);
    expect(list.beams).toEqual([{ length: Math.ceil(arch.arch!.span / 10) * 10, count: 1 }]);
    expect(partsText(list)).toContain('1 × Arch beam');
  });

  it('a support over more lower track than an arch can span is flagged', () => {
    const { layout, top } = upAndOver();
    const joint = worldEnd(layout, { uid: top, connectorId: 'a' }).connector.pose;
    let crossed = layout;
    for (const k of [-2, -1, 0, 1, 2]) {
      const along = k * 50;
      crossed = crossingUnder(crossed, { ...joint, x: joint.x + along * Math.cos(joint.angle), y: joint.y + along * Math.sin(joint.angle) });
    }
    const issues = checkLayout(crossed).filter((i) => i.kind === 'support');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/no room for an arch/);
  });

  it('a helix built from curved ramps arches over its own lower turn', () => {
    let layout = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout;
    let end: EndRef = { uid: 'p1', connectorId: 'b' };
    const uids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const next = extendFrom(layout, end, 'ramp-curve')!;
      layout = next.layout;
      end = next.next!;
      uids.push(next.uid);
    }
    // Four quarter turns climb four levels and come round over the start.
    const over = supportsOf(layout).filter((s) => s.arch);
    expect(over.length).toBeGreaterThan(0);
    expect(checkLayout(layout).filter((i) => i.kind === 'support')).toEqual([]);
  });

  it('ends that line up at different heights are flagged', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    layout = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'straight-long')!.layout;
    layout = raisePieces(layout, new Set(['p2']), D.LEVEL_HEIGHT)!;
    const issues = checkLayout(layout);
    expect(issues.map((i) => i.kind).sort()).toEqual(['height', 'open-end', 'open-end']);
    expect(issues.find((i) => i.kind === 'height')!.message).toMatch(/64 mm higher/);
  });
});

describe('saving raised track', () => {
  it('keeps heights through a file', () => {
    const { layout } = upAndOver();
    const back = layoutFromJson(layoutToJson(layout));
    expect(back.pieces.map((p) => p.z)).toEqual(layout.pieces.map((p) => p.z));
    expect(findJoints(back)).toHaveLength(3);
  });

  it('still opens version 1 files', () => {
    const layout = fromSaved({ format: 'track-builder-layout', version: 1, pieces: [{ piece: 'straight-long', x: 0, y: 0, angle: 0 }] });
    expect(layout.pieces[0].z).toBeUndefined();
  });

  it('leaves floor-level pieces as they were', () => {
    const json = JSON.parse(layoutToJson(addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY).layout));
    expect(json.pieces[0]).toEqual({ piece: 'straight-long', x: 0, y: 0, angle: 0 });
  });
});

describe('T and star switches', () => {
  it('the T switch turns a quarter left or right into the ends of a D straight', () => {
    const t = getPiece('switch-t');
    const [trunk, left, right] = t.connectors;
    expect(trunk.pose).toEqual({ x: 0, y: 0, angle: Math.PI });
    expect(left.pose.x).toBeCloseTo(D.T_SWITCH_RADIUS, 9);
    expect(left.pose.y).toBeCloseTo(D.T_SWITCH_RADIUS, 9);
    expect(left.pose.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(right.pose.y).toBeCloseTo(-D.T_SWITCH_RADIUS, 9);
    expect(left.pose.y - right.pose.y).toBeCloseTo(D.LONG_STRAIGHT, 9);
    expect(getPiece('switch-t').brioIds).toEqual(['T']);
  });

  it('the T switch has a lever at each of its three ends', () => {
    const net = new TrackNetwork(addPiece(EMPTY_LAYOUT, 'switch-t', IDENTITY).layout);
    const points = net.switches();
    expect(points.map((p) => p.key).sort()).toEqual(['p1:branch0', 'p1:branch1', 'p1:trunk']);
    for (const p of points) expect(p.choices).toHaveLength(2);
  });

  it('the star switch offers three ways on from each of its four ends', () => {
    const star = getPiece('switch-star');
    expect(star.connectors).toHaveLength(4);
    expect(star.brioIds).toEqual(['X']);
    const net = new TrackNetwork(addPiece(EMPTY_LAYOUT, 'switch-star', IDENTITY).layout);
    const points = net.switches();
    expect(points).toHaveLength(4);
    for (const p of points) expect(p.choices).toHaveLength(3);
  });

  it('a train from the T trunk goes the way its lever is set', () => {
    // A straight into the trunk, buffer stops on both arms.
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    const t = extendFrom(layout, { uid: 'p1', connectorId: 'b' }, 'switch-t')!;
    layout = extendFrom(t.layout, { uid: t.uid, connectorId: 'branch0' }, 'buffer')!.layout;
    layout = extendFrom(layout, { uid: t.uid, connectorId: 'branch1' }, 'buffer')!.layout;
    const ends = (lever: number) => {
      const sim = new TrainSim(layout);
      for (let i = 0; i < lever; i++) sim.toggleLever(`${t.uid}:trunk`);
      const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p1:0', s: 60, reversed: false }) as Train;
      sim.setThrottle(train.id, 1);
      for (let i = 0; i < 600 && train.status.kind !== 'stuck'; i++) sim.advance(1 / 60);
      expect(train.status).toMatchObject({ stuck: 'buffer' });
      return train.vehicles[0].geo.center.y;
    };
    expect(ends(0)).toBeGreaterThan(50);
    expect(ends(1)).toBeLessThan(-50);
  });
});

describe('trains on ramps', () => {
  /** Run from the floor up and over; `highest` is how high the engine got, `tail` the last car. */
  function runOver(consist: string[]): { train: Train; highest: number; tail: number } {
    const { layout } = upAndOver();
    const sim = new TrainSim(layout);
    const train = sim.addTrain(
      consist.map((stockId) => ({ stockId, reversed: false })),
      { edgeKey: 'p1:0', s: D.LONG_STRAIGHT - 10 - consist.length * 45, reversed: false },
    ) as Train;
    sim.setThrottle(train.id, 1);
    let highest = 0;
    let tail = 0;
    for (let i = 0; i < 60 * 30 && !train.wrecked && train.status.kind !== 'stuck'; i++) {
      sim.advance(1 / 60);
      highest = Math.max(highest, train.vehicles[0].geo.z);
      tail = Math.max(tail, train.vehicles[train.vehicles.length - 1].geo.z);
    }
    return { train, highest, tail };
  }

  it('a battery engine climbs up and over and runs off the far end', () => {
    const { train, highest } = runOver(['battery-engine']);
    expect(highest).toBeCloseTo(D.LEVEL_HEIGHT, 0);
    expect(train.status).toMatchObject({ stuck: 'ran-off' });
  });

  it('a battery engine pulls a car up and over', () => {
    const { train, highest } = runOver(['battery-engine', 'wagon']);
    expect(highest).toBeCloseTo(D.LEVEL_HEIGHT, 0);
    expect(train.status).toMatchObject({ stuck: 'ran-off' });
  });

  it("a battery engine with a heavy load can't get up the ramp", () => {
    // It slows near the top, stops, and slides back down: the train never gets over.
    const { tail, train } = runOver(['battery-engine', 'timber', 'timber', 'timber', 'timber']);
    expect(tail).toBeLessThan(D.LEVEL_HEIGHT / 2);
    expect(train.status).toMatchObject({ kind: 'stuck' });
  });

  it('vehicles on a bridge pass over a train underneath', () => {
    const { layout, top } = upAndOver();
    const crossed = crossingUnder(layout, middleOf(layout, top));
    const under = crossed.pieces[crossed.pieces.length - 1].uid;
    const sim = new TrainSim(crossed);
    sim.addTrain([{ stockId: 'coach', reversed: false }], { edgeKey: `${under}:0`, s: D.LONG_STRAIGHT / 2, reversed: false });
    sim.addTrain([{ stockId: 'coach', reversed: false }], { edgeKey: `${top}:0`, s: D.MEDIUM_STRAIGHT / 2, reversed: false });
    sim.advance(0.05);
    expect(sim.trains.every((t) => !t.wrecked)).toBe(true);
  });
});

// Keep the helper honest: the up-and-over layout's open ends are where we think.
it('up and over is open at both floor ends', () => {
  const { layout, down } = upAndOver();
  const open = openEnds(layout).map((e): EndRef => ({ uid: e.uid, connectorId: e.connectorId }));
  expect(open).toEqual([
    { uid: 'p1', connectorId: 'a' },
    { uid: down, connectorId: 'a' },
  ]);
});
