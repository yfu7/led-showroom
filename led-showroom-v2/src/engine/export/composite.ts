/**
 * Shared compositing helpers for the image / video exporters.
 *
 * An export frame is built in three layers, exactly like the live viewport:
 *   1. backdrop  — the venue photo cover-fitted to the frame, or the colour / radial gradient
 *                  the Environment paints when there is no photo (`paintBackdrop`)
 *   2. WebGL     — the main scene rendered by `Renderer.renderToCanvas` (or read straight from the
 *                  live canvas while recording)
 *   3. websites  — CSS3D iframes are not part of the WebGL canvas, so they are rasterised with
 *                  html2canvas and re-inserted as temporary textured planes at the CSS3D objects'
 *                  transforms (`buildWebsiteOverlays`, v1 buildRecordOverlays), so perspective is
 *                  handled natively by the renderer.
 *
 * Auto-crop (v1 Save Image): when no venue photo is staged the output is cropped to the
 * screen-space bounding box of the entities plus padding (`entityScreenBBox` + `autoCropRect`).
 *
 * Pure maths (`coverFitRect`, `autoCropRect`, `evenRect`, `projectBoxCorners`, `unionRects`) has
 * no DOM dependency and is unit tested.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { LedWallEntity } from '../document/types';
import { coverFit } from '../calibration/perspective';
import { LAYER_MAIN } from '../scene/Renderer';

export interface Rect { x: number; y: number; w: number; h: number }

/* ───────────────────────────── pure maths ───────────────────────────── */

/** CSS `background-size: cover` placement of an `imgW × imgH` image inside a `dstW × dstH` box. */
export function coverFitRect(imgW: number, imgH: number, dstW: number, dstH: number): Rect {
  const f = coverFit(imgW, imgH, dstW, dstH);
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

/** v1 padding rule: max(minPadPx, 20 % of the bbox's shorter side), clamped to the canvas. */
export function cropPadding(bbox: Rect, minPadPx = 40): number {
  return Math.max(minPadPx, Math.round(Math.min(bbox.w, bbox.h) * 0.2));
}

/**
 * Crop rect for an export: the entity bbox grown by `cropPadding`, clamped to the canvas.
 * Falls back to the full canvas when the bbox is missing or degenerate (v1: `bbox.w > 1 && bbox.h > 1`).
 */
export function autoCropRect(bbox: Rect | null, canvasW: number, canvasH: number, minPadPx = 40): Rect {
  const full: Rect = { x: 0, y: 0, w: canvasW, h: canvasH };
  if (!bbox || !(bbox.w > 1) || !(bbox.h > 1)) return full;
  const pad = cropPadding(bbox, minPadPx);
  const x0 = Math.max(0, Math.floor(bbox.x - pad));
  const y0 = Math.max(0, Math.floor(bbox.y - pad));
  const x1 = Math.min(canvasW, Math.ceil(bbox.x + bbox.w + pad));
  const y1 = Math.min(canvasH, Math.ceil(bbox.y + bbox.h + pad));
  const w = x1 - x0, h = y1 - y0;
  if (!(w > 1) || !(h > 1)) return full;
  return { x: x0, y: y0, w, h };
}

/** Video codecs need even dimensions: floor w/h to even numbers (never below 2). */
export function evenRect(r: Rect): Rect {
  return { x: r.x, y: r.y, w: Math.max(2, r.w & ~1), h: Math.max(2, r.h & ~1) };
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Union of rects; null when the list is empty. */
export function unionRects(rects: (Rect | null)[]): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) {
    if (!r) continue;
    if (!out) { out = { ...r }; continue; }
    const x0 = Math.min(out.x, r.x), y0 = Math.min(out.y, r.y);
    const x1 = Math.max(out.x + out.w, r.x + r.w), y1 = Math.max(out.y + out.h, r.y + r.h);
    out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return out;
}

const CORNER_SIGNS: [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];
const _v = new THREE.Vector3();

/**
 * Screen-space AABB (pixels, y down) of a local-space box transformed by `matrixWorld` and seen
 * through `camera` (whose matrices must be up to date) on a `width × height` viewport.
 * Corners behind the camera / outside the depth range are ignored; null when none project.
 */
export function projectBoxCorners(box: THREE.Box3, matrixWorld: THREE.Matrix4, camera: THREE.Camera, width: number, height: number): Rect | null {
  if (box.isEmpty()) return null;
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
  const hx = (box.max.x - box.min.x) / 2, hy = (box.max.y - box.min.y) / 2, hz = (box.max.z - box.min.z) / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const [sx, sy, sz] of CORNER_SIGNS) {
    _v.set(cx + sx * hx, cy + sy * hy, cz + sz * hz).applyMatrix4(matrixWorld).project(camera);
    if (!(_v.z >= -1 && _v.z <= 1)) continue; // behind the camera or past the far plane (also NaN)
    const px = (_v.x * 0.5 + 0.5) * width;
    const py = (-_v.y * 0.5 + 0.5) * height;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    any = true;
  }
  return any ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

/* ───────────────────────────── scene queries ───────────────────────────── */

/**
 * Screen-space AABB of every visible mesh of the given entities (all entities when `ids` is
 * omitted), in pixels of a `size` viewport (defaults to the live renderer size). Helpers
 * (`userData.helper`) are skipped. v1 computeWallScreenBBox.
 */
export function entityScreenBBox(engine: Engine, ids?: string[], size?: { w: number; h: number }): Rect | null {
  const w = size?.w ?? engine.renderer.width, h = size?.h ?? engine.renderer.height;
  const camera = engine.camera.camera;
  camera.updateMatrixWorld(true);
  const roots = (ids ? ids.map(id => engine.scene.rootOf(id)) : engine.scene.all().map(r => r.root)).filter(Boolean) as THREE.Object3D[];
  const rects: (Rect | null)[] = [];
  for (const root of roots) {
    if (!root.visible) continue;
    root.updateMatrixWorld(true);
    root.traverseVisible(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry || m.userData.helper) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      if (bb) rects.push(projectBoxCorners(bb, m.matrixWorld, camera, w, h));
    });
  }
  return unionRects(rects);
}

