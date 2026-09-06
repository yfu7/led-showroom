/**
 * Catalog panel: searchable, collapsible groups of cards. Click adds the item at a free spot on the
 * floor; drag starts an HTML5 drag that the viewport overlay turns into a `showroom:catalog-drop`
 * window event, handled here through `instantiateCatalogItem`.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import * as THREE from 'three';
import { ChevronRight, Plus, Search } from 'lucide-react';
import type { Engine } from '@/engine/Engine';
import type { Document, Entity } from '@/engine/document/types';
import { wallDims } from '@/engine/ledwall/layout';
import { LIMITS, WALL_GAP_IN } from '@/engine/ledwall/specs';
import { pickGround, pointerToNdc } from '@/engine/scene/Picking';
import type { Vec3 } from '@/engine/math';
import { cmdAddEntities } from '@/engine/commands/entity';
import { cloneEntities } from '@/engine/clipboard';
import { useDoc, useEngine, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import { useContextMenu } from '@/app/components/ContextMenu';
import type { MenuItem } from '@/app/components/MenuPanel';
import { NumberField } from '@/app/components/NumberField';
import { TextField } from '@/app/components/TextField';
import { CatalogIcon } from '@/app/components/Icons';
import { buildCatalog, catalogGroups, findCatalogItem, wallSubLine, type CatalogItem } from './catalogItems';
import { applyOrder, clearOrder, isCustomised, loadOrder, reorder, saveOrder, type CatalogOrder } from './catalogOrder';

export const CATALOG_DRAG_TYPE = 'application/x-showroom-catalog';
export const CATALOG_DROP_EVENT = 'showroom:catalog-drop';

/* ───────────────────────────── placement ───────────────────────────── */

/** Approximate floor footprint (width along X, depth along Z, inches) of an entity not yet in the scene. */
function footprint(e: Entity): { w: number; d: number } | null {
  switch (e.type) {
    case 'led-wall': { const dm = wallDims(e); return { w: dm.totalW, d: Math.max(dm.panelD, e.accessories ? 20 : 6) }; }
    case 'stage': return { w: e.widthIn, d: e.depthIn };
    case 'equipment': return { w: e.dims[0], d: e.dims[2] };
    case 'model': return { w: e.dims?.[0] ?? 36, d: e.dims?.[2] ?? 36 };
    // rooms, splats, dimensions and groups keep their own origin
    default: return null;
  }
}

/** World XZ bounds of every placed, footprint-bearing entity (rooms enclose the scene, so they are skipped). */
function occupied(engine: Engine): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  const b = new THREE.Box3();
  for (const r of engine.scene.all()) {
    const t = r.entity.type;
    if (t === 'room' || t === 'dimension' || t === 'group' || !r.root.visible) continue;
    r.bounds(b);
    if (!b.isEmpty()) out.push(b.clone());
  }
  return out;
}

function isFree(x: number, z: number, fp: { w: number; d: number }, boxes: THREE.Box3[], margin = 2): boolean {
  const minX = x - fp.w / 2 - margin, maxX = x + fp.w / 2 + margin;
  const minZ = z - fp.d / 2 - margin, maxZ = z + fp.d / 2 + margin;
  return !boxes.some(b => b.max.x > minX && b.min.x < maxX && b.max.z > minZ && b.min.z < maxZ);
}

/**
 * Choose a spot for a new entity: the floor point under the viewport centre when it is free,
 * otherwise the next slot to the right of everything (v1 `arrangeWalls`: WALL_GAP_IN apart,
 * bottom-aligned on the floor). Sets `transform.position` on the entity in place.
 */
export function placeNew(engine: Engine, entity: Entity): Entity {
  const fp = footprint(entity);
  if (!fp) return entity;
  const boxes = occupied(engine);

  let pos: Vec3 | null = null;
  // Prefer the orbit target's floor point (what the user is looking at), then walk toward the
  // camera in front of it until a free spot appears; the raw viewport-centre ray tends to land far
  // behind whatever is in view.
  const target = engine.camera.controls.target;
  const cam = engine.camera.camera.position;
  const dir = new THREE.Vector3(cam.x - target.x, 0, cam.z - target.z);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); else dir.normalize();
  const step = Math.max(fp.d, 24) + 12;
  for (let k = 0; k <= 6 && !pos; k++) {
    const x = target.x + dir.x * step * k, z = target.z + dir.z * step * k;
    if (Number.isFinite(x) && Number.isFinite(z) && isFree(x, z, fp, boxes)) pos = [x, 0, z];
  }
  if (pos) {
    /* placed near the target */
  } else if (boxes.length === 0) {
    pos = [0, 0, 0];
  } else {
    let rightmost = -Infinity;
    for (const b of boxes) rightmost = Math.max(rightmost, b.max.x);
    pos = [rightmost + WALL_GAP_IN + fp.w / 2, 0, 0];
  }
  entity.transform = { ...entity.transform, position: pos };
  return entity;
}

