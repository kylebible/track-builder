import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT } from '../layout/layout';
import { decodeLayout, encodeLayout, layoutFromJson, layoutToJson } from '../planning/file';
import { environmentId, getEnvironment, offArea, TABLE } from './environments';

const table = getEnvironment('table');
/** A long straight (216 mm) running along x, starting at `x`. */
const straightAt = (x: number, y = 0) => addPiece(EMPTY_LAYOUT, 'straight-long', { ...IDENTITY, x, y }).layout;

describe('environments', () => {
  it('knows its own ids and nothing else', () => {
    expect(environmentId('rug')).toBe('rug');
    expect(environmentId('moon')).toBeUndefined();
    expect(environmentId(undefined)).toBeUndefined();
  });

  it('finds track hanging off the table, inside the rim', () => {
    const inner = TABLE.width / 2 - TABLE.rim;
    expect(offArea(straightAt(-108), table)).toBeNull();
    // A straight ending right at the rim still fits.
    expect(offArea(straightAt(inner - 216), table)).toBeNull();
    const off = offArea(straightAt(inner - 100), table)!;
    expect(off.uids).toEqual(['p1']);
    expect(off.at.x).toBeGreaterThan(inner);
    // Across the table the track's own width counts: 20 mm from its centre to its edge.
    expect(offArea(straightAt(-108, TABLE.depth / 2 - TABLE.rim - 19), table)).not.toBeNull();
    expect(offArea(straightAt(-108, TABLE.depth / 2 - TABLE.rim - 21), table)).toBeNull();
  });

  it('never finds track off an endless floor', () => {
    expect(offArea(straightAt(50_000), getEnvironment('floor'))).toBeNull();
  });

  it('keeps the environment in layout files and share links', async () => {
    const layout = { ...straightAt(0), environment: 'grass' as const };
    expect(layoutFromJson(layoutToJson(layout)).environment).toBe('grass');
    expect((await decodeLayout(await encodeLayout(layout))).environment).toBe('grass');
    expect(layoutFromJson(layoutToJson(straightAt(0))).environment).toBeUndefined();
  });

  it('opens a layout whose environment it does not know, just without it', () => {
    const json = JSON.stringify({ ...JSON.parse(layoutToJson(straightAt(0))), environment: 'moon' });
    const opened = layoutFromJson(json);
    expect(opened.pieces).toHaveLength(1);
    expect(opened.environment).toBeUndefined();
  });
});