/* ───────────────────────────── backdrop ───────────────────────────── */

export interface BackdropGradient { top: string; bottom: string }

/**
 * Paint the backdrop of a `w × h` frame into `ctx`: the venue photo cover-fitted, or the same
 * radial gradient the Environment paints (`gradient.top` → `color`, or → `gradient.bottom` when the
 * colour is 'auto'/empty), or a flat `color` when no gradient colours are given.
 * `crop` paints only that sub-rect of the full frame at the context origin (video crops).
 */
export function paintBackdrop(ctx: CanvasRenderingContext2D, photo: HTMLImageElement | null, color: string, w: number, h: number, crop?: Rect, gradient?: BackdropGradient): void {
  ctx.save();
  if (crop) ctx.translate(-crop.x, -crop.y);
  const solid = color && color !== 'auto' ? color : (gradient?.bottom ?? '#0b0b0d');
  ctx.fillStyle = solid;
  ctx.fillRect(0, 0, w, h);
  const usable = photo && photo.complete && photo.naturalWidth > 0 && photo.naturalHeight > 0;
  if (usable) {
    const r = coverFitRect(photo.naturalWidth, photo.naturalHeight, w, h);
    ctx.drawImage(photo, r.x, r.y, r.w, r.h);
  } else if (gradient) {
    // CSS: radial-gradient(ellipse at 50% 65%, top 0%, bottom 70%) with the default farthest-corner
    // sizing — the ellipse keeps the farthest-side aspect ratio, scaled by √2 to reach the corner.
    const cx = w * 0.5, cy = h * 0.65;
    const rx = Math.max(cx, w - cx), ry = Math.max(cy, h - cy);
    const k = ry / Math.max(1e-6, rx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, k);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * Math.SQRT2);
    g.addColorStop(0, gradient.top);
    g.addColorStop(0.7, solid);
    g.addColorStop(1, solid);
    ctx.fillStyle = g;
    ctx.fillRect(-cx, -cy / k, w, h / k);
    ctx.restore();
  }
  ctx.restore();
}

const photoCache = new Map<string, Promise<HTMLImageElement | null>>();

