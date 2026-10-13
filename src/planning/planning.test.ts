import { describe, expect, it } from 'vitest';
import { deg, IDENTITY } from '../geometry/pose';
import { flexContext, flexDrag } from '../layout/flex';
import { addPiece, EMPTY_LAYOUT, extendFrom, findJoints, openEnds, transformPieces, worldEnds, type EndRef, type Layout } from '../layout/layout';
import { checkLayout, summarize } from './check';
import { codeFromHash, decodeLayout, encodeLayout, layoutFromJson, layoutToJson, LayoutFileError, shareUrl } from './file';
import { partsList, partsText } from './parts';

/** Keep adding pieces from the open end the last one left. */
function build(start: string, rest: (string | [string, 'flipped'])[]): { layout: Layout; uids: string[] } {
  let { layout, uid } = addPiece(EMPTY_LAYOUT, start, IDENTITY);
  const uids = [uid];
  let end: EndRef | null = { uid, connectorId: 'b' };
  for (const item of rest) {
    const [id, flipped] = typeof item === 'string' ? [item, false] : [item[0], true];
    const ext = extendFrom(layout, end!, id, flipped);
    if (!ext) throw new Error(`could not add ${id}`);
    ({ layout } = ext);
    uids.push(ext.uid);
    end = ext.next;
  }
  return { layout, uids };
}

const curves = (n: number) => Array<string>(n).fill('curve-large');

/** The oval with a siding from the layout tests: 13 pieces, every end joined. */
function ovalWithSiding(): Layout {
  let { layout } = build('curve-large', [...curves(3), ['switch-curved', 'flipped'], ...curves(4), 'straight-medium']);
  for (const id of ['curve-large', 'straight-long', 'buffer']) layout = extendFrom(layout, openEnds(layout)[0], id)!.layout;
  return layout;
}

/** Joints as sorted text, since rounding can change which joint is found first. */
const jointSet = (layout: Layout) =>
  findJoints(layout)
    .map((j) => [`${j.a.uid}:${j.a.connectorId}`, `${j.b.uid}:${j.b.connectorId}`].sort().join('-'))
    .sort();

const kinds = (layout: Layout) => checkLayout(layout).map((i) => i.kind);

describe('parts list', () => {
  it('counts each piece, with left and right curves as the same piece', () => {
    const { layout } = build('curve-large', ['curve-large', ['curve-large', 'flipped'], 'straight-short', 'curve-large-hh']);
    const list = partsList(layout);
    expect(list.total).toBe(5);
    expect(list.lines.map((l) => [l.name, l.variant, l.count])).toEqual([
      ['Short straight', 'peg + hole', 1],
      ['Large curve', 'peg + hole', 3],
      ['Large curve', 'two holes', 1],
    ]);
  });

  it('lists switches by which end has the peg', () => {
    const list = partsList(ovalWithSiding());
    expect(list.lines.find((l) => l.category === 'switch')).toMatchObject({ name: 'Curved switch', variant: 'hole trunk', brioIds: ['L'], count: 1 });
    expect(partsText(list)).toContain('9 × Large curve, peg + hole (E)');
    expect(partsText(list)).toMatch(/13 pieces in all$/);
  });
});

