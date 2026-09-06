/**
 * The item lists behind every right-click menu, in one place so the viewport, the Objects panel
 * and the Content panel offer the same actions with the same wording and the same undo labels.
 *
 * Everything here goes through `engine.run` / `engine.update`, so each item is undoable; anything
 * whose effect is off screen (isolate, select-all-of-type, paste) raises a toast.
 */
import {
  ArrowDown, ArrowDownToLine, ArrowUp, Box, Copy, CopyPlus, Eraser, Eye, EyeOff, Focus, Grid2x2, Layers, Lock, LockOpen,
  Maximize2, Monitor, MousePointer2, Pencil, Plus, RotateCcw, Ruler, Scissors, Shapes, Trash2, X,
} from 'lucide-react';
import type { Engine } from '@/engine/Engine';
import type { Entity, EntityType, LedWallEntity, StageEntity } from '@/engine/document/types';
import { isLedWall, isStage } from '@/engine/document/types';
import { cmdAddEntities, cmdUpdateEntities } from '@/engine/commands/entity';
import { descendants, uniqueName } from '@/engine/document/Document';
import { createStage } from '@/engine/document/defaults';
import { duplicateEntities } from '@/engine/tools/SelectTool';
import { stageTopY } from '@/engine/behaviours';
import { canReorderWindow } from '@/engine/ledwall/contentWindows';
import { hiddenEntityIds } from '@/engine/tools/BoxSelect';
import { STAGE_HEIGHTS_IN } from '@/engine/ledwall/specs';
import type { Vec3 } from '@/engine/math';
import type { MenuItem } from '@/app/components/MenuPanel';
import { useStore } from '@/app/store';
import { instantiateCatalogItem } from '@/app/panels/Catalog';
import { buildCatalog, catalogGroups, GROUP_LED, GROUP_STAGING, GROUP_VENUE } from '@/app/panels/catalogItems';
import { addWindow, clearWindowSource, duplicateWindow, moveWindow, removeWindow } from '@/app/panels/contentActions';
import { requestClearScene } from '@/app/shell/ClearSceneDialog';

const DEG = Math.PI / 180;

/* ───────────────────────────── rename plumbing ───────────────────────────── */

/**
 * Rename is an inline edit owned by a panel, not a command, so the menus ask for it by event:
 * `showroom:rename-entity` is picked up by the Objects panel and `showroom:rename-window` by the
 * Content panel. The dispatch is deferred one task so the panel that has to grow the row (the
 * Objects tab may still be switching in) is mounted and listening by the time it lands.
 */
export const RENAME_ENTITY_EVENT = 'showroom:rename-entity';
export const RENAME_WINDOW_EVENT = 'showroom:rename-window';

export interface RenameEntityDetail { id: string }
export interface RenameWindowDetail { wallId: string; windowId: string }

/**
 * True while no dock can be shown at all. The rename input lives in a panel, and a collapsed or
 * hidden dock still mounts it: at zero width it would take DOM focus invisibly and swallow every
 * subsequent keystroke, so the request is refused instead of firing into nothing.
 */
export const canRename = (): boolean => !useStore.getState().presentation;

export function requestEntityRename(id: string): void {
  const st = useStore.getState();
  if (st.presentation) return;
  // setLeftTab opens the dock as well, but say so explicitly — the input must be visible before
  // it is focused, whether or not the panels were hidden with Tab.
  st.setLeftOpen(true);
  st.setLeftTab('outliner');
  window.setTimeout(() => window.dispatchEvent(new CustomEvent<RenameEntityDetail>(RENAME_ENTITY_EVENT, { detail: { id } })), 0);
}

export function requestWindowRename(engine: Engine, wallId: string, windowId: string): void {
  const st = useStore.getState();
  if (st.presentation) return;
  if (!engine.isSelected(wallId)) engine.select([wallId]);
  st.setRightOpen(true);
  st.selectWindow(wallId, windowId);
  window.setTimeout(() => window.dispatchEvent(new CustomEvent<RenameWindowDetail>(RENAME_WINDOW_EVENT, { detail: { wallId, windowId } })), 0);
}

/* ───────────────────────────── entity actions ───────────────────────────── */

