import { normalizeAngle } from '../geometry/pose';
import { layoutTraps, newTrapEntries } from '../trains/traps';
import { estimate, searchFills, type FillOptions } from './fill';
import { findJoints, openEnds, type EndRef, type Layout, type WorldEnd } from './layout';

/** A preview that only adds track, joining existing open ends in pairs. */
export interface Connections {
  layout: Layout;
  uids: string[];
  pairs: [EndRef, EndRef][];
  remaining: EndRef[];
  initialEnds: number;
  /** The search stopped at its work limit; another pairing may do better. */
  limited: boolean;
  /** Joining the ends introduces a train trap, shown just as in Generate a section. */
  trapped: boolean;
}

export interface ConnectOptions extends Pick<FillOptions, 'play' | 'blocked'> {
  budgetMs?: number;
  pairBudgetMs?: number;
  /** Changes the order of similarly promising pairs when trying again. */
  seed?: number;
}

const BUDGET_MS = 12000;
const PAIR_BUDGET_MS = 1000;
const MAX_ATTEMPTS = 80;
const MAX_PAIRS = 48;
/** A nearby gap can still beat a much longer link between separate sections. */
const SAME_SECTION_MM = 432;
const ref = (end: EndRef): EndRef => ({ uid: end.uid, connectorId: end.connectorId });

/** Prefer connecting separate sections before closing a loop within one section. */
function candidates(layout: Layout, ends: WorldEnd[], seed: number): [EndRef, EndRef][] {
  const parent = new Map(layout.pieces.map((p) => [p.uid, p.uid]));
  const root = (uid: string): string => {
    const p = parent.get(uid)!;
    if (p === uid) return uid;
    const r = root(p);
    parent.set(uid, r);
    return r;
  };
  for (const joint of findJoints(layout)) parent.set(root(joint.a.uid), root(joint.b.uid));
  const pairs: { a: WorldEnd; b: WorldEnd; separate: boolean; cost: number }[] = [];
  // Stable per-pair jitter lets another attempt try a different close pairing.
  const jitter = (a: EndRef, b: EndRef): number => {
    let h = seed | 0;
    for (const c of `${a.uid}:${a.connectorId}/${b.uid}:${b.connectorId}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return (h >>> 0) / 0x100000000 * 80;
  };
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i];
    for (const b of ends.slice(i + 1)) {
      const goal = { ...b.connector.pose, angle: normalizeAngle(b.connector.pose.angle + Math.PI) };
      pairs.push({ a, b, separate: root(a.uid) !== root(b.uid), cost: estimate(a.connector.pose, a.connector.z ?? 0, goal, b.connector.z ?? 0) + jitter(a, b) });
    }
  }
  return pairs.sort((a, b) => (a.cost + (a.separate ? 0 : SAME_SECTION_MM)) - (b.cost + (b.separate ? 0 : SAME_SECTION_MM)))
    .slice(0, MAX_PAIRS).map(({ a, b }) => [ref(a), ref(b)]);
}

/**
 * Join as many open ends as possible, trying other pairings when an earlier
 * route blocks a later one. Each step yields the best preview so far, and
 * time between steps does not count against the work budget.
 */
export function* searchConnections(base: Layout, options: ConnectOptions = {}): Generator<Connections, Connections> {
  const original = openEnds(base);
  let best: Connections = { layout: base, uids: [], pairs: [], remaining: original.map(ref), initialEnds: original.length, limited: false, trapped: false };
  yield best;
  if (original.length < 2) return best;
  const budget = options.budgetMs ?? BUDGET_MS;
  if (budget <= 0) return { ...best, limited: true };
  const pairBudget = options.pairBudgetMs ?? PAIR_BUDGET_MS;
  let spent = 0;
  let resumed = performance.now();
  const left = () => budget - spent - (performance.now() - resumed);
  const pause = function* (): Generator<Connections, void> {
    spent += performance.now() - resumed;
    yield best;
    resumed = performance.now();
  };
  const before = layoutTraps(base);
  interface Step {
    plan: Connections;
    pairs: [EndRef, EndRef][];
    index: number;
  }
  let clipped = false;
  const step = (plan: Connections): Step => {
    const ends = openEnds(plan.layout);
    if (ends.length * (ends.length - 1) / 2 > MAX_PAIRS) clipped = true;
    return { plan, pairs: candidates(plan.layout, ends, options.seed ?? 0), index: 0 };
  };
  const stack: Step[] = [step(best)];
  let attempts = 0;
  const better = (p: Connections) => p.remaining.length < best.remaining.length ||
    (p.remaining.length === best.remaining.length && (Number(p.trapped) < Number(best.trapped) || (p.trapped === best.trapped && p.uids.length < best.uids.length)));
  while (stack.length && left() > 0 && attempts < MAX_ATTEMPTS) {
    const current = stack[stack.length - 1];
    if (current.index >= current.pairs.length || current.plan.remaining.length < 2) {
      stack.pop();
      continue;
    }
    const [a, b] = current.pairs[current.index++];
    attempts++;
    const search = searchFills(current.plan.layout, a, b, { play: options.play, blocked: options.blocked, wanted: 1, budgetMs: Math.max(1, Math.min(pairBudget, left())) });
    let found = search.next();
    while (!found.done && left() > 0) {
      yield* pause();
      found = search.next();
    }
    const fill = found.value[0];
    if (!fill) continue;
    const remaining = openEnds(fill.layout).map(ref);
    // Plain paths must consume ends, never create extra loose branches.
    if (remaining.length >= current.plan.remaining.length) continue;
    const plan: Connections = {
      layout: fill.layout,
      uids: [...current.plan.uids, ...fill.uids],
      pairs: [...current.plan.pairs, [ref(a), ref(b)]],
      remaining,
      initialEnds: original.length,
      limited: false,
      trapped: newTrapEntries(before, layoutTraps(fill.layout)).length > 0,
    };
    if (better(plan)) best = plan;
    yield* pause();
    // This is the most ends plain two-ended paths can consume.
    if (!plan.trapped && plan.remaining.length === original.length % 2) return best;
    // An alternative first pair can leave more room than the current choice.
    stack.push(step(plan));
  }
  return { ...best, limited: clipped || stack.length > 0 };
}

/** The same search to completion, for non-interactive callers. */
export function connectOpenEnds(base: Layout, options: ConnectOptions = {}): Connections {
  const search = searchConnections(base, options);
  for (;;) {
    const next = search.next();
    if (next.done) return next.value;
  }
}
