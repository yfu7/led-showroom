# Veloxity Showroom — Architecture

A to-scale 3D modelling platform for LED walls, LED posters and event equipment. The
modelling engine is the core; the UI is a thin layer over it.

## Principles

1. **Engine first.** `src/engine` is framework-free TypeScript over three.js. It owns the
   document (scene model), rendering, tools, the command history and persistence, and it
   emits events. Nothing in `src/engine` imports React.
2. **Document is data.** Everything the user builds is a plain, versioned, serialisable JSON
   `Document`. Renderers are pure functions of the document; they never hold authoritative
   state. Undo/redo, presets, autosave and export all work on the document.
3. **Inches internally, any unit on screen.** World unit = 1 inch (all product specs are in
   inches; 1:1 scale). Y is up, the ground plane is `y = 0`. The UI formats every number in
   the user's chosen unit (`in`, `ft-in`, `mm`, `cm`, `m`).
4. **Every mutation is a command.** UI and tools call `engine.run(command)`. Commands are
   `{ label, do(), undo(), mergeKey? }`; drags coalesce through `mergeKey`.
5. **Three axes, always.** Objects have full position/rotation/scale; tools expose all three
   axes (gizmo, drag-on-plane, numeric fields) with snapping and ground-lock.

## Layout

```
src/
  main.tsx                     boot: mount React
  app/                         React UI (a Zustand store mirrors engine state)
    App.tsx                    shell: TopBar / LeftDock / Viewport / RightDock / StatusBar
    store.ts                   zustand store, subscribed to engine events
    shell/                     TopBar, LeftDock, RightDock, StatusBar, ViewportOverlay, ViewCube,
                               Hud, CalibrationOverlay, ShortcutsSheet
    panels/                    Catalog (+ catalogItems), Outliner, Inspector, LedWallInspector,
                               ContentPanel (+ contentActions), CornersSection, ShapeEditor,
                               TransformSection, SceneInspector, EntityInspectors, VenuePanel,
                               ExportPanel (+ exportDialogs), PresetsPanel
    components/                Button/IconButton, Segmented, Toggle, NumberField + LengthField
                               (unit-aware, drag-to-scrub), Slider, Select, TextField, Section,
                               MenuPanel (the one menu surface) + Menu (anchored dropdown) +
                               ContextMenu (useContextMenu, right-click at a point),
                               Modal, Tooltip, Toasts, DropZone, Icons
    menus/                     entityMenu: the item lists every right-click menu is built from
    hooks/                     useGlobalShortcuts, useViewportStats
    styles/                    tokens.css (design language), base.css, components.css
  engine/
    Engine.ts                  facade: document + scene + tools + history + events + persistence
    clipboard.ts               internal entity clipboard (copy / cut / paste) + the shared
                               entity-cloning core used by duplicate and paste
    behaviours.ts              document post-processing: stage riding, auto-rotate, span source
    events.ts                  typed EventEmitter
    ids.ts                     id generator
    units.ts                   inch <-> unit conversion, parsing and formatting
    math.ts                    small vector/plane helpers
    document/
      types.ts                 Document / Entity / component types (the schema)
      Document.ts              immutable-style helpers: getEntity, addEntity, removeEntities, ...
      defaults.ts              factory functions for every entity type
    commands/
      History.ts               undo/redo stack with merge keys
      entity.ts                add / remove / update / transform / patch-document commands
    scene/
      SceneManager.ts          three.Scene, entity-renderer registry, sync(document) diffing
      Renderer.ts              layered WebGL + CSS3D + overlay renderers, GPU modes, resize
      CameraRig.ts             perspective/ortho cameras, orbit, fly mode, view presets, framing
      Environment.ts           shader ground grid, floor, lighting rigs, backdrop photo/colour
      Selection.ts             selection outlines, hover, bounding box with corner ticks
      Picking.ts               raycast helpers (entities, surfaces, ground, planes, projection)
    entities/                  one renderer per entity type (document -> three objects)
      EntityRenderer.ts        the renderer contract + transform helpers
      index.ts                 registry: registerDefaultRenderers(engine)
      LedWallRenderer.ts       panels, bezels, corners/mitres, custom shapes, accessories,
                               pixel grid, dimensions, content windows, brightness
      StageRenderer.ts         deck risers; RoomRenderer.ts venue room; GroupRenderer.ts
      EquipmentRenderer.ts     + equipmentGeometry.ts: parametric to-scale event equipment
      ModelRenderer.ts         imported glTF/OBJ/STL/FBX/PLY
      SplatRenderer.ts         Gaussian splats
      DimensionRenderer.ts     measure-tool dimensions
    ledwall/                   pure geometry/layout maths for LED walls (no scene state)
      specs.ts                 product constants (panel px/inch, base, support, gap, stages)
      layout.ts                cells, segments, corners, mitres, positions, pixel <-> local
      geometry.ts              panel/mitre/base-plate/support geometry + shared materials
      pixelGrid.ts             analytic moiré-free pixel-grid shader, masks, distance fade
      dimensions.ts            engineering dimension lines and billboard labels
      contentWindows.ts        rect maths, units (px / panels / %), align, spanning
    content/
      ContentLayer.ts          content source -> texture or CSS3D element
      video.ts                 codec sniffing, <video> pump, HEVC via WebCodecs + MP4Box
      generators.ts            test patterns, colour fills
      modelLoaders.ts          glTF/OBJ/STL/FBX/PLY loading and measuring
    tools/                     Tool.ts contract + ToolManager, index.ts registry, and
                               SelectTool, TransformTool (gizmo), MeasureTool, CalibrateTool,
                               ContentDragTool, ShapeTool, BoxSelect, snapping, pointSnap
    calibration/               perspective.ts (two-vanishing-point solve, EXIF focal length),
                               CalibrationSession.ts (sightline tracing, apply, grid)
    export/                    image.ts (PNG), video.ts (MP4/WebM), gltf.ts, composite.ts
    catalog/equipment.ts       equipment catalog definitions
    persistence/               AssetStore.ts (IndexedDB), presets.ts, sceneFile.ts, v1import.ts
  types/                       ambient declarations for mp4box and gaussian-splats-3d
server/index.cjs               local server: website proxy, splat pipeline, static dist
api/proxy.js                   Vercel serverless proxy
docs/                          v1 feature inventory (acceptance checklist) + design language
```

