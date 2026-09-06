# Changelog

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
