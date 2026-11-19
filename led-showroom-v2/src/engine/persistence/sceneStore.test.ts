/**
 * Tests for the client half of the on-disk scene store.
 *
 * Most of these are about one question: when is there no store? The menu that saves builds to disk
 * appears only where the local server does, and the probe is what decides. Anything that answers
 * the route without being that server — a static host returning its own index.html, a dev proxy
 * with nothing behind it, some other API — has to read as "no store", never as "an empty store",
 * or the app offers to save builds into nowhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteStoredScene, listStoredScenes, readStoredScene, writeStoredScene } from './sceneStore';
import { createDocument } from '../document/defaults';
import type { AssetReader, AssetWriter } from './sceneFile';

const meta = (over: Record<string, unknown> = {}) =>
  ({ file: 'Build A.showroom.json', name: 'Build A', sizeBytes: 12, savedAt: 1_700_000_000_000, versions: [], ...over });

const LISTING = { dir: 'C:\\Users\\x\\Documents\\LED Showroom', scenes: [meta()] };

/** A Response-alike: only what sceneStore touches. */
function reply(body: unknown, { status = 200, type = 'application/json' } = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  } as unknown as Response;
}

const stub = (fn: (url: string, init?: RequestInit) => Promise<Response>) =>
  vi.stubGlobal('fetch', vi.fn(fn as unknown as typeof fetch));

afterEach(() => { vi.unstubAllGlobals(); });

/* ───────── the probe ───────── */

describe('listStoredScenes', () => {
  it('returns the listing when the local server answers', async () => {
    stub(async () => reply(LISTING));
    await expect(listStoredScenes()).resolves.toEqual(LISTING);
  });

  it('reads an empty store as an empty store, not as no store', async () => {
    stub(async () => reply({ dir: 'D:\\builds', scenes: [] }));
    await expect(listStoredScenes()).resolves.toEqual({ dir: 'D:\\builds', scenes: [] });
  });

  it('is null when nothing is listening', async () => {
    stub(async () => { throw new TypeError('Failed to fetch'); });
    await expect(listStoredScenes()).resolves.toBeNull();
  });

  it('is null when the route does not exist', async () => {
    stub(async () => reply({ error: 'Not found' }, { status: 404 }));
    await expect(listStoredScenes()).resolves.toBeNull();
  });

  /** A static host with an SPA fallback answers 200 with the app itself. That is not a store. */
  it('is null when a static host answers with its own page', async () => {
    stub(async () => reply('<!doctype html><html>…', { type: 'text/html; charset=utf-8' }));
    await expect(listStoredScenes()).resolves.toBeNull();
  });

  it('is null when the JSON is not a listing', async () => {
    for (const body of [null, 42, 'ok', { ok: true }, { dir: 'x' }, { scenes: [] }, { dir: 1, scenes: [] }]) {
      stub(async () => reply(body));
      await expect(listStoredScenes()).resolves.toBeNull();
    }
  });

  it('is null when an entry is not a scene', async () => {
    for (const bad of [{}, meta({ savedAt: 'yesterday' }), meta({ versions: null }), meta({ versions: [{}] })]) {
      stub(async () => reply({ dir: 'x', scenes: [bad] }));
      await expect(listStoredScenes()).resolves.toBeNull();
    }
  });
});

/* ───────── the rest, where a failure is a failure and not an absence ───────── */

describe('writeStoredScene', () => {
  const assets: AssetReader = { async getBlob() { return null; } };

  it('posts the scene under the name and returns where it went', async () => {
    let seen: { url: string; body: { name?: string; scene?: { format?: string } } } | null = null;
    stub(async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return reply({ dir: 'D:\\builds', saved: meta() });
    });

    const r = await writeStoredScene('Build A', createDocument('Build A'), assets);
    expect(seen!.url).toBe('/api/scenes');
    expect(seen!.body.name).toBe('Build A');
    expect(seen!.body.scene?.format).toBe('led-showroom-scene');
    expect(r.saved.file).toBe('Build A.showroom.json');
    expect(r.dir).toBe('D:\\builds');
    expect(r.missing).toEqual([]);
  });

  it('passes on what the server said went wrong', async () => {
    stub(async () => reply({ error: 'That scene is larger than this server will store.' }, { status: 413 }));
    await expect(writeStoredScene('Build A', createDocument('Build A'), assets))
      .rejects.toThrow(/larger than this server will store/);
  });

  it('still fails usefully when the server says nothing', async () => {
    stub(async () => reply('', { status: 500, type: 'text/plain' }));
    await expect(writeStoredScene('Build A', createDocument('Build A'), assets)).rejects.toThrow(/500/);
  });

  it('does not report a save the server did not describe', async () => {
    stub(async () => reply({ dir: 'D:\\builds' }));
    await expect(writeStoredScene('Build A', createDocument('Build A'), assets)).rejects.toThrow(/did not say/);
  });
});

describe('readStoredScene and deleteStoredScene', () => {
  const assets: AssetWriter = { async put() { return 'id'; } };

  it('addresses a version as one path segment', async () => {
    const urls: string[] = [];
    stub(async url => { urls.push(url); return reply(createDocument('Build A')); });

    await readStoredScene('versions/Build A-2026-11-19T13-05-00-123.showroom.json', assets);
    // The server decodes exactly one segment, so the separator must not arrive raw.
    expect(urls[0]).toBe('/api/scenes/file/versions%2FBuild%20A-2026-11-19T13-05-00-123.showroom.json');
  });

  it('loads a saved scene back into a document', async () => {
    stub(async () => reply(createDocument('Build A')));
    const { doc } = await readStoredScene('Build A.showroom.json', assets);
    expect(doc.name).toBe('Build A');
  });

  it('reports a scene that is no longer there', async () => {
    stub(async () => reply({ error: 'No such scene: Gone.showroom.json' }, { status: 404 }));
    await expect(readStoredScene('Gone.showroom.json', assets)).rejects.toThrow(/No such scene/);
  });

  it('deletes by sending DELETE, and reports a refusal', async () => {
    let method = '';
    stub(async (_url, init) => { method = String(init?.method); return reply({ ok: true }); });
    await deleteStoredScene('Build A.showroom.json');
    expect(method).toBe('DELETE');

    stub(async () => reply({ error: 'No such scene: Gone.showroom.json' }, { status: 404 }));
    await expect(deleteStoredScene('Gone.showroom.json')).rejects.toThrow(/No such scene/);
  });
});
