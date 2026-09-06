import { describe, it, expect } from 'vitest';
import {
  MAX_PRESETS, PRESETS_KEY, V1_IMPORTED_KEY, deletePreset, importV1Presets, listPresets, loadPreset, renamePreset, savePreset, summarize,
  type StorageLike,
} from './presets';
import { V1_PRESETS_KEY, V1_VIEW_KEY } from './v1import';
import { createDocument, createEquipment, createLedWall, createStage } from '../document/defaults';
import type { Document } from '../document/types';

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  writes = 0;
  quota = Infinity;
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.writes++; if (v.length > this.quota) throw new Error('QuotaExceededError'); this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

function doc(name = 'Scene'): Document {
  const d = createDocument(name);
  const w1 = createLedWall({ cols: 5, rows: 5 });
  const w2 = createLedWall({ cols: 3, rows: 2 });
  w2.shape = { mode: 'custom', cells: ['0,0', '1,0', '2,0', '0,1'] };
  const eq = createEquipment({ id: 'x', name: 'Box', geometry: 'box', dims: [1, 1, 1], color: '#fff' });
  return { ...d, entities: [w1, w2, createStage(24), eq, { ...eq, id: 'eq2' }, { ...eq, id: 'eq3' }] };
}

describe('summarize', () => {
  it('formats walls, stages and equipment', () => {
    expect(summarize(doc())).toBe('2 walls · 5×5, 3×2 (custom) · 1 stage · 3 equipment');
  });
  it('handles an empty document and singulars', () => {
    expect(summarize(createDocument())).toBe('0 walls');
    expect(summarize({ ...createDocument(), entities: [createLedWall({ cols: 4, rows: 4 })] })).toBe('1 wall · 4×4');
  });
});

describe('presets CRUD', () => {
  it('saves, lists (newest first), loads a copy, renames and deletes', () => {
    const st = new MemStorage();
    expect(listPresets(st)).toEqual([]);
    const a = savePreset('A', doc('A'), undefined, st);
    const b = savePreset('B', doc('B'), 'data:image/png;base64,AAAA', st);
    const list = listPresets(st);
    expect(list.map(p => p.id)).toEqual([b.id, a.id]);
    expect(list[0].thumbnail).toBe('data:image/png;base64,AAAA');
    expect(list[0].summary).toBe('2 walls · 5×5, 3×2 (custom) · 1 stage · 3 equipment');
    expect((list[0] as unknown as { doc?: unknown }).doc).toBeUndefined();

    const loaded = loadPreset(a.id, st)!;
    expect(loaded.name).toBe('A');
    loaded.name = 'mutated';
    expect(loadPreset(a.id, st)!.name).toBe('A');
    expect(loadPreset('nope', st)).toBeNull();

    expect(renamePreset(a.id, 'A2', st)).toBe(true);
    expect(listPresets(st).find(p => p.id === a.id)!.name).toBe('A2');
    expect(renamePreset('nope', 'x', st)).toBe(false);

    expect(deletePreset(b.id, st)).toBe(true);
    expect(deletePreset(b.id, st)).toBe(false);
    expect(listPresets(st).map(p => p.id)).toEqual([a.id]);
  });

  it('defaults empty names', () => {
    const st = new MemStorage();
    expect(savePreset('   ', createDocument(), undefined, st).name).toBe('Untitled preset');
  });

  it('keeps at most MAX_PRESETS, dropping the oldest', () => {
    const st = new MemStorage();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PRESETS + 3; i++) ids.push(savePreset(`P${i}`, createDocument(), undefined, st).id);
    const list = listPresets(st);
    expect(list.length).toBe(MAX_PRESETS);
    expect(list[0].id).toBe(ids[ids.length - 1]);
    expect(list.some(p => p.id === ids[0])).toBe(false);
    expect(list.some(p => p.id === ids[2])).toBe(false);
    expect(list.some(p => p.id === ids[3])).toBe(true);
  });

  it('migrates a preset saved by an older schema instead of handing it over raw', () => {
    const st = new MemStorage();
    st.m.set(PRESETS_KEY, JSON.stringify([{
      id: 'old', name: 'Old', savedAt: 1, summary: '',
      doc: {
        version: 1, name: 'Old',
        entities: [{ id: 'w', type: 'led-wall', cols: 4 }, { id: 'ufo', type: 'alien' }],
        settings: { units: 'ft' },
      },
    }]));
    const d = loadPreset('old', st)!;
    expect(d.version).toBe(2);
    expect(d.entities.map(e => e.type)).toEqual(['led-wall']);
    expect(d.settings.units).toBe('ft');
    expect(d.settings.pixelGridDistIn).toBe(72);
    expect(d.view.fov).toBe(40);
  });

  it('returns null for a preset whose document is not a document', () => {
    const st = new MemStorage();
    st.m.set(PRESETS_KEY, JSON.stringify([{ id: 'bad', name: 'Bad', savedAt: 1, summary: '', doc: { version: 99 } }]));
    expect(loadPreset('bad', st)).toBeNull();
  });

  it('survives malformed storage', () => {
    const st = new MemStorage();
    st.m.set(PRESETS_KEY, '{not json');
    expect(listPresets(st)).toEqual([]);
    st.m.set(PRESETS_KEY, JSON.stringify([{ id: 'x' }, 42, { id: 'ok', name: 'n', savedAt: 1, summary: '', doc: createDocument() }]));
    expect(listPresets(st).map(p => p.id)).toEqual(['ok']);
  });

  it('sheds thumbnails, then the oldest presets, when the quota is hit', () => {
    const st = new MemStorage();
    savePreset('A', createDocument(), 'data:x,' + 'a'.repeat(2000), st);
    st.quota = JSON.stringify(st.getItem(PRESETS_KEY)).length + 200; // room for a small second preset without thumbnails
    savePreset('B', createDocument(), 'data:x,' + 'b'.repeat(2000), st);
    const list = listPresets(st);
    expect(list.length).toBe(2);
    expect(list.every(p => !p.thumbnail)).toBe(true);
    st.quota = 10;
    expect(() => savePreset('C', createDocument(), undefined, st)).toThrow();
  });
});