/** Y the entity origin must take so its rendered bottom rests on `supportY` (cf. TransformSection). */
function restY(engine: Engine, e: Entity, supportY: number): number {
  const b = engine.scene.get(e.id)?.bounds();
  const offset = b && !b.isEmpty() && Number.isFinite(b.min.y) ? b.min.y - e.transform.position[1] : 0;
  return supportY - offset;
}

const editable = (engine: Engine, ids: string[]): Entity[] =>
  ids.map(id => engine.entity(id)).filter((e): e is Entity => !!e && !e.locked);

/** Rest each entity on the floor, or on the deck it rides. One undo entry. */
export function dropToFloor(engine: Engine, ids: string[]): void {
  const targets = editable(engine, ids);
  if (!targets.length) return;
  const patches = targets.map(e => {
    const support = e.attachedTo ? engine.entity(e.attachedTo) : undefined;
    const supportY = isStage(support) ? stageTopY(support) : 0;
    const p = e.transform.position;
    return { id: e.id, patch: { transform: { ...e.transform, position: [p[0], restY(engine, e, supportY), p[2]] as Vec3 } } as Partial<Entity> };
  });
  engine.run(cmdUpdateEntities(engine, patches, { label: targets.length === 1 ? 'Drop to floor' : `Drop to floor (${targets.length})` }));
}

export function resetRotation(engine: Engine, ids: string[]): void {
  const targets = editable(engine, ids);
  if (!targets.length) return;
  engine.run(cmdUpdateEntities(
    engine,
    targets.map(e => ({ id: e.id, patch: { transform: { ...e.transform, rotation: [0, 0, 0] as Vec3 } } as Partial<Entity> })),
    { label: targets.length === 1 ? 'Reset rotation' : `Reset rotation (${targets.length})` },
  ));
}

export function setVisibility(engine: Engine, ids: string[], visible: boolean): void {
  const targets = ids.map(id => engine.entity(id)).filter(Boolean) as Entity[];
  if (!targets.length) return;
  engine.run(cmdUpdateEntities(engine, targets.map(e => ({ id: e.id, patch: { visible } as Partial<Entity> })), { label: visible ? 'Show' : 'Hide' }));
}

export function setLocked(engine: Engine, ids: string[], locked: boolean): void {
  const targets = ids.map(id => engine.entity(id)).filter(Boolean) as Entity[];
  if (!targets.length) return;
  engine.run(cmdUpdateEntities(engine, targets.map(e => ({ id: e.id, patch: { locked } as Partial<Entity> })), { label: locked ? 'Lock' : 'Unlock' }));
}

/** Clone the selection in place of the tool's Ctrl+D, so the menu and the key do the same thing. */
export function duplicateSelection(engine: Engine, ids: string[]): void {
  const { clones, idMap } = duplicateEntities(engine.doc, ids);
  if (!clones.length) return;
  engine.run(cmdAddEntities(engine, clones, clones.length === 1 ? `Duplicate ${clones[0].name}` : `Duplicate ${clones.length} objects`));
  engine.select(ids.map(id => idMap.get(id)).filter(Boolean) as string[]);
  engine.history.commit();
}

/** Everything selectable, exactly as the tool's Ctrl+A defines it: not locked, not hidden. */
export function selectAll(engine: Engine): void {
  const hidden = hiddenEntityIds(engine.doc.entities);
  engine.select(engine.doc.entities.filter(e => !e.locked && !hidden.has(e.id)).map(e => e.id));
}

/** Select every entity of `type` (Objects panel). */
export function selectAllOfType(engine: Engine, type: EntityType): void {
  const ids = engine.doc.entities.filter(e => e.type === type).map(e => e.id);
  if (!ids.length) return;
  engine.select(ids);
  engine.toast('info', ids.length === 1 ? 'Selected 1 object' : `Selected ${ids.length} objects`);
}

