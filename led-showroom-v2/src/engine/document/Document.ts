/** Pure helpers over the Document. None of these mutate their input. */
import type { Document, Entity, LedWallEntity } from './types';
import { cloneJson } from '../math';

export function getEntity(doc: Document, id: string | null | undefined): Entity | undefined {
  if (!id) return undefined;
  return doc.entities.find(e => e.id === id);
}

export function getEntities(doc: Document, ids: Iterable<string>): Entity[] {
  const set = new Set(ids);
  return doc.entities.filter(e => set.has(e.id));
}

export function walls(doc: Document): LedWallEntity[] {
  return doc.entities.filter((e): e is LedWallEntity => e.type === 'led-wall');
}

export function children(doc: Document, parentId: string | null): Entity[] {
  return doc.entities.filter(e => (e.parentId ?? null) === parentId);
}

export function descendants(doc: Document, id: string): Entity[] {
  const out: Entity[] = [];
  const walk = (pid: string) => {
    for (const c of children(doc, pid)) { out.push(c); walk(c.id); }
  };
  walk(id);
  return out;
}

/** Entities attached to (standing on) `id`. */
export function attachedTo(doc: Document, id: string): Entity[] {
  return doc.entities.filter(e => e.attachedTo === id);
}

export function withEntity(doc: Document, id: string, patch: Partial<Entity> | ((e: Entity) => Entity)): Document {
  return {
    ...doc,
    entities: doc.entities.map(e => (e.id === id ? (typeof patch === 'function' ? patch(e) : ({ ...e, ...patch } as Entity)) : e)),
  };
}

export function withEntities(doc: Document, entities: Entity[]): Document {
  return { ...doc, entities };
}

export function addEntity(doc: Document, entity: Entity, index?: number): Document {
  const entities = doc.entities.slice();
  if (index === undefined || index < 0 || index > entities.length) entities.push(entity);
  else entities.splice(index, 0, entity);
  return { ...doc, entities };
}

export function removeEntities(doc: Document, ids: Iterable<string>): Document {
  const set = new Set(ids);
  // also remove descendants
  for (const id of Array.from(set)) for (const d of descendants(doc, id)) set.add(d.id);
  return {
    ...doc,
    entities: doc.entities
      .filter(e => !set.has(e.id))
      .map(e => (e.attachedTo && set.has(e.attachedTo) ? { ...e, attachedTo: null } : e)),
  };
}

/** Unique display name: "LED Wall", "LED Wall 2", "LED Wall 3"… */
export function uniqueName(doc: Document, base: string): string {
  const names = new Set(doc.entities.map(e => e.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
  return `${base} ${Date.now()}`;
}

export function cloneEntity<T extends Entity>(e: T): T {
  return cloneJson(e);
}

export function touch(doc: Document): Document {
  return { ...doc, updatedAt: Date.now() };
}
