/**
 * Command factories for document mutations. Each returns a Command for History.run().
 * `DocHost` is the minimal engine surface the commands need.
 */
import type { Command } from './History';
import type { Document, Entity, Transform } from '../document/types';
import { addEntity, getEntity, removeEntities, withEntity } from '../document/Document';
import { cloneJson } from '../math';

export interface DocHost {
  readonly doc: Document;
  /** Replace the document (the engine emits change events). */
  setDoc(doc: Document, meta?: { silent?: boolean }): void;
}

export function cmdAddEntity(host: DocHost, entity: Entity, opts: { label?: string; select?: (ids: string[]) => void } = {}): Command {
  return {
    label: opts.label ?? `Add ${entity.name}`,
    do() { host.setDoc(addEntity(host.doc, entity)); opts.select?.([entity.id]); },
    undo() { host.setDoc(removeEntities(host.doc, [entity.id])); opts.select?.([]); },
  };
}

export function cmdAddEntities(host: DocHost, entities: Entity[], label = `Add ${entities.length} objects`): Command {
  return {
    label,
    do() { let d = host.doc; for (const e of entities) d = addEntity(d, e); host.setDoc(d); },
    undo() { host.setDoc(removeEntities(host.doc, entities.map(e => e.id))); },
  };
}

export function cmdRemoveEntities(host: DocHost, ids: string[], label?: string): Command {
  let removed: { entity: Entity; index: number }[] = [];
  let detached: { id: string; attachedTo: string }[] = [];
  return {
    label: label ?? (ids.length === 1 ? `Delete ${getEntity(host.doc, ids[0])?.name ?? 'object'}` : `Delete ${ids.length} objects`),
    do() {
      const doc = host.doc;
      const set = new Set(ids);
      removed = doc.entities.map((e, i) => ({ entity: cloneJson(e), index: i })).filter(x => set.has(x.entity.id));
      detached = doc.entities.filter(e => e.attachedTo && set.has(e.attachedTo) && !set.has(e.id)).map(e => ({ id: e.id, attachedTo: e.attachedTo! }));
      host.setDoc(removeEntities(doc, ids));
    },
    undo() {
      let d = host.doc;
      for (const r of removed.sort((a, b) => a.index - b.index)) d = addEntity(d, cloneJson(r.entity), r.index);
      for (const x of detached) d = withEntity(d, x.id, { attachedTo: x.attachedTo } as Partial<Entity>);
      host.setDoc(d);
    },
  };
}

/**
 * Patch one entity. `mergeKey` lets continuous edits (sliders, drags) collapse into one history entry.
 * The patch may be a partial object or a function producing the new entity.
 */
export function cmdUpdateEntity<T extends Entity>(host: DocHost, id: string, patch: Partial<T> | ((e: T) => T), opts: { label?: string; mergeKey?: string } = {}): Command {
  let before: Entity | undefined;
  return {
    label: opts.label ?? `Edit ${getEntity(host.doc, id)?.name ?? 'object'}`,
    mergeKey: opts.mergeKey,
    do() {
      const cur = getEntity(host.doc, id);
      if (!cur) return;
      if (!before) before = cloneJson(cur);
      const next = typeof patch === 'function' ? (patch as (e: T) => T)(cur as T) : ({ ...cur, ...patch } as Entity);
      host.setDoc(withEntity(host.doc, id, () => next));
    },
    undo() { if (before) host.setDoc(withEntity(host.doc, id, () => cloneJson(before!))); },
  };
}

/** Patch several entities at once (multi-select edits, group moves). */
export function cmdUpdateEntities(host: DocHost, patches: { id: string; patch: Partial<Entity> | ((e: Entity) => Entity) }[], opts: { label?: string; mergeKey?: string } = {}): Command {
  let before: Map<string, Entity> | null = null;
  return {
    label: opts.label ?? `Edit ${patches.length} objects`,
    mergeKey: opts.mergeKey,
    do() {
      let d = host.doc;
      if (!before) { before = new Map(); for (const p of patches) { const e = getEntity(d, p.id); if (e) before.set(p.id, cloneJson(e)); } }
      for (const p of patches) {
        const cur = getEntity(d, p.id);
        if (!cur) continue;
        const next = typeof p.patch === 'function' ? p.patch(cur) : ({ ...cur, ...p.patch } as Entity);
        d = withEntity(d, p.id, () => next);
      }
      host.setDoc(d);
    },
    undo() {
      if (!before) return;
      let d = host.doc;
      for (const [id, e] of before) d = withEntity(d, id, () => cloneJson(e));
      host.setDoc(d);
    },
  };
}

export function cmdSetTransform(host: DocHost, id: string, transform: Transform, opts: { label?: string; mergeKey?: string } = {}): Command {
  return cmdUpdateEntity<Entity>(host, id, { transform: cloneJson(transform) } as Partial<Entity>, { label: opts.label ?? `Move ${getEntity(host.doc, id)?.name ?? 'object'}`, mergeKey: opts.mergeKey });
}

export function cmdSetTransforms(host: DocHost, items: { id: string; transform: Transform }[], opts: { label?: string; mergeKey?: string } = {}): Command {
  return cmdUpdateEntities(host, items.map(i => ({ id: i.id, patch: { transform: cloneJson(i.transform) } as Partial<Entity> })), { label: opts.label ?? `Move ${items.length} objects`, mergeKey: opts.mergeKey });
}

/** Replace the whole document (preset load, import). */
export function cmdReplaceDocument(host: DocHost, next: Document, label = 'Load scene'): Command {
  let before: Document | null = null;
  return {
    label,
    do() { if (!before) before = host.doc; host.setDoc(next); },
    undo() { if (before) host.setDoc(before); },
  };
}

/** Patch top-level document fields (settings, environment, view). */
export function cmdPatchDocument(host: DocHost, patch: Partial<Document> | ((d: Document) => Document), opts: { label?: string; mergeKey?: string } = {}): Command {
  let before: Document | null = null;
  return {
    label: opts.label ?? 'Edit scene',
    mergeKey: opts.mergeKey,
    do() {
      if (!before) before = host.doc;
      const next = typeof patch === 'function' ? patch(host.doc) : { ...host.doc, ...patch };
      host.setDoc(next);
    },
    undo() { if (before) host.setDoc(before); },
  };
}

/** Move an entity to a new index in the entity list (outliner reorder). */
export function cmdReorderEntity(host: DocHost, id: string, toIndex: number): Command {
  let fromIndex = -1;
  return {
    label: 'Reorder',
    do() {
      const list = host.doc.entities.slice();
      fromIndex = list.findIndex(e => e.id === id);
      if (fromIndex < 0) return;
      const [e] = list.splice(fromIndex, 1);
      list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, e);
      host.setDoc({ ...host.doc, entities: list });
    },
    undo() {
      if (fromIndex < 0) return;
      const list = host.doc.entities.slice();
      const i = list.findIndex(e => e.id === id);
      const [e] = list.splice(i, 1);
      list.splice(fromIndex, 0, e);
      host.setDoc({ ...host.doc, entities: list });
    },
  };
}