/* ───────────────────────────── instantiate ───────────────────────────── */

function tooManyWalls(engine: Engine, entity: Entity): boolean {
  if (entity.type !== 'led-wall') return false;
  const n = engine.doc.entities.filter(e => e.type === 'led-wall').length;
  if (n < LIMITS.maxWalls) return false;
  engine.toast('error', `Up to ${LIMITS.maxWalls} LED walls per scene`);
  return true;
}

/**
 * Create the catalog item `id` and add it to the scene (selecting it). With `worldPoint` the entity
 * is dropped there (y is forced to the floor for floor-standing items); otherwise `placeNew` picks a spot.
 */
export async function instantiateCatalogItem(engine: Engine, id: string, worldPoint?: Vec3, params?: { cols?: number; rows?: number }): Promise<void> {
  const item = findCatalogItem(id, engine.doc.settings.units);
  if (!item) { engine.toast('error', 'Unknown catalog item'); return; }
  let entity: Entity | null;
  try {
    entity = await item.make({ engine, ...params });
  } catch (err) {
    engine.toast('error', `Could not add ${item.name}: ${(err as Error).message}`);
    return;
  }
  if (!entity) return;
  if (tooManyWalls(engine, entity)) return;
  if (worldPoint && footprint(entity)) {
    entity.transform = { ...entity.transform, position: [worldPoint[0], 0, worldPoint[2]] };
  } else if (!worldPoint) {
    placeNew(engine, entity);
  }
  engine.add(entity);
}

/** How many more LED walls the scene can still take. */
function wallHeadroom(engine: Engine): number {
  return LIMITS.maxWalls - engine.doc.entities.filter(e => e.type === 'led-wall').length;
}

/**
 * Add `count` copies of a catalog item as ONE undo entry, stepped apart along +X by their own
 * footprint. The item's factory runs once (so a model / splat import asks for its file once) and
 * the rest are clones of it, which also keeps the names unique.
 */
export async function instantiateCatalogItems(engine: Engine, id: string, count: number, worldPoint?: Vec3, params?: { cols?: number; rows?: number }): Promise<void> {
  const item = findCatalogItem(id, engine.doc.settings.units);
  if (!item) { engine.toast('error', 'Unknown catalog item'); return; }
  let first: Entity | null;
  try {
    first = await item.make({ engine, ...params });
  } catch (err) {
    engine.toast('error', `Could not add ${item.name}: ${(err as Error).message}`);
    return;
  }
  if (!first) return;

  let n = Math.max(1, Math.round(count));
  if (first.type === 'led-wall') {
    const room = wallHeadroom(engine);
    if (room <= 0) { engine.toast('error', `Up to ${LIMITS.maxWalls} LED walls per scene`); return; }
    if (n > room) { n = room; engine.toast('info', `Added ${room} — up to ${LIMITS.maxWalls} LED walls per scene`); }
  }

  const fp = footprint(first);
  if (worldPoint && fp) first.transform = { ...first.transform, position: [worldPoint[0], 0, worldPoint[2]] };
  else if (!worldPoint) placeNew(engine, first);

  const step = (fp?.w ?? 24) + WALL_GAP_IN;
  const entities: Entity[] = [first];
  let scratch: Document = { ...engine.doc, entities: [...engine.doc.entities, first] };
  for (let i = 1; i < n; i++) {
    const { clones } = cloneEntities(scratch, [first], [step * i, 0, 0]);
    entities.push(...clones);
    scratch = { ...scratch, entities: [...scratch.entities, ...clones] };
  }
  engine.run(cmdAddEntities(engine, entities, entities.length === 1 ? `Add ${first.name}` : `Add ${entities.length} × ${item.name}`));
  engine.select(entities.map(e => e.id));
  engine.history.commit();
}

/**
 * Payload of the `showroom:catalog-drop` event. ViewportOverlay sends `{ id, world }` (a floor
 * point); `point` and client `x`/`y` are accepted too so other dispatchers keep working.
 */
interface DropDetail { id: string; world?: Vec3; point?: Vec3; x?: number; y?: number }