/** Hide everything that is not `ids` (nor an ancestor or descendant of them). One undo entry. */
export function isolateEntities(engine: Engine, ids: string[]): void {
  const keep = new Set(ids);
  for (const id of ids) {
    for (const d of descendants(engine.doc, id)) keep.add(d.id);
    let p = engine.entity(id)?.parentId;
    while (p) { keep.add(p); p = engine.entity(p)?.parentId; }
  }
  const hide = engine.doc.entities.filter(e => !keep.has(e.id) && e.visible);
  if (!hide.length) { engine.toast('info', 'Nothing else to hide'); return; }
  engine.run(cmdUpdateEntities(engine, hide.map(e => ({ id: e.id, patch: { visible: false } as Partial<Entity> })), { label: 'Isolate' }));
  engine.toast('info', hide.length === 1 ? 'Hid 1 object — use Show all to bring it back' : `Hid ${hide.length} objects — use Show all to bring them back`);
}

export function showAllEntities(engine: Engine): void {
  const hidden = engine.doc.entities.filter(e => !e.visible);
  if (!hidden.length) { engine.toast('info', 'Everything is already visible'); return; }
  engine.run(cmdUpdateEntities(engine, hidden.map(e => ({ id: e.id, patch: { visible: true } as Partial<Entity> })), { label: 'Show all' }));
  engine.toast('info', hidden.length === 1 ? 'Showed 1 object' : `Showed ${hidden.length} objects`);
}

/**
 * Another deck of the same size and height, butted against this one's local +X edge and sharing
 * its yaw — the usual way a stage grows. (Local +X maps to world (cos y, 0, −sin y), the same
 * handedness `applyTransform` and the deck attachment maths use.)
 */
export function addAdjacentDeck(engine: Engine, stage: StageEntity): void {
  const t = stage.transform;
  const r = t.rotation[1] * DEG;
  const w = Math.max(1, stage.widthIn) * Math.abs(t.scale[0] || 1);
  const position: Vec3 = [t.position[0] + w * Math.cos(r), t.position[1], t.position[2] - w * Math.sin(r)];
  const deck = createStage(stage.heightIn, position, uniqueName(engine.doc, stage.name.replace(/\s\d+$/, '')));
  deck.widthIn = stage.widthIn;
  deck.depthIn = stage.depthIn;
  deck.color = stage.color;
  deck.transform = { ...deck.transform, rotation: [0, t.rotation[1], 0], scale: [...t.scale] as Vec3 };
  engine.add(deck);
}

/* ───────────────────────────── entity menu ───────────────────────────── */

export interface EntityMenuOptions {
  /** Start an inline rename. Defaults to asking the Objects panel through the rename event. */
  onRename?(id: string): void;
  /** Extra items folded in just above the delete row (the Objects panel's own actions). */
  extra?: MenuItem[];
}

/**
 * The menu for one or more entities, shared by the viewport and the Objects panel. Callers must
 * have made `ids` the selection first — every item acts on the selection, not on a hidden target.
 */
export function buildEntityMenu(engine: Engine, ids: string[], opts: EntityMenuOptions = {}): MenuItem[] {
  const ents = ids.map(id => engine.entity(id)).filter(Boolean) as Entity[];
  if (!ents.length) return [];
  const primary = ents[ents.length - 1];
  const multi = ents.length > 1;
  const n = ents.length;
  const allVisible = ents.every(e => e.visible);
  const allLocked = ents.every(e => e.locked);
  const rename = opts.onRename ?? requestEntityRename;

  const items: MenuItem[] = [
    { label: 'Focus', icon: <Focus />, onSelect: () => engine.focusSelection() },
    { label: 'Frame selection', icon: <Maximize2 />, kbd: 'F', onSelect: () => engine.frameSelection() },
    'sep',
    { label: multi ? `Duplicate ${n} objects` : 'Duplicate', icon: <CopyPlus />, kbd: 'Ctrl+D', disabled: allLocked, onSelect: () => duplicateSelection(engine, ids) },
    { label: 'Copy', icon: <Copy />, kbd: 'Ctrl+C', onSelect: () => engine.copy(ids) },
    { label: 'Cut', icon: <Scissors />, kbd: 'Ctrl+X', disabled: allLocked, onSelect: () => engine.cut(ids) },
    { label: 'Rename', icon: <Pencil />, kbd: 'F2', disabled: multi || (!opts.onRename && !canRename()), onSelect: () => rename(primary.id) },
    { label: 'Drop to floor', icon: <ArrowDownToLine />, disabled: allLocked, onSelect: () => dropToFloor(engine, ids) },
    { label: 'Reset rotation', icon: <RotateCcw />, disabled: allLocked, onSelect: () => resetRotation(engine, ids) },
    'sep',
    allVisible
      ? { label: multi ? 'Hide these' : 'Hide', icon: <EyeOff />, onSelect: () => setVisibility(engine, ids, false) }
      : { label: multi ? 'Show these' : 'Show', icon: <Eye />, onSelect: () => setVisibility(engine, ids, true) },
    allLocked
      ? { label: 'Unlock', icon: <LockOpen />, onSelect: () => setLocked(engine, ids, false) }
      : { label: 'Lock', icon: <Lock />, onSelect: () => setLocked(engine, ids, true) },
  ];

  if (!multi && isLedWall(primary)) items.push(...wallSection(engine, primary));
  if (!multi && isStage(primary)) {
    items.push('sep', { label: 'Stage', header: true }, { label: 'Add adjacent deck', icon: <Layers />, onSelect: () => addAdjacentDeck(engine, primary) });
  }
  if (!multi && primary.type === 'dimension') {
    items.push('sep', { label: 'Delete measurement', icon: <Ruler />, danger: true, onSelect: () => engine.remove([primary.id]) });
  }

  if (opts.extra?.length) items.push('sep', ...opts.extra);

  items.push('sep', {
    label: multi ? `Delete ${n} objects` : 'Delete',
    icon: <Trash2 />, kbd: 'Del', danger: true, disabled: allLocked,
    onSelect: () => engine.remove(ids.filter(id => !engine.entity(id)?.locked)),
  });
  return items;
}

