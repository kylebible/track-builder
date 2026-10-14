import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, type EndRef, type Layout } from '../layout/layout';
import type { Crossing } from '../trains/route';
import { TrainSim } from '../trains/sim';
import type { Synth } from './synth';
import { clackStrength, jointsPassed, TrainSounds } from './trainSounds';

function build(start: string, rest: string[]): Layout {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, start, IDENTITY);
  let end: EndRef = { uid, connectorId: 'b' };
  for (const id of rest) {
    const ext = extendFrom(layout, end, id)!;
    layout = ext.layout;
    end = ext.next!;
  }
  return layout;
}

const curves = (n: number) => Array<string>(n).fill('curve-large');

/** Counts what would have been played. */
function listener() {
  const heard = { clack: 0, whistle: 0, ding: 0 };
  const synth = {
    muted: false,
    clack: () => heard.clack++,
    whistle: () => heard.whistle++,
    ding: () => heard.ding++,
  } as unknown as Synth;
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1500, 950);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { heard, sounds: new TrainSounds(synth, camera) };
}

/** Run the train for `seconds`, listening every frame. */
function run(sim: TrainSim, sounds: TrainSounds, seconds: number, from = 0): void {
  for (let i = 0; i < seconds * 60; i++) {
    sim.advance(1 / 60);
    sounds.update(sim, true, from + i / 60);
  }
}

const crossing = (u: number): Crossing => ({ u, at: { x: 0, y: 0 }, uids: ['a', 'b'], fit: { lateralMm: 0, angleDeg: 0, gapMm: 0, unjoined: false } as Crossing['fit'] });

describe('train sounds', () => {
  it('an axle passes the joints between where it was and where it is, either way', () => {
    const joints = [crossing(100), crossing(200), crossing(300)];
    expect(jointsPassed(90, 210, joints).map((c) => c.u)).toEqual([100, 200]);
    expect(jointsPassed(210, 90, joints).map((c) => c.u)).toEqual([100, 200]);
    // Sitting on a joint and rolling off it in either direction counts it once in total.
    expect(jointsPassed(100, 120, joints)).toHaveLength(0);
    expect(jointsPassed(90, 100, joints)).toHaveLength(1);
    expect(jointsPassed(150, 150, joints)).toHaveLength(0);
  });

  it('a clack is louder going faster and over a rough joint', () => {
    const smooth = crossing(0).fit;
    const rough = { ...smooth, lateralMm: 1.5, angleDeg: 1.5 };
    expect(clackStrength(180, smooth)).toBeGreaterThan(clackStrength(30, smooth));
    expect(clackStrength(100, rough)).toBeGreaterThan(clackStrength(100, smooth));
    expect(clackStrength(1000, { ...rough, unjoined: true, gapMm: 5 })).toBeLessThanOrEqual(1);
  });

  it('every axle clacks over every joint it rolls across', () => {
    const layout = build('straight-long', ['straight-long', 'straight-long', 'straight-long']);
    const sim = new TrainSim(layout);
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p1:0', s: 100, reversed: false });
    if (typeof train === 'string') throw new Error(train);
    const { heard, sounds } = listener();
    sounds.update(sim, true, 0);
    sim.setThrottle(train.id, 1);
    run(sim, sounds, 2.5);
    const joints = train.route.crossings.filter((c) => c.u < train.vehicles[0].u - 28).length;
    expect(joints).toBeGreaterThan(0);
    // Two axles over each joint the whole engine has cleared.
    expect(heard.clack).toBeGreaterThanOrEqual(joints * 2);
  });

  it('an engine whistles as it sets off, and a car on its own does not', () => {
    const layout = build('straight-long', ['straight-long', 'straight-long']);
    const sim = new TrainSim(layout);
    const engine = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p1:0', s: 100, reversed: false });
    const wagon = sim.addTrain([{ stockId: 'wagon', reversed: false }], { edgeKey: 'p3:0', s: 100, reversed: false });
    if (typeof engine === 'string' || typeof wagon === 'string') throw new Error('no train');
    const { heard, sounds } = listener();
    sounds.update(sim, true, 0);
    sim.setThrottle(wagon.id, 1);
    sounds.update(sim, true, 0.1);
    expect(heard.whistle).toBe(0);
    sim.setThrottle(engine.id, 1);
    sounds.update(sim, true, 0.2);
    expect(heard.whistle).toBe(1);
  });

  it('bells ring while a train is near a level crossing, then stop', () => {
    // An oval with a level crossing on the far side from where the train starts.
    const layout = build('straight-long', ['straight-long', 'level-crossing', ...curves(4), 'straight-long', 'straight-long', 'straight-medium', ...curves(4)]);
    const sim = new TrainSim(layout);
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey: 'p13:0', s: 10, reversed: false });
    if (typeof train === 'string') throw new Error(train);
    const { heard, sounds } = listener();
    sounds.update(sim, true, 0);
    sim.setThrottle(train.id, 1);
    run(sim, sounds, 4);
    expect(train.status.kind).toBe('running');
    expect(heard.ding).toBeGreaterThan(3);
    // Setting off and coming up to the crossing.
    expect(heard.whistle).toBe(2);
    // Paused, the bells fall silent.
    const before = heard.ding;
    for (let i = 0; i < 60; i++) sounds.update(sim, false, 4 + i / 60);
    expect(heard.ding).toBe(before);
  });
});
