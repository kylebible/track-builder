import { describe, expect, it } from 'vitest';
import { twoLassos } from '../trains/trapLayouts';
import { layoutTraps } from '../trains/traps';
import { checkLayout } from './check';
import { trapId, turnBackFixes } from './trapFix';

describe('fixing a train trap', () => {
  it('the check flags each trap at its way in', () => {
    const { layout, main, far } = twoLassos();
    const traps = checkLayout(layout).filter((i) => i.kind === 'trap');
    expect(traps).toHaveLength(2);
    expect(traps.every((i) => i.message.startsWith('Train trap'))).toBe(true);
    expect(traps.map((i) => i.uids[0]).sort()).toEqual([main, far].sort());
  });

  it('a turn-back siding on the loop lets trapped trains out', () => {
    const { layout, far } = twoLassos();
    const trap = layoutTraps(layout).traps.find((t) => t.loopUids.includes(far))!;
    const [fix] = turnBackFixes(layout, trap);
    expect(fix).toBeDefined();
    const pieces = fix.uids.map((uid) => fix.layout.pieces.find((p) => p.uid === uid)!.pieceId);
    expect(pieces.some((id) => id.startsWith('switch-'))).toBe(true);
    expect(pieces.some((id) => id.startsWith('buffer'))).toBe(true);
    const after = layoutTraps(fix.layout).traps;
    expect(after.map(trapId)).not.toContain(trapId(trap));
    expect(after).toHaveLength(1);
    // Nothing new wrong with the layout.
    expect(checkLayout(fix.layout).filter((i) => i.kind !== 'open-end' && i.kind !== 'trap')).toHaveLength(0);
  });
});
