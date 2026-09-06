/**
 * Asset store session cache. The behaviour under test is v1 item 35: the object URL of a source
 * that was replaced or cleared must be given back (v1 revoked it by hand — index.html:5557, 6919),
 * and giving it back must not destroy the asset, so undo can mint a fresh URL.
 *
 * Node has no IndexedDB, so a minimal in-memory fake stands in for it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AssetStore, collectAssetIds } from './AssetStore';

/* ── tiny IndexedDB fake: just what openDb/put/get/getAll/delete touch ── */
function installFakeIdb(): () => void {
  const rows = new Map<string, unknown>();
  const req = <T>(result: T): { result: T; onsuccess?: () => void; onerror?: () => void } => {
    const r: { result: T; onsuccess?: () => void; onerror?: () => void } = { result };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  };
  const objectStore = {
    put: (row: { id: string }) => { rows.set(row.id, row); return req(undefined); },
    get: (id: string) => req(rows.get(id)),
    getAll: () => req(Array.from(rows.values())),
    delete: (id: string) => { rows.delete(id); return req(undefined); },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => {
      const tx: { objectStore: () => typeof objectStore; oncomplete?: () => void; onerror?: () => void; error: null } =
        { objectStore: () => objectStore, error: null };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  const prev = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = { open: () => req(db) };
  return () => { (globalThis as { indexedDB?: unknown }).indexedDB = prev; };
}

let restore = () => {};
beforeEach(() => { restore = installFakeIdb(); });
afterEach(() => restore());

describe('releaseUnused', () => {
  it('revokes the URL of an asset the document no longer references, and keeps the referenced one', async () => {
    const store = new AssetStore();
    const oldId = await store.put(new Blob(['old video']), 'old.mp4');
    const newId = await store.put(new Blob(['new video']), 'new.mp4');
    const oldUrl = await store.getUrl(oldId);
    const newUrl = await store.getUrl(newId);
    expect(oldUrl).toBeTruthy();
    expect(newUrl).toBeTruthy();

    // the window's source was replaced: only the new asset is still in the document
    expect(store.releaseUnused(new Set([newId]))).toBe(1);
    expect(store.urlIfLoaded(oldId)).toBeNull();
    expect(store.urlIfLoaded(newId)).toBe(newUrl);
  });

  it('is non-destructive: a released asset comes back (undo) with a fresh URL', async () => {
    const store = new AssetStore();
    const id = await store.put(new Blob(['clip']), 'clip.mp4');
    const first = await store.getUrl(id);

    store.releaseUnused(new Set()); // window cleared
    expect(store.urlIfLoaded(id)).toBeNull();

    const again = await store.getUrl(id); // undo puts the source back
    expect(again).toBeTruthy();
    expect(again).not.toBe(first);
    expect((await store.list()).map(a => a.id)).toContain(id);
  });

  it('never releases an asset that could not be persisted (memory is the only copy)', async () => {
    restore();
    const store = new AssetStore(); // no IndexedDB at all
    const id = await store.put(new Blob(['orphan']), 'orphan.png');
    const url = await store.getUrl(id);
    expect(store.releaseUnused(new Set())).toBe(0);
    expect(store.urlIfLoaded(id)).toBe(url);
    expect(await store.getBlob(id)).toBeTruthy();
    restore = installFakeIdb();
  });

  it('keeps exactly the ids the document references', async () => {
    const store = new AssetStore();
    const used = await store.put(new Blob(['a']), 'a.png');
    const unused = await store.put(new Blob(['b']), 'b.png');
    await store.getUrl(used);
    await store.getUrl(unused);
    const doc = { entities: [{ contentWindows: [{ source: { type: 'image', assetId: used } }] }] };
    store.releaseUnused(collectAssetIds(doc));
    expect(store.urlIfLoaded(used)).toBeTruthy();
    expect(store.urlIfLoaded(unused)).toBeNull();
  });
});
