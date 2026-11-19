/**
 * "Generate render": a CAD drawing sheet of the show, as a PNG.
 *
 *   ┌──────────────┬──────────────┐
 *   │     TOP      │  ISOMETRIC   │   third-angle projection, one shared scale, hidden lines
 *   ├──────────────┼──────────────┤   removed; the iso is a pictorial and says NTS
 *   │    FRONT     │    RIGHT     │
 *   ├──────────────┴──────────────┤
 *   │ PROJECT · DATE · OVERALL …  │   title strip: what it is, how big, at what scale
 *   └─────────────────────────────┘
 *
 * Three decisions worth knowing about:
 *
 *  - **The scale is chosen first, the cameras follow.** `sheetLayout` picks a standard ratio that
 *    fits every view, and each orthographic frustum is then `cellPx / 2 / pxPerIn` wide. A
 *    zoom-to-fit per view would look similar and be a lie: the printed "1 : 48" and the scale bar
 *    would not measure. Because the frustum is centred on the model bounds, the drawn silhouette is
 *    exactly `size × pxPerIn` centred on the cell, which is also where the dimensions are placed.
 *  - **Dimensions are drawn in 2D here, not toggled on in the document.** Flipping every wall's
 *    `showDimensions` for the capture would write to the document, land in undo history, and give
 *    per-wall dimension chains instead of the overall sizes a sheet wants.
 *  - **The geometry comes from `buildLineArt`,** a separate paper-white scene. See that module for
 *    what is copied and what is deliberately left out.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Document } from '../document/types';
import { formatArea, formatDims, formatLength, type Unit } from '../units';
import { filledCount, wallDims } from '../ledwall/layout';
import { buildLineArt } from './lineArt';
import { canvasToBlob, downloadBlob, timestampName } from './composite';
import {
  PAPERS, scaleBar, sheetLayout,
  type Extents, type PaperId, type SheetLayout, type ViewKey, type Viewport,
} from './sheet';

export interface DrawingOptions {
  paper?: PaperId;
  dpi?: number;
  /** 'quad' (default) is the four-up sheet; a single key is a 1-up of that view. */
  views?: 'quad' | ViewKey;
  /** Title-block project name. Defaults to the document name. */
  project?: string;
  /** Title-block date. Defaults to today, formatted for the current locale. */
  date?: string;
  fileName?: string;
  noDownload?: boolean;
}

export interface DrawingResult {
  blob: Blob;
  canvas: HTMLCanvasElement;
  layout: SheetLayout;
  /** The line-art builder hit its edge budget and fell back to boxes for some geometry. */
  simplified: boolean;
  /** Nothing visible to draw: the sheet carries its title block and says so. */
  empty: boolean;
  /**
   * What the run actually cost, split by phase, so a slow sheet can be attributed instead of
   * guessed at. One measurement, on one scene, for scale: 17 meshes / 204 segments on ANSI B,
   * 150 dpi → lineArt 1, render 25, encode 45, total 78 ms; the same scene at 300 dpi → lineArt
   * 1, render 34, encode 2304, total 2345 ms. Nothing here says how another scene divides: a
   * scene near the `maxSegments` budget may well be lineArt-bound.
   */
  stats: DrawingStats;
}

export interface DrawingStats {
  /** Meshes copied into the line-art scene. */
  meshes: number;
  /** Edge segments drawn across all of them. */
  segments: number;
  /** Building the line-art scene: the geometry-bound phase. */
  lineArtMs: number;
  /** Rendering the view cells and pasting them: the pixel-bound phase, usually the bulk. */
  renderMs: number;
  /** PNG encode of the finished sheet. */
  encodeMs: number;
  /** Wall-clock for the whole compose, milliseconds. */
  ms: number;
}

export interface TitleField {
  label: string;
  value: string;
  /** Relative width of this cell in the title strip. */
  weight: number;
}

/* ───────────────────────────── title block ───────────────────────────── */

