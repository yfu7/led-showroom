/**
 * Chrome floating over the 3D viewport: the tool island (top centre), the view island (bottom
 * centre), the HUD (top left), the axis widget (top right), the contextual hint bar, the loading
 * strip, the catalog drop target and the calibration overlay. The root is pointer-transparent so
 * the canvas keeps receiving input; only the islands accept pointer events.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, Box, Focus, Footprints, Globe, Hand, Lock, LockOpen, Magnet, Maximize2, MousePointer2, Move, Orbit, RotateCw, Ruler, Scale3d,
} from 'lucide-react';
import { Button, IconButton } from '@/app/components/Button';
import { Segmented } from '@/app/components/Segmented';
import { useDoc, useEngine, useStore } from '@/app/store';
import { useViewportStats } from '@/app/hooks/useViewportStats';
import { CATALOG_DRAG_TYPE, CATALOG_DROP_EVENT } from '@/app/panels/Catalog';
import { pickGround, pointerToNdc } from '@/engine/scene/Picking';
import { isLedWall, type LedWallEntity } from '@/engine/document/types';
import type { LedWallRenderer } from '@/engine/entities/LedWallRenderer';
import type { Vec3 } from '@/engine/math';
import { useContextMenu } from '@/app/components/ContextMenu';
import { buildEmptyViewportMenu, buildEntityMenu, buildWindowMenu } from '@/app/menus/entityMenu';
import type { Tool, ToolId } from '@/engine/tools/Tool';
import type { Projection } from '@/engine/scene/CameraRig';
import { Hud } from './Hud';
import { ViewCube } from './ViewCube';
import { CalibrationOverlay } from './CalibrationOverlay';

/** The drag MIME type and drop event are owned by the catalog; re-exported for older importers. */
export { CATALOG_DRAG_TYPE, CATALOG_DROP_EVENT };

/**
 * Payload of the `showroom:catalog-drop` window event. `world` and `point` carry the same floor
 * point (the catalog listener reads `point`, or re-picks from `x`/`y` when it is absent).
 */
export interface CatalogDropDetail {
  id: string;
  world: [number, number, number];
  point: [number, number, number];
  x: number;
  y: number;
}

type Space = 'world' | 'local';
/** The transform tool's optional coordinate-space API (written by another agent; guarded). */
interface SpaceAware { space?: Space; setSpace?(s: Space): void }

const TRANSFORM_TOOLS: ToolId[] = ['move', 'rotate', 'scale'];
const isTransformTool = (t: Tool | null): t is Tool & SpaceAware => !!t && TRANSFORM_TOOLS.includes(t.id);

/* ───────── hints ───────── */

/** Renders `[Key]` fragments as <kbd>. */
function hintNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<kbd key={i++}>{m[1]}</kbd>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HINTS: Partial<Record<ToolId, string>> = {
  select: 'Drag to orbit · Right-drag to pan · Scroll to zoom · Drag an object to move it · [Shift]+drag to move vertically',
  move: '[W]/[E]/[R] switch · [X] local/world · [Ctrl] inverts snapping',
  rotate: '[W]/[E]/[R] switch · [X] local/world · [Ctrl] inverts snapping',
  scale: '[W]/[E]/[R] switch · [X] local/world · [Ctrl] inverts snapping',
  content: 'Drag the selected content window across the wall surface · [Esc] to exit',
  shape: 'Click cells to add or remove panels · Drag to paint · [Shift+S] to exit',
  add: 'Click the floor to place · [Esc] to cancel',
};
const WALK_HINT = '[W][A][S][D] move · [Q][E] up/down · Drag to look · [Shift] faster · [Shift+W] exit';
const PAN_SCHEME_HINT = 'Drag to pan · Middle-drag to orbit · Scroll to zoom · Drag an object to move it · [Shift]+drag to move vertically';

/* ───────── component ───────── */

