/**
 * Content sources → renderable media.
 *
 *  image / test-pattern / color  → THREE.Texture (sRGB) on an unlit plane
 *  video                         → CanvasTexture fed by a FramePlayer (native <video> pump or WebCodecs HEVC)
 *  website                       → a DOM element (iframe through the proxy) shown with CSS3D
 *
 * A ContentMedia is shared by every plane (segment/cell slice, back face) of one content window.
 */
import * as THREE from 'three';
import type { ContentSource } from '../document/types';
import type { AssetStore } from '../persistence/AssetStore';
import { createHevcPlayer, createNativeVideoPlayer, pickDecodePath, sniffVideoCodecs, type FramePlayer } from './video';
import { renderPattern } from './generators';

export type MediaKind = 'texture' | 'dom' | 'none';

export interface ContentMedia {
  kind: MediaKind;
  /** Pixel size of the media (natural size for images/videos; wall px for generated). */
  width: number;
  height: number;
  texture: THREE.Texture | null;
  /** For websites: the element to mount in a CSS3D object. */
  element: HTMLElement | null;
  /** Ready when the first frame / image is available. */
  ready: Promise<void>;
  /** Per-frame update; returns true when the texture changed. */
  update(): boolean;
  /** Live video player, when any. */
  player: FramePlayer | null;
  dispose(): void;
}

