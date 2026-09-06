/**
 * Named scene presets in localStorage (`showroom-v2:presets`): a FIFO list of at most
 * `MAX_PRESETS` snapshots of the document, each with a one-line summary and an optional
 * thumbnail (data URL). Includes the one-shot migration of v1 presets.
 *
 * Every function takes an optional `storage` (anything with the localStorage getItem/setItem/
 * removeItem trio) so it can be exercised without a DOM; the default is `localStorage`, falling
 * back to an in-memory map when storage is unavailable or throws.
 */
import { newId } from '../ids';
import { cloneJson } from '../math';
import type { Document } from '../document/types';
import { isEquipment, isLedWall, isModel, isSplat, isStage } from '../document/types';
import { LIMITS } from '../ledwall/specs';
import { migrateDocument } from './sceneFile';
import { convertV1Preset, readV1PresetsFromStorage, readV1ViewFromStorage } from './v1import';

export const PRESETS_KEY = 'showroom-v2:presets';
export const V1_IMPORTED_KEY = 'showroom-v2:v1-imported';
export const MAX_PRESETS = LIMITS.maxPresets; // 50

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PresetMeta {
  id: string;
  name: string;
  /** ms epoch. */
  savedAt: number;
  /** e.g. "2 walls · 5×5, 3×2 (custom) · 1 stage · 3 equipment" */
  summary: string;
  /** PNG/JPEG data URL. */
  thumbnail?: string;
}

interface StoredPreset extends PresetMeta { doc: Document }

/* ───────────────────────────── storage ───────────────────────────── */

class MemoryStorage implements StorageLike {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
}

let memoryFallback: MemoryStorage | null = null;

function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* access denied (privacy mode) */ }
  return (memoryFallback ??= new MemoryStorage());
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Read the stored list (oldest → newest). Malformed storage yields an empty list. */
function readAll(storage: StorageLike): StoredPreset[] {
  let raw: string | null = null;
  try { raw = storage.getItem(PRESETS_KEY); } catch { return []; }
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((p): p is StoredPreset => isObj(p) && typeof p.id === 'string' && isObj(p.doc));
  } catch { return []; }
}

/**
 * Persist the list. On quota errors, progressively drop thumbnails (newest last) and finally
 * the oldest presets until the write fits; throws only if even a single preset cannot be stored.
 */
function writeAll(storage: StorageLike, list: StoredPreset[]): void {
  const attempt = (l: StoredPreset[]): boolean => {
    try { storage.setItem(PRESETS_KEY, JSON.stringify(l)); return true; } catch { return false; }
  };
  if (attempt(list)) return;
  const work = list.map(p => ({ ...p }));
  for (let i = 0; i < work.length; i++) {
    if (!work[i].thumbnail) continue;
    delete work[i].thumbnail;
    if (attempt(work)) return;
  }
  while (work.length > 1) {
    work.shift();
    if (attempt(work)) return;
  }
  throw new Error('Preset storage is full');
}

/* ───────────────────────────── API ───────────────────────────── */

const meta = ({ doc: _d, ...m }: StoredPreset): PresetMeta => m;

/** Presets, newest first. */
export function listPresets(storage: StorageLike = defaultStorage()): PresetMeta[] {
  return readAll(storage).map(meta).reverse();
}

/** Save a snapshot of `doc`. Beyond `MAX_PRESETS` the oldest presets are dropped (FIFO). */
export function savePreset(name: string, doc: Document, thumbnail?: string, storage: StorageLike = defaultStorage()): PresetMeta {
  const list = readAll(storage);
  const preset: StoredPreset = {
    id: newId('preset'),
    name: (name || '').trim() || 'Untitled preset',
    savedAt: Date.now(),
    summary: summarize(doc),
    doc: cloneJson(doc),
  };
  if (thumbnail) preset.thumbnail = thumbnail;
  list.push(preset);
  while (list.length > MAX_PRESETS) list.shift();
  writeAll(storage, list);
  return meta(preset);
}

