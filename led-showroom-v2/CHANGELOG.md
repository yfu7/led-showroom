# Changelog

## Unreleased

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
care.

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
