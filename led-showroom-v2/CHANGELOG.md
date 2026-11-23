# Changelog

## Unreleased

### Generate render: a 3D viewer anyone can open; the drawing sheet is now Generate CAD

Generate render now saves one .html file. It opens in any browser, offline, with nothing to install,
so it can be emailed. It is view only:

- **Orbit** round the build: drag, scroll or pinch to zoom, right-drag to pan.
- **Walk** the floor at eye height (66 in). On a computer, click to look with the mouse and walk with
  W A S D or the arrows (Shift hurries, F switches mode). On a phone, use the thumb stick and drag to look.
- **Stands**: Overview, Front, Top and one square on to each wall (walls that share a name are
  numbered), plus Reset back to where the page opened. Each stand fits the window it is opened in.
- **Dimensions** (or M) shows the measurements as the app draws them, over the model: every wall's
  dimensions, whether or not they were switched on in the app, and the tape measurements placed in
  it with their dashed dx / dy / dz legs (the end markers stay in the app), in the display unit.
  Off when the page opens; the button is left out when there are none.

The room carries over: lighting, floor, shadows and the backdrop. A staged venue photo is embedded;
if its host will not hand it over, the toast says so and the plain backdrop is used. Each wall shows
the frame it is showing at export. Live websites and venue scans stay in the app, and the toast says
when the scene had any.

A PIN-gated diagnostics panel in the page shows fps, draw calls, triangles, the camera, the GLB size
and load time. It shows nothing private, since the file travels.

The drawing sheet now sits under its own entry, **Generate CAD**, in the Export panel and the File
menu. It is made to hand to the client:

- **No build column.** The schedule of walls, parts and notes on the right is gone, and so are the
  wall tag balloons that pointed into it. The specs stay in the title strip at the bottom.
- **The Veloxity logo** opens the title strip, in the brand blue, from the veloxity.us header.
- **Bigger views.** The views get the whole width, and the lines between the four cells move with
  the build, keeping third angle (Top over Front, Right beside it). A 778 x 134 x 54 in run of walls
  went from 1:192 to 1:96. When moving the lines buys no finer scale, the cells stay even.

Under the hood, the page's script (three.js inside, about 640 KB) is built on its own by a Vite
plugin and loads only when a viewer is saved. It travels in the page as base64 and runs from there,
since minified three can hold text that would end a plain script element early.

### Ghosts go out as the real parts

Anything that leaves the app for a client (Save image, video, the 3D viewer page, GLB/glTF) draws
ghost trusses, the parts a rig needs and we do not hold, as the real parts: solid, casting
shadows. The app still draws them see-through, and the build list and Truss panel still count
them to buy. The CAD sheet already drew every part solid. A video take and a GLB export may
overlap: the ghosts stay real until the last of them ends, and a ghost edited mid-take is set real
again on the next frame.

The CAD sheet's graphic scale drops to inches (¼, ½, 1, 2, 3 or 6 in) when a foot would overrun
its cell, as at 1:8 on ANSI A; before, the bar ran past the title block. Checked on every paper at
every standard scale.

### Header toggle: cheapest or hide couplers

The Truss section has a Header switch for Auto truss: Cheapest, as before, or Hide couplers.
Hide couplers puts no header coupler in a lintel's lowest holes, where it shows under the lintel,
whatever that costs. Flipping it plans a wall's Auto truss rig again in the new mode, and one undo
takes it back. On the 30 x 7 arch, each leg becomes a 5 ft under five blocks. The header couples to
the upper lintel row's low holes, the wall sits on the plates with no shim, and the parts to buy are
nine blocks and the couplers past ours, $6,485.40. Cheapest keeps the bottom row at $1,221 in
sticks.

A header chord may now sit up to 0.16 in under the holes it couples to, with the coupler taking
up the gap; before, it could only sit level or below a quarter-inch shim. A leg may stack up to
four spare blocks in Hide couplers, and the plan warns to have that stack checked. The lintel's
top row of holes can't be reached hidden: the nearest leg, 9 ft under three blocks, would stand
8.82 in above the 7-row wall.

The rig remembers its mode. A Hide couplers rig opened again in Build truss still couples with
nothing showing under the lintel. Auto truss's message now carries the planner's notes on the block
stack and the drop. If a re-plan fails, or you cancel replacing a hand-built rig, the switch goes
back to the mode the rig was built in.

### The 2 ft DT-GP2, a stick to buy

The catalog has the DT-GP2 2 ft stick in black (Global Truss GP0222), with none owned and priced
at a retailer's $407, an estimate. Auto truss can put one in a frame's leg where the 3 ft could go:
a 5 ft and a 2 ft stand as high as a 4 ft and a 3 ft, and cost $71 less to buy. The 30 x 7 arch's
legs are now a 5 ft and a 2 ft each, three 2 ft to buy, $213 less than three 3 ft.

### A fuller drawing sheet; Record video turns the whole build

