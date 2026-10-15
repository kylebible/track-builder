import { findFills } from '../layout/fill';
import { distance, IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, extendFrom, worldEnd, type EndRef, type Extension, type Layout } from '../layout/layout';

// Small layouts with and without train traps, for the tests.

/** Lay pieces one after another from `end`. */
export function lay(layout: Layout, end: EndRef, ids: string[], flipped = false): { layout: Layout; end: EndRef | null; uids: string[] } {
  const uids: string[] = [];
  let at: EndRef | null = end;
  for (const id of ids) {
    const ext: Extension = extendFrom(layout, at!, id, flipped)!;
    layout = ext.layout;
    uids.push(ext.uid);
    at = ext.next;
  }
  return { layout, end: at, uids };
}

const curves = (n: number): string[] => Array(n).fill('curve-large');

/** Put a curved switch on, by `by`, either gender: whichever fits. */
function switchOn(layout: Layout, end: EndRef, by: string, flipped = true): { layout: Layout; uid: string } {
  const ext = extendFrom(layout, end, 'switch-curved', flipped, by) ?? extendFrom(layout, end, 'switch-curved-peg', flipped, by);
  return { layout: ext!.layout, uid: ext!.uid };
}

/**
 * An oval with a curved switch in it, its branch off to the outside. On its
 * own, a train running one way round can take the branch; the other way,
 * it only ever runs through the switch from the branch side.
 */
export function ovalWithSwitch(layout: Layout = EMPTY_LAYOUT, attach?: { end: EndRef; by: string }, flipped = true): { layout: Layout; sw: string } {
  const placed = attach ? switchOn(layout, attach.end, attach.by, flipped) : addPiece(layout, 'switch-curved', IDENTITY, flipped);
  // Round from the straight's far end and back into the trunk, on the side away from the branch.
  const branch = worldEnd(placed.layout, { uid: placed.uid, connectorId: 'branch1' }).connector.pose;
  const away = (l: Layout) => {
    const added = l.pieces.slice(placed.layout.pieces.length);
    return added.reduce((sum, p) => sum + distance(p.pose, branch), 0) / added.length;
  };
  const ways = [true, false].map((f) => lay(placed.layout, { uid: placed.uid, connectorId: 'branch0' }, [...curves(4), 'straight-medium', ...curves(4)], f).layout);
  return { layout: away(ways[0]) > away(ways[1]) ? ways[0] : ways[1], sw: placed.uid };
}

/**
 * Two ovals joined by a line between their switches' branches. Each switch
 * has its trunk facing into its own loop, so a train that goes down the
 * line can never come back: each loop is a trap for trains from the other.
 */
export function twoLassos(): { layout: Layout; main: string; far: string; line: string[] } {
  const main = ovalWithSwitch();
  const line = lay(main.layout, { uid: main.sw, connectorId: 'branch1' }, ['curve-large', 'straight-long', 'straight-long', 'straight-long'], true);
  const far = ovalWithSwitch(line.layout, { end: line.end!, by: 'branch1' });
  return { layout: far.layout, main: main.sw, far: far.sw, line: line.uids };
}

/**
 * An oval with a line off it to a turning loop: the line runs into the far
 * switch's trunk, and its two branches lead round and back into each other.
 */
export function ovalAndTurningLoop(): { layout: Layout; main: string; far: string } {
  const main = ovalWithSwitch();
  const line = lay(main.layout, { uid: main.sw, connectorId: 'branch1' }, ['curve-large', 'straight-long', 'straight-long', 'straight-long'], true);
  const far = switchOn(line.layout, line.end!, 'trunk', false);
  const round = lay(far.layout, { uid: far.uid, connectorId: 'branch0' }, ['straight-long', ...curves(4)]);
  const fills = findFills(round.layout, round.end!, { uid: far.uid, connectorId: 'branch1' }, { budgetMs: 2000, wanted: 1 });
  if (!fills.length) throw new Error('no way round the turning loop');
  return { layout: fills[0].layout, main: main.sw, far: far.uid };
}
