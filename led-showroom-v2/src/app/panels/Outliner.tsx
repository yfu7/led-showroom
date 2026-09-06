/**
 * Objects panel: one row per entity (children indented under their group), with hover/selection
 * synced to the viewport, inline rename, visibility / lock / delete actions, keyboard handling and
 * drag-to-reorder through `cmdReorderEntity`.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Box, Eye, EyeOff, Folder, Home, Layers, Lock, Monitor, Plus, Ruler, Shapes, Sparkles, Trash2, Unlock, type LucideIcon } from 'lucide-react';
import type { Entity, EntityType } from '@/engine/document/types';
import { cmdReorderEntity } from '@/engine/commands/entity';
import { filledCount, isRectWall } from '@/engine/ledwall/layout';
import { formatDims, formatLength, type Unit } from '@/engine/units';
import { v3dist } from '@/engine/math';
import { useDoc, useEngine, useStore } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { useContextMenu } from '@/app/components/ContextMenu';
import type { MenuItem } from '@/app/components/MenuPanel';
import { RENAME_ENTITY_EVENT, buildEntityMenu, isolateEntities, selectAllOfType, showAllEntities, type RenameEntityDetail } from '@/app/menus/entityMenu';

export const ENTITY_DRAG_TYPE = 'application/x-showroom-entity';

/** Plural used by the "Select all …" row of the right-click menu. */
const TYPE_PLURAL: Record<EntityType, string> = {
  'led-wall': 'LED walls',
  stage: 'stage decks',
  equipment: 'equipment',
  model: 'models',
  splat: 'splats',
  room: 'venue spaces',
  dimension: 'measurements',
  group: 'groups',
};

const TYPE_ICON: Record<EntityType, LucideIcon> = {
  'led-wall': Monitor,
  stage: Layers,
  equipment: Box,
  model: Shapes,
  splat: Sparkles,
  room: Home,
  dimension: Ruler,
  group: Folder,
};

/** Short per-row summary shown at the right of the name. */
export function entityMeta(e: Entity, unit: Unit, childCount = 0): string {
  switch (e.type) {
    case 'led-wall': return isRectWall(e) ? `${e.cols}×${e.rows}` : `${filledCount(e)} panels`;
    case 'stage': return formatLength(e.heightIn, unit);
    case 'equipment': return formatDims([e.dims[0], e.dims[1]], unit);
    case 'model': return e.dims ? formatDims([e.dims[0], e.dims[1]], unit) : e.format.toUpperCase();
    case 'splat': return e.format;
    case 'room': return formatDims([e.widthIn, e.depthIn], unit);
    case 'dimension': return formatLength(v3dist(e.a, e.b), unit);
    case 'group': return childCount ? `${childCount}` : '';
  }
}

interface RowModel { entity: Entity; child: boolean; index: number }

/** Flatten the entity list: top-level rows in document order, each followed by its children. */
function buildRows(entities: Entity[]): RowModel[] {
  const ids = new Set(entities.map(e => e.id));
  const rows: RowModel[] = [];
  const indexOf = new Map(entities.map((e, i) => [e.id, i] as const));
  const isChild = (e: Entity) => !!e.parentId && ids.has(e.parentId);
  for (const e of entities) {
    if (isChild(e)) continue;
    rows.push({ entity: e, child: false, index: indexOf.get(e.id)! });
    for (const c of entities) if (c.parentId === e.id) rows.push({ entity: c, child: true, index: indexOf.get(c.id)! });
  }
  return rows;
}

