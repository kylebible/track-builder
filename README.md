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

## Raised track

- **Ramps** (N, and N1 with two pegs) climb 64 mm over a D length. A ramp
  goes on by its low end, so it climbs away from the end you build from;
  Reverse (S) turns it round to go down from raised track. Everything built
  on from the top stays up there.
- **Raise** and **Lower** (U, D) lift whatever is selected a level (64 mm)
  at a time. Select connected (A) first to lift a whole stretch.
- Supports are worked out, not placed: a stack of 64 mm blocks stands under
  every raised end, shared by the two ends at a joint
  (`src/layout/supports.ts`). The parts list counts the blocks.
- Ends only join at the same height. Track a full level over other track is
  a bridge; the check flags track crossing lower than that, ends that line
  up at different heights, and supports that would stand on track below.
- Trains feel the slope: a battery engine gets up a ramp pulling one car,
  but a heavy train stalls partway and slides back down.

**T switch** (T) and **star switch** (X) are built on a D straight with
quarter curves into its ends. Every end where paths split has its own lever
when trains run: three on a T, four on a star.

Unmeasured guesses, all in `src/pieces/dimensions.ts` and
`src/pieces/catalog.ts`: the ramp's exact profile (a smooth S here),
the support block size, and which ends of N, T and X are pegs.

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
position in mm, heading in degrees and, for raised track, height in mm.
It also names the environment it was built on.

- Scenery (tunnel, station, level crossing, bridge pier, signal, trees,
  cottage) is at the bottom of the palette. It drags, rotates, flips and
  deletes like track. Drag a tunnel, station or pier near the middle of a
  straight and it lines up over it. The level crossing is a real track piece
  (a medium straight) and joins like one.

Joints are never stored. Two ends count as joined whenever they mate within
the joint play, so a loop that closes in the app closes on the floor.

## Scenes

The **Scene** button picks what the track sits on, at real size
(`src/environments/`):

- Indoors: a play table (1220 × 820 mm with a 20 mm rim, about 400 mm
  high), a 2 × 1.4 m living room rug, a 2.4 × 1.6 m children's play mat
  printed with roads, a roundabout, a river with bridges, a farm, a school,
  shops, a pond and a beach (`src/environments/playmat.ts`), a hardwood
  floor, or the original grid mat with 10 cm squares. Toys lie about the
  floor round them.
- Outdoors: grass with trees, flowers, sheep and a playground; town streets
  (200 mm roads in a 1.5 m grid) with parks, houses, shops, flats, car
  parks and street lamps; a meadow with a 32 cm river, boats, ducks and a
  windmill; a lake beach with palms, umbrellas, sandcastles, sailing boats
  and beach huts; or a snowy field with pines, snowmen and cabins.

The props are toy-like models built from simple shapes
(`src/environments/props.ts`) and laid out from a fixed seed
(`src/environments/dressing.ts`), always leaving the middle of the scene
clear for building.

The choice saves with the layout, in files and share links. The check
reports track that runs past the edge of the table or rug, and track lying on
the ground in the river or lake: raise it over the water like a bridge.
Raised track (on supports or up a ramp) can cross water. Sizes and where the
water is live in `src/environments/environments.ts`; the table size is a
guess at a common train table (`TABLE`). New layouts start on the table;
layouts saved before scenes existed stay on the grid mat.

## Running trains

Open **Trains** in the toolbar (Y) and drag engines and cars onto the
track. Drop one by the end of a train (a green ring shows where) and it
couples on; drop it anywhere else on the track and it starts a new train.
On the track, tap a car to turn it round, or drag it to lift it off and put
it somewhere else; drop it off the track to take it away. Trains that run
into each other nose to tail couple up.

Each train carries its own controls, floating over it: ◀ ■ ▶ for the
engines, ⇄ to turn the whole train round and ✕ to take it off. The panel
keeps Pause, the speed and Reset. Tap a switch's yellow knob to change
which way it sends trains; the yellow stripe shows the way it is set.

The eye button on a train's controls (or C) rides along: the view moves to
the front of the train, over an engine's cab or over the leading car when
it is being pushed, looking down the track ahead (`src/trains/cab.ts`).
When the train backs up, the view moves to its other end. Drag to look
around; the view drifts back to straight ahead when you let go. Switch
knobs still work from the cab. Get off, or Esc, goes back to the view you
had.

The models (`src/trains/trainMesh.ts`) are built in code to look like
wooden Brio trains: painted beech bodies, red plastic wheels and magnet
couplers. No 3D scans are used, since none could be found with a licence
that allows it.

Each vehicle has a north magnet at the front and a south one at the back
(red and blue on the models), so a car turned the wrong way pushes away
instead of coupling, like the real ones.

The simulation (`src/trains/sim.ts`) keeps every axle on the track
centreline, since the grooves do, and works out each vehicle's motion
along the track from its motor, rolling drag, flange drag on curves (worse
for a long rigid wheelbase on a tight curve), the pull and push through
each magnet, and wheels climbing over gaps and rough joints. It flags a
train, with a red ring where it happened, when it:

- runs off an open end, or comes off at a gap or a badly lined-up joint,
- stops against a buffer stop,
- stalls: the motor is on but the drag is more than it can pull, with the
  numbers and the main cause (a tight curve, a gap, or just too much load),
- spins its wheels, or its engines push against each other,
- crashes into another train or its own tail.

It also says when a coupling comes apart, pulled too hard or with the
magnets slid off each other on a bend. Every force figure in `PHYSICS` and
every vehicle size in `src/trains/stock.ts` is an estimate to tune against
real trains, not a measurement.

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

## Scenery models

The scenery models are original, generic designs in the style of the
accessories wooden railway brands sell, built at real size in millimetres
to match the 40 x 12 mm track. Each is made from simple solids in
`src/scenery/models.ts` and exported to `public/models/scenery/*.glb`,
which is what the app loads:

```sh
npm run scenery   # rebuild the GLB files from src/scenery/models.ts
```

Each file is one mesh per paint colour with no textures, 6 to 46 kB. The
GLB files can also be opened in Blender, reworked and exported over the
generated ones (glTF Binary, +Y up, scale 1 unit = 1 mm). Models that sit on
track are centred on the track centerline, running along x; the level
crossing starts at its piece's first end. Running `npm run scenery` again
overwrites hand-edited files.

The bridge pier is placed on the floor only for now: track can't be raised
onto it yet.

Dimensions come from the
[woodenrailway.info Brio track guide](https://woodenrailway.info/track/brio-track-guide).