/** Translate a viewport drop (a world floor point, or client x/y) into a world floor point. */
function dropPoint(engine: Engine, d: DropDetail): Vec3 | undefined {
  const p = d.world ?? d.point;
  if (p && Number.isFinite(p[0]) && Number.isFinite(p[2])) return [p[0], 0, p[2]];
  if (typeof d.x === 'number' && typeof d.y === 'number') {
    const ndc = pointerToNdc({ clientX: d.x, clientY: d.y }, engine.renderer.inputEl);
    const hit = pickGround(ndc, engine.camera.camera, 0);
    if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.z)) return [hit.x, 0, hit.z];
  }
  return undefined;
}

/**
 * Listen for `showroom:catalog-drop` (dispatched by the viewport overlay after an HTML5 drop) and
 * add the item at the drop point. Mounted by LeftDock so it stays live whichever tab is showing.
 */
export function useCatalogDropListener(engine: Engine | null): void {
  useEffect(() => {
    if (!engine) return;
    const onDrop = (ev: Event) => {
      const d = (ev as CustomEvent<DropDetail>).detail;
      if (!d?.id) return;
      void instantiateCatalogItem(engine, d.id, dropPoint(engine, d));
    };
    window.addEventListener(CATALOG_DROP_EVENT, onDrop);
    return () => window.removeEventListener(CATALOG_DROP_EVENT, onDrop);
  }, [engine]);
}

/* ───────────────────────────── UI ───────────────────────────── */

const collapsed = new Set<string>();

/**
 * The card being dragged right now. A card drag serves two purposes — dropping onto the viewport to
 * place the item, and dropping onto a sibling card to reorder the catalog — and `dataTransfer` is
 * write-only until the drop fires, so the source is remembered here for the dragover pass to read.
 */
let dragSource: { id: string; group: string } | null = null;

/** Where a reorder drop would land: before `before`, or at the end of the group when it is null. */
interface DropAt { group: string; before: string | null }

