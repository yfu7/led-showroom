import { describe, it, expect, afterEach } from 'vitest';
import {
  MAX_EMBED_BYTES, SCENE_FILE_FORMAT, assetNames, base64ToBytes, buildSceneFile, bytesToBase64, blobToDataUrl, dataUrlToBlob,
  embedAssets, migrateDocument, parseSceneFile, restoreAssets, rewriteAssetIds, sceneFileName, sceneFileParts, type AssetReader, type AssetWriter,
  type SceneFile,
} from './sceneFile';
import {
  BOOTH_PRESETS, createBoothForScene, createDimension, createDocument, createEquipment, createGroup, createLedWall, createModel,
  createRoom, createSplat, createStage, defaultEnvironment, defaultSettings, defaultView,
} from '../document/defaults';
import type { DimensionEntity, Document, EquipmentEntity, LedWallEntity, ModelEntity, RoomEntity, SplatEntity, StageEntity } from '../document/types';
import { EQUIPMENT_BY_ID } from '../catalog/equipment';
import { STAGE_SIZE_IN } from '../ledwall/specs';

class FakeAssets implements AssetReader, AssetWriter {
  blobs = new Map<string, { blob: Blob; name: string }>();
  n = 0;
  async put(file: Blob, name = 'asset'): Promise<string> { const id = `new_${++this.n}`; this.blobs.set(id, { blob: file, name }); return id; }
  async getBlob(id: string): Promise<Blob | null> { return this.blobs.get(id)?.blob ?? null; }
  async list() { return Array.from(this.blobs.entries()).map(([id, v]) => ({ id, name: v.name, type: v.blob.type, size: v.blob.size, createdAt: 0 })); }
  seed(id: string, text: string, type = 'text/plain', name = id + '.txt'): void { this.blobs.set(id, { blob: new Blob([text], { type }), name }); }
}

function docWithAssets(): Document {
  const wall = createLedWall();
  wall.contentWindows[0].source = { type: 'image', assetId: 'img1', name: 'poster.png', url: 'blob:http://x/abc' };
  const model = createModel('chair.glb', 'glb', { assetId: 'mdl1' });
  const d = createDocument('My Showroom');
  d.environment.backdrop.photo = { assetId: 'photo1', name: 'venue.jpg' };
  return { ...d, entities: [wall, model] };
}

describe('base64 / data URLs', () => {
  it('round-trips bytes of every length mod 3', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 100, 257]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 255);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });
  it('converts blobs to data URLs and back, keeping the mime type', async () => {
    const blob = new Blob(['hello, wall'], { type: 'text/plain' });
    const url = await blobToDataUrl(blob);
    expect(url.startsWith('data:text/plain;base64,')).toBe(true);
    const back = dataUrlToBlob(url)!;
    expect(back.type).toBe('text/plain');
    expect(await back.text()).toBe('hello, wall');
    expect(dataUrlToBlob('nope')).toBeNull();
    expect(await dataUrlToBlob('data:text/plain,hi%20there')!.text()).toBe('hi there');
  });

  describe('browser path (FileReader.readAsDataURL)', () => {
    const g = globalThis as unknown as { FileReader?: unknown };
    const original = g.FileReader;
    afterEach(() => { if (original === undefined) delete g.FileReader; else g.FileReader = original; });

    /** Minimal FileReader: encodes through Buffer, mints the browser-style mime type. */
    class FakeFileReader {
      static calls = 0;
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob): void {
        FakeFileReader.calls++;
        blob.arrayBuffer().then(buf => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
          this.onload?.();
        });
      }
    }
    class BrokenFileReader extends FakeFileReader {
      override readAsDataURL(): void { this.error = new Error('nope'); queueMicrotask(() => this.onerror?.()); }
    }

    it('uses FileReader when available and yields the same URL as the byte encoder', async () => {
      const blob = new Blob(['hello, wall'], { type: 'text/plain' });
      const expected = await blobToDataUrl(blob); // node fallback (no FileReader in this env)
      g.FileReader = FakeFileReader;
      FakeFileReader.calls = 0;
      expect(await blobToDataUrl(blob)).toBe(expected);
      expect(FakeFileReader.calls).toBe(1);
      // typeless blobs get the documented default type on both paths
      expect(await blobToDataUrl(new Blob([new Uint8Array([1, 2, 3])]))).toBe('data:application/octet-stream;base64,AQID');
    });
    it('falls back to the byte encoder when the reader errors', async () => {
      g.FileReader = BrokenFileReader;
      expect(await blobToDataUrl(new Blob(['A'], { type: 'text/plain' }))).toBe('data:text/plain;base64,QQ==');
    });
  });

  it('sceneFileParts joins to exactly JSON.stringify(file)', () => {
    const base: SceneFile = { format: SCENE_FILE_FORMAT, fileVersion: 1, exportedAt: 123, document: createDocument('Parts'), assets: [], missing: ['x.glb'] };
    expect(sceneFileParts(base).join('')).toBe(JSON.stringify(base));
    const withAssets: SceneFile = {
      ...base,
      assets: [
        { id: 'a', name: 'a "quoted".png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
        { id: 'b', name: 'b.jpg', type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BBBB' },
      ],
    };
    const parts = sceneFileParts(withAssets);
    expect(parts.filter(p => p.includes('dataUrl')).length).toBe(2); // one part per embedded asset
    expect(parts.join('')).toBe(JSON.stringify(withAssets));
    expect(JSON.parse(parts.join(''))).toEqual(withAssets);
    // key order is preserved whatever it is
    const reordered = { missing: [], assets: withAssets.assets, format: SCENE_FILE_FORMAT, fileVersion: 1, exportedAt: 1, document: base.document } as SceneFile;
    expect(sceneFileParts(reordered).join('')).toBe(JSON.stringify(reordered));
  });
});

