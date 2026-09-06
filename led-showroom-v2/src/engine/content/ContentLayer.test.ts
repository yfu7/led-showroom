/**
 * The refcounted media cache: every consumer of one source shares a single decoder/texture, which
 * is what makes a spanned video frame-identical across the seam (v1's getSharedSpanVideo,
 * index.html:4969) and what stops the same file decoding once per wall.
 *
 * Node has no DOM, so the media created here never reaches its <video>/<img> stage — the identity,
 * refcount and key behaviour under test are all synchronous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { acquireMedia, clearMediaCache, createContentMedia, mediaCacheKey, mediaCacheSize, releaseMedia, type ContentMedia } from './ContentLayer';
import { AssetStore } from '../persistence/AssetStore';
import { SceneManager } from '../scene/SceneManager';
import { createLedWallRenderer } from '../entities/LedWallRenderer';
import { createDocument, createLedWall } from '../document/defaults';
import { addEntity } from '../document/Document';
import type { RenderContext } from '../entities/EntityRenderer';
import type { ContentSource, Document, LedWallEntity } from '../document/types';

const GEN = { wPx: 1000, hPx: 500, panelPxW: 100, panelPxH: 100, cols: 10, rows: 5 };
const opts = (gen: typeof GEN = GEN) => ({ maxTextureSize: 4096, gen });

const VIDEO: ContentSource = { type: 'video', assetId: 'asset-1', name: 'clip.mp4' };
const IMAGE: ContentSource = { type: 'image', assetId: 'asset-2', name: 'poster.jpg' };

/** The asset is missing in node, so `ready` rejects; swallow it so the run has no unhandled rejection. */
function quiet<T extends ContentMedia>(m: T): T {
  m.ready.catch(() => {});
  return m;
}

/** Wrap dispose so the test can count it without changing behaviour. */
function countDisposes(m: ContentMedia): () => number {
  let n = 0;
  const inner = m.dispose.bind(m);
  m.dispose = () => { n++; inner(); };
  return () => n;
}

beforeEach(() => clearMediaCache());

describe('mediaCacheKey', () => {
  it('ignores the wall size for sourced media (one decoder for walls of different sizes)', () => {
    expect(mediaCacheKey(VIDEO, opts())).toBe(mediaCacheKey(VIDEO, opts({ ...GEN, wPx: 4000, cols: 40 })));
    expect(mediaCacheKey(IMAGE, opts())).toBe(mediaCacheKey(IMAGE, opts({ ...GEN, hPx: 2000, rows: 20 })));
  });

  it('separates different sources, loop/mute flags and texture budgets', () => {
    expect(mediaCacheKey(VIDEO, opts())).not.toBe(mediaCacheKey(IMAGE, opts()));
    expect(mediaCacheKey(VIDEO, opts())).not.toBe(mediaCacheKey({ ...VIDEO, assetId: 'other' }, opts()));
    expect(mediaCacheKey(VIDEO, opts())).not.toBe(mediaCacheKey({ ...VIDEO, loop: false }, opts()));
    expect(mediaCacheKey(VIDEO, opts())).not.toBe(mediaCacheKey({ ...VIDEO, muted: false }, opts()));
    expect(mediaCacheKey(VIDEO, opts())).not.toBe(mediaCacheKey(VIDEO, { ...opts(), maxTextureSize: 2048 }));
  });

  it('keys generated patterns by the size they are baked at', () => {
    const pattern: ContentSource = { type: 'test-pattern', name: 'panels' };
    expect(mediaCacheKey(pattern, opts())).toBe(mediaCacheKey(pattern, opts()));
    expect(mediaCacheKey(pattern, opts())).not.toBe(mediaCacheKey(pattern, opts({ ...GEN, wPx: 2000, cols: 20 })));
  });
});

describe('acquireMedia / releaseMedia', () => {
  it('hands every consumer of one source the same media', () => {
    const assets = new AssetStore();
    const a = quiet(acquireMedia(VIDEO, assets, opts()));
    const b = quiet(acquireMedia(VIDEO, assets, opts({ ...GEN, wPx: 3000, cols: 30 })));
    expect(b).toBe(a);
    expect(mediaCacheSize()).toBe(1);
  });

  it('disposes only when the last consumer releases, and re-creates afterwards', () => {
    const assets = new AssetStore();
    const a = quiet(acquireMedia(VIDEO, assets, opts()));
    const disposes = countDisposes(a);
    quiet(acquireMedia(VIDEO, assets, opts()));

    releaseMedia(a);
    expect(disposes()).toBe(0);
    expect(mediaCacheSize()).toBe(1);

    releaseMedia(a);
    expect(disposes()).toBe(1);
    expect(mediaCacheSize()).toBe(0);

    releaseMedia(a); // stray extra release
    expect(disposes()).toBe(1);

    expect(quiet(acquireMedia(VIDEO, assets, opts()))).not.toBe(a);
  });

  it('keeps different sources apart', () => {
    const assets = new AssetStore();
    const a = quiet(acquireMedia(VIDEO, assets, opts()));
    const b = quiet(acquireMedia(IMAGE, assets, opts()));
    expect(b).not.toBe(a);
    expect(mediaCacheSize()).toBe(2);
  });

  it('disposes media that never came from the cache', () => {
    const m = quiet(createContentMedia(IMAGE, new AssetStore(), opts()));
    const disposes = countDisposes(m);
    releaseMedia(m);
    expect(disposes()).toBe(1);
    expect(mediaCacheSize()).toBe(0);
  });
});

/* ── the reason the cache exists: span mode ── */

function ctxFor(doc: Document): RenderContext {
  return {
    doc,
    assets: new AssetStore(),
    camera: new THREE.PerspectiveCamera(40, 1.6, 1, 60000),
    invalidate() {},
    setLoading() {},
    unit: doc.settings.units,
    needs: { css3d: false, pixelGrid: false },
    maxTextureSize: 4096,
  };
}

function spanDoc(): Document {
  let doc = createDocument();
  doc = { ...doc, settings: { ...doc.settings, spanContent: true } };
  const a = createLedWall({ name: 'Wall 1', cols: 4, rows: 3 });
  const b = createLedWall({ name: 'Wall 2', cols: 4, rows: 3, position: [200, 0, 0] });
  a.contentWindows[0].source = VIDEO;
  return addEntity(addEntity(doc, a), b);
}

describe('span mode', () => {
  it('gives both walls one shared player instead of one decoder each', () => {
    const doc = spanDoc();
    const ctx = ctxFor(doc);
    const scene = new SceneManager();
    scene.register('led-wall', createLedWallRenderer);
    scene.sync(doc, ctx);

    const walls = doc.entities.filter(e => e.type === 'led-wall') as LedWallEntity[];
    expect(walls).toHaveLength(2);
    expect(mediaCacheSize()).toBe(1); // one media for two walls

    scene.dispose();
    expect(mediaCacheSize()).toBe(0); // and both references given back
  });

  it('per-wall content keeps one media per distinct source', () => {
    let doc = spanDoc();
    doc = { ...doc, settings: { ...doc.settings, spanContent: false } };
    const walls = doc.entities.filter(e => e.type === 'led-wall') as LedWallEntity[];
    walls[1].contentWindows[0].source = IMAGE;
    const ctx = ctxFor(doc);
    const scene = new SceneManager();
    scene.register('led-wall', createLedWallRenderer);
    scene.sync(doc, ctx);

    expect(mediaCacheSize()).toBe(2);
    scene.dispose();
    expect(mediaCacheSize()).toBe(0);
  });
});