export function Catalog() {
  const engine = useEngine();
  const doc = useDoc();
  const unit = doc.settings.units;
  const query = useStore(s => s.catalogQuery);
  const setQuery = useStore(s => s.setCatalogQuery);
  const [, bump] = useState(0);
  const [customOpen, setCustomOpen] = useState<string | null>(null);
  const [order, setOrder] = useState<CatalogOrder>(loadOrder);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);

  const items = useMemo(() => buildCatalog(unit), [unit]);
  const groups = useMemo(() => catalogGroups(items), [items]);
  const q = query.trim().toLowerCase();

  /**
   * Each group in its display order, unfiltered. A reorder is resolved against these full lists, so
   * dragging while a search narrows the grid cannot drop the hidden items out of the saved order.
   */
  const ordered = useMemo(() => {
    const by = new Map<string, CatalogItem[]>();
    for (const g of groups) by.set(g, applyOrder(items.filter(i => i.group === g), order[g]));
    return by;
  }, [items, groups, order]);
  const matches = (i: CatalogItem) => `${i.name} ${i.sub} ${i.group}`.toLowerCase().includes(q);
  const anyVisible = q ? items.some(matches) : items.length > 0;

  const toggleGroup = (g: string) => { if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g); bump(n => n + 1); };

  const onAdd = (item: CatalogItem, params?: { cols: number; rows: number }) => {
    if (item.custom && !params) { setCustomOpen(customOpen === item.id ? null : item.id); return; }
    void instantiateCatalogItem(engine, item.id, undefined, params);
  };

  /* ── drag to reorder ── */
  const startDrag = (item: CatalogItem) => { dragSource = { id: item.id, group: item.group }; };
  const endDrag = () => { dragSource = null; setDropAt(null); };
  /** True while a card from `group` is in flight, so that group's cards accept a reorder drop. */
  const reordering = (group: string) => dragSource !== null && dragSource.group === group;

  const overCard = (e: DragEvent, item: CatalogItem) => {
    if (!reordering(item.group) || dragSource?.id === item.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropAt(d => (d?.group === item.group && d.before === item.id ? d : { group: item.group, before: item.id }));
  };
  const overGroupEnd = (e: DragEvent, group: string) => {
    if (!reordering(group)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropAt(d => (d?.group === group && d.before === null ? d : { group, before: null }));
  };

  /** Commit the move. `before` is the id to insert ahead of, or null for the end of the group. */
  const move = (group: string, before: string | null) => {
    const from = dragSource?.id;
    endDrag();
    const full = ordered.get(group);
    if (!from || !full || from === before) return;
    const next: CatalogOrder = { ...order, [group]: reorder(full, from, before) };
    setOrder(next);
    saveOrder(next);
  };
  const dropOnCard = (e: DragEvent, item: CatalogItem) => {
    if (!reordering(item.group)) return;
    e.preventDefault();
    e.stopPropagation();
    move(item.group, item.id);
  };
  const dropOnGroupEnd = (e: DragEvent, group: string) => {
    if (!reordering(group)) return;
    e.preventDefault();
    move(group, null);
  };
  const resetGroup = (group: string) => {
    const next = { ...order };
    delete next[group];
    setOrder(next);
    if (Object.keys(next).length === 0) clearOrder(); else saveOrder(next);
    engine.toast('info', `${group} back in catalog order`);
  };

  /* ── right-click: place once, at the viewport centre, or in a run ── */
  const menu = useContextMenu();
  /** The floor point under the middle of the viewport, when the ray reaches it. */
  const centrePoint = (): Vec3 | undefined => {
    const p = pickGround(new THREE.Vector2(0, 0), engine.camera.camera, 0);
    return p ? [p.x, 0, p.z] : undefined;
  };
  const onCardContextMenu = (ev: MouseEvent, item: CatalogItem) => {
    const repeat = (n: number) => ({
      label: `Add ${n}`,
      onSelect: () => { void instantiateCatalogItems(engine, item.id, n); },
    });
    const list: MenuItem[] = [
      { label: 'Add to scene', icon: <Plus />, onSelect: () => onAdd(item) },
      { label: 'Add at viewport centre', onSelect: () => { void instantiateCatalogItem(engine, item.id, centrePoint()); } },
      'sep',
      repeat(2), repeat(5), repeat(10),
    ];
    if (isCustomised(order, item.group)) {
      list.push('sep', { label: 'Reset catalog order', onSelect: () => resetGroup(item.group) });
    }
    menu.open(ev, list);
  };
  const onGroupContextMenu = (ev: MouseEvent, group: string) => {
    menu.open(ev, [
      { label: collapsed.has(group) ? 'Expand' : 'Collapse', onSelect: () => toggleGroup(group) },
      { label: 'Reset catalog order', disabled: !isCustomised(order, group), onSelect: () => resetGroup(group) },
    ]);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); }
  };

  return (
    <>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
        <TextField
          type="search" value={query} onChange={setQuery} icon={<Search size={14} strokeWidth={1.5} />} clearable
          placeholder="Search catalog" aria-label="Search catalog" spellCheck={false} onKeyDown={onSearchKey}
        />
      </div>
      <div className="panel-body">
        {!anyVisible && (
          <div className="empty">
            <div className="title display">Nothing matches</div>
            <div className="hint">Try a product name, a category or a size.</div>
          </div>
        )}
        {groups.map(g => {
          const full = ordered.get(g) ?? [];
          const list = q ? full.filter(matches) : full;
          if (!list.length) return null;
          const open = q ? true : !collapsed.has(g);
          const lastId = list[list.length - 1].id;
          const custom = isCustomised(order, g);
          return (
            <div key={g}>
              <div className="catalog-group">
                <button type="button" className="row" onClick={() => toggleGroup(g)} aria-expanded={open}
                  onContextMenu={e => onGroupContextMenu(e, g)}
                  title={custom ? 'Your order — right-click to reset' : 'Drag cards to reorder'}
                  style={{ width: '100%', height: 26, gap: 8, color: 'var(--fg-2)' }}>
                  <ChevronRight size={12} strokeWidth={1.5} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--t-fast) var(--ease)', flex: 'none' }} />
                  <span className="label grow" style={{ textAlign: 'left', color: 'inherit' }}>{g}</span>
                  {custom && <span className="dot" aria-label="Custom order" />}
                  <span className="num" style={{ fontSize: 'var(--fs-2xs)', color: 'var(--fg-3)' }}>{list.length}</span>
                </button>
              </div>
              {open && (
                <div className="catalog-grid" onDragOver={e => overGroupEnd(e, g)} onDrop={e => dropOnGroupEnd(e, g)}>
                  {list.map(item => (
                    <Card
                      key={item.id} item={item} customOpen={customOpen === item.id}
                      dragging={dropAt !== null && dragSource?.id === item.id}
                      dropBefore={dropAt?.group === g && dropAt.before === item.id}
                      dropAfter={dropAt?.group === g && dropAt.before === null && item.id === lastId}
                      onAdd={onAdd} onCloseCustom={() => setCustomOpen(null)} onContextMenu={onCardContextMenu}
                      onDragStart={startDrag} onDragEnd={endDrag} onDragOver={overCard} onDrop={dropOnCard}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {menu.node}
    </>
  );
}

/* ───────────────────────────── card ───────────────────────────── */

interface CardProps {
  item: CatalogItem;
  customOpen: boolean;
  /** Dimmed because this is the card in flight over a reorder target. */
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onAdd(item: CatalogItem, params?: { cols: number; rows: number }): void;
  onCloseCustom(): void;
  onContextMenu(e: MouseEvent, item: CatalogItem): void;
  onDragStart(item: CatalogItem): void;
  onDragEnd(): void;
  onDragOver(e: DragEvent, item: CatalogItem): void;
  onDrop(e: DragEvent, item: CatalogItem): void;
}

function Card(p: CardProps) {
  const { item, customOpen } = p;
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    // the open form owns pointer gestures (text selection, scrubbing) — never start a card drag
    if (customOpen) { e.preventDefault(); return; }
    e.dataTransfer.setData(CATALOG_DRAG_TYPE, item.id);
    e.dataTransfer.setData('text/plain', item.id);
    // dropped on the viewport it copies the product in; dropped on a sibling card it moves this card
    e.dataTransfer.effectAllowed = 'copyMove';
    p.onDragStart(item);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); p.onAdd(item); }
  };
  const stop = (e: MouseEvent) => e.stopPropagation();
  const cls = ['card', p.dragging && 'dragging', p.dropBefore && 'drop-before', p.dropAfter && 'drop-after']
    .filter(Boolean).join(' ');

  return (
    <div
      className={cls} draggable={!customOpen} role="button" tabIndex={0} title={item.description}
      onClick={() => p.onAdd(item)} onKeyDown={onKey} onContextMenu={e => p.onContextMenu(e, item)}
      onDragStart={onDragStart} onDragEnd={p.onDragEnd}
      onDragOver={e => p.onDragOver(e, item)} onDrop={e => p.onDrop(e, item)}
      style={customOpen ? { gridColumn: '1 / -1', cursor: 'default' } : undefined}
    >
      <div className={item.image ? 'thumb photo' : 'thumb'}>
        {item.image
          ? <img src={item.image} alt="" draggable={false} />
          : <CatalogIcon kind={item.icon} />}
      </div>
      <div className="title">{item.name}</div>
      <div className="sub truncate" title={item.sub}>{item.sub}</div>
      {!customOpen && (
        <span className="add" aria-hidden="true"><Plus /></span>
      )}
      {customOpen && <CustomWallForm onSubmit={v => p.onAdd(item, v)} onCancel={p.onCloseCustom} stop={stop} />}
    </div>
  );
}

function CustomWallForm({ onSubmit, onCancel, stop }: { onSubmit(p: { cols: number; rows: number }): void; onCancel(): void; stop(e: MouseEvent): void }) {
  const [cols, setColsState] = useState(5);
  const [rows, setRowsState] = useState(5);
  // Enter inside a NumberField commits (onChange) and then bubbles here in the same keydown, before
  // React re-renders — so submit reads the latest values from a ref, not from closure state.
  const latest = useRef({ cols: 5, rows: 5 });
  const setCols = (v: number) => { latest.current.cols = v; setColsState(v); };
  const setRows = (v: number) => { latest.current.rows = v; setRowsState(v); };
  const unit = useDoc().settings.units;
  const submit = () => onSubmit({ cols: clampInt(latest.current.cols, LIMITS.maxCols), rows: clampInt(latest.current.rows, LIMITS.maxRows) });
  return (
    <div
      onClick={stop} onMouseDown={stop} draggable={false}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onCancel(); if (e.key === 'Enter') submit(); }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4, borderTop: '1px solid var(--line)', cursor: 'default' }}
    >
      <div className="grid-2">
        <NumberField value={cols} onChange={setCols} min={1} max={LIMITS.maxCols} step={1} decimals={0} scrub="C" title="Columns" />
        <NumberField value={rows} onChange={setRows} min={1} max={LIMITS.maxRows} step={1} decimals={0} scrub="R" title="Rows" />
      </div>
      <div className="sub num">{wallSubLine(clampInt(cols, LIMITS.maxCols), clampInt(rows, LIMITS.maxRows), unit)}</div>
      <div className="row">
        <Button size="sm" variant="primary" onClick={submit}>Add wall</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const clampInt = (v: number, max: number) => Math.max(1, Math.min(max, Math.round(v)));
