# Veloxity Showroom

A to-scale 3D modelling platform for LED walls, LED posters and the Veloxity rental fleet, rebuilt from the
ground up around a modelling engine. Everything is in real units (inches internally, shown in the
unit you choose), on three axes, with undo, snapping, measuring, photo-matched venues and exports.

## Run locally

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173
npm run server       # optional: proxy + splat pipeline API on http://localhost:3001 (websites on walls need it)
```

`npm run build` type-checks and produces `dist/`. `npm run server` then serves `dist/` with the API
on one port (`PORT=3001` by default). `npm test` runs the engine's unit tests.

The splat pipeline needs `led-showroom-tools` (COLMAP and Brush) and `led-showroom-spaces` beside
the repo; without them that panel simply hides itself. Everything else runs with no setup.

## Layout

See [ARCHITECTURE.md](ARCHITECTURE.md). In short: `src/engine` is a framework-free TypeScript engine
over three.js (document model, commands/undo, scene renderers, tools, exports, persistence);
`src/app` is the React shell over it; `server/` is the local Node server; `api/` the Vercel proxy.

## What carried over from v1

Every practical v1 capability is here: multi-wall scenes with corners (mitred folds) and custom
cell shapes, up to eight content windows per wall with px / panel / % layout and 9-point alignment,
images, videos (including HEVC through WebCodecs), live websites through the proxy, test patterns,
spanning content across walls, bezels, double-sided, brightness in nits, base plates and back
supports, the moiré-free pixel-grid overlay with distance thresholds, engineering dimensions,
venue photos with perspective calibration (trace sightlines), the 3D venue room, Gaussian splats
(loading and the local video → splat pipeline), stage decks with attachment, save image, record
video (MP4 / WebM), presets (v1 presets import automatically), GPU / quality options and view
persistence.

## What is new

A real scene graph with any number of objects (LED walls, stages, an equipment catalog, imported
glTF/OBJ/STL/FBX models, rooms, splats, measurements), full three-axis transforms with a gizmo,
drag-on-floor moves with ground lock and stacking, snapping, box selection, an outliner, undo/redo
for everything, orthographic views and a view cube, walk mode, a measure tool with snapping, glTF
export, scene files with embedded assets, light and dark themes, and a redesigned interface.