/**
 * A fresh copy of the stored document, or null. A preset can be years older than the running
 * build, so it goes through the same `migrateDocument` gate as an imported scene file: missing
 * fields get their defaults and unrepairable entities are dropped instead of reaching the
 * renderers. Only a blob that is not a document at all yields null.
 */
export function loadPreset(id: string, storage: StorageLike = defaultStorage()): Document | null {
  const p = readAll(storage).find(x => x.id === id);
  if (!p) return null;
  try { return migrateDocument(cloneJson(p.doc)); }
  catch (err) { console.warn('[presets] preset could not be migrated', id, err); return null; }
}

export function deletePreset(id: string, storage: StorageLike = defaultStorage()): boolean {
  const list = readAll(storage);
  const next = list.filter(p => p.id !== id);
  if (next.length === list.length) return false;
  writeAll(storage, next);
  return true;
}

export function renamePreset(id: string, name: string, storage: StorageLike = defaultStorage()): boolean {
  const list = readAll(storage);
  const p = list.find(x => x.id === id);
  if (!p) return false;
  p.name = (name || '').trim() || p.name;
  writeAll(storage, list);
  return true;
}

export function clearPresets(storage: StorageLike = defaultStorage()): void {
  try { storage.removeItem(PRESETS_KEY); } catch { /* ignore */ }
}

/* ───────────────────────────── summary ───────────────────────────── */

const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/** One line: "2 walls · 5×5, 3×2 (custom) · 1 stage · 3 equipment". Custom walls report their bounding box. */
export function summarize(doc: Document): string {
  const walls = doc.entities.filter(isLedWall);
  const parts: string[] = [];
  parts.push(plural(walls.length, 'wall'));
  if (walls.length) parts.push(walls.map(w => `${w.cols}×${w.rows}${w.shape.mode === 'custom' ? ' (custom)' : ''}`).join(', '));
  const stages = doc.entities.filter(isStage).length;
  if (stages) parts.push(plural(stages, 'stage'));
  const equipment = doc.entities.filter(isEquipment).length;
  if (equipment) parts.push(`${equipment} equipment`);
  const models = doc.entities.filter(e => isModel(e) || isSplat(e)).length;
  if (models) parts.push(plural(models, 'model'));
  return parts.join(' · ');
}

/* ───────────────────────────── v1 migration ───────────────────────────── */

/**
 * One-shot import of the legacy app's presets (`led-showroom-presets` + `led-showroom-view`)
 * into v2 presets. Idempotent: once run it marks `showroom-v2:v1-imported` and returns 0 on
 * later calls (pass `force` to re-run). Returns the number of presets imported.
 */
export function importV1Presets(storage: StorageLike = defaultStorage(), force = false): number {
  let done: string | null = null;
  try { done = storage.getItem(V1_IMPORTED_KEY); } catch { /* ignore */ }
  if (done && !force) return 0;

  const v1 = readV1PresetsFromStorage(storage);
  const view = readV1ViewFromStorage(storage);
  let n = 0;
  if (v1.length) {
    const list = readAll(storage);
    // v1 pushes new presets to the end (oldest-first, index.html 9100) — same order as the v2 list
    for (let i = 0; i < v1.length; i++) {
      const p = v1[i];
      let doc: Document;
      try { doc = convertV1Preset(p, view); } catch (err) { console.warn('[presets] skipped unreadable v1 preset', err); continue; }
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Imported preset ${i + 1}`;
      doc = { ...doc, name };
      list.push({
        id: newId('preset'),
        name,
        savedAt: typeof p.ts === 'number' && Number.isFinite(p.ts) ? p.ts : Date.now(),
        summary: summarize(doc),
        doc,
      });
      n++;
    }
    while (list.length > MAX_PRESETS) list.shift();
    try { writeAll(storage, list); } catch (err) { console.warn('[presets] v1 import could not be stored', err); return 0; }
  }
  try { storage.setItem(V1_IMPORTED_KEY, String(Date.now())); } catch { /* ignore */ }
  return n;
}