export function proxyUrl(url: string): string {
  if (/^https?:\/\//i.test(url) && !url.includes(location.host)) return '/proxy?url=' + encodeURIComponent(url);
  return url;
}

/**
 * Sandbox applied to every iframe that displays a user-supplied website — the sliced CSS3D
 * windows in `LedWallRenderer` and the single-element path below. One constant, two importers,
 * so the two paths cannot drift apart again.
 *
 * Trade-off recorded on purpose: `allow-same-origin` stays for now. The website proxy re-serves
 * the remote page from *this app's* origin, so a displayed page runs same-origin with the
 * showroom and can reach this origin's localStorage (autosaved document, settings, presets, the
 * catalog order), its IndexedDB (the AssetStore — uploaded images, video and models) and its
 * cookies, and can call same-origin endpoints such as /proxy as the app. Dropping the token is
 * the safer end state, but it also breaks every site that needs storage or cookies to render, so
 * it is the product owner's call, not a silent change. Settle that before editing this line.
 */
export const WEBSITE_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

export function sourceKey(src: ContentSource | null): string {
  if (!src) return '';
  return JSON.stringify([src.type, src.assetId ?? src.url ?? '', src.color ?? '', src.name ?? '']);
}

/** Resolve the URL for a source (asset id → object URL). */
export async function resolveSourceUrl(src: ContentSource, assets: AssetStore): Promise<string | null> {
  if (src.assetId) return assets.getUrl(src.assetId);
  return src.url ?? null;
}

interface GenOpts { wPx: number; hPx: number; panelPxW: number; panelPxH: number; cols: number; rows: number; physicalW?: string; physicalH?: string }

function textureFromImage(img: HTMLImageElement | HTMLCanvasElement, maxSize: number): THREE.Texture {
  let source: HTMLImageElement | HTMLCanvasElement = img;
  const w = (img as HTMLImageElement).naturalWidth || img.width, h = (img as HTMLImageElement).naturalHeight || img.height;
  if (Math.max(w, h) > maxSize) {
    const s = maxSize / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    source = c;
  }
  const tex = new THREE.Texture(source);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Create the media for a content source. `gen` is needed for generated patterns. */
export function createContentMedia(src: ContentSource, assets: AssetStore, opts: { maxTextureSize: number; gen: GenOpts; onError?: (msg: string) => void }): ContentMedia {
  const none: ContentMedia = { kind: 'none', width: 0, height: 0, texture: null, element: null, ready: Promise.resolve(), update: () => false, player: null, dispose() {} };

  /* ── generated ── */
  if (src.type === 'color' || src.type === 'test-pattern') {
    const kind = src.type === 'color' ? 'solid' : ((src.name as 'test' | 'panels' | 'alignment' | 'bars') || 'test');
    const g = opts.gen;
    const scale = Math.min(1, opts.maxTextureSize / Math.max(g.wPx, g.hPx));
    const canvas = renderPattern(kind, { wPx: Math.round(g.wPx * scale), hPx: Math.round(g.hPx * scale), panelPxW: g.panelPxW * scale, panelPxH: g.panelPxH * scale, cols: g.cols, rows: g.rows, color: src.color, physicalW: g.physicalW, physicalH: g.physicalH });
    const texture = textureFromImage(canvas, opts.maxTextureSize);
    return { kind: 'texture', width: canvas.width, height: canvas.height, texture, element: null, ready: Promise.resolve(), update: () => false, player: null, dispose: () => texture.dispose() };
  }

  /* ── image ── */
  if (src.type === 'image') {
    const media: ContentMedia = { ...none, kind: 'texture' };
    let disposed = false;
    media.ready = (async () => {
      const url = await resolveSourceUrl(src, assets);
      if (!url) throw new Error('Image unavailable');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Could not load image ' + (src.name || ''))); img.src = url; });
      if (disposed) return;
      media.texture = textureFromImage(img, opts.maxTextureSize);
      media.width = img.naturalWidth; media.height = img.naturalHeight;
    })().catch(err => { opts.onError?.((err as Error).message); throw err; });
    media.dispose = () => { disposed = true; media.texture?.dispose(); };
    return media;
  }

  /* ── video ── */
  if (src.type === 'video') {
    const media: ContentMedia = { ...none, kind: 'texture' };
    let disposed = false;
    let lastFrame = -1;
    media.ready = (async () => {
      const blob = src.assetId ? await assets.getBlob(src.assetId) : null;
      // v1 item 35: never mint a second object URL for an asset. `AssetStore.getUrl` keeps one
      // URL per asset for the session and revokes it when the asset is released, so replacing or
      // clearing a video actually frees the decoded file instead of pinning it for the page's life
      // (v1 revoked the window's blob URL by hand — index.html:5557, 6919, 6981, 7000).
      const url = await resolveSourceUrl(src, assets);
      if (!url) throw new Error('Video unavailable');
      let path: 'native' | 'webcodecs-hevc' | 'unsupported' = 'native';
      if (blob) {
        try { path = pickDecodePath(await sniffVideoCodecs(blob)); } catch { path = 'native'; }
      }
      if (path === 'unsupported') throw new Error('This video codec cannot be decoded in this browser');
      const player = path === 'webcodecs-hevc' && blob
        ? createHevcPlayer(blob, { maxTextureSize: opts.maxTextureSize, loop: src.loop ?? true, muted: src.muted ?? true })
        : createNativeVideoPlayer(url, { maxTextureSize: opts.maxTextureSize, loop: src.loop ?? true, muted: src.muted ?? true });
      if (disposed) { player.dispose(); return; }
      media.player = player;
      await player.ready;
      if (disposed) { player.dispose(); return; }
      const tex = new THREE.CanvasTexture(player.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      media.texture = tex;
      media.width = player.width; media.height = player.height;
      player.play();
      player.onFrame = () => { lastFrame++; };
    })().catch(err => { opts.onError?.((err as Error).message); throw err; });
    let seen = -1;
    media.update = () => {
      if (!media.texture || !media.player) return false;
      // players call onFrame when a new frame is on the canvas; fall back to time polling
      if (lastFrame !== seen) { seen = lastFrame; media.texture.needsUpdate = true; return true; }
      if (lastFrame < 0) { media.texture.needsUpdate = true; return true; }
      return false;
    };
    media.dispose = () => { disposed = true; media.player?.dispose(); media.texture?.dispose(); };
    return media;
  }

  /* ── website ── */
  if (src.type === 'website') {
    const url = src.url ?? '';
    const el = document.createElement('div');
    el.className = 'sr-web';
    Object.assign(el.style, { background: '#000', overflow: 'hidden', pointerEvents: 'auto' });
    const ifr = document.createElement('iframe');
    Object.assign(ifr.style, { width: '100%', height: '100%', border: '0', display: 'block', background: '#000' });
    ifr.src = proxyUrl(url);
    ifr.setAttribute('sandbox', WEBSITE_IFRAME_SANDBOX);
    el.appendChild(ifr);
    return { kind: 'dom', width: 0, height: 0, texture: null, element: el, ready: Promise.resolve(), update: () => false, player: null, dispose: () => { ifr.src = 'about:blank'; el.remove(); } };
  }

  return none;
}

/* ─────────────────────────── shared media cache ─────────────────────────── */

interface CacheEntry { refs: number; media: ContentMedia }

const cache = new Map<string, CacheEntry>();
const cacheKeys = new WeakMap<ContentMedia, string>();
/** Marks a media whose last reference is gone, so a stray second release is a no-op. */
const RELEASED = 'media-released';

export interface MediaOpts { maxTextureSize: number; gen: GenOpts; onError?: (msg: string) => void }

/**
 * Cache key: the source plus everything that changes the produced media. Generated patterns are
 * baked at the wall's pixel size; videos carry their loop/mute flags; images depend on neither.
 */
export function mediaCacheKey(src: ContentSource, opts: { maxTextureSize: number; gen: GenOpts }): string {
  const g = opts.gen;
  const gen = src.type === 'color' || src.type === 'test-pattern'
    ? [g.wPx, g.hPx, g.panelPxW, g.panelPxH, g.cols, g.rows, g.physicalW ?? '', g.physicalH ?? ''].join(',')
    : '';
  const vid = src.type === 'video' ? `${src.loop ?? true},${src.muted ?? true}` : '';
  return `${sourceKey(src)}|${opts.maxTextureSize}|${gen}|${vid}`;
}

/**
 * Refcounted `createContentMedia`. Every consumer of the same source (all the walls of a spanned
 * image or video, the same file dropped on several walls) gets the *same* ContentMedia, so one
 * decoder feeds one CanvasTexture and the walls are frame-identical across the seam — v1 did this
 * for span mode only, with `getSharedSpanVideo` (index.html:4969).
 *
 * Websites are never shared: a DOM element can only live in one CSS3D object.
 * Pair every call with `releaseMedia`; the media is disposed when the last consumer releases it.
 */
export function acquireMedia(src: ContentSource, assets: AssetStore, opts: MediaOpts): ContentMedia {
  if (src.type === 'website') return createContentMedia(src, assets, opts);
  const key = mediaCacheKey(src, opts);
  const hit = cache.get(key);
  if (hit) {
    hit.refs++;
    // the first consumer owns the onError callback passed to createContentMedia; report to this one too
    if (opts.onError) hit.media.ready.catch(err => opts.onError!((err as Error)?.message ?? String(err)));
    return hit.media;
  }
  const media = createContentMedia(src, assets, opts);
  cache.set(key, { refs: 1, media });
  cacheKeys.set(media, key);
  return media;
}

/** Drop one reference taken by `acquireMedia`; disposes the media when the last one goes. */
export function releaseMedia(media: ContentMedia | null | undefined): void {
  if (!media) return;
  const key = cacheKeys.get(media);
  if (key === RELEASED) return; // already disposed by an earlier release
  const entry = key !== undefined ? cache.get(key) : undefined;
  if (!entry || entry.media !== media) { media.dispose(); return; } // uncached (a website)
  if (--entry.refs > 0) return;
  cache.delete(key!);
  cacheKeys.set(media, RELEASED);
  media.dispose();
}

/** Live cache entries (tests/diagnostics). */
export function mediaCacheSize(): number { return cache.size; }

/** Dispose and forget everything in the cache (tests). */
export function clearMediaCache(): void {
  for (const e of cache.values()) { cacheKeys.set(e.media, RELEASED); e.media.dispose(); }
  cache.clear();
}
