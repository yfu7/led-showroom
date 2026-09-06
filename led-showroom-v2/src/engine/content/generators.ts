/**
 * Built-in content generators: canvas-drawn test patterns at the wall's native pixel size.
 *
 * Ported from v1 `generateTestPattern` (index.html 6141-6190) and `loadSolidColor` (6201-6213),
 * plus three v2 extras (panel numbers, alignment circles, SMPTE-style colour bars).
 *
 * `renderPattern` / `patternBlob` need a DOM (`document.createElement('canvas')`) and throw a
 * clear error in node. The colour tables and the `PATTERNS` list are pure and safe to import
 * anywhere.
 */
import { IPOSTER } from '@/engine/ledwall/specs';

/** Identifier of a built-in pattern. */
export type PatternKind = 'test' | 'panels' | 'alignment' | 'bars' | 'solid';

/** One entry in the pattern picker. */
export interface PatternInfo {
  id: PatternKind;
  name: string;
  description: string;
}

/** All built-in patterns, in picker order. */
export const PATTERNS: PatternInfo[] = [
  { id: 'test', name: 'Test pattern', description: 'Rainbow gradient with panel grid, centre crosshair and a resolution readout (v1).' },
  { id: 'panels', name: 'Panel numbers', description: 'Every panel outlined and labelled with its column and row.' },
  { id: 'alignment', name: 'Alignment', description: 'Concentric circles, diagonals and a centre crosshair for checking geometry and seams.' },
  { id: 'bars', name: 'Colour bars', description: 'SMPTE-style colour bars for checking colour balance and gamma.' },
  { id: 'solid', name: 'Solid colour', description: 'A single flat colour across the whole wall.' },
];

/**
 * The seven horizontal gradient stops of the v1 test pattern (index.html 6150-6153).
 * `offset` is the 0..1 position along the wall width.
 */
export const RAINBOW_STOPS: ReadonlyArray<{ readonly offset: number; readonly color: string }> = [
  { offset: 0, color: '#ff0000' },
  { offset: 0.17, color: '#ff8800' },
  { offset: 0.33, color: '#ffff00' },
  { offset: 0.5, color: '#00cc00' },
  { offset: 0.67, color: '#0066ff' },
  { offset: 0.83, color: '#8800ff' },
  { offset: 1, color: '#ff00ff' },
];

/** The seven 75 % SMPTE colour bars (top band), left to right. */
export const SMPTE_BARS: ReadonlyArray<string> = [
  '#c0c0c0', // grey
  '#c0c000', // yellow
  '#00c0c0', // cyan
  '#00c000', // green
  '#c000c0', // magenta
  '#c00000', // red
  '#0000c0', // blue
];

/** The reverse-bar band under the main bars (SMPTE middle strip), left to right. */
export const SMPTE_REVERSE_BARS: ReadonlyArray<string> = [
  '#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0',
];

/** Bottom SMPTE strip: -I, white, +Q, black, then the PLUGE steps (sub-black, black, super-black). */
export const SMPTE_BOTTOM: ReadonlyArray<{ readonly color: string; readonly width: number }> = [
  { color: '#00214c', width: 5 / 4 }, // -I
  { color: '#ffffff', width: 5 / 4 }, // white
  { color: '#32006a', width: 5 / 4 }, // +Q
  { color: '#131313', width: 5 / 4 }, // black
  { color: '#090909', width: 1 / 3 }, // PLUGE: 3.5 IRE
  { color: '#131313', width: 1 / 3 }, // PLUGE: 7.5 IRE
  { color: '#1d1d1d', width: 1 / 3 }, // PLUGE: 11.5 IRE
  { color: '#131313', width: 1 }, // black
];

/** Default fill for the `solid` pattern when no colour is given. */
export const DEFAULT_SOLID_COLOR = '#ffffff';

/** Default label drawn on the `test` pattern (v1 hard-coded 'LED WALL TEST'). */
export const DEFAULT_TEST_LABEL = 'LED WALL TEST';