The drawing sheet has a schedule column beside the views. It lists each wall under a tag (W1, W2...)
with its panel and pitch, array and panel count, size and pixels, and weight where the panel spec
gives one, then a total. Equipment is counted by catalog part, with parts to buy counted apart.
Notes give the units, how the cabinets hang (from the panel spec's mount holes), that DT-GP and F34
truss do not connect when both are drawn, and what "to buy" means. The Front and Top views carry the
wall tags; the Front view chains the walls' edges across its top and marks the height of each wall
top, and of each wall bottom off the floor. The Top view has a FRONT arrow, the title strip a sheet
number and paper size, and the border zone references (1, 2... across, A, B... down).

Record video now opens on a turntable: one full 360° turn of 60 s, 6° a second (45, 60, 90 or 120
s to choose), and the take ends with the turn. It frames the whole build, whatever is selected and
leaving out the room, so the build fills most of the frame at the widest point of the turn. The
take is full frame, so the turn is never cropped to the first angle. An orthographic view switches
to perspective for the take.

Takes come out as H.264 MP4. A frame past what H.264 takes (4096 px wide, 4096 x 2304 in all) is
scaled down to fit rather than recorded as VP9, and where the browser has no WebCodecs encoder,
MediaRecorder records MP4 where it can. WebM is left for a browser with no MP4 recorder at all.

### Auto truss buys as little as it can

Auto truss now picks the rig that costs least to buy. Pieces we own cost nothing; the rest are
priced from our orders (SO #735958 and #736643, and INV-1131 for the couplers at $18.75 after the
discount). The 3 ft stick is on none of them, so it is priced at a retailer's listed $478, and the
note says that one is an estimate. Holding every column still comes first; the cost decides between
rigs that hold as many, then the fewest pieces. Under a header span one column may go without a
coupler or a tower where that saves money, and the note says which column and what it saved. The
toast says what the parts to buy come to, and God Mode shows the plan's cost
against the rig put up. A span laid out as one stick we would have to buy is spliced from sticks
we have left, or with the cheapest stick to buy, where that costs less; sticks already standing
elsewhere in the scene count as used
when layouts are compared.

An arch's header still couples to the lintel's lowest row of holes. No leg of real sticks and
blocks puts a header chord on any other row within the quarter-inch shim, so the 30 x 7 arch stands
each frame leg on 7 ft of stick, one of them to buy, under a spare block, as before. Where a header could
take another row for the same money, the rig with fewest couplers bare under a lintel is chosen.

### Dimension labels scale with zoom; the turntable turns slower

Dimension and measure labels are now a fixed size in the room (12 in tall for a wall's dimensions)
rather than a fixed size on screen, so they grow as you zoom in and shrink as you pull back. Far out
they stop shrinking at half the size they used to hold, so a whole floor stays readable. In an
orthographic view the zoom alone scales them.

A turntable take turns no quicker than once every 30 s. Manual records one full turn (30 s); a
shorter take shows that part of the turn, and the dialog says how many degrees.

### Record video: falls back when the browser's encoder records nothing

Recording could fail with "No frames were recorded" where the browser said it could encode H.264
but its encoder then returned nothing, or returned frames the MP4 writer would not take. Now each
codec first encodes the opening frame into a throwaway file, and only one that comes out as a file
is used: H.264, then VP9, then VP8, then WebM. Where one the browser offered fails, the message says
which it fell back to and why, and a take that still ends empty says what the encoder or the MP4
writer reported. A codec whose encoder never finishes its test frame is given up on after 4 s, a
take the MP4 writer cut short says so, and the Record dialog's badge names the codec the same test
picks (MP4 · H.264, MP4 · VP9, or WebM).

### Auto truss puts the rig up through the builder

**Auto truss** is back, in the Truss section of the wall's inspector, in the Build truss panel and
on the wall's right-click menu. It plans the legs as before, then puts every piece up as Build truss
would: each piece is checked as a click would be, the gaps between frame tops are closed with F,
and the couplers come with the pieces. The rig then opens in Build truss to go on with by hand.

- On the 30 x 7 arch, flat and folded walls, and walls turned and moved, it stands the planned
  legs and puts the couplers into the planned holes on the planned shim, with no piece refused.
- F closes each gap from the sticks on hand where they reach, so a rig can take more, shorter
  sticks than the plan and draw fewer ghosts: a flat 30 x 7 takes 9 sticks and 12 ghosts, against
  the plan's 7 and 14.
- The message says, as before, where a mitre cuts holes away and where a fold leaves a column
  unheld.
- A planned piece that would not go up is left out and named in the message.
- Run again, it replaces its own rig without asking. A rig built by hand is asked about first.
- God Mode shows the last run on the wall: planned against put up, the gaps F filled, anything
  refused and why, and how long it took.

### Build truss: put a wall's rig up by hand, a piece at a time

**Build truss** (Shift+T, the wall's right-click menu, or the Truss section of its inspector) puts
the rig up from the DT-GP stock one piece at a time.

- **The palette** is the 3 ft stick (to buy), the 4, 5 and 8 ft sticks, the six-way block and the
  base plate, each with how many are left; keys 1 to 6 pick one. A piece past the stock goes up as
  a ghost. F34 is not offered: it does not connect to DT-GP.
- **Point** at an open face of a piece already up (a block has six) and the piece in hand shows
  there, green where it can go and red where it cannot, with the reason in the panel. A base plate
  goes on the floor behind the cabinets, snapped a whole number of sticks from a leg already behind
  the run, else to a line of bolt holes.
- **Click** (or Enter) puts it up. Its couplers come with it, and the wall is raised onto the plates
  and shimmed onto the holes as Auto truss does it.
- **F** fills the gap from a block's side to the block across from it with sticks that close it
  exactly, picked as Auto truss picks a span's sticks: columns held, then sticks on hand, then
  couplers, then the fewest sticks.
- **Right-click** a piece to take it down, with anything that stood only on it. A stick is found by
  its solid box, so a click between its lattice tubes still takes it.
- Every step is one undo.

Built by hand on the 30 x 7 arch (the three legs Auto truss stands, then F across both doorways),
the rig closes on Auto truss's shim and holds as many columns, from the sticks on hand.

A rig put up or changed by hand is marked so in the scene file. **Rebuild truss rig** asks before
it plans over one; undo puts the hand-built rig back.

### Auto truss: a walk-through arch gets its header, on a 3 ft stick to buy

**The base plate is 1.5 in thick**, as measured, where the catalog had it about an inch. Every rig
and the wall on it stand half an inch higher than 2.4.0 says; nothing changes between the truss and
the wall.

**A 3 ft DT-GP stick is back in the catalog, with none owned.** It is on none of our orders. The
planner puts one only in a frame's leg, only where it lands the header on a row of holes, and takes
such a rig only where it supports more columns than every rig of our own sticks. The stick is drawn
as a ghost, and the planner says how many to buy. A 2 ft DT-GP2 does the same job beside a 5 ft
stick (a 4 and a 3 make 7 ft, as a 5 and a 2 do), and costs less: see the DT-GP2 above.

**A 30 x 7 arch under a two-row lintel now frames.** A leg behind each pier stands on a plate, a
5 ft and a 2 ft stick and two blocks, the lower one a spacer: 107.82 in. Spans run block face to
block face behind both doorways, and the header's bottom chord lands on the lintel's low holes, on a
0.15 in shim. 28 of the 30 columns have couplers and all 30 are supported, where three towers gave 3
and 6. It takes three 2 ft sticks to buy, and 52 couplers where we have 38.

Those low holes stand 1.20 in above the lintel's bottom edge, and a coupler's body reaches 1.38 in
each way from its bolt, so 39 of the couplers over the doorways hang 0.18 in below the lintel, where
they show from the front. That is not checked, any more than the coupler past a column's side below.

In a sweep of 30-column arches of 3 to 12 rows, with bezels on, every arch of six rows or more with
doorways three to five rows high now frames on one 3 ft stick per leg (21 arches). With bezels off,
walls of five to nine rows with doorways two to four rows high frame on two per leg (15). Doorways of
six rows or more with bezels on, and of five or more on walls under ten rows with bezels off, still
stand on towers alone. No rectangular wall of 3 to 14 rows, 4 to 20 columns wide, takes one.

### Truss inventory: every order, and two systems that never mix

The catalog now holds what the five Stage Lighting Store sales orders say we bought.

- **DT-GP:** 3 x 8 ft, 6 x 5 ft, 12 x 4 ft (6 more on #736643; was 8), 6 six-way corners and 6
  base plates. The planner has four more 4 ft sticks to build from before it draws ghosts. No 3 ft
  stick is on any order, so none is in the catalog: the orders are the whole of our stock.
- **F34 was bought, not just quoted:** 2 x 1.5 m, 6 x 1.25 m, 4 two-way corners, 2 T junctions, 2
  steel 1 x 4 ft plates and 2 black 30 x 30 in plates, the last new to the catalog (the order says
  only 30 x 30; 3/8 in aluminium is from retailer listings). The 6-way junction block and the
  12 x 12 in plate were quoted but never ordered; they now show 0 owned, so the build list flags any
  placed as short.
- **DT-GP and F34 do not connect** (11.156 in section on bolted end plates, 11.42 in on conical
  couplers). Every truss part now names its system, the inspector shows it, and the planner builds
  from DT-GP alone: a test checks every rig it draws for a part of any other system. The half
  coupler is in neither; it closes on the 50 mm chord of both.
- Sales Order #735958 bills six DT-GP-Base36 plates against a quantity of 0, and lists six 30 in
  raised GP bases (GP0287) beside them at no charge. The catalog keeps the 36 x 36 in plate about an
  inch thick, as the plates we hold were described; GP0287 is not in the catalog.

### Auto truss: spans across openings, legs from 4, 5 and 8 ft sticks, and fewer towers

**Frames span openings.** A frame no longer needs one unbroken run of full-height columns. Where a
wall stands on piers with doorways between them, as an arch does, the planner puts a leg behind each
pier and bridges each doorway behind the lintel: sticks spliced end to end, up to eight to a span,
block face to block face. Every stick is end-plated, so each splice is a weld; the planner picks the
mix and order of sticks that puts the most couplers on the header clear of them. A leg stands only
behind columns filled down to the floor. A base plate may still reach out past the wall's end, but
never sideways into a doorway. Where a pier is one column wide, too narrow for a plate, the span runs
on past it to the next pier that can take a leg. Near a fold, a plate also keeps off the floor of
the doorways on the other side of it: between the jambs, from a plate's width in front of the wall to
a plate's width behind it. A wall with a doorway beside a fold gets fewer legs for it, sometimes none.

**A coupled column holds the columns bolted beside it.** Columns are bolted to each other, so the
couplers in one column carry its neighbours too. While a column's top stands no higher than 8 ft above
the plates (five iPoster rows), its couplers hold the column either side of it; above that, only the
column on the side of the hole line they are in. The planner now counts a column as supported when it
has couplers of its own or is bolted to one that does, and lays towers out to support the most
columns with the fewest towers: an 8 x 3 wall stands on three towers where it took six, a 2 x 3 on
one. It warns separately about columns held by a neighbour and columns nothing holds. The 8 ft line is
a working assumption, not a rated figure.

**Leg heights from every stick we have.** A leg is any stack of 4, 5 and 8 ft sticks, with a
corner block under the header's block as a spacer when that helps, so the header lands on a row of
holes within the quarter-inch shim. With bezels on, one leg does: plate, 4 ft stick and block, 60.16
in, the Financial Times frame, its header's top chord on the fourth row's low holes. With bezels
off, legs of 4 + 5 + 5 ft and a block (180.16 in, the ninth row's high holes) frame walls of ten to
twelve rows, and 4 + 4 + 5 + 5 ft or 5 + 5 + 8 ft with a spacer (239.32 in, the thirteenth row's low
holes) taller ones; nine rows and under stand on towers. Where no leg lands a header on a row, a
frame can still stand as a brace with no couplers on its header, where it supports as many columns
as towers would; with our sticks, no rectangular wall of three to nine rows comes out that way.

**Towers and spans count stock.** A tower takes the stack that leaves us least short, and a spliced
span takes sticks we still have before ones we would be short of. A frame's legs are laid out to
leave room for a tower's plate beside them.

**Spans past 20 ft are flagged.** That is where the DT-GP span table stops, so the planner warns
that a longer span wants checking before it carries the wall.

**Nothing stands in or shows past the cabinets across a fold.** Behind one run, a leg, span or
coupler could stand inside the cabinets of the run past a fold, in front of that run where the wall
folds forward, or show above or through it where it is shorter or open: a 7 x 4 folded 90 degrees
put a leg into its corner column. The planner now looks at each column of every other run
square on, and places no leg, span or coupler where it would stand in that column's cabinets or show
past them. A plate, which may reach under and in front of cabinets, is held to the doorways rule
above. Where two frames' plates would overlap at a tight fold, one frame gives way, and the planner
tries the frames in the other order too. It says when columns go unheld because of a fold.

This costs rigs. A wall that folds can get fewer legs than it would straight, sometimes none: of 59
folded walls drawn at random, 28 get a rig where 35 did, and 154 columns are held where 179 were,
though 14 of the 35 old rigs had something showing. A 50 x 20 wall folded twice stands on 18 legs
where 15 stood, holds 48 of its 50 columns where it held 49, and is slower to plan, about 0.9 s
where it took 0.8 s. A test samples every rig on 11 folded walls and those 59, reading what shows
off the scene rather than the planner's own sums: it finds nothing, where the planner as it was
showed something on 4 of the 11 and 14 of the 59.

For example, a 30 x 6 arch with two-column piers at both ends and in the middle, and a four-row
lintel over two-row openings, gets three legs of plate, 4 ft stick and block, and spans of 30 ft (4,
5, 8, 8 and 5 ft sticks) and 28 ft (an 8 and five 4 ft sticks), block faces 49 in up, over the
openings' 38.96 in tops. Every column is held, 28 by couplers of their own and 2 by the coupled
column beside them. It needs 48 couplers, 10 past our 38.

A walk-through arch cannot frame. Over five-row doorways the lintel's lowest holes stand 96 in up
the wall, and the nearest header our sticks give, on a block on 8 ft of stick, has its bottom chord
0.99 in over them: past the shim. A 30 x 7 arch with a two-row lintel stands on three towers, one per
pier, which hold the six pier columns; nothing holds the lintel's 24.

Known limits: one- and two-row walls get no rig. The shortest leg, a plate and a 4 ft stick, is
49 in, and two rows on the plates stand 38.9 in. On three rows no leg lands a header within the
shim, and a frame leg, 60.16 in, would show over their 57.82, so those walls stand on towers, most
columns held by a neighbour rather than couplers of their own. A frame spans only openings two rows
high or less, under its spans' 49 in; an arch over taller openings, a walk-through one included,
stands on towers alone, its lintel columns mostly out of reach. Bridging a one-column pier makes
long spans: a 29 x 6 arch over two-row openings, with a one-column middle pier, gets one 57 ft span
(six 8 ft sticks, a 5 and a 4), three 8 ft sticks past our three. A one-column end pier leaves a leg a window
of 1.6 in (its section behind the column, its plate reaching out past the wall's end but clear of
the doorway), so a frame reaches it only where a whole number of feet of span lands a leg there;
otherwise that end stands on a tower. Beside a fold, at any angle, some columns can be out of reach.
Across a fold, each column is looked at square on, not at a slant: at a slant, rig behind one run
can show beside another run's cabinets on a wall folded more than once (3 of 378 folded walls drawn
at random). Within a run, a coupler on a column's outer hole line can reach about 0.2 in past the column's side,
behind an open slot in the column beside it; that is not checked, folded or straight. With bezels
off, an 11 x 8 stands on six towers, every
column held, but they take 66 couplers, 28 past our 38. Spans past 20 ft are drawn but not rated.

## 2.3.0 — 2026-11-19

### Auto truss: hidden behind the wall, and built from what we own

2.2.0's rig stood a tower behind every column and stacked it to the top row, which left truss
showing over the top of most walls and ignored what was on the shelf. A rig now aims at what the
Financial Times wall needed: out of sight behind the cabinets, and built from our own stock.

**Nothing shows from the front.** Every stick and block stands behind the cabinets in front
of it: no higher than their top, no wider than the wall. Only the base plates reach out, flat on the
floor under the cabinets. A notched wall is read column by column, so a short column gets a leg
under its own top rather than one sized for its neighbours.

**Frames, not just towers.** Where a run of full-height columns allows it, the planner builds a
frame: legs of base plate, sticks and a 6-way corner block, with 4, 5 and 8 ft spans block to block
across the top. The header's chords take couplers too, wherever a row of holes lands on one clear of
a weld. The 11 x 8 Financial Times wall comes out as four legs of plate, 4 ft stick and block, 60.16
in tall, spans of 5 + 8 + 5 ft, the header on the fourth row's bottom holes over a 0.10 in shim,
every column held, 18 couplers and nothing short. That 4 ft leg is the only height of ours that lands
a header within the shim, so a frame needs a wall four rows high. Columns a frame cannot reach get
towers, and a tower's plate never overlaps another plate, across a fold included.

**The stock we own is the limit.** 8 ft: 3. 5 ft: 6. 4 ft: 8. Corner blocks: 6. Base plates: 6.
Half couplers: 38. Pieces already standing elsewhere in the scene come off those counts first. What
a plan needs past them is still drawn, see-through and named "(not owned)", and the toast, the
build list and Copy as text all say how many of each are ghosts. The F34 is quoted, not owned, so
the planner does not use it.

**The legs stand on the base plates, and so does the wall.** 2.2.0 drew a base as a 36 in riser.
It is the 36 x 36 in plate, about an inch thick, flat on the floor, and a leg's first stick bolts
straight onto it. The wall rests on the plates' top: up by the plate's thickness, plus at most a
quarter-inch shim when that lands a header chord on a row of holes. A wall standing higher comes
down to the plates. This replaces 2.2.0's hunt upward for a height that cleared every weld; a hole
on a weld now goes without a coupler and is reported.

The corner block is drawn as the 11.16 in cube it is rather than a 22 in junction, and the 4 ft
count is 8. Rigs placed before this keep their old pieces until Auto truss runs again.

Known limits: a wall under three rows gets no rig. The shortest leg we can stand, a plate and a
4 ft stick, is 49 in, and two rows on the plates stand 38.86 in, so it would show over the top.
With bezels off no header lands within a quarter inch (it would take 0.28 in), so those walls get
towers. Two frames meeting at a fold can still put plates on top of each other, and the planner
says so when they do.

### Build list: stage decks

Stage decks are on the build list now, as hardware lines: one line per size, the same deck turned
a quarter counted together, a deck on shorter legs kept apart. No deck stock is recorded yet, so
the lines carry no owned figure and never show a shortfall.

## 2.2.0 — 2026-11-19

The truss, the clamps and the bolt holes we actually own, the rig that holds a wall up, and the
count that goes to the warehouse. Measurements snap to real hardware rather than to triangles,
builds save as files on this computer, and the mouse pans before it orbits.

### Build list: what the scene asks the warehouse to pull

The app knew a wall was six columns of four. The warehouse needed to know it was sixteen cabinets,
six of them powered, two of those mitred on the right - and the person in between was counting it
off a screenshot.

File -> Build list, or the button under Export, counts it. Cabinets first, split powered against
regular and flat against cut, then the crates they ship in, then every catalog item standing in
the scene with its quantity and whether we own that many. Copy as text drops the whole thing into
an email or straight into the allocation sheet.

The counting rules are not this app's. They are the ones the fleet is actually scheduled by, out of
"LED Alloc 2026 - Rules & Assumptions", and the sheet already cites this app for its cabinet
dimensions, so the two now agree in both directions. The unit is the cabinet, never the panel: a
cabinet is six panels, and a list that said "panels" would pull six times too much, which is why
that figure appears only in the diagnostic view and says what it is when it does. Every column
carries one powered cabinet of its own cut, so a column with a mitred end wants a powered cabinet
with a mitred end rather than a flat one out of the general pile. A double-sided build is two sides
of one grid - twice the cabinets, twice the powered, one set of base plates under it. Crates take
eight cabinets and are pooled over the whole scene: six posters are twenty-four cabinets and three
crates, not six part-full ones. Set the sheet's money20/20 order up in the app - six 7 x 6 V-walls,
twenty posters, thirty double-sided - and it counts the 104 powered flat, 360 regular flat and
6 / 6 / 6 and 30 / 30 / 30 corner cabinets the sheet states, 572 in all. The 72 crates that holds
are the app's own arithmetic on the eight-to-a-crate rule.

Two things it says out loud rather than quietly getting wrong. A mitred corner is what the fold
implies, not what the build has to use - the HubSpot U-wall was butted with flats - so the cut
counts come with that caveat attached. And a wall folded at every joint might close into a ring,
which the geometry does not model: the app will show a Left and a Right where a cube wants two
Doubles, and now tells you so instead of leaving you to find out on the floor.

Shortfalls read off the same catalog the truss planner warns from, so the two screens cannot
disagree about what we own. A quoted part is not stock and is not counted as zero either; it simply
carries no shortfall, because how many we hold is not something an estimate says.

### Auto truss: the rig behind the wall

A build is a wall plus whatever holds it up, and the app could only draw the wall. The truss was a
catalogue you placed by hand, a leg at a time, with nothing checking that a coupler could reach the
cabinet it was meant to bolt to.

Right-click a wall and there is an Auto truss item. It plans a free-standing rig behind the wall and
puts the whole thing in with one command: a 36 in raised base behind each cabinet column, GP sticks
stacked on it to reach the top row, and a half coupler at every mount hole it can get a jaw to.

The geometry is the point of it. A coupler has a fixed reach - 1.97 in from the back face of its
bolt plate to the axis of the chord in its jaw - so a chord either lies exactly on a line of mount
holes or nowhere near one. Each leg is placed so one of its 50 mm main chords runs straight up that
column's line of holes, inboard of it, which also lands the whole 11.16 in section behind the
cabinet it carries instead of hanging nine inches past the edge of the wall. Couplers go on the main
chords only, never on the 25 mm diagonals, and never within a jaw's length of a weld: a half coupler
cannot close over a joint.

That last rule is why the wall comes up off the deck. The lowest hole on a cabinet standing on the
floor sits 1.2 in up, which puts a jaw right on the end frame of the base it is gripping, and an
inch of lift clears it. Taller walls want more, because every row has to clear at once and two
sticks meeting stand their end frames back to back in a 3.2 in dead band: a four-row wall settles
at 7.6 in, which is where all eight of its holes land in clear tube. A wall hanging off truss does
not care what height it hangs at, so the planner hunts upward in tenths of an inch, through a bay's
worth of travel, for the height that strands the fewest couplers, and says how far it moved the
wall. If no height clears everything it keeps the best one and reports what it had to leave off.
The floor-stand kit comes off at the same time, because its back supports stand exactly where the
legs do. All of it - the legs, the couplers, the raise, the kit - is one undo.

Folds are handled rather than skirted. Each leg squares up to its own run, and a fold tight enough
to mitre away a column's near line of holes sends that leg to the column's far line instead, rather
than leaving the cabinet at the corner with nothing under it.

It also says what the rig would cost. A wall wanting eight raised bases says so against the six on
the sales order: a plan you cannot build today is still the right plan, but it is worth saying out
loud. Auto truss on a wall that already has a rig replaces it rather than standing a second one
inside the first, and Remove truss rig takes it off and leaves the wall where it stands.

**Existing scenes look slightly different.** Truss chords are now drawn at their real 50 mm
diameter rather than a stylised 0.6 in radius - which is what makes a coupler placed on paper land
on the chord in the picture - and the plate under a truss upright is drawn at its declared footprint
instead of twice it, 11.16 in rather than 22.3 in. The old plate reached 2.8 in past the face of any
cabinet its leg stood behind, and overlapped itself on a single-column wall.

### The cabinets show their bolt holes, and you can measure to them

Every iPoster cabinet has an M10 hole at each of the four corners of its back face, each one
starting an inch in from both edges that meet at its corner. That is what a half coupler bolts
into, and it was nowhere in the app: the back of a wall was a blank grey face, so the one question
a rigger asks of a model - where does the truss meet this thing - had no answer in it.

Display > Mount holes draws them. The bore is only 0.39 in across on a 25.2 in cabinet, which is a
pixel or two from anywhere you would frame a build, so each hole gets a ring around it at a
readable size. Both ring radii come off the inset rather than being fixed, so the marker can never
cross the panel edge however small the cabinet.

The measure tool snaps to the hole centres, which is the point of drawing them: hole to hole across
a seam, hole to the floor, hole to a clamp. A hole beats the panel corner beside it when both are
under the pointer, because someone hovering a hole is aiming at the hole. The centre sits in the
face, not out at the marker - the marker stands off so it can be seen, and a tape measure does not
care. Only the holes turned towards you are offered: snapping goes by distance on screen, and the
back of a cabinet lands within a pixel or two of the front face directly over it, so without that
the front of a wall would snap to holes behind two inches of aluminium.

Sharp folds are the one place a hole goes missing. The mitre that lets two runs meet at a corner
trims the back face, and past about 107 degrees the trim passes the hole's offset: there is no face
left to draw it on. Those are left undrawn and unsnappable rather than hanging in the air beside the
fold. The count on the panel stays four - the inspector takes it from the spec, because the mitre is
how the drawing meets a corner, not a cut anyone makes to a cabinet.

### The turntable orbits the build

Record video has a Turntable toggle that carries the camera once around over the length of the
take - a 360° of the build, twelve seconds by default. It span around the wrong thing. OrbitControls
turns about its target, and that target is left wherever the last pan, focus or double-click put
it: a corner of the room, a clamp someone had zoomed in on, a point behind the camera. The result
swept the venue with the build drifting across the frame or out of it.

It now frames before it starts, so the target is on the build and the camera is at a distance that
fits it. With something selected it frames that instead - a turn around one wall rather than the
whole floor. The camera is left where the take put it rather than snapped back, because that is the
view the video is of, and it is the same state the Frame control gives.

### Builds saved on this computer, not just in the browser

Until now the app's whole memory was browser storage: one autosaved document and up to fifty
presets. That is held per browser profile AND per origin, so a build made on localhost was
invisible on the deployed site and vice versa, and clearing site data took the lot. There was no
history of a build either - the autosave is one slot, overwritten every half second.

File > Builds on this computer now saves real `.showroom.json` files into a folder on disk, lists
what is there with the date and size of each, and opens or deletes any of them. The folder's path
is on show in the dialog, because that is the literal answer to "where did my build go" - and
`Documents` is not always the Documents that Explorer shows, since OneDrive folder redirection
moves it and only the resolved path says where.

Saving over a build keeps the old one. The file already there is moved into `versions/` under its
own name and the time it was written, and those copies are listed under the build they came from,
so "previous builds" means previous builds and not just the last one. The stamp carries
milliseconds and takes a counter when even those collide: two saves inside one clock tick - a
double-click is enough - must not rename the first straight over the second.

Deleting is the opposite and says so before it fires. The button arms first, names how many
versions go with the build, and states that the files are deleted rather than sent to the Recycle
Bin. The versions go with the scene: once the build is gone nothing in the app can reach them
again, and disk nobody can see, still holding a build someone asked to be rid of, is not a backup.

This is the local server's half of the app, so the menu entry appears only where that server is
running. On the deploy the routes are not there and the entry hides itself - and "no store" has to
mean exactly that, so the listing is accepted only when it parses as JSON and has the shape the
server promises. A static host answering an unknown path with its own index.html would otherwise
read as an empty store, and the app would offer to save builds into nowhere.

### The measure tool snaps to elements, not just to triangles

Snapping only ever saw mesh topology: a vertex of the mesh under the pointer, or the midpoint of
one of the three edges of the hit triangle - which includes the diagonal a quad is split along, a
line that is nowhere on the object. Features a build is actually dimensioned from had no target at
all. The centre of a case, the middle of a wall's face, the midpoint of a real edge: none of them
is a vertex, so none of them could be caught.

An element's own box now contributes its 27 features - 8 corners, 12 edge midpoints, 6 face
centres and the centre. It is the box in the element's OWN frame, not a world-aligned box around
it, because an axis-aligned box around a rotated case has its corners out in the air beside it. A
folded LED wall gets one box per flat segment for the same reason; a custom shape gets none, since
a segment's rectangle covers cells a staircase removed, and every panel is its own mesh, so the
real corners of a custom shape already snap as vertices.

The gap this closes is the one that made snapping feel unreliable. Within a few pixels of a
silhouette corner the ray passes BESIDE the mesh and lands on the floor, so every mesh-derived
candidate vanishes at exactly the spot someone aiming at that corner puts the pointer. Element
features are tested on every path, including a floor hit and a complete miss.

`element` shares a rank with `vertex` rather than outranking it, so the closer of the two wins: a
box corner 9 px away must not beat a real vertex 1 px away on a truss or a clamp, which are
nothing like boxes.

### Selected items snap from anywhere

Select the panels or cases you want a distance between, and their features snap wherever they are
on screen, whether or not the pointer is over them - the scene in front no longer catches the
pointer first. Everything unselected still has to be near the ray: its bounds, grown by what the
snap radius is worth in inches at that depth, must meet the ray at all.

### The clamps, and what they bolt to

Thirty-eight TAF 8002 slim half couplers, from Invoice INV-1131 (Truss Concepts, 13 October 2026,
paid). These are the part that connects the two halves of the inventory, so the entry says so: the
jaw takes 48-51 mm and the DT-GP chord is 50 mm, which no document states but both specs imply.
The bolt is M10 and so are the holes in our cabinets, which is the other half of the same fit.

Ours are the 8002, not the 8002-B, so they are natural aluminium rather than black - the one piece
of our truss hardware that is not. The invoice gives no geometry, so the size is nominal and says
so, as the junction blocks and base plates already do.

The cabinet side is recorded on the panel spec rather than in prose: `MountSpec` carries the thread
and the hole inset, with the inset defined as the distance to the NEAR SIDE of the hole, because
"the hole starts 1 inch in" is where it starts, not where its centre is. Which edges carry holes,
and how many, is deliberately left out - nothing measured says so yet, and guessing it would read
as measured.

A `clamp` geometry builds the part as a jaw on a bolt plate. The plate carries the declared height
and the jaw is sized from the depth left behind it, not the other way round: a jaw as tall as its
box is as deep as it is tall, so driving height from the jaw would make a part declared tall and
thin bulge far outside its own footprint.

### Dimensions of a folded shape land on the folded shape

A custom-shape wall could always be folded — it takes the same `corners` list a rectangular one
does — but its dimensions were drawn flat, under a comment asserting that "custom walls have no
corners". Past the fold the lines floated off the panels they measured and their labels bunched up
around the corner, which is what the pile-up in an L-shaped build actually was. It was never
crowding: two dimensions on the same side of a shape are never closer than a panel pitch, because
same side and same offset means the same edge run and those are merged before anything is drawn.

Each run is now drawn in the frame of the segment carrying it, the way segment widths already were,
and a horizontal run crossing a fold is split there. That is not only a placement fix: a span bent
through 90 degrees has no single length, so the old drawing labelled a six-panel top edge 151.5"
when what the build needs is two 75.7" faces. A four-row wall folded after column 2 goes from six
dimensions, two of them fictional, to eight that each describe one real edge.

### The truss we actually own

The catalog carried two placeholder trusses — a generic 12" box truss and a generic upright. Beside
them now sit the twelve parts from the Global Truss paperwork, with part numbers, counts and the
document each came from.

Six documents turned out to describe three purchases, not six. Two of them are the same sales order
twice (#735903 and #735958 differ in nothing but the order number and the date), and two more are
one estimate and its revision under a single number, #162181. Summing the stack naively would have
invented $29,014.97 of truss. What is left is one sales order and two estimates, and the difference
matters: only Sales Order #735958 was bought. The DT-GP arch package is real — six legs of 5 ft plus
4 ft, three 8 ft spans, six 6-way corners and six raised bases, which is exactly three arches. The
F34 parts are quoted and may never have been ordered, so each says so in its own spec rows rather
than sitting silently alongside the ones we hold.

The two systems do not connect to each other: DT-GP is an 11.156" section bolted with four 5/8"
Gr.8 bolts, F34 is 11.42" on conical couplers. Both are 6082-T6 aluminium, both ordered black.
DT-GP entries carry the engineered span table with its basis stated, since "370 plf" without
"strength plus L/180 deflection, loads at panel points, not additive" reads like a rigging rating.
There is no equivalent F34 data, so none is shown.

Stick lengths and sections are the manufacturer's own designations and are exact; the F34 segments
are metric (1.5 m and 1.25 m, not 5 ft and 4 ft). The paperwork gives no geometry for the junction
blocks or the base plates, so those dimensions are nominal and every one of them says so.

Three new geometry kinds — `truss-corner`, `truss-tee` and `truss-block` — build a junction as a
vertical hub spanning the full height with horizontal arms reaching the declared faces, so `dims` is
the overall extent including the arms and the block stands exactly as tall as it claims whichever
arms it has. Truss sticks take the entity's own colour through a new `alloy` material instead of the
fixed grey `metal`, because every stick on these orders is black. The raised 36" base plate needed
no new kind: `truss-upright` is already a plate with a truss riser on it.

The two generic placeholders are kept rather than replaced — a saved scene may reference them.

### Left drag moves, middle drag orbits

The default navigation scheme is now pan-first: holding the left button drags the view, holding the
scroll wheel orbits it. Both schemes already existed and the View menu still offers either, but the
default was orbit-first, and a stored preference wins over a default — so the switch would have
changed nothing for anyone who had already opened the app. The settings record therefore carries a
version now, and a record written before it drops only the keys whose default moved, keeping the
rest. A scheme chosen from the View menu from here on carries the version and is left alone.

Nothing else had to move: the pan scheme was already wired through `CameraRig.applyScheme`, and
`SelectTool` already suppresses camera pan for a claimed left press, which is what keeps drag-to-move
and box-select working when the left button is the pan button.

## 2.1.0 — 2026-11-18

A CAD drawing sheet, folds on hand-painted wall shapes, the two docks swapped, and an audit of what
happens when one scene holds many objects rather than one.

### Generate render

A third export beside Save image and Record video, and the first that produces a drawing rather than
a picture. Third-angle projection — Top above Front, Right beside Front, an isometric in the fourth
cell — on ANSI A or B, A4 or A3, at 150 or 300 dpi, with a title strip across the foot carrying the
project, the date, the panel count and LED area, each distinct wall resolution and the overall size.

The three orthographic views share one standard scale picked from the usual set (1:24, 1:48, 1:96…),
the largest at which every view still fits its cell, and the camera frustums are derived from that
ratio instead of zoom-to-fit, so the printed "1 : 48" and the scale bar are exact rather than
approximate and a dimension carries from one view to the next with a straightedge. The isometric is
fitted to its own cell and labelled NTS, which is what a pictorial is.

Hidden lines go without a CPU line solver: every surface is re-materialised paper white and pushed
back a hair with `polygonOffset`, then black edges are drawn over it, so the depth buffer does the
occlusion. Photo cutouts are billboards that turn to face the camera and would be a plausible-looking
lie in an elevation, so each is replaced by the outline of the entity's declared dimensions box.
Content windows, the pixel grid and the 3D annotations are left out — the sheet draws its own
dimensions, and a construction drawing is about the structure rather than what is playing on it. An
edge budget drops the remaining meshes to bounding-box outlines rather than stalling the tab, and
says so on the sheet when it does.

### Folds on a hand-painted shape

A custom shape and a mitred corner fold now compose. Painting a panel into the column left of the
shape renumbers every column, so a fold recorded as "after column 2" has to become "after column 3"
to stay on the same physical joint; it did not, and the whole wall folded one joint over the moment
the shape grew leftwards. Fold indices are re-keyed by the same translation the shape normaliser
applies, then pruned.

The shape grid also reads at the sizes people actually paint: a cell has an 18 px floor and the grid
scrolls sideways past roughly fourteen columns, instead of shrinking every cell to a sliver.

### The inspector is on the left

The two docks changed sides: the inspector and the scene tree now open on the left, the catalog on
the right. Inside each dock the editable fields come first and the read-only specifications sit at
the foot, so the things you change are under the cursor and the numbers you check are where a
specification sheet keeps them. No panel knows which side it is on — the assignment is two CSS
`grid-area`s and the two top-bar toggles that name the sides to the user.

### Many objects in one scene

The architecture is a show canvas holding idempotent items, each with its own specifications, and an
audit of it against N items fixed eleven defects. The ones worth naming:

- Deleting a parent took its children with it but recorded only the parent, so undo brought the
  parent back and left the children gone with no entry left to restore them.
- The per-wall content-window selection existed twice, in the engine and in the panel. Clicking a
  window in the viewport left the panel pointing at a different one, and the next edit landed on the
  wrong window. The engine's map is now the only owner, it emits its changes, and it forgets walls
  the document no longer has.
- The wall cap was enforced in the catalog alone, so duplicate, paste and the inspector's Duplicate
  button walked straight past it — and then the catalog refused every further wall because the scene
  already held more than the limit. Every path that adds walls asks one gate now.
- In span mode the walls share one canvas, but an item was re-rendered only when its own JSON
  changed, so resizing wall 2 or deleting wall 1 left wall 3 showing a stale slice. What a wall reads
  from its neighbours is now part of the scene's global key.
- A k-entity gizmo drag copied the whole document k times per frame; one pass over the entity list
  does it once.
- Selection outlines cached an `EdgesGeometry` per geometry in a `WeakMap` and dropped them without
  `dispose()`, which leaks the buffers for the life of the context because three keeps its own
  strong reference. They are now owned, capped and freed.
- Changing the selection ends any in-flight edit gesture, so two items edited inside the merge window
  can no longer fold into one history entry whose undo reverts the first and whose redo re-applies
  only the second.
- Windows left hanging outside a wall after a cols/rows edit, a shape paint or a product swap are
  re-clamped through one shared function rather than three.

### Diagnostic view

An administrative view behind a PIN, off by default and dropped on reload, that adds raw engine state
to the inspector and the render dialog: ids, the stored shape and corner arrays, sheet layout numbers
and per-phase compose timings. The standard view renders none of it — each caller guards on the flag
itself, so the normal inspector is byte-for-byte what it was.

### Fixed

- One typed edit pushed two undo entries. Enter committed and then blurred, and the blur handler
  committed the same text again against a `value` prop React had not refreshed, so a second command
  ran outside the merge window. Every number, length and colour field was affected, on single and
  multiple selection, and the visible symptom was a first Ctrl+Z that appeared to do nothing. One
  commit per focus session now; arrow stepping and scrub-drag are untouched by the guard.
- A multi-step shape paint merges into one history entry, and a merged entry redoes with the last
  step's command: the fold re-keying was written as a shift of whatever wall the patch landed on, so
  redoing a gesture that had grown the shape leftwards by three columns moved the fold by one. Both
  paint paths now compute the whole shape patch as a finished state, in one shared function.
- Escape in a name field committed the abandoned text as a rename, because the blur handler ran
  before React re-rendered with the restored name.
- Escape in a number or length field left the history merge window open, so an unrelated edit within
  a second and a half folded into the abandoned field's entry.
- Focusing a number field and leaving it without typing committed the displayed value, writing the
  rounded number back over the stored one. An untouched field now commits nothing.
- A drawing sheet of an empty scene printed `OVERALL 1 in × 1 in × 1 in` at `1 : 1`, in the title
  strip and again under every view. The unit cube is there to keep the layout maths finite, not to
  be measured; nothing on a blank sheet states a scale or a size now.

### Known limitations

- A multiple selection shows the primary item's value in each field and applies an edit as a shared
  delta. There is no "mixed" indicator to say the others differ.
- Encoding the drawing sheet to PNG dominates its cost at high resolution: on one 17-mesh scene, 150
  dpi took 78 ms in total and 300 dpi took 2.3 s, almost all of it in the encode. The diagnostic view
  reports the three phases separately.
- Loading a scene file that contains two entities with the same id renames the second rather than
  remapping what referred to it. A duplicate id makes any such reference genuinely ambiguous, so it
  is reported instead of guessed.

888 tests across 47 files, no type errors.

## 2.0.0 — 2026-09-06

The first release of Veloxity Showroom, a ground-up rebuild of the single-file v1 app as a to-scale
3D modelling platform. It lives in `led-showroom-v2/` alongside v1, which is untouched.

### The shape of it

`src/engine` is framework-free TypeScript over three.js and owns the document model, an undoable
command stack, scene renderers, tools, exports and persistence. `src/app` is a React shell that
reads a Zustand store and writes only through Engine commands, so everything is undoable. One world
unit is one inch, Y is up, and every object's origin sits on the floor at its bottom centre, which
is what makes the scene dimensionally honest rather than merely proportional.

### Carried over from v1

Audited against a 108-item checklist. Multi-wall scenes with mitred corner folds and custom cell
shapes; up to eight content windows per wall with pixel, panel and percentage layout and 9-point
alignment; images, video including HEVC through WebCodecs, live websites, test patterns and content
spanned across walls; bezels, double-sided, brightness in nits, base plates and back supports; the
moire-free pixel-grid overlay with distance thresholds; engineering dimensions; venue photos with
perspective calibration; the 3D venue room; Gaussian splats and the local video-to-splat pipeline;
stage decks with attachment; save image and record video; presets, with v1 presets importing
automatically.

### New

A real scene graph holding any number of objects, three-axis transforms with a gizmo, drag-on-floor
moves with ground lock and stacking, snapping, box selection, an outliner, undo and redo for
everything, orthographic views and a view cube, walk mode, a measure tool, glTF export, scene files
with embedded assets, right-click menus throughout, light and dark themes, and a redesigned
interface.

### Panel geometry now comes from the manufacturer's CAD

The LED iPoster panel is 25.2 × 18.9 × 1.77 in, taken from the SolidWorks STEP rather than v1's
rounded inch call-out of 25.125 × 18.875 × 2 in. The part is inch-authored, and these numbers make
the pixel pitch exactly square at 1.86 mm across 344 × 258 pixels, which is what a P1.86 product
should be. They also match the manufacturer's own 6 × 5 assembly at exactly 151.2 × 94.5 in.

`npm run cad` converts the STEP files in `cad/` to glTF, and the wall's base plate and back supports
render as that real geometry, with the parametric extrusion standing in synchronously so nothing
pops while the mesh loads.

### Catalog

The Veloxity fleet ships as photographed cutouts at real scale. Cards drag two ways: onto the
viewport to place the item, or onto a sibling card to reorder the group, which persists. Venue
spaces include 10 × 10, 20 × 10 and 20 × 20 trade-show booths, drawn as a footprint rather than a
room: the floor face, plus faded dashed corner guides on the 8 ft back-drape line. A booth is open
on its aisle sides in reality, so solid walls would be a fiction, and the guides read as the drape
datum instead — anything poking above them is over height for a linear booth. The room inspector's
"Walls as outline" switch does the same for a venue space, and switching it back off raises the
walls again.

### Security

The website-on-a-wall proxy validated only the URL scheme, which made the deployed app an open
proxy: any host could be named, including loopback, private ranges and the cloud metadata address,
and the response was read from inside the hosting network. It also relayed upstream `Set-Cookie`
onto this origin and returned everything with `Access-Control-Allow-Origin: *`.

`server/urlGuard.cjs` is now the single guard both proxies use. It rejects embedded credentials,
resolves the host and checks every returned address against the loopback, private, link-local,
carrier-grade NAT, reserved and multicast ranges, unwrapping IPv4-mapped IPv6 before re-checking.
The resolver runs once and the connection is pinned to the address that was validated, so a name
resolving public then private cannot slip through. Redirects re-run the guard on every hop and carry
a hop cap. A blocked host answers identically to a DNS failure, so internal topology cannot be
mapped by comparing errors. Cookies and the CORS header are gone from every response path.

A live handle on the Engine, and therefore on the document and every uploaded asset, was also
reaching every visitor from `App.tsx`. It is now development-only and eliminated from the production
bundle.

### Known limitations

- Because the proxy re-serves pages from this origin, a displayed site can still reach this origin's
  browser storage. Removing `allow-same-origin` from the website iframe would close it, at the cost
  of breaking any site that needs cookies or storage.
- Transform fields ellipsise into their tooltip past roughly 25 metres in millimetres; equal columns
  matter more there, because the axis-coloured handles are read down the column.
- The splat pipeline needs `led-showroom-tools` and `led-showroom-spaces` beside the repo. Without
  them that panel hides itself, and `/api/splat/videos` returns 404 on a hosted deployment.
- A booth saved before booths became outlines reopens with solid walls: `outlineWalls` defaults to
  false for any room a file does not carry it for, which is the right default for a venue space and
  the only safe one for a room the user shaped by hand. Guessing from the dimensions would silently
  strip the walls off a 20 × 20 ft room that was never a booth, so an old booth is switched over by
  hand — "Walls as outline" in the room inspector, or clicking the footprint again.

819 tests across 42 files, no type errors.