/** LED totals across every wall, the same arithmetic the Specifications block reports. */
function ledTotals(doc: Document): { panels: number; areaSqIn: number; resolutions: string[] } {
  let panels = 0, areaSqIn = 0;
  const resolutions: string[] = [];
  for (const e of doc.entities) {
    if (e.type !== 'led-wall') continue;
    const d = wallDims(e);
    panels += filledCount(e);
    areaSqIn += d.totalW * d.totalH;
    const res = `${d.wallWPx} × ${d.wallHPx}`;
    if (!resolutions.includes(res)) resolutions.push(res);
  }
  return { panels, areaSqIn, resolutions };
}

/**
 * The title strip's contents. Pure — `date` is passed in rather than read from the clock so the
 * sheet is reproducible and this is testable.
 */
export function titleFields(
  doc: Document,
  extents: Extents,
  unit: Unit,
  opts: { date: string; scaleDenom: number; toScale: boolean; paper?: string; project?: string; empty?: boolean },
): TitleField[] {
  const { panels, areaSqIn, resolutions } = ledTotals(doc);
  const res = resolutions.length === 0 ? '—'
    : resolutions.length <= 2 ? resolutions.join('  ·  ')
    : `${resolutions[0]}  +${resolutions.length - 1} more`;
  return [
    { label: 'PROJECT', value: (opts.project ?? doc.name ?? '').trim() || 'Untitled show', weight: 2.4 },
    { label: 'DATE', value: opts.date, weight: 1.1 },
    // An empty scene has no extents and no scale. `generateDrawing` hands this function a unit
    // cube so the layout maths stays finite, which would otherwise print as a measured 1 in cube
    // at 1 : 1 — a drawing that reads as a real object, of nothing.
    { label: 'OVERALL  W × H × D', value: opts.empty ? '—' : formatDims([extents.w, extents.h, extents.d], unit), weight: 2 },
    { label: 'LED', value: panels ? `${panels} panels  ·  ${formatArea(areaSqIn, unit)}` : '—', weight: 1.6 },
    { label: 'RESOLUTION', value: res, weight: 1.5 },
    { label: 'SCALE', value: opts.empty ? '—' : opts.toScale ? `1 : ${opts.scaleDenom}` : 'NTS', weight: 1.2 },
  ];
}

/* ───────────────────────────── cameras ───────────────────────────── */

/**
 * Eye direction and page-up for each view. Third angle: the Top view's page-down is +Z (the model's
 * front), and the Right view's page-left is +Z, so the edges shared with the Front view face it.
 */
const VIEW_BASIS: Record<ViewKey, { dir: [number, number, number]; up: [number, number, number] }> = {
  front: { dir: [0, 0, 1], up: [0, 1, 0] },
  top: { dir: [0, 1, 0], up: [0, 0, -1] },
  right: { dir: [1, 0, 0], up: [0, 1, 0] },
  iso: { dir: [1, 0.82, 1], up: [0, 1, 0] },
};

/**
 * An orthographic camera for one cell. To-scale views take their frustum from the sheet scale; the
 * iso is fitted to its cell by projecting the bounds corners into camera space.
 */
export function viewCamera(view: Viewport, bounds: THREE.Box3, pxPerIn: number): THREE.OrthographicCamera {
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const diag = Math.max(1, size.length());
  const dist = diag * 2;
  const basis = VIEW_BASIS[view.key];

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, dist * 2 + diag * 2);
  cam.up.set(basis.up[0], basis.up[1], basis.up[2]);
  cam.position.copy(centre).add(new THREE.Vector3(basis.dir[0], basis.dir[1], basis.dir[2]).normalize().multiplyScalar(dist));
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);

  let halfW: number, halfH: number;
  if (view.toScale) {
    halfW = view.fit.w / 2 / pxPerIn;
    halfH = view.fit.h / 2 / pxPerIn;
    cam.left = -halfW; cam.right = halfW; cam.top = halfH; cam.bottom = -halfH;
  } else {
    // Fit to the projected silhouette. Its centre is not the bounds centre — a box seen from a
    // corner leans — so the frustum is offset onto it rather than left on the model axis, which
    // used to park the iso high and right of its cell.
    const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
    const p = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z);
      p.applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const k = Math.min(view.fit.w / Math.max((maxX - minX) * 1.07, 1e-3), view.fit.h / Math.max((maxY - minY) * 1.07, 1e-3));
    halfW = view.fit.w / 2 / k;
    halfH = view.fit.h / 2 / k;
    const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
    cam.left = ox - halfW; cam.right = ox + halfW; cam.top = oy + halfH; cam.bottom = oy - halfH;
  }
  cam.updateProjectionMatrix();
  return cam;
}

