/**
 * Local asset store (IndexedDB). Uploaded images, videos, models, photos and splats are kept
 * as Blobs keyed by an asset id so documents survive reloads. Blob URLs are minted lazily and
 * cached for the session.
 */
import { newId } from '../ids';

const DB_NAME = 'led-showroom-v2';
const STORE = 'assets';
const DB_VERSION = 1;

export interface AssetMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface Row extends AssetMeta { blob: Blob }

export class AssetStore {
  private dbp: Promise<IDBDatabase> | null = null;
  private urls = new Map<string, string>();
  private blobs = new Map<string, Blob>();
  private memoryOnly = false;
  /** Assets whose IndexedDB write failed: the in-memory blob is the only copy. */
  private unpersisted = new Set<string>();

  private db(): Promise<IDBDatabase> {
    if (!this.dbp) this.dbp = openDb().catch(err => { this.memoryOnly = true; throw err; });
    return this.dbp;
  }

  /** Store a file; returns its asset id. */
  async put(file: Blob, name = (file as File).name || 'asset'): Promise<string> {
    const id = newId('a');
    const row: Row = { id, name, type: file.type, size: file.size, createdAt: Date.now(), blob: file };
    this.blobs.set(id, file);
    try {
      const db = await this.db();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(row);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (err) {
      this.unpersisted.add(id); // memory is the only copy: never release it
      console.warn('[assets] persisted in memory only:', (err as Error).message);
    }
    return id;
  }

  async getBlob(id: string): Promise<Blob | null> {
    const cached = this.blobs.get(id);
    if (cached) return cached;
    if (this.memoryOnly) return null;
    try {
      const db = await this.db();
      const row = await new Promise<Row | undefined>((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => res(req.result as Row | undefined);
        req.onerror = () => rej(req.error);
      });
      if (row) { this.blobs.set(id, row.blob); return row.blob; }
    } catch { /* ignore */ }
    return null;
  }

  /** Object URL for an asset (session-cached). */
  async getUrl(id: string): Promise<string | null> {
    const u = this.urls.get(id);
    if (u) return u;
    const blob = await this.getBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return url;
  }

  /** Synchronous lookup if the URL was already minted. */
  urlIfLoaded(id: string): string | null { return this.urls.get(id) ?? null; }

  async remove(id: string): Promise<void> {
    const u = this.urls.get(id);
    if (u) { URL.revokeObjectURL(u); this.urls.delete(id); }
    this.blobs.delete(id);
    this.unpersisted.delete(id);
    try {
      const db = await this.db();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch { /* ignore */ }
  }

  /**
   * Release the session cache (object URL + in-memory blob) of every asset outside `keep`, and
   * return how many URLs were revoked. v1 revoked a window's blob URL the moment its source was
   * replaced or cleared (index.html:5557, 6919, 6981, 7000); here the URLs belong to the store, so
   * dropping the unreferenced ones is the equivalent — without it a session that swaps several
   * large videos pins every one of them for the life of the page.
   *
   * Non-destructive: the IndexedDB row stays, so undo, redo or a re-import mint a fresh URL. It is
   * therefore a no-op when the store never reached IndexedDB (the memory copy is then the only one).
   */
  releaseUnused(keep: Set<string>): number {
    if (this.memoryOnly) return 0;
    const held = (id: string): boolean => keep.has(id) || this.unpersisted.has(id);
    let n = 0;
    for (const [id, url] of Array.from(this.urls)) if (!held(id)) { URL.revokeObjectURL(url); this.urls.delete(id); n++; }
    for (const id of Array.from(this.blobs.keys())) if (!held(id)) this.blobs.delete(id);
    return n;
  }

  async list(): Promise<AssetMeta[]> {
    try {
      const db = await this.db();
      return await new Promise<AssetMeta[]>((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => res((req.result as Row[]).map(({ blob: _b, ...m }) => m));
        req.onerror = () => rej(req.error);
      });
    } catch { return []; }
  }

  /** Delete every asset not referenced by `keep`. */
  async prune(keep: Set<string>): Promise<number> {
    const all = await this.list();
    let n = 0;
    for (const a of all) if (!keep.has(a.id)) { await this.remove(a.id); n++; }
    return n;
  }
}

export const assets = new AssetStore();

/** Collect every assetId referenced anywhere in a JSON value. */
export function collectAssetIds(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const v of value) collectAssetIds(v, out); return out; }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'assetId' && typeof v === 'string') out.add(v);
    else collectAssetIds(v, out);
  }
  return out;
}
