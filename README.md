# Track Builder

Design wooden Brio train layouts in 3D at real piece dimensions, before
building them on the floor.

Live site: https://kylebible.github.io/track-builder/

## Building a layout

- Tap a piece in the palette to put it down. Open ends show as dots: blue
  for pegs, orange for holes, green for the end you're building from.
- Tap an open end, then palette pieces, to keep extending from it. Pieces
  that have no end that fits are greyed out.
- **Curves turn** (Left / Right, or T) sets which way new curves and
  switches turn as you build outward. Mirror (F) flips one already placed.
- **Ends** picks the peg and hole pattern for straights and curves: one of
  each, two pegs or two holes. Switches go on trunk first and buffer stops
  pick whichever version fits; Reverse (S) turns a switch round, swapping it
  for its twin with the pegs the other way if it has to.
- Drag a piece to move it. Bring an end within 30 mm and 25 degrees of an
  open end of the other gender and it snaps on (`DEFAULT_SNAP_RANGE` in
  `src/layout/layout.ts`). Shift-drag, or double-click then drag, moves the
  whole connected section.
- Dragging a piece that's joined into track flexes its joints instead, the
  way you nudge real track: each joint gives up to its play, the far end of
  the track holds still, and the piece stops once the joints run out. If
  that brings an open end within snap range of another and the joints can
  give enough to reach it, a loop that nearly meets closes. Pull 25 mm past
  the limit and the piece unclips and moves freely (`src/layout/flex.ts`).
- Toolbar and keys: rotate 45° (R, Shift+R), select connected (A), delete
  (Delete), fit the layout in view (V), undo and redo (Ctrl+Z,
  Ctrl+Shift+Z). The ? button lists them all.

## Planning tools

- **Parts** lists how many of each piece the layout uses, with every peg and
  hole version on its own line (left and right curves are the same piece
  turned over, so they count together). Copy puts the list on the
  clipboard as text.
- **Check** looks for what would go wrong on the floor: ends that nearly
  meet but sit outside the joint play (a loop that doesn't quite close),
  two pegs or two holes meeting, track running into other track, and open
  ends. Tap an item to fly to it; problems show as red rings while the
  check is open. Thresholds live in `src/planning/check.ts`.
- **Save & share**: the layout saves in the browser as you build. Download
  a layout file, open one, start afresh (undo brings the old layout back),
  or copy a share link. The link carries the whole layout in its `#layout=`
  part, so nothing is uploaded anywhere.

Layout files are JSON (`src/planning/file.ts`): each piece's catalog id,
position in mm and heading in degrees.

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
