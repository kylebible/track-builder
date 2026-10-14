import type { Edge, TrackNetwork } from './network';

// The shortest way along the track from a train's front to a spot, running
// forwards only, and which way each switch on the way has to point. Job
// trains use it to choose between stops and to set the levers ahead of them.

export interface Spot {
  edgeKey: string;
  /** Along the edge's path. */
  s: number;
}

export interface Way {
  /** mm from the start to the spot. */
  distance: number;
  /** Each switch point on the way, in order, the lever setting it needs, and how far ahead it is. */
  switches: { key: string; choice: number; count: number; at: number }[];
}

/** Where to start: running along `edge` toward its end `leave`, `left` mm short of it. */
export interface Start {
  edge: Edge;
  leave: 0 | 1;
  left: number;
}

interface Node {
  edge: Edge;
  /** The end it was entered by. */
  enterAt: 0 | 1;
  d: number;
  switches: Way['switches'];
}

/** How far it searches, mm: well past anything on a play-table layout. */
const LIMIT_MM = 60000;

export function shortestWay(network: TrackNetwork, start: Start, to: Spot): Way | null {
  // On the edge it's on already, ahead of it.
  if (start.edge.key === to.edgeKey) {
    const ahead = start.leave === 1 ? to.s - (start.edge.length - start.left) : start.edge.length - start.left - to.s;
    if (ahead >= 0) return { distance: ahead, switches: [] };
  }
  const best = new Map<string, number>();
  const queue: Node[] = [];
  const push = (n: Node) => {
    const key = `${n.edge.key}/${n.enterAt}`;
    if ((best.get(key) ?? Infinity) <= n.d || n.d > LIMIT_MM) return;
    best.set(key, n.d);
    queue.push(n);
  };
  const onward = (edge: Edge, leave: 0 | 1, d: number, switches: Way['switches']) => {
    let found: { key: string; count: number } | null = null;
    const first = network.onward(edge, leave, (key, count) => {
      found = { key, count };
      return 0;
    });
    if (first.kind !== 'edge') return;
    const f = found as { key: string; count: number } | null;
    if (!f) {
      push({ edge: first.edge, enterAt: first.enterAt, d, switches });
      return;
    }
    for (let i = 0; i < f.count; i++) {
      const next = network.onward(edge, leave, () => i);
      if (next.kind === 'edge') push({ edge: next.edge, enterAt: next.enterAt, d, switches: [...switches, { key: f.key, choice: i, count: f.count, at: d }] });
    }
  };
  onward(start.edge, start.leave, start.left, []);
  while (queue.length) {
    // Small layouts: a linear scan for the nearest is plenty.
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[k].d) k = i;
    const n = queue.splice(k, 1)[0];
    if (n.d > (best.get(`${n.edge.key}/${n.enterAt}`) ?? Infinity)) continue;
    if (n.edge.key === to.edgeKey) {
      const along = n.enterAt === 0 ? to.s : n.edge.length - to.s;
      return { distance: n.d + along, switches: n.switches };
    }
    onward(n.edge, n.enterAt === 0 ? 1 : 0, n.d + n.edge.length, n.switches);
  }
  return null;
}
