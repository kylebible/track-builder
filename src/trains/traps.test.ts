import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT } from '../layout/layout';
import { lay, ovalAndTurningLoop, twoLassos } from './trapLayouts';
import { poseAt } from '../geometry/path';
import { jobConsist } from './jobs';
import { TrackNetwork } from './network';
import { TrainSim } from './sim';
import { layoutTraps } from './traps';

describe('train traps', () => {
  it('finds loops joined on by a switch whose trunk faces into the loop', () => {
    const { layout, main, far, line } = twoLassos();
    const { traps } = layoutTraps(layout);
    expect(traps).toHaveLength(2);
    // Down the line from the main loop, a train is shut in the far one, and the other way about.
    const intoFar = traps.find((t) => t.loopUids.includes(far))!;
    expect(intoFar.entries.map((e) => e.uid)).toEqual([main]);
    expect(intoFar.loopUids).not.toContain(main);
    for (const uid of line) expect(intoFar.uids).toContain(uid);
    const intoMain = traps.find((t) => t.loopUids.includes(main))!;
    expect(intoMain.entries.map((e) => e.uid)).toEqual([far]);
  });

  it('a plain oval has none', () => {
    const { layout, uid } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    const oval = lay(layout, { uid, connectorId: 'b' }, [...Array(4).fill('curve-large'), 'straight-long', ...Array(4).fill('curve-large')]);
    expect(layoutTraps(oval.layout).traps).toHaveLength(0);
  });

  it('a turning loop at the end of a line is no trap: trains come back out the other way round', () => {
    expect(layoutTraps(ovalAndTurningLoop().layout).traps).toHaveLength(0);
  });
});

describe('trains and traps', () => {
  /** A train on the main loop running towards the switch into the far loop, with the lever set into it. */
  function headedIn(autoroute: boolean) {
    const { layout, far, line } = twoLassos();
    const sim = new TrainSim(layout);
    const trap = layoutTraps(layout).traps.find((t) => t.loopUids.includes(far))!;
    const entry = trap.entries[0];
    const [edgeKey, leave] = entry.from.split('>');
    const edge = sim.network.edge(edgeKey)!;
    // Its middle a little way back from the switch, running towards it.
    const train = sim.addTrain([{ stockId: 'battery-engine', reversed: false }], { edgeKey, s: leave === '1' ? 20 : edge.length - 20, reversed: leave === '0' });
    if (typeof train === 'string') throw new Error(train);
    sim.setLever(entry.switchKey, entry.index, entry.ways);
    if (autoroute) sim.setAutoroute(true);
    sim.setThrottle(train.id, 1);
    const visited = new Set<string>();
    for (let i = 0; i < 30 * 30; i++) {
      sim.advance(1 / 30);
      for (const seg of train.route.segments) visited.add(seg.edge.uid);
    }
    return { visited, line };
  }

  it('without autoroute a train follows the lever into the trap', () => {
    const { visited, line } = headedIn(false);
    expect(line.some((uid) => visited.has(uid))).toBe(true);
  });

  it('under autoroute a train keeps out of it, whatever the lever says', () => {
    const { visited, line } = headedIn(true);
    expect(line.some((uid) => visited.has(uid))).toBe(false);
  });
});

describe('job trains shut in a trap', () => {
  it('back out to get to work', () => {
    const { layout: track, far } = twoLassos();
    const net = new TrackNetwork(track);
    const trap = layoutTraps(track).traps.find((t) => t.loopUids.includes(far))!;
    // The coal mine on the main loop, the coaling stage on the far one.
    const straightOn = (inTrap: boolean) => net.edges.find((e) => e.pieceId === 'straight-medium' && trap.loopUids.includes(e.uid) === inTrap)!;
    let layout = addPiece(track, 'coal-mine', poseAt(straightOn(false).path, 72)).layout;
    layout = addPiece(layout, 'coaling-stage', poseAt(straightOn(true).path, 72)).layout;
    const sim = new TrainSim(layout);
    sim.economy.all('coaling-stage')[0].stock.coal = 0;
    // On the far loop, running round the way it can't leave by.
    const [edgeKey, leave] = trap.loop.find((k) => k.startsWith(`${straightOn(true).uid}:`))!.split('>');
    const train = sim.addTrain(jobConsist('coal'), { edgeKey, s: 72, reversed: leave === '0' }, 'Coal train', 'coal');
    if (typeof train === 'string') throw new Error(train);
    sim.setAutoroute(true);
    sim.setThrottle(train.id, 1);
    const loaded = () => train.consist.some((c) => (c.units ?? 0) > 0);
    let ok = false;
    for (let i = 0; i < 120 * 30 && !ok; i++) {
      sim.advance(1 / 30);
      ok = loaded();
    }
    expect(ok).toBe(true);
  });
});
