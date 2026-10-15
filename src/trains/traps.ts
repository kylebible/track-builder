import type { Pose } from '../geometry/pose';
import { defOf, type Layout } from '../layout/layout';
import { RouteGraph, headingKey, type Heading } from './dispatch';
import { edgeEndPose, TrackNetwork } from './network';

// Train traps: places a train can run into but never get back out of.
//
// A train is a heading: an edge and the end it is running towards. From
// each heading it can go on to the next (one way, or one of several at a
// facing switch). It can also turn back where the track lets it: at a
// buffer stop it backs out the other way, and on a turntable it can be
// turned to any line, either way round.
//
// A trap is a way at a facing switch after which some loop of track the
// train could have gone round is out of its reach for ever: it is shut in a
// smaller part of the layout, going round and round. Just being turned the
// other way round for good doesn't count (an oval with a siding does that:
// in and back out, and it runs the other way round the same oval), nor does
// running to the end of the track (the open-end check's business). The
// classic trap is a loop joined on by a switch whose trunk faces into the
// loop: trains come in by the branch, go round, come back in on the
// straight and out of the trunk into the loop again, for ever.

/** One way into a trap: a facing switch, and which of its ways leads in. */
export interface TrapEntry {
  /** The switch point's key, `uid:connectorId`, as levers know it. */
  switchKey: string;
  /** The switch piece. */
  uid: string;
  /** Which way at the switch (index into its ways, in path order) leads in. */
  index: number;
  /** How many ways the switch offers from this side. */
  ways: number;
  /** The heading the train is on as it runs into the switch. */
  from: string;
  /** The heading it takes into the trap. */
  into: string;
  /** Where the switch point is, facing back the way the train comes from. */
  at: Pose;
}

/** One trap, and every way into it. */
export interface Trap {
  /** Ways in, one per facing switch way that leads here. */
  entries: TrapEntry[];
  /** Every piece a train can still reach once it is in. */
  uids: string[];
  /** The pieces of the loop it ends up going round. */
  loopUids: string[];
  /** Headings round that loop, the way trains run round it. */
  loop: string[];
}

export interface TrapReport {
  traps: Trap[];
  /** `from>into` for every way into a trap: routing keeps out of these. */
  entering: Set<string>;
  /** Headings inside some trap. */
  inside: Set<string>;
}

export const wayKey = (from: string, into: string) => `${from}|${into}`;

/** Where a train on `h` can be next: on along the track, or turned back. */
function successors(graph: RouteGraph, h: Heading, turntables: Map<string, Heading[]>): Heading[] {
  const { next, end } = graph.ways(h);
  const out: Heading[] = [...next];
  // Up against a buffer stop, a train backs out the other way.
  if (end === 'buffer') out.push({ edge: h.edge, leave: h.leave === 1 ? 0 : 1 });
  // On a turntable it can be turned to any line, either way round.
  const table = turntables.get(h.edge.uid);
  if (table) out.push(...table);
  return out;
}