/* ───────────────────────────── 2D sheet furniture ───────────────────────────── */

const INK = '#111111';
const INK_LIGHT = '#8a8a8a';
const font = (px: number, weight = 400): string => `${weight} ${Math.round(px)}px "Segoe UI", Roboto, system-ui, sans-serif`;

function strokeRect(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, lw: number, colour = INK): void {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = lw;
  ctx.strokeRect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw);
  ctx.restore();
}

/** A filled triangular arrowhead at (x, y) pointing along `(dx, dy)`. */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, len: number): void {
  const w = len * 0.34;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - dx * len - dy * w, y - dy * len + dx * w);
  ctx.lineTo(x - dx * len + dy * w, y - dy * len - dx * w);
  ctx.closePath();
  ctx.fill();
}

/**
 * A dimension line with witness ticks and the measurement above (horizontal) or alongside
 * (vertical) it, drawn the way a drafter would.
 */
function dimension(
  ctx: CanvasRenderingContext2D,
  axis: 'h' | 'v',
  from: number, to: number, at: number,
  text: string, dpi: number,
): void {
  const a = Math.min(from, to), b = Math.max(from, to);
  if (b - a < 2) return;
  const tick = 0.055 * dpi;
  const head = Math.min(0.07 * dpi, (b - a) / 3);
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = Math.max(1, 0.008 * dpi);
  ctx.beginPath();
  if (axis === 'h') {
    ctx.moveTo(a, at); ctx.lineTo(b, at);
    ctx.moveTo(a, at - tick); ctx.lineTo(a, at + tick);
    ctx.moveTo(b, at - tick); ctx.lineTo(b, at + tick);
  } else {
    ctx.moveTo(at, a); ctx.lineTo(at, b);
    ctx.moveTo(at - tick, a); ctx.lineTo(at + tick, a);
    ctx.moveTo(at - tick, b); ctx.lineTo(at + tick, b);
  }
  ctx.stroke();
  if (axis === 'h') { arrow(ctx, a, at, -1, 0, head); arrow(ctx, b, at, 1, 0, head); }
  else { arrow(ctx, at, a, 0, -1, head); arrow(ctx, at, b, 0, 1, head); }

  ctx.font = font(0.1 * dpi, 600);
  ctx.textAlign = 'center';
  if (axis === 'h') {
    ctx.textBaseline = 'bottom';
    const m = ctx.measureText(text).width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((a + b) / 2 - m / 2 - 3, at - 0.145 * dpi, m + 6, 0.13 * dpi);
    ctx.fillStyle = INK;
    ctx.fillText(text, (a + b) / 2, at - 0.03 * dpi);
  } else {
    ctx.translate(at, (a + b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'bottom';
    const m = ctx.measureText(text).width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-m / 2 - 3, -0.145 * dpi, m + 6, 0.13 * dpi);
    ctx.fillStyle = INK;
    ctx.fillText(text, 0, -0.03 * dpi);
  }
  ctx.restore();
}

/** Which two extents a view measures, and under which labels. */
function viewDims(extents: Extents, key: ViewKey): { across: number; down: number } | null {
  switch (key) {
    case 'front': return { across: extents.w, down: extents.h };
    case 'top': return { across: extents.w, down: extents.d };
    case 'right': return { across: extents.d, down: extents.h };
    case 'iso': return null;
  }
}

function drawTitleBlock(ctx: CanvasRenderingContext2D, layout: SheetLayout, fields: TitleField[], toScale: boolean): void {
  const tb = layout.titleBlock, dpi = layout.dpi;
  strokeRect(ctx, tb, Math.max(1.5, 0.012 * dpi));

  // The scale bar gets the last cell, so it sits under the printed ratio.
  const total = fields.reduce((s, f) => s + f.weight, 0);
  let x = tb.x;
  fields.forEach((f, i) => {
    const w = (tb.w * f.weight) / total;
    if (i > 0) {
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1, 0.008 * dpi);
      ctx.beginPath(); ctx.moveTo(x, tb.y); ctx.lineTo(x, tb.y + tb.h); ctx.stroke();
      ctx.restore();
    }
    const px = x + 0.1 * dpi;
    ctx.fillStyle = INK_LIGHT;
    ctx.font = font(0.075 * dpi, 600);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(f.label, px, tb.y + 0.11 * dpi);

    ctx.fillStyle = INK;
    ctx.font = font(f.label === 'PROJECT' ? 0.17 * dpi : 0.13 * dpi, f.label === 'PROJECT' ? 700 : 500);
    // Shrink to fit rather than overflow into the neighbouring cell.
    let size = f.label === 'PROJECT' ? 0.17 * dpi : 0.13 * dpi;
    while (size > 0.07 * dpi && ctx.measureText(f.value).width > w - 0.2 * dpi) {
      size -= 0.008 * dpi;
      ctx.font = font(size, f.label === 'PROJECT' ? 700 : 500);
    }
    ctx.fillText(f.value, px, tb.y + 0.3 * dpi);

    if (f.label === 'SCALE' && toScale) {
      // A graphic scale, so the sheet stays measurable after someone prints it at the wrong size.
      const bar = scaleBar(layout.pxPerIn, w - 0.42 * dpi);
      const by = tb.y + tb.h - 0.3 * dpi;
      const bh = 0.058 * dpi;
      ctx.save();
      ctx.strokeStyle = INK; ctx.fillStyle = INK;
      ctx.lineWidth = Math.max(1, 0.007 * dpi);
      for (let t = 0; t < bar.ticks; t += 2) ctx.fillRect(px + (bar.px * t) / bar.ticks, by, bar.px / bar.ticks, bh);
      ctx.strokeRect(px, by, bar.px, bh);
      for (let t = 1; t < bar.ticks; t++) {
        const tx = px + (bar.px * t) / bar.ticks;
        ctx.beginPath(); ctx.moveTo(tx, by); ctx.lineTo(tx, by + bh); ctx.stroke();
      }
      ctx.font = font(0.07 * dpi, 600);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left'; ctx.fillText('0', px, by + bh + 0.03 * dpi);
      ctx.textAlign = 'center'; ctx.fillText(`${bar.feet} ft`, px + bar.px, by + bh + 0.03 * dpi);
      ctx.restore();
    }
    x += w;
  });
}

