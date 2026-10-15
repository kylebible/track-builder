import { placeConnectorAt } from '../geometry/joint';
import { distance } from '../geometry/pose';
import { getPiece } from '../pieces/catalog';
import { defOf, extendFrom, findPiece, worldEnds, type EndRef, type Layout } from '../layout/layout';
import { edgeEndPose, TrackNetwork } from '../trains/network';
import { RouteGraph } from '../trains/dispatch';
import { findTraps, type Trap } from '../trains/traps';
import { checkLayout } from './check';

// Fixing a train trap by giving trains somewhere to turn back: a straight
// on the loop is swapped for a switch the same length, its trunk facing
// the trains coming round, with a short siding and a buffer stop off its
// branch. A trapped train takes the siding, backs out of it the other way
// round, and can then leave the loop the way the others came in.

export interface TrapFix {
  layout: Layout;
  /** The new and changed pieces. */
  uids: string[];
  /** What it did, for the button and a message: "Added a turn-back siding". */
  label: string;
}

/** Switches whose straight way is as long as a straight they can stand in for, by that length. */
const SWITCHES_BY_LENGTH: [number, string][] = [
  [144, 'switch-curved'],
  [108, 'switch-short-curved'],
  [144, 'switch-parallel-new'],
];

/** Sidings to try off the switch's branch, shortest first: a buffer stop on its own is enough to turn back at. */
const SIDINGS: string[][] = [['straight-short'], ['straight-medium'], ['curve-large'], []];

/** A key for a trap, the same while the loop it shuts trains in stays the same. */
export const trapId = (trap: Trap): string => [...trap.loopUids].sort().join(',');

/**
 * Ways to free the trains in `trap` with a turn-back siding, best first.
 * Each one adds no new problems to the layout check (and none of
 * `blocked`'s, such as off the table), makes no new trap, and frees this one.
 */
export function turnBackFixes(layout: Layout, trap: Trap, options: { blocked?: (layout: Layout) => Iterable<string>; wanted?: number } = {}): TrapFix[] {
  const wanted = options.wanted ?? 1;
  const network = new TrackNetwork(layout);
  const before = checkLayout(layout, { traps: false }).filter((i) => i.kind !== 'open-end').length;
  const blockedBefore = new Set(options.blocked?.(layout) ?? []);
  const trapsBefore = findTraps(new RouteGraph(network)).traps.length;
  const fixes: TrapFix[] = [];
  const tried = new Set<string>();
  for (const key of trap.loop) {
    const [edgeKey, leaveText] = key.split('>');
    const edge = network.edge(edgeKey);
    if (!edge || tried.has(edge.uid)) continue;
    tried.add(edge.uid);
    const piece = findPiece(layout, edge.uid);
    const def = defOf(piece);
    if (def.category !== 'straight' || def.paths.length !== 1 || edge.path.kind !== 'straight' || edge.path.rise) continue;
    // The end trains running round come in at, and the one they leave by.
    const leave = Number(leaveText) as 0 | 1;
    const entry = edgeEndPose(edge, leave === 1 ? 0 : 1);
    const ends = worldEnds(piece);
    const inEnd = ends.find((e) => distance(e.connector.pose, entry) < 0.5);
    const outEnd = ends.find((e) => e !== inEnd);
    if (!inEnd || !outEnd) continue;
    for (const [length, base] of SWITCHES_BY_LENGTH) {
      if (Math.abs(length - edge.length) > 0.5) continue;
      for (const id of [base, `${base}-peg`]) {
        const sw = getPiece(id);
        const trunk = sw.connectors.find((c) => c.id === 'trunk')!;
        const straightOn = sw.connectors.find((c) => c.id === 'branch0')!;
        // The new switch's ends have to be the same way round as the straight's.
        if (trunk.gender !== inEnd.connector.gender || straightOn.gender !== outEnd.connector.gender) continue;
        for (const flipped of [false, true]) {
          const pose = placeConnectorAt(inEnd.connector.pose, defOf({ pieceId: id, flipped }), 'trunk');
          const swapped: Layout = {
            pieces: layout.pieces.map((p) => (p.uid === piece.uid ? { ...p, pieceId: id, flipped, pose } : p)),
          };
          for (const siding of SIDINGS) {
            const fix = laySiding(swapped, { uid: piece.uid, connectorId: 'branch1' }, siding);
            if (!fix) continue;
            const added = new Set([piece.uid, ...fix.uids]);
            const issues = checkLayout(fix.layout, { traps: false }).filter((i) => i.kind !== 'open-end');
            if (issues.length > before || issues.some((i) => i.uids.some((u) => added.has(u)))) continue;
            if ([...(options.blocked?.(fix.layout) ?? [])].some((u) => added.has(u) && !blockedBefore.has(u))) continue;
            const after = findTraps(new RouteGraph(new TrackNetwork(fix.layout))).traps;
            if (after.length >= trapsBefore || after.some((t) => trapId(t) === trapId(trap))) continue;
            fixes.push({ layout: fix.layout, uids: [...added], label: 'Added a turn-back siding' });
            if (fixes.length >= wanted) return fixes;
            break;
          }
        }
      }
    }
  }
  return fixes;
}

/** Pieces off an end, then a buffer stop of whichever gender fits. */
function laySiding(layout: Layout, from: EndRef, ids: string[]): { layout: Layout; uids: string[] } | null {
  const uids: string[] = [];
  let end: EndRef | null = from;
  for (const id of ids) {
    const ext = extendFrom(layout, end!, id);
    if (!ext?.next) return null;
    layout = ext.layout;
    uids.push(ext.uid);
    end = ext.next;
  }
  const buffer = extendFrom(layout, end!, 'buffer') ?? extendFrom(layout, end!, 'buffer-peg');
  if (!buffer) return null;
  return { layout: buffer.layout, uids: [...uids, buffer.uid] };
}