/** The "Wall" block of the entity menu: content, shape and the four display toggles. */
function wallSection(engine: Engine, wall: LedWallEntity): MenuItem[] {
  const patch = (p: Partial<LedWallEntity>, label: string) => engine.update<LedWallEntity>(wall.id, p, { label });
  return [
    'sep',
    { label: 'Wall', header: true },
    { label: 'Add content window', icon: <Plus />, onSelect: () => { const w = addWindow(engine, wall); if (w) useStore.getState().selectWindow(wall.id, w.id); } },
    { label: 'Edit shape', icon: <Shapes />, kbd: 'Shift+S', onSelect: () => { if (!engine.isSelected(wall.id)) engine.select([wall.id]); engine.tools.activate('shape'); } },
    { label: 'Bezels', checked: wall.bezels, onSelect: () => patch({ bezels: !wall.bezels }, wall.bezels ? 'Hide bezels' : 'Show bezels') },
    { label: 'Pixel grid', checked: wall.pixelGrid, onSelect: () => patch({ pixelGrid: !wall.pixelGrid }, wall.pixelGrid ? 'Hide pixel grid' : 'Show pixel grid') },
    { label: 'Dimensions', checked: wall.showDimensions, onSelect: () => patch({ showDimensions: !wall.showDimensions }, wall.showDimensions ? 'Hide dimensions' : 'Show dimensions') },
    { label: 'Accessories', checked: wall.accessories, onSelect: () => patch({ accessories: !wall.accessories }, wall.accessories ? 'Hide base and support' : 'Show base and support') },
  ];
}

/* ───────────────────────────── empty viewport menu ───────────────────────────── */

const DEFAULT_WALL_ITEM = 'led-wall-5x5';

/** Equipment groups (everything the catalog offers that is not an LED wall, a deck or a venue). */
function equipmentSubmenu(engine: Engine, point: Vec3): MenuItem[] {
  const items = buildCatalog(engine.doc.settings.units);
  const groups = catalogGroups(items).filter(g => g !== GROUP_LED && g !== GROUP_STAGING && g !== GROUP_VENUE);
  return groups.map(g => ({
    label: g,
    submenu: items.filter(i => i.group === g).map(i => ({
      label: i.name,
      onSelect: () => { void instantiateCatalogItem(engine, i.id, point); },
    })),
  }));
}

