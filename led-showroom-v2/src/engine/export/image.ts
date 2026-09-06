/**
 * Save Image (v1 8091–8409): composite PNG of the current view.
 *
 *   backdrop (venue photo cover-fit / colour gradient)  →  WebGL scene at `scale` × viewport
 *   (websites re-inserted as textured planes)           →  auto-crop to the entities + padding
 *
 * Selection outlines / hover edges are hidden for the capture; the transform gizmo and the
 * selection box live on LAYER_GIZMO, which `renderToCanvas` never draws. Video content windows
 * are canvas textures, so they show their current frame.
 */
import type { Engine } from '../Engine';
import {
  autoCropRect, canvasToBlob, createWebsiteOverlays, downloadBlob, entityScreenBBox,
  loadBackdropPhoto, paintBackdrop, rasterizeIframes, rectsEqual, timestampName, type Rect,
} from './composite';

export interface SaveImageOptions {
  /** Output size relative to the viewport (CSS px). Default 2 (2× viewport). */
  scale?: number;
  /** Skip the backdrop; the PNG keeps the WebGL alpha. */
  transparent?: boolean;
  /** 'auto' (default): crop to the entities + padding when no venue photo is staged; 'none': full frame. */
  crop?: 'auto' | 'none';
  /** Include the pixel-grid layer (default true). */
  includeGrid?: boolean;
  /** Download name; default 'veloxity-showroom-<timestamp>.png'. */
  fileName?: string;
  /** Return the blob without triggering a download. */
  noDownload?: boolean;
}

/** Largest WebGL canvas edge we ask for (drawing buffers above this fail silently on many GPUs). */
export const MAX_EXPORT_EDGE = 8192;

/** Export size for a given viewport and scale, clamped so the longest edge stays ≤ maxEdge. */
export function exportSize(viewW: number, viewH: number, scale: number, maxEdge = MAX_EXPORT_EDGE): { w: number; h: number; scale: number } {
  const s = Math.max(0.1, scale);
  const longest = Math.max(viewW, viewH) * s;
  const k = longest > maxEdge ? maxEdge / longest : 1;
  const eff = s * k;
  return { w: Math.max(2, Math.round(viewW * eff)), h: Math.max(2, Math.round(viewH * eff)), scale: eff };
}

/**
 * Render the current view to a composited canvas. Shared by `saveImage` and any caller that wants
 * the pixels rather than a file (clipboard, thumbnails).
 */
export async function captureView(engine: Engine, opts: SaveImageOptions = {}): Promise<{ canvas: HTMLCanvasElement; crop: Rect; full: { w: number; h: number } }> {
  const size = exportSize(engine.renderer.width, engine.renderer.height, opts.scale ?? 2);
  const W = size.w, H = size.h;
  const transparent = !!opts.transparent;
  const includeGrid = opts.includeGrid ?? true;

  const photoUrl = engine.env.photo;
  const [photo, rasters] = await Promise.all([
    transparent ? Promise.resolve(null) : loadBackdropPhoto(photoUrl),
    // force: an export must never reuse an earlier snapshot — the page may have scrolled, changed
    // or only finished loading since the last Save Image.
    rasterizeIframes(engine, { force: true }),
  ]);

  const selectionVisible = engine.selectionHelper.group.visible;
  const overlays = createWebsiteOverlays(engine, rasters);
  let gl: HTMLCanvasElement;
  try {
    engine.selectionHelper.group.visible = false;
    engine.env.update(engine.camera.camera);
    gl = engine.renderer.renderToCanvas(engine.scene.scene, engine.camera.camera, W, H, includeGrid);
  } finally {
    overlays.dispose();
    engine.selectionHelper.group.visible = selectionVisible;
    engine.invalidate();
  }

  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  const ctx = full.getContext('2d')!;
  if (!transparent) {
    const theme = engine.env.theme;
    paintBackdrop(ctx, photo, engine.doc.environment.backdrop.color, W, H, undefined, { top: theme.backdropTop, bottom: theme.backdropBottom });
  }
  ctx.drawImage(gl, 0, 0, W, H);

  // v1: crop to the model when the user has not staged a venue photo (the surroundings are the point then).
  let crop: Rect = { x: 0, y: 0, w: W, h: H };
  if ((opts.crop ?? 'auto') === 'auto' && !photoUrl) {
    crop = autoCropRect(entityScreenBBox(engine, undefined, { w: W, h: H }), W, H, Math.round(40 * size.scale));
  }
  if (rectsEqual(crop, { x: 0, y: 0, w: W, h: H })) return { canvas: full, crop, full: { w: W, h: H } };
  const out = document.createElement('canvas');
  out.width = crop.w; out.height = crop.h;
  out.getContext('2d')!.drawImage(full, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return { canvas: out, crop, full: { w: W, h: H } };
}

/** Capture the view as a PNG blob and (unless `noDownload`) download it as 'veloxity-showroom-<timestamp>.png'. */
export async function saveImage(engine: Engine, opts: SaveImageOptions = {}): Promise<Blob> {
  const { canvas } = await captureView(engine, opts);
  const blob = await canvasToBlob(canvas, 'image/png');
  if (!opts.noDownload) downloadBlob(blob, opts.fileName ?? timestampName('png'));
  return blob;
}