describe('assetNames / rewriteAssetIds', () => {
  it('finds sibling names and fileNames', () => {
    const names = assetNames(docWithAssets());
    expect(names.get('img1')).toBe('poster.png');
    expect(names.get('mdl1')).toBe('chair.glb');
    expect(names.get('photo1')).toBe('venue.jpg');
  });
  it('rewrites ids, strips blob: urls next to an assetId and can drop unmapped ids', () => {
    const d = docWithAssets();
    const out = rewriteAssetIds(d, new Map([['img1', 'a1'], ['photo1', 'p1']]));
    const wall = out.entities[0] as LedWallEntity;
    expect(wall.contentWindows[0].source!.assetId).toBe('a1');
    expect(wall.contentWindows[0].source!.url).toBeUndefined();
    expect((out.entities[1] as ModelEntity).assetId).toBe('mdl1');
    expect(out.environment.backdrop.photo!.assetId).toBe('p1');
    expect(d.environment.backdrop.photo!.assetId).toBe('photo1'); // input untouched
    const dropped = rewriteAssetIds(d, new Map(), true);
    expect((dropped.entities[1] as ModelEntity).assetId).toBeUndefined();
  });
});

describe('migrateDocument', () => {
  it('fills a bare object with defaults', () => {
    const d = migrateDocument({});
    expect(d.version).toBe(2);
    expect(d.entities).toEqual([]);
    expect(d.environment).toEqual(defaultEnvironment());
    expect(d.view).toEqual(defaultView());
    expect(d.settings).toEqual(defaultSettings());
    expect(d.id).toMatch(/^doc_/);
  });
  it('keeps a current document unchanged', () => {
    const d = docWithAssets();
    expect(migrateDocument(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it('merges partial settings / environment / view and entity fields from older docs', () => {
    const d = migrateDocument({
      version: 1, name: 'old',
      settings: { units: 'mm', snap: { translateIn: 2 }, bogus: 1 },
      environment: { grid: { visible: false }, lighting: { preset: 'venue' }, backdrop: { color: '#123456', photo: { url: 'http://x/p.jpg' } } },
      view: { fov: 55, position: [1, 2, 3], target: [0, 0, 0] },
      entities: [
        { id: 'w', type: 'led-wall', cols: 3 },
        { type: 'stage', heightIn: 16, transform: { position: [1, 2, 3] } },
        { id: 'zz', type: 'alien' },
        { id: 'w', type: 'group', name: 'dup', parentId: 'missing', attachedTo: 'missing' },
      ],
    });
    expect(d.settings.units).toBe('mm');
    expect(d.settings.snap).toEqual({ ...defaultSettings().snap, translateIn: 2 });
    expect(d.settings.showHud).toBe(true);
    expect(d.environment.grid).toEqual({ ...defaultEnvironment().grid, visible: false });
    expect(d.environment.lighting.preset).toBe('venue');
    expect(d.environment.backdrop.color).toBe('#123456');
    expect(d.environment.backdrop.photo).toEqual({ url: 'http://x/p.jpg', name: 'Photo' });
    expect(d.view.fov).toBe(55);
    expect(d.view.savedViews).toEqual([]);
    expect(d.entities.length).toBe(3);
    const wall = d.entities[0] as LedWallEntity;
    expect(wall.cols).toBe(3); expect(wall.rows).toBe(5); expect(wall.contentWindows).toEqual([]); expect(wall.bezels).toBe(true);
    expect(wall.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(d.entities[1].id).toBeTruthy();
    expect(d.entities[1].transform).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(d.entities[2].id).not.toBe('w');
    expect(d.entities[2].parentId).toBeNull();
    expect(d.entities[2].attachedTo).toBeNull();
  });
  it('prunes stored corners that no longer sit on a joint', () => {
    const d = migrateDocument({
      version: 1,
      entities: [{ id: 'w', type: 'led-wall', cols: 3, corners: [{ afterCol: 1, angle: 90 }, { afterCol: 2, angle: 45 }, { afterCol: -1, angle: 30 }, 'junk'] }],
    });
    expect((d.entities[0] as LedWallEntity).corners).toEqual([{ afterCol: 1, angle: 90 }]);
  });
  it('rejects non-documents and newer versions', () => {
    expect(() => migrateDocument(null)).toThrow();
    expect(() => migrateDocument('x')).toThrow();
    expect(() => migrateDocument({ version: 99 })).toThrow(/newer/);
  });

  it('repairs an autosave written by an older build (the boot restore path)', () => {
    // shaped like `showroom-v2:doc` from a build before settings/view/environment grew fields
    const older = {
      version: 1, id: 'doc_old', name: 'Yesterday',
      entities: [
        { id: 'w1', type: 'led-wall', cols: 4, rows: 3, transform: { position: [10, 0, -20] } },
        { id: 's1', type: 'stage', heightIn: 18 },
      ],
      settings: { units: 'ft' },
      view: { fov: 50 },
    };
    const d = migrateDocument(JSON.parse(JSON.stringify(older)));
    expect(d.version).toBe(2);
    expect(d.id).toBe('doc_old');
    expect(d.entities.map(e => e.id)).toEqual(['w1', 's1']);
    expect(d.settings).toEqual({ ...defaultSettings(), units: 'ft' });
    expect(d.view).toEqual({ ...defaultView(), fov: 50 });
    expect(d.environment).toEqual(defaultEnvironment());
    expect(d.entities[0].transform).toEqual({ position: [10, 0, -20], rotation: [0, 0, 0], scale: [1, 1, 1] });
  });

  it('survives a truncated autosave: the readable half is kept, the rest defaulted', () => {
    // a partial localStorage write leaves objects missing their tails
    const truncated = { version: 2, entities: [{ id: 'w1', type: 'led-wall', cols: 6 }, null, 7, { type: 'stage' }], settings: null, view: 'x', environment: [] };
    const d = migrateDocument(truncated);
    expect(d.entities.map(e => e.type)).toEqual(['led-wall', 'stage']);
    expect((d.entities[0] as LedWallEntity).cols).toBe(6);
    expect(d.settings).toEqual(defaultSettings());
    expect(d.view).toEqual(defaultView());
    expect(d.environment).toEqual(defaultEnvironment());
  });

  it('clamps restored transforms to the sanity envelope (v1 P26)', () => {
    const d = migrateDocument({
      entities: [
        { id: 'a', type: 'stage', transform: { position: [99999, -1e9, 12], rotation: [0, 450, 0], scale: [1e6, 0, -2] } },
        { id: 'b', type: 'stage', transform: { position: [1, 2, 3], scale: [0.5, 40, 2] } },
        { id: 'c', type: 'stage', transform: { position: ['x', 2, 3], rotation: [NaN, 0, 0], scale: [1, 1, 1] } },
      ],
    });
    // out of range: clamped in, never dropped; a non-positive scale resets to 1
    expect(d.entities[0].transform).toEqual({ position: [3000, -3000, 12], rotation: [0, 450, 0], scale: [1000, 1, 1] });
    // in range: a metre-authored model at 40x and the 0.01 the scale field allows both survive
    expect(d.entities[1].transform.scale).toEqual([0.5, 40, 2]);
    // a junk component invalidates its whole vector, as before
    expect(d.entities[2].transform.position).toEqual([0, 0, 0]);
    expect(d.entities[2].transform.rotation).toEqual([0, 0, 0]);
  });

  describe('per-type defaults (defaults.ts factories)', () => {
    const ents = (entities: unknown[]) => migrateDocument({ entities }).entities;

    it('keeps every factory-made entity unchanged', () => {
      const eq = createEquipment({ id: 'kiosk-1', name: 'Kiosk', geometry: 'kiosk', dims: [24, 60, 18], color: '#333', accent: '#fff' });
      const all = [createLedWall(), createStage(), eq, createModel('m.obj', 'obj', {}), createSplat('s.ksplat', {}), createRoom(), createDimension([0, 0, 0], [10, 0, 0]), createGroup()];
      expect(ents(JSON.parse(JSON.stringify(all)))).toEqual(all);
    });
    it('stage: dims and colour', () => {
      const [s] = ents([{ type: 'stage', heightIn: -3, widthIn: 'x' }]) as StageEntity[];
      expect(s).toMatchObject({ widthIn: STAGE_SIZE_IN, depthIn: STAGE_SIZE_IN, heightIn: 24, color: '#1a1a1c' });
    });
    it('equipment: requires a known geometry and finite dims, defaults the rest', () => {
      const out = ents([
        { type: 'equipment', geometry: 'kiosk', dims: [1, 2, 3] },
        { type: 'equipment', geometry: 'hovercraft', dims: [1, 2, 3] },
        { type: 'equipment', geometry: 'box', dims: [1, Infinity, 3] },
        { type: 'equipment', geometry: 'box' },
        { type: 'equipment', geometry: 'box', dims: [1, 2, 3], catalogId: 'c1', color: '#f00', accent: 7, screen: 'nope' },
      ]) as EquipmentEntity[];
      expect(out.length).toBe(2);
      expect(out[0]).toMatchObject({ geometry: 'kiosk', dims: [1, 2, 3], catalogId: 'custom', color: '#4a4a52', screen: null });
      expect(out[0].accent).toBeUndefined();
      expect(out[1]).toMatchObject({ catalogId: 'c1', color: '#f00', screen: null });
      expect(out[1].accent).toBeUndefined();
    });
    it('equipment: keeps a cad product’s mesh url through a round trip', () => {
      // The catalog ships no cad product today; the round trip must still preserve one.
      const part = { ...EQUIPMENT_BY_ID['charging-table'], geometry: 'cad' as const, model: '/models/iposter-panel.glb' };
      const eq = createEquipment(part);
      expect(eq.model).toBe(part.model);
      const [out] = ents(JSON.parse(JSON.stringify([eq]))) as EquipmentEntity[];
      expect(out).toEqual(eq);
      expect(out.geometry).toBe('cad');
      expect(out.model).toBe(part.model);
    });
    it('equipment: keeps a photo product’s cutout url and billboard flag through a round trip', () => {
      const photo = Object.values(EQUIPMENT_BY_ID).find(d => d.geometry === 'photo' && d.image)!;
      const eq = { ...createEquipment(photo), billboard: false };
      const [out] = ents(JSON.parse(JSON.stringify([eq]))) as EquipmentEntity[];
      expect(out).toEqual(eq);
      expect(out.image).toBe(photo.image);
      expect(out.billboard).toBe(false);
    });
    it('equipment: drops a model / image / billboard that is not a shipped asset', () => {
      // These fields are fetched by url at render time (loadCadGeometry / loadProductTexture), so an
      // imported scene may only point them inside the app's own public folders.
      const base = { type: 'equipment', geometry: 'cad', dims: [1, 2, 3] };
      const out = ents([
        { ...base, model: 'https://evil.example/x.glb' },
        { ...base, model: 42 },
        { ...base, model: '/models/../../secret.glb' },
        { ...base, geometry: 'photo', image: '//evil.example/x.webp' },
        { ...base, billboard: 'yes' },
      ]) as EquipmentEntity[];
      expect(out).toHaveLength(5);
      for (const e of out) {
        expect(e.model).toBeUndefined();
        expect(e.image).toBeUndefined();
        expect(e.billboard).toBeUndefined();
      }
    });
    it('model: fileName / format (from the extension) / sourceUnit', () => {
      const [a, b, c] = ents([
        { type: 'model', fileName: 'Chair.FBX', sourceUnit: 'parsecs' },
        { type: 'model', fileName: 'thing.bin', format: 'stl', dims: [1, 2, 'x'] },
        { type: 'model' },
      ]) as ModelEntity[];
      expect(a).toMatchObject({ fileName: 'Chair.FBX', format: 'fbx', sourceUnit: 'm' });
      expect(b).toMatchObject({ fileName: 'thing.bin', format: 'stl' });
      expect(b.dims).toBeUndefined();
      expect(c).toMatchObject({ fileName: 'model.glb', format: 'glb', sourceUnit: 'm' });
    });
    it('splat: fileName / format', () => {
      const [a, b] = ents([{ type: 'splat', fileName: 'scan.splat' }, { type: 'splat', format: 'bogus' }]) as SplatEntity[];
      expect(a).toMatchObject({ fileName: 'scan.splat', format: 'splat' });
      expect(b).toMatchObject({ fileName: 'splat.ply', format: 'ply' });
    });
    it('room: dims / show / outlineWalls / surfaces / colour / opacity', () => {
      const d = createRoom();
      const [r] = ents([{ type: 'room', widthIn: 0, show: { ceiling: true }, surfaces: { back: { kind: 'image', assetId: 'x' }, floor: { kind: 'hologram' }, left: 3 }, opacity: 4 }]) as RoomEntity[];
      expect(r).toMatchObject({ widthIn: d.widthIn, heightIn: d.heightIn, depthIn: d.depthIn, show: { ...d.show, ceiling: true }, color: d.color, opacity: 1 });
      expect(r.surfaces).toEqual({ back: { kind: 'image', assetId: 'x' } });
      // Missing or junk outlineWalls falls back to the factory default (false), like every other flag.
      expect(r.outlineWalls).toBe(false);
      expect(d.outlineWalls).toBe(false);
      expect((ents([{ type: 'room', outlineWalls: 'yes' }])[0] as RoomEntity).outlineWalls).toBe(false);
    });

    it('room: an outlined booth survives a scene-file round trip', () => {
      const booth = createBoothForScene(BOOTH_PRESETS[0]);
      expect(booth.outlineWalls).toBe(true);
      const [back] = ents(JSON.parse(JSON.stringify([booth]))) as RoomEntity[];
      expect(back).toEqual(booth);
      expect(back.outlineWalls).toBe(true);
      expect(back.show).toEqual({ back: false, floor: true, ceiling: false, left: false, right: false });
    });
    it('dimension: a / b / label', () => {
      const [a, b] = ents([{ type: 'dimension', a: [1, 2, 3], b: 'x', label: 5 }, { type: 'dimension', a: [0, 0, 0], b: [4, 0, 0], label: 'L' }]) as DimensionEntity[];
      expect(a).toMatchObject({ a: [1, 2, 3], b: [0, 0, 0] });
      expect(a.label).toBeUndefined();
      expect(b).toMatchObject({ a: [0, 0, 0], b: [4, 0, 0], label: 'L' });
    });
    it('group / base: link fields are normalised to string | null', () => {
      const [g] = ents([{ type: 'group', parentId: 12, attachedTo: 'nope' }]);
      expect(g.type).toBe('group');
      expect(g.parentId).toBeNull();
      expect(g.attachedTo).toBeNull();
    });
  });
});

describe('embedAssets / restoreAssets', () => {
  it('embeds referenced assets and reports missing ones by name', async () => {
    const assets = new FakeAssets();
    assets.seed('img1', 'PNG', 'image/png');
    assets.seed('photo1', 'JPG', 'image/jpeg');
    const { assets: embedded, missing } = await embedAssets(docWithAssets(), assets);
    expect(embedded.map(a => a.id).sort()).toEqual(['img1', 'photo1']);
    expect(embedded.find(a => a.id === 'img1')).toMatchObject({ name: 'poster.png', type: 'image/png' });
    expect(missing).toEqual(['chair.glb']);
  });
  it('stops embedding past the size limit', async () => {
    const assets = new FakeAssets();
    assets.seed('img1', 'x'.repeat(10)); assets.seed('mdl1', 'y'.repeat(10)); assets.seed('photo1', 'z'.repeat(10));
    const r = await embedAssets(docWithAssets(), assets, 25);
    expect(r.assets.length).toBe(2);
    expect(r.missing.length).toBe(1);
    expect(MAX_EMBED_BYTES).toBe(150 * 1024 * 1024);
  });
  it('restores blobs through put and maps ids', async () => {
    const assets = new FakeAssets();
    const map = await restoreAssets([
      { id: 'a', name: 'a.txt', type: 'text/plain', dataUrl: await blobToDataUrl(new Blob(['A'], { type: 'text/plain' })) },
      { id: 'bad', name: 'b', type: '', dataUrl: 'garbage' },
    ], assets);
    expect(map.get('a')).toBe('new_1');
    expect(map.has('bad')).toBe(false);
    expect(await assets.blobs.get('new_1')!.blob.text()).toBe('A');
    expect(assets.blobs.get('new_1')!.name).toBe('a.txt');
  });
});

describe('scene file round trip', () => {
  it('exports and imports, rewriting ids and listing what is missing', async () => {
    const src = new FakeAssets();
    src.seed('img1', 'PNG', 'image/png');
    src.seed('photo1', 'JPG', 'image/jpeg');
    const file = await buildSceneFile(docWithAssets(), src);
    expect(file.format).toBe(SCENE_FILE_FORMAT);
    expect(file.missing).toEqual(['chair.glb']);
    const wallSrc = (file.document.entities[0] as LedWallEntity).contentWindows[0].source!;
    expect(wallSrc.url).toBeUndefined(); // blob: url stripped
    expect(wallSrc.assetId).toBe('img1');

    const dst = new FakeAssets();
    const json = JSON.parse(JSON.stringify(file));
    const { doc, missing } = await parseSceneFile(json, dst);
    const wall = doc.entities[0] as LedWallEntity;
    expect(wall.contentWindows[0].source!.assetId).toMatch(/^new_/);
    expect(doc.environment.backdrop.photo!.assetId).toMatch(/^new_/);
    expect((doc.entities[1] as ModelEntity).assetId).toBeUndefined();
    expect(missing).toEqual(['chair.glb']);
    expect(dst.blobs.size).toBe(2);
    expect(await dst.getBlob(wall.contentWindows[0].source!.assetId!).then(b => b!.text())).toBe('PNG');
  });
  it('keeps asset ids that were not embedded but exist in the local store', async () => {
    const src = new FakeAssets();
    src.seed('img1', 'PNG', 'image/png');
    // mdl1 and photo1 are not in the source store → not embedded, listed in file.missing
    const file = JSON.parse(JSON.stringify(await buildSceneFile(docWithAssets(), src)));
    expect(file.missing.sort()).toEqual(['chair.glb', 'venue.jpg']);

    const dst = new FakeAssets();
    dst.seed('mdl1', 'GLB', 'model/gltf-binary'); // the importing machine already has the model
    const { doc, missing } = await parseSceneFile(file, dst);
    expect((doc.entities[1] as ModelEntity).assetId).toBe('mdl1'); // kept, not remapped
    expect((doc.entities[0] as LedWallEntity).contentWindows[0].source!.assetId).toMatch(/^new_/); // restored
    expect(doc.environment.backdrop.photo!.assetId).toBeUndefined(); // neither restored nor present → dropped
    expect(missing).toEqual(['venue.jpg']);
  });
  it('drops unmapped ids when the writer cannot read the local store', async () => {
    const writer: AssetWriter = { put: async () => 'p1' };
    const { doc, missing } = await parseSceneFile(JSON.parse(JSON.stringify(docWithAssets())), writer);
    expect((doc.entities[1] as ModelEntity).assetId).toBeUndefined();
    expect(missing.sort()).toEqual(['chair.glb', 'poster.png', 'venue.jpg']);
  });
  it('accepts a bare document and rejects junk', async () => {
    const dst = new FakeAssets();
    const d = { ...createDocument('Bare'), entities: [createStage()] };
    const r = await parseSceneFile(JSON.parse(JSON.stringify(d)), dst);
    expect(r.doc.name).toBe('Bare');
    expect(r.missing).toEqual([]);
    await expect(parseSceneFile(42, dst)).rejects.toThrow();
    await expect(parseSceneFile({ format: SCENE_FILE_FORMAT, fileVersion: 999, document: {} }, dst)).rejects.toThrow(/newer/);
  });
  it('suggests a slug filename', () => {
    expect(sceneFileName(createDocument('My Showroom  (v2)!'))).toBe('my-showroom-v2.showroom.json');
    expect(sceneFileName(createDocument(''))).toBe('showroom.showroom.json');
  });
});