describe('importV1Presets', () => {
  const v1 = [
    { name: 'Old one', ts: 1000, cols: 3, rows: 2, corners: [], contentWindows: [], showBezels: true },
    { name: 'Two walls', ts: 2000, walls: [{ id: 'w1', cols: 5, rows: 5 }, { id: 'w2', cols: 2, rows: 2, shape: { mode: 'custom', cells: ['0,0', '1,1'] } }], spanContent: true },
  ];

  it('converts v1 presets once and marks the import', () => {
    const st = new MemStorage();
    st.m.set(V1_PRESETS_KEY, JSON.stringify(v1));
    st.m.set(V1_VIEW_KEY, JSON.stringify({ cam: { px: 0, py: 60, pz: 300, tx: 0, ty: 40, tz: 0 }, fov: 45 }));
    expect(importV1Presets(st)).toBe(2);
    const list = listPresets(st);
    expect(list.map(p => p.name)).toEqual(['Two walls', 'Old one']);
    expect(list[1].savedAt).toBe(1000);
    expect(list[0].summary).toBe('2 walls · 5×5, 2×2 (custom)');
    const d = loadPreset(list[0].id, st)!;
    expect(d.version).toBe(2);
    expect(d.name).toBe('Two walls');
    expect(d.settings.spanContent).toBe(true);
    expect(st.getItem(V1_IMPORTED_KEY)).not.toBeNull();
    expect(importV1Presets(st)).toBe(0);
    expect(listPresets(st).length).toBe(2);
    expect(importV1Presets(st, true)).toBe(2);
    expect(listPresets(st).length).toBe(4);
  });

  it('is a no-op without v1 data (but still marks the import)', () => {
    const st = new MemStorage();
    expect(importV1Presets(st)).toBe(0);
    expect(st.getItem(V1_IMPORTED_KEY)).not.toBeNull();
    expect(listPresets(st)).toEqual([]);
  });

  it('names unnamed presets by index', () => {
    const st = new MemStorage();
    st.m.set(V1_PRESETS_KEY, JSON.stringify([{ cols: 1, rows: 1 }, { cols: 2, rows: 2 }]));
    importV1Presets(st);
    expect(listPresets(st).map(p => p.name)).toEqual(['Imported preset 2', 'Imported preset 1']);
  });
});
