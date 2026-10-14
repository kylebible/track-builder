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

## More track types

- **Middle straight** (A3, 72 mm), alongside the mini, short, medium and
  long straights.
- **Bendy track**: put it down straight, then Bend (B) it 7.5° at a time up
  to 45°, the way the Curves turn setting says (Shift+B straightens it). It
  bends about the end it's joined by. Every bend counts as one bendy track
  on the parts list.
- **Double track**: double straight (K1), large double curve (EE) and short
  double curve (EE1), two tracks 46 mm apart. A piece goes on by its first
  track; Reverse (S) moves it across to join by the other.
- **Arch bridge**: climbs a level over an N-length slope, runs across a
  144 mm top on its own legs and comes back down, so floor track can pass
  under the top. It needs no support blocks.
- **Bridge spans**: a stone viaduct (three arches, 432 mm), a suspension
  bridge (towers and cables, 432 mm), a steel truss bridge (216 mm) and a
  red covered bridge (288 mm). Each is level track a level up on its own
  structure, with a hole at both ends: climb to it with an N ramp and come
  down with an N1, like the C straight in an up and over. No support blocks
  go under a span or the ramp tops joined to it, and floor track can run
  underneath (`src/render/bridges.ts` draws them).

## Even more track types

- **Half curves** (large and short): a sixteenth of a circle, for awkward gaps.
- **Bumpy track**: an A length with three 4 mm humps that rock a train.
- **Curved ramp**: a quarter turn on the E radius that climbs a level.
- **Helix tower**: two turns round a central column, climbing a level per
  turn and coming out right over where it went in. It eases off where each
  turn passes over the one below, so every turn clears by a full level. No
  support blocks.
- **Curved viaduct**: a stone viaduct span turning an eighth of a circle.
- **Five-point switch** (Q), **parallel switch** (F1/G1, an A long) and
  **triple parallel switch** (F2/G2).
- **Curved crossing** (H3): two E curves crossing in the middle.
- **Double crossover** (K): a double straight with a crossover between
  its tracks.
- **Turntable**: a pit with eight ends round it. Trains run straight across
  any line; the turning itself isn't simulated. An **engine shed** (scenery)
  seats over a straight like the station does.

**T switch** (T) and **star switch** (X) are built on a D straight with
quarter curves into its ends. Every end where paths split has its own lever
when trains run: three on a T, four on a star.

Unmeasured guesses, all in `src/pieces/dimensions.ts` and
`src/pieces/catalog.ts`: the ramp's exact profile (a smooth S here),
the support block size, which ends of N, T and X are pegs, the bendy
track's length and bend limit, the double curves' radii, and the sizes
of the arch bridge and the bridge spans, and everything in "Even more track
types" apart from the Brio letters' lengths and angles from the guide.

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

- Scenery (tunnel, station, level crossing, lifting bridge, cargo loader,
  magnetic crane, bridge pier, signal, trees, cottage) is at the bottom of
  the palette. It drags, rotates, flips and
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

### Autoroute

Turn on **Autoroute** in the Trains panel and trains set the switches
themselves and wait for each other instead of colliding
(`src/trains/dispatch.ts`). Every piece of track is a block: a train holds
the pieces it stands on and reserves the way ahead, throwing each facing
switch its way as it does. It reserves on through the next switch that
splits the line and down the way it takes, to the switch at the far end,
so it never waits halfway along single track where a train coming the
other way could meet it. A piece another train holds stops it just short,
showing "Waiting for Train 2". At a facing switch whose lever points at
taken track, a train takes the other way if that one is free and leads on
(not into a siding), so trains pass each other on passing loops, going
the same way or opposite ways. With nothing set, it follows the levers;
levers no train has reserved still change with a tap. It also stops a
train before it runs off an open end.

**Go to** on a train's card sends it to a station, the cargo loader, a
crane or a trackside place by the shortest way, setting switches as it
goes (pieces other trains hold count as longer, so it picks the free side
of a loop). It runs whichever way round is shorter, backing up if need
be, and stops with its middle on the spot, after any loading or
unloading there; a blue pin marks where it's going. Trains can still
deadlock: two passing loops can't let four trains through each other.
Code can do the same with `sim.routeTo(trainId, destination)`;
`sim.arrivals` lists the trains that got there.

### Accessories that work

Some scenery works with running trains (`src/trains/accessories.ts`).
Trains with their engines on brake for them and set off again on their own:

- **Signal**: tap it to turn it red or green. A red signal stops trains
  coming toward its lamps, a little short of it; turn the signal round (R)
  to face the other way. It works the track within 90 mm of it.
- **Station**: trains stop with their middle at the platform for 3 seconds,
  once each time round. Some passengers get off each coach and some get on,
  and the train waits until they have.
- **Cargo loader**: sits over the track like a station. A train stops each
  empty open wagon under its chute and a crate drops in.
- **Magnetic crane**: put it beside the track, 5 to 15 cm from it. A train
  stops each loaded wagon under the hook, and the crane lifts the crate off
  and stacks it on the far side. A crate adds 20 g to a wagon.
- **Lifting bridge**: a long straight whose middle span rises 10 cm between
  two towers. Tap the yellow knob on its control box to lift or lower it.
  Trains wait at either end while it is up, it won't lift with a train on
  it, and anything that rolls onto it while it is up falls off.

Signals and the bridge's knob take taps whenever the Trains panel is open or
trains are on the track. Stopping distances and waiting times are in
`ACCESSORY`. The lifting bridge and the loader are our own designs, not
measured pieces.

### Cars, cargo and trackside stops

Besides the open wagon, coach and timber car there are a coal hopper, water
tank car, milk car, cattle car, mail van, flat car, car carrier and brake
van. Each car that carries something shows it on the model as it fills:
passengers at the windows, logs, coal, cows, crates and toy cars.

Steam engines burn water and coal and battery engines use charge as they
run (`SUPPLIES` in `src/trains/sim.ts`). A tender's coal is burned before
the engine's own, and a water tank car tops up the boiler when it gets low.
An engine that runs dry stops and says what it needs. The Trains panel has a
switch to turn this off, and Reset puts every train back with full stores
and empty cars.

The **Trackside stops** section of the palette has places that sit over a
straight like the station (`src/trains/stops.ts`). A train with its engines
on stops at one only when there's work for it there, lines up the cars that
need it, waits while the work is done, and carries on:

- **Water tower**, **coaling stage**, **charging post**: top up engines (and
  tenders and water tank cars).
- **Coal mine** fills coal hoppers; the **power station** empties them.
- **Farm** loads cows and milk; the **market** unloads them.
- **Post office** swaps the mail van's bags.
- **Lumber camp** loads logs; the **sawmill** takes them and loads crates of
  planks; the **toy factory** loads toy cars and crates; the **goods shed**
  unloads crates and toy cars.
- **Whistle board**: engines whistle as they pass. **Slow board**: trains
  slow down past it.

The train's controls show what's happening while it waits, and the panel
keeps a tally of what has been delivered. Work rates are in `WORK`.

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
npm run perf    # frame and edit timings for a 250-piece layout with trains
```

`npm run perf` drives the app in headless Chromium, so it needs Playwright
(`npm i -D playwright`, not installed by default). It reports draw calls,
the JS time of a frame's train update, an edit and the layout check, on
desktop and on a 4x CPU-throttled phone. Its frame rate uses software WebGL,
so compare it between runs on the same machine rather than reading it as
real-world fps.

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