/** Options for rendering a pattern. Pixel sizes are the wall's native resolution. */
export interface PatternOptions {
  /** Canvas width in pixels (normally cols * panelPxW). */
  wPx: number;
  /** Canvas height in pixels (normally rows * panelPxH). */
  hPx: number;
  /** Pixel width of one panel (grid pitch). Defaults to the iPoster tile. */
  panelPxW?: number;
  /** Pixel height of one panel (grid pitch). Defaults to the iPoster tile. */
  panelPxH?: number;
  /** Panel columns — shown in the resolution readout and used as the `panels` grid width. */
  cols: number;
  /** Panel rows — shown in the resolution readout and used as the `panels` grid height. */
  rows: number;
  /** Fill colour for the `solid` pattern (any CSS colour). */
  color?: string;
  /** Headline text for the `test` pattern. Defaults to 'LED WALL TEST'. */
  label?: string;
  /** Pre-formatted physical width (e.g. "8' 4.5\"") shown under the resolution readout. */
  physicalW?: string;
  /** Pre-formatted physical height shown under the resolution readout. */
  physicalH?: string;
}

/** Sanitised, defaulted copy of the options (see `resolvePatternOptions`). */
export interface ResolvedPatternOptions {
  /** Canvas width, integer >= 1. */
  w: number;
  /** Canvas height, integer >= 1. */
  h: number;
  /** Panel pixel width, integer >= 1. */
  pw: number;
  /** Panel pixel height, integer >= 1. */
  ph: number;
  /** Panel columns, integer >= 1. */
  cols: number;
  /** Panel rows, integer >= 1. */
  rows: number;
  color: string;
  label: string;
  physicalW?: string;
  physicalH?: string;
}

/**
 * Coerce a numeric option to a positive integer. Non-finite values (NaN, +/-Infinity, or a
 * missing optional) fall back to `fallback` rather than leaking `NaN` into the canvas size or
 * the readout text (v1 always received integers from `wallDims`, so it never had to guard).
 */
function positiveInt(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.round(v)) : fallback;
}

/**
 * Sanitise and default a `PatternOptions`. Pure; exported so the numeric coercion can be tested
 * without a DOM. Every size is rounded to an integer >= 1, non-finite sizes fall back to sane
 * defaults (1 x 1 canvas, the iPoster tile, a 1 x 1 grid), and `color` / `label` get their v1
 * defaults.
 */
export function resolvePatternOptions(opts: PatternOptions): ResolvedPatternOptions {
  return {
    w: positiveInt(opts.wPx, 1),
    h: positiveInt(opts.hPx, 1),
    pw: positiveInt(opts.panelPxW, IPOSTER.pxW),
    ph: positiveInt(opts.panelPxH, IPOSTER.pxH),
    cols: positiveInt(opts.cols, 1),
    rows: positiveInt(opts.rows, 1),
    color: opts.color ?? DEFAULT_SOLID_COLOR,
    label: opts.label ?? DEFAULT_TEST_LABEL,
    physicalW: opts.physicalW,
    physicalH: opts.physicalH,
  };
}

type Resolved = ResolvedPatternOptions;

/**
 * Headline font size used by the `test` pattern: 8 % of the wall height, clamped to 24..60 px
 * (v1 index.html 6176). Pure; exported for tests and for UIs that want to match the size.
 */
export function testLabelFontSize(hPx: number): number {
  return Math.max(24, Math.min(60, Math.round(hPx * 0.08)));
}

/**
 * The resolution readout string of the `test` pattern, exactly as v1 formats it
 * (index.html 6187): `"1032 x 774 px  (3x3)"`.
 */
export function resolutionReadout(wPx: number, hPx: number, cols: number, rows: number): string {
  return wPx + ' x ' + hPx + ' px  (' + cols + 'x' + rows + ')';
}

/**
 * True when a usable 2D canvas context can be obtained: a browser, or jsdom with the optional
 * `canvas` package. False in plain node and in jsdom without `canvas` (where `getContext('2d')`
 * returns null). Probes a real context so it agrees with what `renderPattern` will do.
 */
export function canRenderPatterns(): boolean {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    return !!document.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!canRenderPatterns()) {
    throw new Error('renderPattern needs a DOM canvas with a 2D context; it cannot run in node.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable.');
  return { canvas, ctx };
}

/* ------------------------------------------------------------------------------------------ */
/* Shared drawing helpers                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** v1 panel grid: 1 px white @ 35 % on every panel boundary, including both outer edges. */
function drawPanelGrid(ctx: CanvasRenderingContext2D, r: Resolved, style = 'rgba(255,255,255,0.35)', lineWidth = 1): void {
  ctx.strokeStyle = style;
  ctx.lineWidth = lineWidth;
  for (let x = 0; x <= r.w; x += r.pw) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, r.h); ctx.stroke();
  }
  for (let y = 0; y <= r.h; y += r.ph) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(r.w, y); ctx.stroke();
  }
}