export function Outliner() {
  const engine = useEngine();
  const doc = useDoc();
  const selection = useStore(s => s.selection);
  const hovered = useStore(s => s.hovered);
  const setLeftTab = useStore(s => s.setLeftTab);
  const unit = doc.settings.units;

  const rows = useMemo(() => buildRows(doc.entities), [doc.entities]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; after: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Set while a selection change originates here, so we don't scroll our own clicks. */
  const internal = useRef(false);
  const anchor = useRef<string | null>(null);

  // selection changed from the viewport → bring the primary row into view
  useEffect(() => {
    if (internal.current) return;
    const id = selection[selection.length - 1];
    if (!id) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selection]);

  /**
   * Run a selection change that originates in this panel. The store update and the effect above
   * are synchronous, so clearing the flag in a microtask covers both the emitting case and the
   * no-op case (Engine.select returns early when nothing changes) without leaving it stuck.
   */
  const selectInternal = (ids: string[], mode?: 'replace' | 'add' | 'toggle') => {
    internal.current = true;
    try { engine.select(ids, mode); } finally { queueMicrotask(() => { internal.current = false; }); }
  };

  const select = (id: string, e: MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const ids = rows.map(r => r.entity.id);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { selectInternal(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    anchor.current = id;
    if (e.ctrlKey || e.metaKey) selectInternal([id], 'toggle');
    else selectInternal([id]);
  };

  const remove = (ids: string[]) => { if (ids.length) engine.remove(ids); };

  /* ── right-click menu ── */
  const menu = useContextMenu();
  const onRowContextMenu = (ev: MouseEvent, id: string) => {
    // A right-click inside a multi-selection keeps it; on any other row it selects that row.
    if (!engine.isSelected(id)) { anchor.current = id; selectInternal([id]); }
    const ids = engine.selection.length ? engine.selection.slice() : [id];
    const e = engine.entity(id);
    const extra: MenuItem[] = e ? [
      { label: `Select all ${TYPE_PLURAL[e.type]}`, icon: <Layers />, onSelect: () => selectAllOfType(engine, e.type) },
      { label: 'Isolate', icon: <Eye />, onSelect: () => isolateEntities(engine, ids) },
      { label: 'Show all', icon: <Eye />, onSelect: () => showAllEntities(engine) },
    ] : [];
    menu.open(ev, buildEntityMenu(engine, ids, { onRename: setRenaming, extra }));
  };

  // A rename asked for from the viewport menu lands here (the row owns the inline input).
  useEffect(() => {
    const onRename = (ev: Event) => {
      const id = (ev as CustomEvent<RenameEntityDetail>).detail?.id;
      if (!id || !engine.entity(id)) return;
      setRenaming(id);
      listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener(RENAME_ENTITY_EVENT, onRename);
    return () => window.removeEventListener(RENAME_ENTITY_EVENT, onRename);
  }, [engine]);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(selection.filter(id => !engine.entity(id)?.locked)); }
    else if (e.key === 'F2') { const id = selection[selection.length - 1]; if (id) { e.preventDefault(); e.stopPropagation(); setRenaming(id); } }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const ids = rows.map(r => r.entity.id);
      const cur = ids.indexOf(selection[selection.length - 1]);
      const next = ids[Math.max(0, Math.min(ids.length - 1, (cur < 0 ? (e.key === 'ArrowDown' ? -1 : ids.length) : cur) + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { anchor.current = next; selectInternal(e.shiftKey ? [...selection, next] : [next]); }
    }
  };

  /* ── drag to reorder ── */
  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData(ENTITY_DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!e.dataTransfer.types.includes(ENTITY_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (!dragOver || dragOver.id !== id || dragOver.after !== after) setDragOver({ id, after });
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, targetId: string) => {
    const id = e.dataTransfer.getData(ENTITY_DRAG_TYPE);
    setDragOver(null);
    if (!id || id === targetId) return;
    e.preventDefault();
    const from = doc.entities.findIndex(x => x.id === id);
    let to = doc.entities.findIndex(x => x.id === targetId);
    if (from < 0 || to < 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientY > r.top + r.height / 2) to += 1;
    if (from < to) to -= 1;
    if (to === from) return;
    engine.run(cmdReorderEntity(engine, id, to));
  };

  const count = doc.entities.length;

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Objects</span>
        <span className="muted num" style={{ fontSize: 'var(--fs-xs)' }}>{count}</span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={<Plus size={14} strokeWidth={1.5} />} onClick={() => setLeftTab('catalog')} tip="Open the catalog">Add</Button>
      </div>
      <div className="panel-body" ref={listRef} tabIndex={0} onKeyDown={onListKey} style={{ outline: 'none', padding: count ? '6px 6px 12px' : 0 }}>
        {count === 0 ? (
          <div className="empty">
            <Monitor />
            <div className="title">An empty floor</div>
            <div className="hint">Add an LED wall from the catalog</div>
            <Button size="sm" onClick={() => setLeftTab('catalog')}>Browse catalog</Button>
          </div>
        ) : (
          <div
            className="list" role="listbox" aria-label="Objects" aria-multiselectable="true"
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
          >
            {rows.map(({ entity: e, child }) => {
              const Icon = TYPE_ICON[e.type] ?? Box;
              const selected = selection.includes(e.id);
              const over = dragOver?.id === e.id ? dragOver : null;
              const childCount = e.type === 'group' ? doc.entities.filter(c => c.parentId === e.id).length : 0;
              const meta = entityMeta(e, unit, childCount);
              return (
                <div
                  key={e.id} data-id={e.id} draggable={renaming !== e.id}
                  role="option" aria-selected={selected}
                  className={['list-row', child ? 'child' : '', selected ? 'selected' : ''].filter(Boolean).join(' ')}
                  style={{
                    opacity: e.visible ? 1 : 0.55,
                    boxShadow: over ? (over.after ? 'inset 0 -1.5px 0 var(--accent)' : 'inset 0 1.5px 0 var(--accent)') : hovered === e.id && !selected ? 'inset 0 0 0 1px var(--line-strong)' : undefined,
                  }}
                  onMouseEnter={() => engine.setHover(e.id)}
                  onMouseLeave={() => { if (engine.hovered === e.id) engine.setHover(null); }}
                  onClick={ev => select(e.id, ev)}
                  onContextMenu={ev => onRowContextMenu(ev, e.id)}
                  onDoubleClick={() => setRenaming(e.id)}
                  onDragStart={ev => onDragStart(ev, e.id)}
                  onDragOver={ev => onDragOver(ev, e.id)}
                  onDrop={ev => onDrop(ev, e.id)}
                  onDragEnd={() => setDragOver(null)}
                >
                  <Icon className="icon" />
                  {renaming === e.id ? (
                    <RenameInput
                      value={e.name}
                      onCommit={name => { setRenaming(null); if (name && name !== e.name) engine.update(e.id, { name }, { label: `Rename ${e.name}` }); }}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <span className="name" title={e.name}>{e.name}</span>
                  )}
                  {renaming !== e.id && meta && <span className="meta">{meta}</span>}
                  {e.locked && renaming !== e.id && <Lock size={12} strokeWidth={1.5} style={{ color: 'var(--fg-3)', flex: 'none' }} role="img" aria-label="Locked" />}
                  <span className="actions" onClick={ev => ev.stopPropagation()} onDoubleClick={ev => ev.stopPropagation()}>
                    <IconButton size="sm" tip={e.visible ? 'Hide' : 'Show'} onClick={() => engine.update(e.id, { visible: !e.visible }, { label: e.visible ? `Hide ${e.name}` : `Show ${e.name}` })}>
                      {e.visible ? <Eye /> : <EyeOff />}
                    </IconButton>
                    <IconButton size="sm" tip={e.locked ? 'Unlock' : 'Lock'} onClick={() => engine.update(e.id, { locked: !e.locked }, { label: e.locked ? `Unlock ${e.name}` : `Lock ${e.name}` })}>
                      {e.locked ? <Unlock /> : <Lock />}
                    </IconButton>
                    <IconButton size="sm" tip="Delete" kbd="Del" onClick={() => remove([e.id])} disabled={e.locked}>
                      <Trash2 />
                    </IconButton>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {menu.node}
    </>
  );
}

function RenameInput({ value, onCommit, onCancel }: { value: string; onCommit(v: string): void; onCancel(): void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const commit = () => { if (done.current) return; done.current = true; onCommit(text.trim()); };
  const cancel = () => { if (done.current) return; done.current = true; onCancel(); };
  return (
    <input
      className="rename" value={text} autoFocus spellCheck={false} aria-label="Rename"
      onFocus={e => e.target.select()}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      }}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    />
  );
}