export function ViewportOverlay() {
  const engine = useEngine();
  const doc = useDoc();
  const tool = useStore(s => s.tool);
  const flyMode = useStore(s => s.flyMode);
  const projection = useStore(s => s.projection);
  const viewLocked = useStore(s => s.viewLocked);
  const loadingCount = useStore(s => s.loading.size);
  const hasSelection = useStore(s => s.selection.length > 0);
  const presentation = useStore(s => s.presentation);
  useViewportStats();

  const snap = doc.settings.snap;
  const calibrated = !!doc.environment.backdrop.calibration?.solved;
  const hasPhoto = !!doc.environment.backdrop.photo;

  /* ───── transform space (engine flag on the transform tool, not in the store) ───── */
  // Each transform tool keeps its own space and the X shortcut toggles only the active one, so
  // read from the active tool when it is a transform tool and fall back to Move otherwise.
  const readSpace = useCallback((): Space => {
    const active = engine.tools.activeTool;
    const src = isTransformTool(active) ? active : (engine.tools.get('move') as SpaceAware | undefined);
    return src?.space ?? 'world';
  }, [engine]);
  const [space, setSpaceState] = useState<Space>(readSpace);
  useEffect(() => {
    const sync = () => { const s = readSpace(); setSpaceState(prev => (prev === s ? prev : s)); };
    const offs = [engine.on('tool', sync), engine.on('frame', sync)];
    return () => offs.forEach(f => f());
  }, [engine, readSpace]);
  const toggleSpace = () => {
    const next: Space = readSpace() === 'world' ? 'local' : 'world';
    // Write to all three so W/E/R hops keep the same space.
    for (const id of TRANSFORM_TOOLS) (engine.tools.get(id) as SpaceAware | undefined)?.setSpace?.(next);
    setSpaceState(next);
  };

  /* ───── contextual hint (measure reads the live tool hint; the nav scheme is a plain engine field) ───── */
  const [toolHint, setToolHint] = useState<string>(() => engine.tools.activeTool?.hint ?? '');
  const [navScheme, setNavScheme] = useState(() => engine.settings.navigation);
  useEffect(() => {
    const sync = () => {
      const h = engine.tools.activeTool?.hint ?? '';
      setToolHint(prev => (prev === h ? prev : h));
      const n = engine.settings.navigation;
      setNavScheme(prev => (prev === n ? prev : n));
    };
    const offs = [engine.on('tool', sync), engine.on('frame', sync)];
    sync();
    return () => offs.forEach(f => f());
  }, [engine]);

  let hint: ReactNode = null;
  if (flyMode) hint = hintNodes(WALK_HINT);
  else if (tool === 'measure') hint = toolHint;
  else if (tool === 'select') hint = hintNodes(navScheme === 'pan' ? PAN_SCHEME_HINT : HINTS.select!);
  else if (tool && HINTS[tool]) hint = hintNodes(HINTS[tool]!);
  else if (toolHint) hint = toolHint;

  /* ───── right-click menu ───── */
  // ToolManager suppresses the browser menu on the viewport and forwards right *clicks* (not
  // right-drag pans) here, after giving the active tool a chance to consume them.
  const menu = useContextMenu();
  const openMenu = menu.open;
  useEffect(() => engine.tools.onContextMenu(p => {
    const cam = engine.camera.camera;
    const origin = { clientX: p.event.clientX, clientY: p.event.clientY };
    // engine.pickAt, not a bare pickEntity: hidden entities must not swallow a right-click
    // (three's raycaster ignores `visible`, so an isolated-away wall would still be hit).
    const hit = engine.pickAt(p.ndc);
    if (hit) {
      const wall = engine.entity<LedWallEntity>(hit.entityId);
      // With the content tool on, the wall's pixels belong to the window under the pointer.
      if (engine.tools.activeId === 'content' && isLedWall(wall)) {
        const r = engine.scene.get(wall.id) as LedWallRenderer | undefined;
        const px = r?.pixelAtWorld ? r.pixelAtWorld(hit.point) : null;
        const win = px ? r!.windowAt(px.px, px.py) : null;
        if (win) {
          if (!engine.isSelected(wall.id)) engine.select([wall.id]);
          openMenu(origin, buildWindowMenu(engine, wall, win.id));
          return;
        }
      }
      // Right-clicking inside a multi-selection keeps it; anything else becomes the selection.
      if (!engine.isSelected(hit.entityId)) engine.select([hit.entityId]);
      openMenu(origin, buildEntityMenu(engine, engine.selection));
      return;
    }
    const g = pickGround(p.ndc, cam, 0);
    const point: Vec3 = g ? [g.x, 0, g.z] : [0, 0, 0];
    openMenu(origin, buildEmptyViewportMenu(engine, point));
  }), [engine, openMenu]);

  /* ───── catalog drop target ───── */
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    // Only the catalog's own MIME type counts: a text selection dragged out of a field must not
    // light up the drop layer or dispatch a bogus catalog id.
    const isCatalogDrag = (e: globalThis.DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      const list = Array.from(types);
      return !list.includes('Files') && list.includes(CATALOG_DRAG_TYPE);
    };
    const onEnter = (e: globalThis.DragEvent) => { if (!isCatalogDrag(e)) return; dragDepth.current++; setDragActive(true); };
    const onLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragActive(false); };
    const onEnd = () => { dragDepth.current = 0; setDragActive(false); };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onEnd);
    window.addEventListener('dragend', onEnd);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onEnd);
      window.removeEventListener('dragend', onEnd);
    };
  }, []);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const id = e.dataTransfer.getData(CATALOG_DRAG_TYPE).trim();
    if (!id) return;
    const ndc = pointerToNdc(e, engine.renderer.inputEl);
    const p = pickGround(ndc, engine.camera.camera, 0);
    const world: [number, number, number] = p ? [p.x, 0, p.z] : [0, 0, 0];
    window.dispatchEvent(new CustomEvent<CatalogDropDetail>(CATALOG_DROP_EVENT, {
      detail: { id, world, point: world, x: e.clientX, y: e.clientY },
    }));
  };

  /* ───── actions ───── */
  const activate = (id: ToolId) => { if (flyMode) engine.camera.setFlyMode(false); engine.tools.activate(id); };
  const toggleWalk = () => engine.camera.setFlyMode(!flyMode);
  const toggleSnap = () => engine.patchSettings({ snap: { ...snap, enabled: !snap.enabled } }, snap.enabled ? 'Disable snapping' : 'Enable snapping');
  const toggleGround = () => engine.patchSettings({ snap: { ...snap, groundLock: !snap.groundLock } }, snap.groundLock ? 'Unlock from ground' : 'Lock to ground');
  const toggleAutoRotate = () => engine.patchSettings({ autoRotate: !doc.settings.autoRotate }, doc.settings.autoRotate ? 'Stop auto-rotate' : 'Auto-rotate');
  const setProjection = (p: Projection) => engine.camera.setProjection(p);
  const toggleLock = () => {
    const next = !viewLocked;
    engine.camera.setLocked(next);
    // Keep the document's calibration in step, otherwise restoreFromDocument re-applies the old lock on load.
    if (doc.environment.backdrop.calibration) {
      engine.patchEnvironment(
        env => (env.backdrop.calibration
          ? { ...env, backdrop: { ...env.backdrop, calibration: { ...env.backdrop.calibration, locked: next } } }
          : env),
        next ? 'Lock view' : 'Unlock view',
        'calibration:locked',
      );
    }
  };

  const toolActive = (id: ToolId) => !flyMode && tool === id;
  const island = { pointerEvents: 'auto' as const };

  return (
    <div className="vp-overlay" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {dragActive && (
        // Above the islands, HUD and axis widget (z 9–10) so a release over any of them still lands here.
        <div
          className="vp-drop"
          onDragOver={onDragOver}
          onDrop={onDrop}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', zIndex: 11, boxShadow: 'inset 0 0 0 1.5px var(--accent)', background: 'var(--accent-soft)' }}
        />
      )}

      {!presentation && (
        <div className="vp-toolbar vp-tools" style={island} role="toolbar" aria-label="Tools">
          <IconButton round tip="Select" kbd="V" active={toolActive('select')} onClick={() => activate('select')}><MousePointer2 /></IconButton>
          <IconButton round tip="Move" kbd="W" active={toolActive('move')} onClick={() => activate('move')}><Move /></IconButton>
          <IconButton round tip="Rotate" kbd="E" active={toolActive('rotate')} onClick={() => activate('rotate')}><RotateCw /></IconButton>
          <IconButton round tip="Scale" kbd="R" active={toolActive('scale')} onClick={() => activate('scale')}><Scale3d /></IconButton>
          <span className="sep" />
          <IconButton round tip="Measure" kbd="M" active={toolActive('measure')} onClick={() => activate(tool === 'measure' ? 'select' : 'measure')}><Ruler /></IconButton>
          <IconButton round tip="Drag content" kbd="C" active={toolActive('content')} onClick={() => activate(tool === 'content' ? 'select' : 'content')}><Hand /></IconButton>
          <IconButton round tip="Walk" kbd="Shift+W" active={flyMode} onClick={toggleWalk}><Footprints /></IconButton>
          <span className="sep" />
          <IconButton round tip={snap.enabled ? 'Snapping on' : 'Snapping off'} active={snap.enabled} onClick={toggleSnap}><Magnet /></IconButton>
          <IconButton round tip={space === 'local' ? 'Local space' : 'World space'} kbd="X" active={space === 'local'} onClick={toggleSpace}>{space === 'local' ? <Box /> : <Globe />}</IconButton>
          <IconButton round tip={snap.groundLock ? 'Ground lock on' : 'Ground lock off'} active={snap.groundLock} onClick={toggleGround}><ArrowDownToLine /></IconButton>
        </div>
      )}

      {!presentation && doc.settings.showHud && <Hud />}
      {!presentation && <ViewCube />}

      {!presentation && hint && tool !== 'calibrate' && (
        <div className="hint-bar">{hint}</div>
      )}

      {!presentation && (
        <div className="vp-toolbar vp-views" style={island} role="toolbar" aria-label="Views">
          <Button size="sm" variant="ghost" tip="Home view" kbd="H" onClick={() => engine.setView('home')}>Home</Button>
          <Button size="sm" variant="ghost" tip="Front view" kbd="Alt+1" onClick={() => engine.setView('front')}>Front</Button>
          <Button size="sm" variant="ghost" tip="Three-quarter view" onClick={() => engine.setView('three-quarter')}>3/4</Button>
          <Button size="sm" variant="ghost" tip="Top view" kbd="Alt+7" onClick={() => engine.setView('top')}>Top</Button>
          <Button size="sm" variant="ghost" tip="Isometric view" onClick={() => engine.setView('iso')}>Iso</Button>
          <Button size="sm" variant="ghost" tip="Eye level" onClick={() => engine.setView('eye-level')}>Eye-level</Button>
          <span className="sep" />
          <IconButton round tip="Frame all" kbd="Shift+F" onClick={() => engine.frameAll()}><Maximize2 /></IconButton>
          <IconButton round tip="Frame selection" kbd="F" disabled={!hasSelection} onClick={() => engine.frameSelection()}><Focus /></IconButton>
          <span className="sep" />
          <Segmented<Projection>
            value={projection}
            onChange={setProjection}
            options={[
              { value: 'perspective', label: 'Persp', title: 'Perspective (Alt+5)' },
              { value: 'orthographic', label: 'Ortho', title: 'Orthographic (Alt+5)' },
            ]}
          />
          <IconButton round tip={doc.settings.autoRotate ? 'Stop auto-rotate' : 'Auto-rotate'} active={doc.settings.autoRotate} onClick={toggleAutoRotate}><Orbit /></IconButton>
          {(calibrated || hasPhoto || viewLocked) && (
            <IconButton round tip={viewLocked ? 'Unlock view' : 'Lock view'} active={viewLocked} onClick={toggleLock}>{viewLocked ? <Lock /> : <LockOpen />}</IconButton>
          )}
        </div>
      )}

      {menu.node}

      {loadingCount > 0 && <div className="progress-strip" aria-hidden="true" />}

      {tool === 'calibrate' && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
          <CalibrationOverlay />
        </div>
      )}
    </div>
  );
}