/** v1 centre crosshair: dashed [8,6], 2 px white @ 60 %. */
function drawCrosshair(ctx: CanvasRenderingContext2D, r: Resolved, style = 'rgba(255,255,255,0.6)'): void {
  ctx.strokeStyle = style;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(r.w / 2, 0); ctx.lineTo(r.w / 2, r.h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, r.h / 2); ctx.lineTo(r.w, r.h / 2); ctx.stroke();
  ctx.setLineDash([]);
}

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, sans-serif';

/* ------------------------------------------------------------------------------------------ */
/* Patterns                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** v1 `generateTestPattern` (index.html 6141-6190), plus an optional physical-size line. */
function drawTest(ctx: CanvasRenderingContext2D, r: Resolved): void {
  const { w, h } = r;

  // Rainbow gradient background (6149-6155)
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  for (const s of RAINBOW_STOPS) grad.addColorStop(s.offset, s.color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Panel grid lines (6157-6165)
  drawPanelGrid(ctx, r);

  // Center crosshair (6167-6173)
  drawCrosshair(ctx, r);

  // Label (6175-6182): drop shadow offset by 2 px then white text, both centred.
  const fontSize = testLabelFontSize(h);
  ctx.font = 'bold ' + fontSize + 'px ' + SYSTEM_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(r.label, w / 2 + 2, h / 2 + 2);
  ctx.fillStyle = '#fff';
  ctx.fillText(r.label, w / 2, h / 2);

  // Resolution label (6184-6187)
  ctx.font = Math.round(fontSize * 0.4) + 'px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(resolutionReadout(w, h, r.cols, r.rows), w / 2, h / 2 + fontSize * 0.7);

  // v2 extra: physical size line under the resolution readout, when the caller supplies it.
  if (r.physicalW || r.physicalH) {
    const phys = [r.physicalW, r.physicalH].filter(Boolean).join(' x ');
    ctx.fillText(phys, w / 2, h / 2 + fontSize * 1.15);
  }
}

/** v1 `loadSolidColor` (index.html 6201-6207): flat fill of the whole canvas. */
function drawSolid(ctx: CanvasRenderingContext2D, r: Resolved): void {
  ctx.fillStyle = r.color;
  ctx.fillRect(0, 0, r.w, r.h);
}

/**
 * v2 'panel numbers': every panel gets a dark/light checker tint, a 2 px border inset inside its
 * tile, and a "C{col},R{row}" label (1-based, column first) centred in it. The top-left panel is
 * C1,R1. Panel index also appears small in the corner so it stays legible on tiny previews.
 *
 * The grid is `opts.cols x opts.rows` (the declared wall grid, same source of truth as the `test`
 * readout); `panelPxW/H` only set the tile pitch. If `wPx/hPx` is not exactly `cols*pw x rows*ph`
 * the last column/row is simply clipped or leaves a dark margin.
 */
function drawPanels(ctx: CanvasRenderingContext2D, r: Resolved): void {
  const { w, h, pw, ph, cols, rows } = r;
  const fontSize = Math.max(12, Math.min(96, Math.round(Math.min(pw, ph) * 0.28)));
  const smallSize = Math.max(9, Math.round(fontSize * 0.45));

  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * pw;
      const y = row * ph;
      const even = (col + row) % 2 === 0;
      ctx.fillStyle = even ? '#1e2a38' : '#2c3e50';
      ctx.fillRect(x, y, pw, ph);

      // Border, inset by half its width so it sits fully inside the tile.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, pw - 2, ph - 2);

      // Big label
      ctx.font = 'bold ' + fontSize + 'px ' + SYSTEM_FONT;
      ctx.fillStyle = '#ffffff';
      ctx.fillText('C' + (col + 1) + ',R' + (row + 1), x + pw / 2, y + ph / 2);

      // Small running index (row-major, 1-based) in the top-left corner
      ctx.font = smallSize + 'px ' + SYSTEM_FONT;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'left';
      ctx.fillText(String(row * cols + col + 1), x + 6, y + smallSize * 0.9);
      ctx.textAlign = 'center';
    }
  }
}

/**
 * v2 'alignment': neutral grey field, panel grid, concentric circles centred on the wall
 * (radius step = half the shorter panel dimension), the two diagonals, a solid centre
 * crosshair and small tick marks along all four edges at each panel boundary.
 */
