/**
 * Tests for the saved-scene store (server/scenes.cjs): the folder of real `.showroom.json` files the
 * local server writes, as against the browser storage the app autosaves into.
 *
 * Why the test lives under src/: vitest.config.ts collects `src/**` + `/*.test.ts` only, so this is
 * where the runner can see it. It loads the store through createRequire — the real CommonJS entry
 * point, exactly as server/index.cjs does — which also keeps the .cjs file out of the TypeScript
 * module graph (tsconfig has no allowJs).
 *
 * Every test runs against a throwaway folder under the OS temp directory.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EMBED_BYTES } from '../engine/persistence/sceneFile';

interface SceneMeta { file: string; name: string; sizeBytes: number; savedAt: number }
interface StoredScene extends SceneMeta { versions: SceneMeta[] }
interface SceneStore {
  dir: string;
  list(): { dir: string; scenes: StoredScene[] };
  read(rel: unknown): unknown;
  write(name: unknown, scene: unknown): SceneMeta;
  remove(rel: unknown): boolean;
  fileNameFor(name: unknown): string | null;
  resolve(rel: unknown): string | null;
}
interface ScenesModule {
  createSceneStore(dir: string): SceneStore;
  fileNameFor(name: unknown): string | null;
  EXT: string;
  MAX_BODY_BYTES: number;
}

const scenes = createRequire(import.meta.url)('../../server/scenes.cjs') as ScenesModule;
const { fileNameFor } = scenes;

let dir = '';
let store: SceneStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showroom-scenes-'));
  store = scenes.createSceneStore(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/* ───────── naming ───────── */

describe('fileNameFor', () => {
  it('keeps a readable name and adds the extension once', () => {
    expect(fileNameFor('My Build')).toBe('My Build.showroom.json');
    // Round-trips: a name read back off disk must not grow a second extension.
    expect(fileNameFor('My Build.showroom.json')).toBe('My Build.showroom.json');
  });

  it('flattens anything that could escape the folder', () => {
    // The separators go, and so does the `..` — what is left is a plain file name in one folder.
    expect(fileNameFor('../../etc/passwd')).toBe('etc passwd.showroom.json');
    expect(fileNameFor('C:\\Windows\\win.ini')).toBe('C Windows win.ini.showroom.json');
    expect(fileNameFor('a/../../../b')).toBe('a . . . b.showroom.json');
  });

  it('refuses a name with no usable characters', () => {
    for (const bad of ['', '   ', '..', '.', '...', '/', '\\', '///', null, undefined]) {
      expect(fileNameFor(bad)).toBeNull();
    }
  });

  it('caps the length, extension aside', () => {
    const name = fileNameFor('x'.repeat(500))!;
    expect(name.endsWith(scenes.EXT)).toBe(true);
    expect(name.length - scenes.EXT.length).toBe(80);
  });
});

/* ───────── addressing ───────── */

describe('resolve', () => {
  it('addresses the folder and its versions, and nothing else', () => {
    expect(store.resolve('Build A.showroom.json')).toBe(path.join(dir, 'Build A.showroom.json'));
    expect(store.resolve('versions/Build A.showroom.json')).toBe(path.join(dir, 'versions', 'Build A.showroom.json'));
  });

  it('refuses every way out of the folder', () => {
    for (const bad of [
      '..', '../x', '../../etc/passwd', 'sub/x', 'versions/../x', 'versions/sub/x',
      '..\\x', 'C:\\Windows\\win.ini', '/etc/passwd', '', null, undefined,
    ]) {
      expect(store.resolve(bad)).toBeNull();
    }
  });
});

/* ───────── saving, versioning, reading ───────── */

