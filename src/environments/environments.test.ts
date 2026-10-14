import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../geometry/pose';
import { addPiece, EMPTY_LAYOUT, raisePieces } from '../layout/layout';
import { decodeLayout, encodeLayout, layoutFromJson, layoutToJson } from '../planning/file';
import { environmentId, getEnvironment, inLake, inRiver, inWater, LAKE, offArea, RIVER, riverCentre, TABLE } from './environments';

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

  it('finds track on the ground in the river, but not raised over it', () => {
    const river = getEnvironment('river');
    // A long straight across the river at x = 0, where it runs at RIVER.y.
    const across = addPiece(EMPTY_LAYOUT, 'straight-long', { x: 0, y: riverCentre(0) - 108, angle: Math.PI / 2 }).layout;
    const wet = inWater(across, river)!;
    expect(wet.uids).toEqual(['p1']);
    expect(inRiver(wet.at)).toBe(true);
    expect(inWater(raisePieces(across, new Set(['p1']), 64)!, river)).toBeNull();
    expect(inWater(straightAt(-108), river)).toBeNull();
    expect(RIVER.y - RIVER.width / 2 - RIVER.swing).toBeGreaterThan(300);
  });

  it('finds track in the lake, and none on the beach', () => {
    const lake = getEnvironment('lake');
    expect(inLake({ x: LAKE.x, y: LAKE.y })).toBe(true);
    expect(inLake({ x: 0, y: 0 })).toBe(false);
    expect(inWater(straightAt(LAKE.x - 108, LAKE.y), lake)!.uids).toEqual(['p1']);
    expect(inWater(straightAt(-108), lake)).toBeNull();
  });

  it('has no water where there is none', () => {
    for (const id of ['table', 'town', 'snow'] as const) expect(inWater(straightAt(LAKE.x - 108, LAKE.y), getEnvironment(id))).toBeNull();
  });
});