/** Load (and cache) the venue photo for compositing; null when there is none or it fails to load. */
export function loadBackdropPhoto(url: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  let p = photoCache.get(url);
  if (!p) {
    p = new Promise<HTMLImageElement | null>(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => { photoCache.delete(url); resolve(null); };
      img.src = url;
    });
    photoCache.set(url, p);
  }
  return p;
}

/* ───────────────────────────── websites ───────────────────────────── */

export type IframeRasters = Map<HTMLIFrameElement, HTMLCanvasElement | null>;

interface RasterEntry { canvas: HTMLCanvasElement; at: number }

const rasterCache = new WeakMap<HTMLIFrameElement, RasterEntry>();
const rasterInFlight = new WeakMap<HTMLIFrameElement, Promise<HTMLCanvasElement | null>>();

/**
 * How long a cached raster is reused before the next capture re-rasterises the page. Websites keep
 * loading, scrolling and animating after the first snapshot, so a long-lived cache would put a stale
 * page in every later export; a short window still lets one capture's several passes share a raster.
 */
export const RASTER_TTL_MS = 2000;

/** Whether a raster taken at `stampedAt` may still be reused at `now` (clock jumps count as stale). */
export function rasterIsFresh(stampedAt: number, now: number, ttlMs = RASTER_TTL_MS): boolean {
  const age = now - stampedAt;
  return ttlMs > 0 && age >= 0 && age < ttlMs;
}

export interface RasterizeOptions {
  /** Ignore the cache entirely (Save Image, and every live-website refresh while recording). */
  force?: boolean;
  /** Reuse window for cached rasters; defaults to `RASTER_TTL_MS`. */
  ttlMs?: number;
}

/** All website iframes currently mounted in the CSS3D layer. */
export function websiteIframes(engine: Engine): HTMLIFrameElement[] {
  return Array.from(engine.renderer.css3dEl.querySelectorAll<HTMLIFrameElement>('.sr-web iframe'));
}

function rasterizeIframe(iframe: HTMLIFrameElement, force: boolean, ttlMs: number): Promise<HTMLCanvasElement | null> {
  const entry = rasterCache.get(iframe);
  const cached = entry?.canvas ?? null;
  if (entry && !force && rasterIsFresh(entry.at, Date.now(), ttlMs)) return Promise.resolve(entry.canvas);
  const pending = rasterInFlight.get(iframe);
  if (pending) return pending;
  let doc: Document | null = null;
  try { doc = iframe.contentDocument; } catch { doc = null; }
  if (!doc || !doc.documentElement || !doc.body) return Promise.resolve(cached);
  const p = (async () => {
    try {
      const { default: html2canvas } = await import('html2canvas');
      // documentElement (not body) so html/body backgrounds are included; scale 1 keeps the raster
      // in CSS pixels so it maps 1:1 onto the iframe's CSS box.
      const c = await html2canvas(doc!.documentElement, { backgroundColor: '#ffffff', useCORS: true, logging: false, scale: 1 });
      rasterCache.set(iframe, { canvas: c, at: Date.now() });
      return c;
    } catch (err) {
      console.warn('[export] website rasterisation failed', err);
      return cached;
    } finally {
      rasterInFlight.delete(iframe);
    }
  })();
  rasterInFlight.set(iframe, p);
  return p;
}

/**
 * Rasterise every website iframe in the scene with html2canvas (same-origin through the proxy).
 * Results are cached per iframe for `RASTER_TTL_MS` so a page that has scrolled, changed or finished
 * loading is re-rasterised for the next export; pass `force` to skip the cache outright (Save Image,
 * live websites in recordings). Cross-origin or failed iframes map to null (a cached earlier raster
 * is kept when available).
 */
export async function rasterizeIframes(engine: Engine, opts: RasterizeOptions = {}): Promise<IframeRasters> {
  const iframes = websiteIframes(engine);
  const out: IframeRasters = new Map();
  const ttl = opts.ttlMs ?? RASTER_TTL_MS;
  const results = await Promise.all(iframes.map(f => rasterizeIframe(f, !!opts.force, ttl)));
  iframes.forEach((f, i) => out.set(f, results[i]));
  return out;
}