describe('the store', () => {
  it('lists nothing, rather than failing, before anything is saved', () => {
    expect(store.list()).toEqual({ dir, scenes: [] });
  });

  it('writes a scene and reads it back', () => {
    const meta = store.write('Build A', { hello: 'world' });
    expect(meta.name).toBe('Build A');
    expect(meta.file).toBe('Build A.showroom.json');
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(store.read(meta.file)).toEqual({ hello: 'world' });

    const { scenes: list } = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Build A');
    expect(list[0]!.versions).toEqual([]);
  });

  it('refuses a name a file cannot be called', () => {
    expect(() => store.write('..', {})).toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps what it overwrites as a version', () => {
    store.write('Build A', { v: 1 });
    const meta = store.write('Build A', { v: 2 });

    expect(store.read(meta.file)).toEqual({ v: 2 });
    const [scene] = store.list().scenes;
    expect(scene!.versions).toHaveLength(1);
    expect(store.read(scene!.versions[0]!.file)).toEqual({ v: 1 });
  });

  /**
   * The stamp has to carry milliseconds AND take a counter when even those collide. Both displaced
   * copies here are forced to the same mtime to the millisecond, which is what two saves inside one
   * clock tick look like — a double-click is enough. A seconds-only stamp renames the first copy
   * straight over the second, and the folder that exists so nothing is lost loses something.
   */
  it('keeps every displaced copy, even when they share a timestamp to the millisecond', () => {
    const file = path.join(dir, 'Build A.showroom.json');
    const fixed = new Date('2026-11-19T13:05:00.123Z');

    store.write('Build A', { v: 1 });
    fs.utimesSync(file, fixed, fixed);
    store.write('Build A', { v: 2 });
    fs.utimesSync(file, fixed, fixed);
    store.write('Build A', { v: 3 });

    const [scene] = store.list().scenes;
    expect(store.read(scene!.file)).toEqual({ v: 3 });
    expect(scene!.versions).toHaveLength(2);
    expect(scene!.versions.map(v => store.read(v.file))).toEqual(expect.arrayContaining([{ v: 1 }, { v: 2 }]));
  });

  /**
   * Splitting a version's file name on its last dash lands inside the stamp's own dashes, and the
   * version is then filed under a scene that does not exist. A name with dashes of its own is the
   * case that catches it.
   */
  it('files a version under its scene, not under a slice of its own timestamp', () => {
    store.write('Build-A 2026', { v: 1 });
    store.write('Build-A 2026', { v: 2 });

    const { scenes: list } = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Build-A 2026');
    expect(list[0]!.versions).toHaveLength(1);
  });

  it('does not hand one scene another scene s versions', () => {
    store.write('Build A', { v: 1 });
    store.write('Build A', { v: 2 });
    store.write('Build B', { v: 1 });

    const by = new Map(store.list().scenes.map(s => [s.name, s]));
    expect(by.get('Build A')!.versions).toHaveLength(1);
    expect(by.get('Build B')!.versions).toHaveLength(0);
  });

  it('lists the newest scene first', () => {
    store.write('Older', {});
    store.write('Newer', {});
    const older = path.join(dir, 'Older.showroom.json');
    const back = new Date(Date.now() - 60_000);
    fs.utimesSync(older, back, back);

    expect(store.list().scenes.map(s => s.name)).toEqual(['Newer', 'Older']);
  });

  it('reads and removes a version by its versions/ path', () => {
    store.write('Build A', { v: 1 });
    store.write('Build A', { v: 2 });
    const [scene] = store.list().scenes;
    const version = scene!.versions[0]!;

    expect(version.file.startsWith('versions/')).toBe(true);
    expect(store.read(version.file)).toEqual({ v: 1 });
    expect(store.remove(version.file)).toBe(true);
    expect(store.list().scenes[0]!.versions).toEqual([]);
  });

  it('reports a scene that is not there instead of inventing one', () => {
    expect(store.read('Nothing.showroom.json')).toBeNull();
    expect(store.read('../../etc/passwd')).toBeNull();
    expect(store.remove('Nothing.showroom.json')).toBe(false);
    expect(store.remove('../../etc/passwd')).toBe(false);
  });

  /**
    * Versions are reachable only through the scene they belong to, so leaving them behind would
    * leave disk nobody can see, still holding a build someone asked to be rid of.
    */
  it('takes a scene\'s versions with it, and leaves other scenes alone', () => {
    store.write('Build A', { v: 1 });
    store.write('Build A', { v: 2 });
    store.write('Build B', { v: 1 });
    store.write('Build B', { v: 2 });
    expect(store.remove('Build A.showroom.json')).toBe(true);

    expect(store.list().scenes.map(s => s.name)).toEqual(['Build B']);
    expect(fs.readdirSync(path.join(dir, 'versions')).filter(f => f.startsWith('Build A'))).toEqual([]);
    expect(store.list().scenes[0]!.versions).toHaveLength(1);
  });
});

/* ───────── the wire ───────── */

describe('MAX_BODY_BYTES', () => {
  it('accepts a body as large as the exporter is willing to build', () => {
    // embedAssets counts RAW bytes, but assets travel as base64 data URLs — four characters per
    // three bytes — and the document itself rides along on top of that.
    expect(scenes.MAX_BODY_BYTES).toBeGreaterThan(Math.ceil((MAX_EMBED_BYTES * 4) / 3));
  });
});