/* ───────────────────────────── the sheet ───────────────────────────── */

/**
 * Render the drawing sheet. Returns the canvas, the blob and the layout; downloads the PNG unless
 * `noDownload`.
 */
export async function generateDrawing(engine: Engine, opts: DrawingOptions = {}): Promise<DrawingResult> {
  const unit = engine.doc.settings.units;
  const t0 = performance.now();
  const art = buildLineArt(engine);
  const lineArtMs = performance.now() - t0;
  let renderMs = 0, encodeMs = 0;
  try {
    const size = art.bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : art.bounds.getSize(new THREE.Vector3());
    const extents: Extents = { w: size.x, h: size.y, d: size.z };
    const layout = sheetLayout(extents, { paper: opts.paper, dpi: opts.dpi, views: opts.views });
    const dpi = layout.dpi;
    const empty = art.bounds.isEmpty();

    const sheet = document.createElement('canvas');
    sheet.width = layout.wPx; sheet.height = layout.hPx;
    const ctx = sheet.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, layout.wPx, layout.hPx);
    strokeRect(ctx, layout.border, Math.max(2, 0.016 * dpi));

    // Views. Each is rendered at its cell size and pasted in; nothing in the live scene moves.
    if (!empty) {
      const tRender = performance.now();
      for (const v of layout.views) {
        const cam = viewCamera(v, art.bounds, layout.pxPerIn);
        const cell = engine.renderer.renderToCanvas(art.scene, cam, Math.max(2, Math.round(v.fit.w)), Math.max(2, Math.round(v.fit.h)), false);
        ctx.drawImage(cell, v.fit.x, v.fit.y);
      }
      renderMs = performance.now() - tRender;
    } else {
      ctx.fillStyle = INK_LIGHT;
      ctx.font = font(0.22 * dpi, 600);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('NOTHING TO DRAW — THE SCENE IS EMPTY', layout.drawingArea.x + layout.drawingArea.w / 2, layout.drawingArea.y + layout.drawingArea.h / 2);
    }

    // Cell frames, dimensions and labels, on top of the pasted renders.
    for (const v of layout.views) {
      strokeRect(ctx, { x: v.x, y: v.y, w: v.w, h: v.h }, Math.max(1, 0.006 * dpi), '#d4d4d4');

      if (!empty) {
        const d = viewDims(extents, v.key);
        if (d && v.toScale) {
          const left = v.cx - v.drawnW / 2, right = v.cx + v.drawnW / 2;
          const top = v.cy - v.drawnH / 2, bottom = v.cy + v.drawnH / 2;
          dimension(ctx, 'h', left, right, Math.min(bottom + 0.17 * dpi, v.y + v.h - 0.27 * dpi), formatLength(d.across, unit), dpi);
          dimension(ctx, 'v', top, bottom, Math.min(right + 0.15 * dpi, v.x + v.w - 0.09 * dpi), formatLength(d.down, unit), dpi);
        }
      }

      ctx.fillStyle = INK;
      ctx.font = font(0.11 * dpi, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      // An empty sheet states no scale here either: the unit-cube fallback makes `scaleDenom`
      // 1, and "FRONT 1 : 1" on a blank cell claims a measurement that was never taken.
      const tag = empty ? v.label : v.toScale ? `${v.label}    1 : ${layout.scaleDenom}` : `${v.label}    NTS`;
      ctx.fillText(tag, v.x + v.w / 2, v.y + v.h - 0.07 * dpi);
    }

    // Projection note, top-right of the drawing area.
    ctx.fillStyle = INK_LIGHT;
    ctx.font = font(0.08 * dpi, 600);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(
      layout.views.length > 1 ? 'THIRD ANGLE PROJECTION' : 'ORTHOGRAPHIC PROJECTION',
      layout.border.x + layout.border.w - 0.12 * dpi, layout.border.y + 0.08 * dpi,
    );
    if (layout.overflow) {
      ctx.fillStyle = '#b00020';
      ctx.textAlign = 'left';
      ctx.fillText('SCALE EXCEEDED — VIEWS MAY BE CLIPPED', layout.border.x + 0.12 * dpi, layout.border.y + 0.08 * dpi);
    }

    const toScale = layout.views.some(v => v.toScale) && !empty;
    drawTitleBlock(ctx, layout, titleFields(engine.doc, extents, unit, {
      date: opts.date ?? new Date().toLocaleDateString(),
      scaleDenom: layout.scaleDenom,
      toScale,
      paper: PAPERS[layout.paper.id].name,
      project: opts.project,
      empty,
    }), toScale);

    const tEncode = performance.now();
    const blob = await canvasToBlob(sheet, 'image/png');
    encodeMs = performance.now() - tEncode;
    if (!opts.noDownload) downloadBlob(blob, opts.fileName ?? timestampName('png').replace('.png', '-drawing.png'));
    return {
      blob, canvas: sheet, layout, simplified: art.simplified, empty,
      stats: {
        meshes: art.meshes, segments: art.segments,
        lineArtMs: Math.round(lineArtMs), renderMs: Math.round(renderMs), encodeMs: Math.round(encodeMs),
        ms: Math.round(performance.now() - t0),
      },
    };
  } finally {
    art.dispose();
    engine.invalidate();
  }
}