/** Right-click on empty floor: paste, place, frame, select, the view presets and clear scene. */
export function buildEmptyViewportMenu(engine: Engine, point: Vec3): MenuItem[] {
  const grid = engine.doc.environment.grid.visible;
  const items: MenuItem[] = [];
  if (engine.canPaste) {
    const n = engine.clipboard.topLevelCount;
    items.push({ label: n > 1 ? `Paste ${n} objects here` : 'Paste here', icon: <CopyPlus />, kbd: 'Ctrl+V', onSelect: () => engine.paste(point) }, 'sep');
  }
  items.push(
    { label: 'Add LED wall', icon: <Monitor />, onSelect: () => { void instantiateCatalogItem(engine, DEFAULT_WALL_ITEM, point); } },
    { label: 'Add stage deck', icon: <Layers />, onSelect: () => { void instantiateCatalogItem(engine, `stage-${STAGE_HEIGHTS_IN[0]}`, point); } },
    { label: 'Add equipment', icon: <Box />, submenu: equipmentSubmenu(engine, point) },
    'sep',
    { label: 'Frame all', icon: <Maximize2 />, kbd: 'Shift+F', onSelect: () => engine.frameAll() },
    { label: 'Select all', icon: <MousePointer2 />, kbd: 'Ctrl+A', onSelect: () => selectAll(engine) },
    'sep',
    {
      label: 'View',
      icon: <Focus />,
      submenu: [
        { label: 'Home', kbd: 'H', onSelect: () => engine.setView('home') },
        { label: 'Front', kbd: 'Alt+1', onSelect: () => engine.setView('front') },
        { label: 'Three-quarter', onSelect: () => engine.setView('three-quarter') },
        { label: 'Top', kbd: 'Alt+7', onSelect: () => engine.setView('top') },
        { label: 'Isometric', onSelect: () => engine.setView('iso') },
        { label: 'Eye level', onSelect: () => engine.setView('eye-level') },
      ],
    },
    {
      label: 'Grid', icon: <Grid2x2 />, kbd: 'G', checked: grid,
      onSelect: () => engine.patchEnvironment(env => ({ ...env, grid: { ...env.grid, visible: !env.grid.visible } }), grid ? 'Hide grid' : 'Show grid'),
    },
    'sep',
    // Destructive and unrecoverable, so it sits last and only ever opens the shared confirm.
    { label: 'Clear scene', icon: <Eraser />, danger: true, onSelect: requestClearScene },
  );
  return items;
}

/* ───────────────────────────── content-window menu ───────────────────────────── */

export interface WindowMenuOptions {
  /** Start an inline rename in the panel; defaults to asking the Content panel by event. */
  onRename?(windowId: string): void;
  /** Called after a window is removed, so the panel can move its selection. */
  onRemoved?(windowId: string): void;
}

/** Right-click on a content-window row, or on that window's pixels while the content tool is on. */
export function buildWindowMenu(engine: Engine, wall: LedWallEntity, windowId: string, opts: WindowMenuOptions = {}): MenuItem[] {
  const win = wall.contentWindows.find(w => w.id === windowId);
  if (!win) return [];
  const selectWindow = useStore.getState().selectWindow;
  const rename = opts.onRename ?? ((id: string) => requestWindowRename(engine, wall.id, id));
  return [
    { label: 'Select window', icon: <MousePointer2 />, onSelect: () => { if (!engine.isSelected(wall.id)) engine.select([wall.id]); selectWindow(wall.id, win.id); } },
    { label: 'Rename', icon: <Pencil />, kbd: 'F2', disabled: !opts.onRename && !canRename(), onSelect: () => rename(win.id) },
    { label: 'Duplicate window', icon: <CopyPlus />, onSelect: () => { const c = duplicateWindow(engine, wall, win.id); if (c) selectWindow(wall.id, c.id); } },
    { label: 'Clear content', icon: <Eraser />, disabled: !win.source, onSelect: () => clearWindowSource(engine, wall.id, win.id) },
    'sep',
    { label: 'Bring forward', icon: <ArrowUp />, disabled: !canReorderWindow(wall.contentWindows, win.id, 1), onSelect: () => moveWindow(engine, wall, win.id, 1) },
    { label: 'Send backward', icon: <ArrowDown />, disabled: !canReorderWindow(wall.contentWindows, win.id, -1), onSelect: () => moveWindow(engine, wall, win.id, -1) },
    'sep',
    {
      label: 'Remove window', icon: <X />, danger: true,
      onSelect: () => {
        removeWindow(engine, wall.id, win.id);
        opts.onRemoved?.(win.id);
        engine.toast('info', `Removed ${win.name}`);
      },
    },
  ];
}