interface CSS3DLike extends THREE.Object3D { isCSS3DObject?: boolean; element: HTMLElement }

interface Overlay {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;
  texCanvas: HTMLCanvasElement;
  iframe: HTMLIFrameElement;
  /** The `.sr-web` element the iframe is clipped by (crop is re-derived from it on every refresh). */
  container: HTMLElement;
}

export interface WebsiteOverlays {
  /** Number of planes built. */
  readonly count: number;
  /** Re-blit fresh rasters into the existing textures (live websites). */
  refresh(rasters: IframeRasters): void;
  dispose(): void;
}

export interface SliceCrop { visW: number; visH: number; sx: number; sy: number; sw: number; sh: number }

/**
 * Wall pixel → raster pixel crop for one CSS3D slice: the element shows `visW × visH` CSS px of an
 * iframe positioned at (left, top). Derived from the given raster's size, so it must be recomputed
 * for every new raster (a live page reflows between captures). Pure apart from reading DOM styles.
 */
export function sliceCrop(
  container: Pick<HTMLElement, 'style' | 'clientWidth' | 'clientHeight'>,
  iframe: Pick<HTMLIFrameElement, 'style'>,
  raster: { width: number; height: number },
): SliceCrop | null {
  const visW = parseFloat(container.style.width) || container.clientWidth || 0;
  const visH = parseFloat(container.style.height) || container.clientHeight || 0;
  if (visW < 1 || visH < 1) return null;
  const innerW = parseFloat(iframe.style.width) || visW;
  const innerH = parseFloat(iframe.style.height) || visH;
  const offX = -(parseFloat(iframe.style.left) || 0), offY = -(parseFloat(iframe.style.top) || 0);
  const scX = raster.width / innerW, scY = raster.height / innerH;
  const sx = Math.max(0, offX * scX), sy = Math.max(0, offY * scY);
  const sw = Math.min(raster.width - sx, visW * scX), sh = Math.min(raster.height - sy, visH * scY);
  if (sw < 1 || sh < 1) return null;
  return { visW, visH, sx, sy, sw, sh };
}

function entityOf(engine: Engine, obj: THREE.Object3D): LedWallEntity | undefined {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    const id = o.userData.entityId as string | undefined;
    if (id) return engine.entity<LedWallEntity>(id);
  }
  return undefined;
}

/**
 * Insert temporary WebGL planes (LAYER_MAIN) textured with the iframe rasters at every visible
 * website CSS3D object's transform, so the WebGL render includes websites with correct perspective
 * and occlusion. Iframes without a raster are skipped. Call `dispose()` after capturing.
 */