function drawAlignment(ctx: CanvasRenderingContext2D, r: Resolved): void {
  const { w, h, pw, ph } = r;
  const cx = w / 2;
  const cy = h / 2;

  ctx.fillStyle = '#404040';
  ctx.fillRect(0, 0, w, h);

  drawPanelGrid(ctx, r, 'rgba(255,255,255,0.25)', 1);

  // Diagonals
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w, 0); ctx.lineTo(0, h); ctx.stroke();

  // Concentric circles out to the far corner
  const step = Math.max(8, Math.min(pw, ph) / 2);
  const maxR = Math.hypot(cx, cy);
  ctx.lineWidth = 2;
  let i = 0;
  for (let rad = step; rad <= maxR; rad += step, i++) {
    ctx.strokeStyle = i % 2 === 0 ? '#ffffff' : '#00ffff';
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  }

  // Solid centre crosshair
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

  // Centre dot
  ctx.fillStyle = '#ff3b30';
  ctx.beginPath(); ctx.arc(cx, cy, Math.max(3, step * 0.06), 0, Math.PI * 2); ctx.fill();

  // Edge ticks at panel boundaries
  const tick = Math.max(6, Math.round(Math.min(pw, ph) * 0.08));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  for (let x = 0; x <= w; x += pw) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, tick); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, h - tick); ctx.stroke();
  }
  for (let y = 0; y <= h; y += ph) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(tick, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w, y); ctx.lineTo(w - tick, y); ctx.stroke();
  }

  // Corner squares (one panel-ish tenth) to check the extremities are lit
  const sq = Math.max(8, Math.round(Math.min(pw, ph) * 0.1));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sq, sq);
  ctx.fillRect(w - sq, 0, sq, sq);
  ctx.fillRect(0, h - sq, sq, sq);
  ctx.fillRect(w - sq, h - sq, sq, sq);
}

/**
 * v2 'colour bars': SMPTE-style layout. Top 2/3 = seven 75 % bars; next 1/12 = reverse bars;
 * bottom 1/4 = -I / white / +Q / black / PLUGE strip.
 */
function drawBars(ctx: CanvasRenderingContext2D, r: Resolved): void {
  const { w, h } = r;
  const topH = Math.round(h * (2 / 3));
  const midH = Math.round(h / 12);
  const botY = topH + midH;
  const botH = h - botY;
  const barW = w / SMPTE_BARS.length;

  ctx.fillStyle = '#131313';
  ctx.fillRect(0, 0, w, h);

  SMPTE_BARS.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.floor(i * barW), 0, Math.ceil(barW) + 1, topH);
  });
  SMPTE_REVERSE_BARS.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.floor(i * barW), topH, Math.ceil(barW) + 1, midH);
  });

  const totalUnits = SMPTE_BOTTOM.reduce((s, b) => s + b.width, 0);
  let x = 0;
  for (const b of SMPTE_BOTTOM) {
    const bw = (b.width / totalUnits) * w;
    ctx.fillStyle = b.color;
    ctx.fillRect(Math.floor(x), botY, Math.ceil(bw) + 1, botH);
    x += bw;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Public API                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Render a built-in pattern into a new canvas at the wall's native pixel size.
 * DOM only — throws in node. See `canRenderPatterns()`.
 */
export function renderPattern(kind: PatternKind, opts: PatternOptions): HTMLCanvasElement {
  const r = resolvePatternOptions(opts);
  const { canvas, ctx } = makeCanvas(r.w, r.h);
  switch (kind) {
    case 'test': drawTest(ctx, r); break;
    case 'panels': drawPanels(ctx, r); break;
    case 'alignment': drawAlignment(ctx, r); break;
    case 'bars': drawBars(ctx, r); break;
    case 'solid': drawSolid(ctx, r); break;
    default: {
      const never: never = kind;
      throw new Error('Unknown pattern kind: ' + String(never));
    }
  }
  return canvas;
}

/**
 * Render a pattern and encode it as a PNG blob (what v1 did with `canvas.toBlob` before
 * creating an object URL for the content window). DOM only — in node (or wherever
 * `renderPattern` would throw) the returned promise rejects; it never throws synchronously.
 */
export async function patternBlob(kind: PatternKind, opts: PatternOptions): Promise<Blob> {
  const canvas = renderPattern(kind, opts);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

/**
 * Display name for a generated pattern, matching v1's content-window titles
 * ('Test Pattern', 'Solid #ff0000').
 */
export function patternTitle(kind: PatternKind, opts: Pick<PatternOptions, 'color'> = {}): string {
  if (kind === 'solid') return 'Solid ' + (opts.color ?? DEFAULT_SOLID_COLOR);
  if (kind === 'test') return 'Test Pattern';
  return PATTERNS.find(p => p.id === kind)?.name ?? kind;
}
