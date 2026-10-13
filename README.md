# Track Builder

Design wooden Brio train layouts in 3D at real piece dimensions, before
building them on the floor.

Live site: https://kylebible.github.io/track-builder/

## Building a layout

- Tap a piece in the palette to put it down. Open ends show as dots: blue
  for pegs, orange for holes.
- Tap an open end, then palette pieces, to keep extending from it. Pieces
  that have no end that fits are greyed out.
- Drag a piece to move it. Bring an end within 30 mm and 25 degrees of an
  open end of the other gender and it snaps on (`DEFAULT_SNAP_RANGE` in
  `src/layout/layout.ts`). Shift-drag, or double-click then drag, moves the
  whole connected section.
- Toolbar and keys: rotate 45° (R, Shift+R), flip so curves and switches turn
  the other way (F), attach by a different end (S), select the whole section
  (A), delete (Delete), undo and redo (Ctrl+Z, Ctrl+Shift+Z).

Joints are never stored. Two ends count as joined whenever they mate within
the joint play, so a loop that closes in the app closes on the floor.

## Development

```sh
npm install
npm run dev     # local dev server
npm test        # geometry and layout tests
npm run build   # type-check and build to dist/
```

Pushes to `main` run the tests and deploy to GitHub Pages. In the repo's
Settings → Pages, set **Source** to **GitHub Actions** once.

## How pieces are modelled

All geometry is plan-view 2D in millimetres (`src/geometry`). Each piece in
`src/pieces/catalog.ts` is data: its running paths (straights and arcs along
the track centerline) and its connectors, each with a position, an outward
heading and a gender (peg or hole). Two ends join when one is a peg, the
other a hole, and they are within the joint play in
`src/pieces/dimensions.ts` (2 mm and 2 degrees by default).

Turning pieces are defined turning left; the right-hand version is the same
piece flipped over (`mirrorPiece`), as with real double-sided Brio track.

### Assumptions still to measure

- **Curve radius.** `CURVE_RADII_ARE_INNER_EDGE` in `src/pieces/dimensions.ts`
  treats the published 182 mm (E) and 90 mm (E1) radii as inner-edge radii,
  so centerlines are 202 mm and 110 mm. Flip it if a real curve says
  otherwise; every curve, switch and test follows it.
- **Parallel switch offset.** F/G's second track is assumed to end 50 mm to
  the side (`PARALLEL_SWITCH_OFFSET`).
- **Switch letters.** Each switch shape comes as a pair that differ in where
  the pegs are; which letter has the peg on the trunk isn't confirmed.

Dimensions come from the
[woodenrailway.info Brio track guide](https://woodenrailway.info/track/brio-track-guide).