describe('layout check', () => {
  it('passes a closed circle and the oval with a siding', () => {
    expect(checkLayout(build('curve-large', curves(7)).layout)).toEqual([]);
    expect(checkLayout(ovalWithSiding())).toEqual([]);
    expect(summarize([])).toMatch(/Every end is joined/);
  });

  it('reports the open ends of a loose piece', () => {
    const { layout } = addPiece(EMPTY_LAYOUT, 'straight-medium', IDENTITY);
    expect(kinds(layout)).toEqual(['open-end', 'open-end']);
  });

  it('finds a loop that misses closing by a few millimetres', () => {
    const { layout, uids } = build('curve-large', curves(7));
    const nudged = transformPieces(layout, new Set([uids[7]]), { x: 5, y: 0, angle: 0 });
    const issues = checkLayout(nudged);
    // The nudged curve comes off both its neighbours.
    expect(issues.map((i) => i.kind)).toEqual(['near-miss', 'near-miss']);
    expect(issues[0].message).toMatch(/5\.0 mm apart/);
  });

  it('finds a joint that is out of line', () => {
    const { layout, uids } = build('straight-long', ['straight-long']);
    const turned = transformPieces(layout, new Set([uids[1]]), { x: 0, y: 0, angle: deg(5) });
    const [issue] = checkLayout(turned).filter((i) => i.kind === 'near-miss');
    expect(issue.message).toMatch(/out of line/);
    expect(issue.uids).toEqual(uids);
  });

  it('finds two pegs meeting where a loop closes', () => {
    const { layout } = build('curve-large', curves(7));
    const pegs = { pieces: layout.pieces.map((p, i) => (i === 0 ? { ...p, pieceId: 'curve-large-pp' } : p)) };
    expect(kinds(pegs)).toEqual(['same-gender']);
  });

  it('finds track laid across other track', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    ({ layout } = addPiece(layout, 'straight-long', { x: 108, y: -108, angle: deg(90) }));
    const overlaps = checkLayout(layout).filter((i) => i.kind === 'overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].at.x).toBeCloseTo(108, 0);
    expect(overlaps[0].at.y).toBeCloseTo(0, 0);
  });

  it('allows track side by side a track width apart', () => {
    let { layout } = addPiece(EMPTY_LAYOUT, 'straight-long', IDENTITY);
    ({ layout } = addPiece(layout, 'straight-long', { x: 0, y: 40, angle: 0 }));
    expect(kinds(layout)).not.toContain('overlap');
  });

  it('allows the diverging tracks out of every switch', () => {
    for (const id of ['switch-parallel', 'switch-curved', 'switch-short-curved', 'switch-three-way']) {
      let { layout, uids } = build('straight-medium', [id]);
      for (const end of openEnds(layout).filter((e) => e.uid === uids[1])) {
        layout = extendFrom(layout, end, 'straight-short')!.layout;
      }
      expect(kinds(layout), id).not.toContain('overlap');
    }
  });
});

describe('with joints flexed', () => {
  it('a loop closed by flexing passes the check, and stays closed once saved', async () => {
    // The oval from the flex tests whose sides come up 18 mm short.
    const { layout } = build('straight-long', [...curves(4), 'straight-medium', 'straight-mini', ...curves(4)]);
    expect(kinds(layout)).toEqual(['near-miss']);
    const grab = worldEnds(layout.pieces.at(-1)!).map((e) => e.connector.pose)[0];
    const flexed = flexDrag(flexContext(layout, new Set(['p11']), grab)!, { x: grab.x - 15, y: grab.y })!;
    expect(flexed.closed).not.toBeNull();
    expect(checkLayout(flexed.layout)).toEqual([]);
    // Saving rounds positions; every flexed joint is left with room to spare.
    expect(checkLayout(layoutFromJson(layoutToJson(flexed.layout)))).toEqual([]);
    expect(checkLayout(await decodeLayout((await encodeLayout(flexed.layout))))).toEqual([]);
  });
});

describe('layout files and links', () => {
  it('a saved layout opens with the same pieces and joints', () => {
    const layout = ovalWithSiding();
    const opened = layoutFromJson(layoutToJson(layout));
    expect(opened.pieces.map((p) => p.pieceId)).toEqual(layout.pieces.map((p) => p.pieceId));
    expect(jointSet(opened)).toEqual(jointSet(layout));
    expect(openEnds(opened)).toHaveLength(0);
  });

  it('turns away files that are not layouts, or use unknown pieces', () => {
    expect(() => layoutFromJson('not json')).toThrow(LayoutFileError);
    expect(() => layoutFromJson('{"format":"something-else","pieces":[]}')).toThrow(/isn't a track layout/);
    const unknown = JSON.stringify({ format: 'track-builder-layout', version: 1, pieces: [{ piece: 'monorail', x: 0, y: 0, angle: 0 }] });
    expect(() => layoutFromJson(unknown)).toThrow(/monorail/);
    const newer = JSON.stringify({ format: 'track-builder-layout', version: 99, pieces: [] });
    expect(() => layoutFromJson(newer)).toThrow(/newer version/);
  });

  it('a share link round-trips and stays short', async () => {
    const layout = ovalWithSiding();
    const url = await shareUrl(layout, 'https://kylebible.github.io/track-builder/');
    expect(url.length).toBeLessThan(1000);
    const code = codeFromHash(new URL(url).hash)!;
    const opened = await decodeLayout(code);
    expect(jointSet(opened)).toEqual(jointSet(layout));
  });

  it('a damaged link is reported, not opened', async () => {
    const code = await encodeLayout(ovalWithSiding());
    await expect(decodeLayout(code.slice(0, 20))).rejects.toThrow(LayoutFileError);
    expect(codeFromHash('#something=else')).toBeNull();
  });
});