/** Find every trap in the track. */
export function findTraps(graph: RouteGraph): TrapReport {
  const network = graph.network;
  const turntables = new Map<string, Heading[]>();
  for (const edge of network.edges) {
    const piece = network.piece(edge.uid);
    if (!piece || defOf(piece).structure !== 'turntable') continue;
    turntables.set(edge.uid, [...(turntables.get(edge.uid) ?? []), { edge, leave: 0 }, { edge, leave: 1 }]);
  }
  const headings: Heading[] = network.edges.flatMap((edge) => [{ edge, leave: 0 as const }, { edge, leave: 1 as const }]);
  const byKey = new Map(headings.map((h) => [headingKey(h), h]));
  const next = new Map<string, string[]>();
  for (const h of headings) next.set(headingKey(h), successors(graph, h, turntables).map(headingKey));

  const cyclic = loopingHeadings([...byKey.keys()], next);

  // Where a train can get to from a heading, worked out once per heading asked about.
  const reachCache = new Map<string, Set<string>>();
  const reach = (start: string): Set<string> => {
    let seen = reachCache.get(start);
    if (seen) return seen;
    seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const k of next.get(stack.pop()!) ?? []) if (!seen.has(k)) (seen.add(k), stack.push(k));
    reachCache.set(start, seen);
    return seen;
  };

  /** The pieces of every loop a train can get round from a heading, by heading. */
  const loopCache = new Map<string, Set<string>>();
  const loopsFrom = (start: string): Set<string> => {
    let uids = loopCache.get(start);
    if (!uids) {
      uids = new Set([...reach(start)].filter((k) => cyclic.has(k)).map((k) => byKey.get(k)!.edge.uid));
      loopCache.set(start, uids);
    }
    return uids;
  };

  const byLoop = new Map<string, Trap>();
  const entering = new Set<string>();
  const inside = new Set<string>();
  for (const h of headings) {
    const ways = graph.ways(h).next;
    if (ways.length < 2) continue;
    const from = headingKey(h);
    const before = loopsFrom(from);
    for (const w of ways) {
      const into = headingKey(w);
      const after = loopsFrom(into);
      // Every loop it could get round before, it still can. (No loop at all
      // ahead is just the end of the track: not a trap to go round in.)
      if (after.size === before.size || !after.size) continue;
      const r = reach(into);
      const loop = [...r].filter((k) => cyclic.has(k)).sort();
      const id = [...after].sort().join(',');
      let trap = byLoop.get(id);
      if (!trap) {
        const uids = [...new Set([...r].map((k) => byKey.get(k)!.edge.uid))];
        byLoop.set(id, (trap = { entries: [], uids, loopUids: [...after], loop }));
      }
      trap.entries.push({ switchKey: w.switchKey!, uid: w.switchKey!.slice(0, w.switchKey!.indexOf(':')), index: w.index, ways: ways.length, from, into, at: edgeEndPose(w.edge, w.leave === 1 ? 0 : 1) });
      entering.add(wayKey(from, into));
      for (const k of r) inside.add(k);
    }
  }
  return { traps: [...byLoop.values()], entering, inside };
}

/** The traps in a layout. */
export function layoutTraps(layout: Layout): TrapReport {
  return findTraps(new RouteGraph(new TrackNetwork(layout)));
}

/** A key for each way into a trap that `after` has and `before` hadn't: for telling whether an edit made a new one. */
export function newTrapEntries(before: TrapReport, after: TrapReport): TrapEntry[] {
  const had = new Set(before.traps.flatMap((t) => t.entries.map((e) => `${e.switchKey}#${e.index}`)));
  return after.traps.flatMap((t) => t.entries.filter((e) => !had.has(`${e.switchKey}#${e.index}`)));
}

/**
 * Headings on some loop a train can keep going round: those in a strongly
 * connected group of more than one, or that lead straight back to
 * themselves. Tarjan's algorithm, without recursion so big layouts can't
 * overflow the stack.
 */
function loopingHeadings(keys: string[], next: Map<string, string[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Set<string>();
  let counter = 0;
  for (const root of keys) {
    if (index.has(root)) continue;
    const work: { k: string; i: number }[] = [{ k: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const succ = next.get(top.k) ?? [];
      if (top.i < succ.length) {
        const s = succ[top.i++];
        if (!index.has(s)) {
          index.set(s, counter);
          low.set(s, counter++);
          stack.push(s);
          onStack.add(s);
          work.push({ k: s, i: 0 });
        } else if (onStack.has(s)) {
          low.set(top.k, Math.min(low.get(top.k)!, index.get(s)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].k;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.k)!));
      }
      if (low.get(top.k) === index.get(top.k)) {
        const group: string[] = [];
        for (;;) {
          const k = stack.pop()!;
          onStack.delete(k);
          group.push(k);
          if (k === top.k) break;
        }
        if (group.length > 1 || succ.includes(top.k)) for (const k of group) out.add(k);
      }
    }
  }
  return out;
}