## Document schema (summary)

```ts
Document {
  version: 2; id; name; createdAt; updatedAt;
  units: 'in' | 'ft' | 'mm' | 'cm' | 'm';
  entities: Entity[];                 // flat list, parentId for hierarchy
  environment: {
    grid: { visible, spacingIn, majorEvery };
    floor: { visible, sizeIn, material };
    backdrop: { photo?: { url, name, calibration? }, color };
    room?: { widthIn, depthIn, heightIn, textures?, visible };
    lighting: { preset, intensity, hdr? };
    sky: 'studio' | 'dark' | 'light';
  };
  view: { camera: {...}, projection: 'perspective' | 'ortho', savedViews: [] };
  settings: { showBezels, autoRotate, showDimensions, showPixelGrid, pixelGridDistIn, ... };
}

Entity = LedWallEntity | StageEntity | EquipmentEntity | ModelEntity | SplatEntity
       | DimensionEntity | GroupEntity | RoomEntity
Base: { id, type, name, transform: { position, rotation (deg), scale }, visible, locked, parentId?, attachedTo? }
LedWallEntity adds: { product, cols, rows, shape: { mode, cells? }, corners, bezels, doubleSided,
  brightness, accessories, pixelGrid, dimensions, contentWindows[], spanGroup? }
```

## Data flow

```
UI event -> engine.run(Command) -> Document mutated -> engine.emit('document') ->
  SceneManager.sync(doc) (diff by entity id/version) -> renderers update three objects
  Zustand store receives the new document snapshot -> React re-renders panels
Pointer events on the viewport -> ToolManager -> active Tool -> commands (with mergeKey while dragging)
```

## Rendering

- `WebGLRenderer` (sRGB output, ACES tone mapping, shadows on in high-perf mode) under a
  `CSS3DRenderer` (websites / live iframes) — same camera, same DOM box.
- Images and videos are WebGL textures (export friendly, lit); websites are CSS3D iframes and
  are rasterised with html2canvas for exports.
- Selection: edge lines in the accent colour + a subtle bounding box; hover: faint edges.
- Ground grid: shader grid with 1 ft minor / 4 ft major lines, fading with distance.

## Controls

- Camera: orbit / pan / zoom (mouse + trackpad), fly mode (WASD + QE, eye height 66"),
  ortho views (Top/Front/Right/… numpad-style keys), view cube, `F` focus selection, `H` home.
- Right-click: context menus everywhere — the 3D view (entity actions, or place / frame / view on
  empty floor), the Objects panel, catalog cards and content-window rows. On the viewport the
  browser menu is suppressed by `ToolManager`, which raises the menu from the right-button
  pointerup (`contextmenu` fires on mouse*down* on macOS/Linux, so it cannot tell a click from a
  drag), offering the point to the active tool
  (`Tool.onContextMenu`) and then to `ToolManager.onContextMenu` subscribers — that is how
  `ViewportOverlay` puts its menu up. Only a right *click* qualifies: a right-drag stays a camera
  pan, and a stationary right press has its `userMoved` side effect rolled back by `CameraRig`.
- Clipboard: Ctrl+C / Ctrl+X / Ctrl+V through `engine.copy / cut / paste`. Internal, not the
  system clipboard; a paste is one undo entry and lands on the clicked floor point when it comes
  from the viewport menu.
- Objects: select tool (click / shift-click / box select), drag-on-plane move (ground or the
  object's own plane; Shift = vertical), transform gizmo (`W`/`E`/`R`), local/world space,
  snapping (translate/rotate/scale increments), ground-lock, duplicate (`Ctrl+D`), delete,
  numeric transform fields.
- Tools: Measure (point-to-point with snapping), Calibrate (photo perspective), Content drag
  (move a content window on the wall by dragging on its pixels), Shape paint (custom walls).
