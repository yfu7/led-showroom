/**
 * The app's internal clipboard for entities. It never touches the system clipboard: copied
 * entities are held as deep clones of the document objects, so pasting works after the originals
 * were cut, and across documents in the same session.
 *
 * `cloneEntities` is the shared cloning core — `SelectTool.duplicateEntities` (Ctrl+D) and paste
 * both go through it, so fresh ids, unique names, re-pointed parent/attachment links and the
 * "children follow their parent" offset rule are written once.
 */
import type { Document, Entity } from './document/types';
import { descendants, uniqueName } from './document/Document';
import { newId } from './ids';
import { cloneJson, type Vec3 } from './math';

/** Offset a plain Ctrl+V (or a duplicate) uses when no target point is given (inches). */
export const PASTE_STEP_IN = 12;

/**
 * Clone `originals` into `doc`: fresh ids, names made unique against `doc`, `parentId` /
 * `attachedTo` re-pointed at the clones when the target was copied too, and `offset` applied to
 * top-level clones only (children keep their parent-relative pose).
 *
 * `doc` is only read — for name uniqueness and nothing else — so the originals do not have to be
 * in it (that is what makes paste-after-cut work).
 */
export function cloneEntities(doc: Document, originals: Entity[], offset: Vec3 = [PASTE_STEP_IN, 0, 0]): { clones: Entity[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  for (const e of originals) {
    const prefix = e.id.includes('_') ? e.id.slice(0, e.id.indexOf('_')) : e.type;
    idMap.set(e.id, newId(prefix));
  }
  let scratch = doc;
  const clones: Entity[] = [];
  for (const e of originals) {
    const c = cloneJson(e);
    c.id = idMap.get(e.id)!;
    c.name = uniqueName(scratch, e.name.replace(/\s\d+$/, '') || e.name);
    // Read this before the remap: afterwards `c.parentId` is a brand-new id that is never a key
    // in `idMap`, so testing it there would offset children as well and move them twice.
    const insideTheCopy = !!e.parentId && idMap.has(e.parentId);
    if (insideTheCopy) c.parentId = idMap.get(e.parentId!)!;
    if (c.attachedTo && idMap.has(c.attachedTo)) c.attachedTo = idMap.get(c.attachedTo)!;
    // only top-level clones get the offset; children follow their parent
    if (!insideTheCopy) {
      c.transform.position = [c.transform.position[0] + offset[0], c.transform.position[1] + offset[1], c.transform.position[2] + offset[2]];
    }
    clones.push(c);
    scratch = { ...scratch, entities: [...scratch.entities, c] };
  }
  return { clones, idMap };
}

/** `ids` plus every descendant, as deep clones in document order (nothing is cloned twice). */
export function collectEntities(doc: Document, ids: Iterable<string>): Entity[] {
  const wanted = new Set(ids);
  for (const id of Array.from(wanted)) for (const d of descendants(doc, id)) wanted.add(d.id);
  return doc.entities.filter(e => wanted.has(e.id)).map(e => cloneJson(e));
}

/**
 * The point a copied set is measured from: the mean position of its top-level entities (the ones
 * whose parent was not copied). Pasting at a floor point moves that anchor onto it, so a
 * multi-entity paste keeps the shape of the original arrangement.
 */
export function clipboardAnchor(entities: Entity[]): Vec3 {
  const ids = new Set(entities.map(e => e.id));
  const tops = entities.filter(e => !e.parentId || !ids.has(e.parentId));
  const list = tops.length ? tops : entities;
  if (!list.length) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const e of list) { x += e.transform.position[0]; y += e.transform.position[1]; z += e.transform.position[2]; }
  return [x / list.length, y / list.length, z / list.length];
}

/**
 * Offset for one paste. With a target floor point the anchor lands exactly on it and the height
 * is kept (dropping a wall through the floor is never what was meant); without one the paste
 * steps to the right of the previous paste so repeated Ctrl+V does not stack in place.
 */
export function pasteOffsetFor(anchor: Vec3, at: Vec3 | undefined, repeat: number, step = PASTE_STEP_IN): Vec3 {
  if (at) return [at[0] - anchor[0], 0, at[2] - anchor[2]];
  return [step * Math.max(1, repeat), 0, 0];
}

export interface ClipboardContents {
  entities: Entity[];
  anchor: Vec3;
}

/** Session clipboard: `copy` fills it, `paste` clones out of it. Held by the Engine. */
export class Clipboard {
  private contents: ClipboardContents | null = null;
  /** Pastes since the last copy, so plain Ctrl+V walks its clones to the right. */
  private repeat = 0;

  get canPaste(): boolean { return !!this.contents?.entities.length; }
  /** How many entities are held (descendants included); 0 when empty. */
  get size(): number { return this.contents?.entities.length ?? 0; }
  /** Top-level entities held, for a menu label ("Paste 3 objects"). */
  get topLevelCount(): number {
    const list = this.contents?.entities ?? [];
    const ids = new Set(list.map(e => e.id));
    return list.filter(e => !e.parentId || !ids.has(e.parentId)).length || list.length;
  }
  peek(): ClipboardContents | null { return this.contents; }
  clear(): void { this.contents = null; this.repeat = 0; }

  /** Store `ids` (and their descendants). Returns how many top-level entities were taken. */
  copy(doc: Document, ids: Iterable<string>): number {
    const entities = collectEntities(doc, ids);
    if (!entities.length) { return 0; }
    this.contents = { entities, anchor: clipboardAnchor(entities) };
    this.repeat = 0;
    return this.topLevelCount;
  }

  /**
   * Clones of the held entities, ready to add to `doc`. With `at` the set lands centred on that
   * floor point; without it, one step right of the previous paste.
   */
  paste(doc: Document, at?: Vec3): { clones: Entity[]; idMap: Map<string, string> } {
    if (!this.contents) return { clones: [], idMap: new Map() };
    this.repeat += 1;
    const offset = pasteOffsetFor(this.contents.anchor, at, this.repeat);
    return cloneEntities(doc, this.contents.entities, offset);
  }
}