export function createWebsiteOverlays(engine: Engine, rasters: IframeRasters): WebsiteOverlays {
  const overlays: Overlay[] = [];
  const maxTex = Math.max(256, engine.renderer.maxTextureSize);
  engine.scene.scene.traverseVisible(o => {
    const obj = o as CSS3DLike;
    if (!obj.isCSS3DObject || !obj.element?.classList?.contains('sr-web')) return;
    const iframe = obj.element.querySelector('iframe');
    if (!iframe) return;
    const raster = rasters.get(iframe);
    if (!raster) return;
    const crop = sliceCrop(obj.element, iframe, raster);
    if (!crop) return;

    const texCanvas = document.createElement('canvas');
    const cap = Math.min(1, maxTex / Math.max(crop.sw, crop.sh));
    texCanvas.width = Math.max(1, Math.round(crop.sw * cap));
    texCanvas.height = Math.max(1, Math.round(crop.sh * cap));
    try { texCanvas.getContext('2d')!.drawImage(raster, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, texCanvas.width, texCanvas.height); }
    catch { return; }
    const texture = new THREE.CanvasTexture(texCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const wall = entityOf(engine, obj);
    // LedWallRenderer stamps the factor it also applies as a CSS `filter: brightness()` in the
    // viewport (brightness % × pixel-grid compensation), so the export matches what is on screen.
    const stamped = obj.userData.contentBrightness as number | undefined;
    const b = typeof stamped === 'number' ? stamped
      : wall && typeof wall.brightness === 'number' ? Math.min(1.6, wall.brightness / 100) : 1;
    const mat = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(b, b, b), depthWrite: false, toneMapped: false });
    // Plane in the element's CSS-pixel units; the CSS3D object's scale maps px → inches.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(crop.visW, crop.visH), mat);
    mesh.position.copy(obj.position);
    mesh.quaternion.copy(obj.quaternion);
    mesh.scale.copy(obj.scale);
    mesh.translateZ(0.05); // sit just in front of the CSS3D surface (local +z is the outward normal)
    mesh.renderOrder = 999;
    mesh.layers.set(LAYER_MAIN);
    mesh.userData.helper = true;
    mesh.userData.unpickable = true;
    mesh.name = 'export:website-overlay';
    (obj.parent ?? engine.scene.scene).add(mesh);
    mesh.updateMatrixWorld(true);
    overlays.push({ mesh, texture, texCanvas, iframe, container: obj.element });
  });

  return {
    get count() { return overlays.length; },
    refresh(next: IframeRasters) {
      for (const ov of overlays) {
        const raster = next.get(ov.iframe);
        if (!raster) continue;
        // A live page reflows between rasters (images load, height changes), so the source rect
        // must be re-derived from *this* raster's size (v1 refreshLiveIframeOverlays did the same).
        const crop = sliceCrop(ov.container, ov.iframe, raster);
        if (!crop) continue;
        const ctx = ov.texCanvas.getContext('2d');
        if (!ctx) continue;
        try {
          ctx.clearRect(0, 0, ov.texCanvas.width, ov.texCanvas.height);
          ctx.drawImage(raster, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, ov.texCanvas.width, ov.texCanvas.height);
          ov.texture.needsUpdate = true;
        } catch { /* cross-origin raster; keep the previous frame */ }
      }
    },
    dispose() {
      for (const ov of overlays) {
        ov.mesh.removeFromParent();
        ov.mesh.geometry.dispose();
        ov.mesh.material.dispose();
        ov.texture.dispose();
      }
      overlays.length = 0;
    },
  };
}

/** Convenience wrapper: build the overlays and return their teardown function. */
export function buildWebsiteOverlays(engine: Engine, rasters: IframeRasters): () => void {
  const ov = createWebsiteOverlays(engine, rasters);
  return () => ov.dispose();
}

/**
 * 2D fallback for websites: draws each raster into the screen-space bounding rect of the CSS3D
 * plane's four corners. LIMITATION: no perspective (the quad is approximated by its AABB) and no
 * occlusion — prefer `createWebsiteOverlays`, which renders through WebGL. `scale` maps live
 * viewport pixels to the target canvas.
 */
export function drawWebsiteOverlays(ctx: CanvasRenderingContext2D, engine: Engine, rasters: IframeRasters, scale = 1): void {
  const camera = engine.camera.camera;
  camera.updateMatrixWorld(true);
  const W = engine.renderer.width, H = engine.renderer.height;
  engine.scene.scene.traverseVisible(o => {
    const obj = o as CSS3DLike;
    if (!obj.isCSS3DObject || !obj.element?.classList?.contains('sr-web')) return;
    const iframe = obj.element.querySelector('iframe');
    const raster = iframe ? rasters.get(iframe) : null;
    if (!iframe || !raster) return;
    const crop = sliceCrop(obj.element, iframe, raster);
    if (!crop) return;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3(new THREE.Vector3(-crop.visW / 2, -crop.visH / 2, 0), new THREE.Vector3(crop.visW / 2, crop.visH / 2, 0));
    const r = projectBoxCorners(box, obj.matrixWorld, camera, W, H);
    if (!r || r.w < 1 || r.h < 1) return;
    try { ctx.drawImage(raster, crop.sx, crop.sy, crop.sw, crop.sh, r.x * scale, r.y * scale, r.w * scale, r.h * scale); } catch { /* cross-origin */ }
  });
}

/* ───────────────────────────── files ───────────────────────────── */

export function timestampName(ext: string): string {
  return `veloxity-showroom-${Date.now()}.${ext.replace(/^\./, '')}`;
}

/** Trigger a browser download of `blob` as `fileName`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}
