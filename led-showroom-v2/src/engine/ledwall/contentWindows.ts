/**
 * Content-window geometry: the pure maths behind the "Content Windows" inspector panel and
 * the on-wall content drag. Every rect here is in **wall pixels** (origin top-left, y down),
 * see `PxRect` in the document schema. Nothing in this module touches three.js or the DOM.
 *
 * Ported from v1 (`index.html`):
 *  - clampWindowRect            → v1 4646-4656
 *  - defaultWindowRect          → v1 5566-5586 (addContentWindow)
 *  - pxToUnit / unitToPx / step → v1 6266-6300
 *  - lockedAspectRatio          → v1 6300-6308 (cwLockedRatio captured at lock toggle)
 *  - setRectField (aspect lock) → v1 6310-6360
 *  - alignRect / activeAlign    → v1 6362-6398 ('cw-align' handlers + highlightActiveAlign)
 *  - windowAtPixel              → v1 5812-5821
 *  - spanInfo                   → v1 5743-5752 (getSpanInfo) + 4754-4762 (per-wall slice mapping)
 *  - dragRect                   → v1 8046-8070 (content drag mousemove)
 */
import type { ContentFitMode, ContentWindow, PxRect } from '../document/types';
import type { WallDims } from './layout';

/** Unit the content-window inputs are shown in: raw wall pixels, panel counts, or percent of the wall. */
export type CwUnit = 'px' | 'panels' | 'pct';

/** The nine quick-align positions: row (t/m/b) + column (l/c/r). */
export type AlignKey = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';

/** All quick-align keys in reading order (matches the 3x3 button grid, top-left to bottom-right). */
export const ALIGN_KEYS: readonly AlignKey[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];

/** Full-wall rect for `dims`. */
function fullRect(dims: WallDims): PxRect {
  return { x: 0, y: 0, w: dims.wallWPx, h: dims.wallHPx };
}

/** Pixel size of a single panel along an axis. */
function panelPx(axis: 'x' | 'y', dims: WallDims): number {
  return axis === 'x' ? dims.spec.pxW : dims.spec.pxH;
}

/** Wall pixel size along an axis. */
function wallPx(axis: 'x' | 'y', dims: WallDims): number {
  return axis === 'x' ? dims.wallWPx : dims.wallHPx;
}

/**
 * Clamp a window rect to the wall (v1 `clampWindowRect`, 4646-4656). Returns a new rect;
 * the input is not mutated.
 *
 *  - `fill` / `scaled` windows always cover the whole wall.
 *  - `custom` windows keep their size (a zero/missing width or height falls back to the full
 *    wall, as in v1), are capped at the wall size, and are moved back inside the wall.
 */
export function clampWindowRect(rect: PxRect, mode: ContentFitMode, dims: WallDims): PxRect {
  if (mode === 'fill' || mode === 'scaled') return fullRect(dims);
  const w = Math.min(rect.w || dims.wallWPx, dims.wallWPx);
  const h = Math.min(rect.h || dims.wallHPx, dims.wallHPx);
  const x = Math.max(0, Math.min(rect.x || 0, dims.wallWPx - w));
  const y = Math.max(0, Math.min(rect.y || 0, dims.wallHPx - h));
  return { x, y, w, h };
}

/**
 * Mode and rect for a newly added window (v1 `addContentWindow`, 5566-5586).
 * The first window (`index === 0`) fills the wall; every later window is a custom rect,
 * 50 % x 50 % of the wall, centred (values rounded to whole pixels).
 */
export function defaultWindowRect(index: number, dims: WallDims): { mode: ContentFitMode; rect: PxRect } {
  if (index <= 0) return { mode: 'fill', rect: fullRect(dims) };
  return {
    mode: 'custom',
    rect: {
      x: Math.round(dims.wallWPx * 0.25),
      y: Math.round(dims.wallHPx * 0.25),
      w: Math.round(dims.wallWPx * 0.5),
      h: Math.round(dims.wallHPx * 0.5),
    },
  };
}

/**
 * Convert wall pixels to the display unit (v1 `pxToUnit`, 6266-6272):
 * px → whole pixels, panels → 2 decimals, pct → 1 decimal (percent of the wall along `axis`).
 */
export function pxToUnit(px: number, axis: 'x' | 'y', unit: CwUnit, dims: WallDims): number {
  if (unit === 'px') return Math.round(px);
  if (unit === 'panels') return +(px / panelPx(axis, dims)).toFixed(2);
  const wall = wallPx(axis, dims);
  return wall > 0 ? +((px / wall) * 100).toFixed(1) : 0;
}

/**
 * Convert a value in the display unit back to whole wall pixels (v1 `unitToPx`, 6274-6280).
 */
export function unitToPx(val: number, axis: 'x' | 'y', unit: CwUnit, dims: WallDims): number {
  if (unit === 'px') return Math.round(val);
  if (unit === 'panels') return Math.round(val * panelPx(axis, dims));
  return Math.round((val / 100) * wallPx(axis, dims));
}

/** Input step for a unit (v1 `syncCwInputs`, 6289): 1 px, 0.25 panel, 1 %. */
export function unitStep(unit: CwUnit): number {
  return unit === 'panels' ? 0.25 : 1;
}

/**
 * The w/h ratio to freeze when the user toggles the aspect lock ON (v1 6300-6308):
 * `rect.w / rect.h`, or 1 for a rect with no height. The caller stores this in UI state and
 * passes it to {@link setRectField} on every subsequent edit while the lock is active.
 */
export function lockedAspectRatio(rect: PxRect): number {
  return rect.h > 0 ? rect.w / rect.h : 1;
}

/**
 * Apply an edit of one rect field (value already in wall pixels) and return the clamped rect
 * (v1 input `change` handlers, 6319-6360).
 *
 * With `aspectLock` on, width drives height and height drives width using `lockedRatio`
 * (w/h). v1 froze that ratio when the lock was toggled on (`cwLockedRatio`) so the lock
 * "always reflects the user's chosen proportions": the caller captures it with
 * {@link lockedAspectRatio} at toggle time and passes it on every edit. This matters because
 * each locked edit rounds w and h to whole pixels, so the rect's own ratio drifts away from
 * the locked one (and compounds), and a wall resize (`clampWindowRect`) can change the rect's
 * ratio outright. When `lockedRatio` is omitted the rect's current ratio is used as a
 * fallback (equivalent to toggling the lock on right before the edit).
 *
 * After the lock step, w/h are clamped to [1, wall] and x/y to keep the rect inside the wall.
 * Non-finite values fall back to 1 px (w/h) or 0 (x/y), as `parseFloat(...) || 1` / `|| 0`
 * did in v1.
 */
export function setRectField(
  rect: PxRect,
  field: 'x' | 'y' | 'w' | 'h',
  valuePx: number,
  dims: WallDims,
  aspectLock: boolean,
  lockedRatio?: number,
): PxRect {
  const { wallWPx, wallHPx } = dims;
  const v = Number.isFinite(valuePx) ? valuePx : (field === 'w' || field === 'h' ? 1 : 0);
  let nw = field === 'w' ? v : rect.w;
  let nh = field === 'h' ? v : rect.h;
  let nx = field === 'x' ? v : rect.x;
  let ny = field === 'y' ? v : rect.y;

  const ratio = lockedRatio !== undefined && Number.isFinite(lockedRatio) ? lockedRatio : lockedAspectRatio(rect); // w / h
  if (aspectLock && ratio > 0) {
    if (field === 'w') {
      nw = Math.max(1, Math.min(nw, wallWPx));
      nh = Math.round(nw / ratio);
      nh = Math.max(1, Math.min(nh, wallHPx));
      nw = Math.round(nh * ratio); // re-derive to stay exact
    } else if (field === 'h') {
      nh = Math.max(1, Math.min(nh, wallHPx));
      nw = Math.round(nh * ratio);
      nw = Math.max(1, Math.min(nw, wallWPx));
      nh = Math.round(nw / ratio);
    }
  }

  nw = Math.max(1, Math.min(nw, wallWPx));
  nh = Math.max(1, Math.min(nh, wallHPx));
  nx = Math.max(0, Math.min(nx, wallWPx - nw));
  ny = Math.max(0, Math.min(ny, wallHPx - nh));
  return { x: nx, y: ny, w: nw, h: nh };
}

/**
 * Snap a rect to one of the nine quick-align positions, keeping its size
 * (v1 '.cw-align-btn' click handler, 6362-6378). Centre positions are rounded.
 */
export function alignRect(rect: PxRect, dims: WallDims, key: AlignKey): PxRect {
  const { wallWPx, wallHPx } = dims;
  const xMap: Record<string, number> = { l: 0, c: Math.round((wallWPx - rect.w) / 2), r: wallWPx - rect.w };
  const yMap: Record<string, number> = { t: 0, m: Math.round((wallHPx - rect.h) / 2), b: wallHPx - rect.h };
  return { x: xMap[key[1]]!, y: yMap[key[0]]!, w: rect.w, h: rect.h };
}

/**
 * Which quick-align button should light up for `rect`, or null when the rect is not on any
 * of the nine positions (v1 `highlightActiveAlign`, 6380-6398). Edges must match exactly;
 * the centre tolerates +-1 px of rounding. Edges are tested before the centre, so a rect as
 * wide as the wall reads as "left" (and as tall as the wall reads as "top"), exactly as v1.
 */
export function activeAlign(rect: PxRect, dims: WallDims): AlignKey | null {
  const { wallWPx, wallHPx } = dims;
  const { x: cx, y: cy, w: cw, h: ch } = rect;
  let col = '';
  let row = '';
  if (cx === 0) col = 'l';
  else if (cx === wallWPx - cw) col = 'r';
  else if (Math.abs(cx - Math.round((wallWPx - cw) / 2)) <= 1) col = 'c';

  if (cy === 0) row = 't';
  else if (cy === wallHPx - ch) row = 'b';
  else if (Math.abs(cy - Math.round((wallHPx - ch) / 2)) <= 1) row = 'm';

  if (!row || !col) return null;
  return (row + col) as AlignKey;
}

/**
 * Top-most window under a wall pixel (v1 `windowAtPixel`, 5812-5821). Later windows in the
 * array render on top, so the array is walked back to front. Bounds are half-open
 * (`x <= px < x + w`). Hidden windows (`visible === false`) are skipped — v1 had no
 * visibility flag, so this is the only addition.
 */
export function windowAtPixel(windows: readonly ContentWindow[], px: number, py: number): ContentWindow | null {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i]!;
    if (w.visible === false) continue;
    const r = w.rect;
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return w;
  }
  return null;
}

/** A rect converted to inches, measured from the wall's top-left corner (y down). */
export function rectInches(rect: PxRect, dims: WallDims): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.x * dims.inPerPxX,
    y: rect.y * dims.inPerPxY,
    w: rect.w * dims.inPerPxX,
    h: rect.h * dims.inPerPxY,
  };
}

/** Fraction of the wall's pixel area the rect covers, 0..1 (0 for a degenerate wall). */
export function rectCoverage(rect: PxRect, dims: WallDims): number {
  const area = dims.wallWPx * dims.wallHPx;
  if (!(area > 0)) return 0;
  const cover = (Math.max(0, rect.w) * Math.max(0, rect.h)) / area;
  return Math.min(1, Math.max(0, cover));
}

/**
 * Move a rect by a pixel delta, keeping it inside the wall (v1 content-drag mousemove,
 * 8046-8070). The clamped position is rounded to whole pixels; size is unchanged.
 */
export function dragRect(rect: PxRect, dxPx: number, dyPx: number, dims: WallDims): PxRect {
  const nx = Math.max(0, Math.min(rect.x + dxPx, dims.wallWPx - rect.w));
  const ny = Math.max(0, Math.min(rect.y + dyPx, dims.wallHPx - rect.h));
  return { x: Math.round(nx), y: Math.round(ny), w: rect.w, h: rect.h };
}

/** One wall's slice of the combined span canvas (see `spanInfo`). */
export interface SpanWallSlice {
  id: string;
  /** Horizontal offset of this wall's slice in the combined canvas (walls placed left to right). */
  xOffsetPx: number;
  /** Vertical offset: `maxHPx - hPx`, i.e. walls are bottom-aligned on the canvas. */
  yOffsetPx: number;
  wPx: number;
  hPx: number;
}

/**
 * The "span content" pixel model: all walls treated as one contiguous canvas.
 * `totalWPx` is the sum of wall widths, `maxHPx` the tallest wall; each wall shows the
 * `[xOffsetPx, yOffsetPx, wPx, hPx]` slice of a canvas of that size.
 */
export interface SpanInfo {
  totalWPx: number;
  maxHPx: number;
  walls: SpanWallSlice[];
}

/**
 * Build the span pixel model for a list of walls in document order (v1 `getSpanInfo`,
 * 5743-5752, plus the per-wall slice mapping in `applyAllWindowRects`, 4754-4762).
 * Walls are laid side by side left to right with no gap (the physical gap between walls is
 * ignored, as in v1) and bottom-aligned, so a shorter wall is offset down by
 * `maxHPx - hPx` and shows the bottom part of the shared canvas.
 */
export function spanInfo(walls: readonly { id: string; dims: WallDims }[]): SpanInfo {
  let totalWPx = 0;
  let maxHPx = 0;
  const slices: SpanWallSlice[] = [];
  for (const wall of walls) {
    const wPx = wall.dims.wallWPx;
    const hPx = wall.dims.wallHPx;
    slices.push({ id: wall.id, xOffsetPx: totalWPx, yOffsetPx: 0, wPx, hPx });
    totalWPx += wPx;
    maxHPx = Math.max(maxHPx, hPx);
  }
  for (const s of slices) s.yOffsetPx = maxHPx - s.hPx;
  return { totalWPx, maxHPx, walls: slices };
}

/**
 * Switch a window to `custom` mode. A `fill`/`scaled` window becomes a custom rect that still
 * covers the whole wall (so nothing visibly moves); a window already in `custom` mode keeps
 * its rect, clamped to the wall. Returns a new window object; the input is not mutated.
 */
export function promoteToCustomRect(window: ContentWindow, dims: WallDims): ContentWindow {
  const rect = window.mode === 'custom' ? clampWindowRect(window.rect, 'custom', dims) : fullRect(dims);
  return { ...window, mode: 'custom', rect };
}

/**
 * Move one window within the draw order. Later windows are drawn on top, so "bring forward" is
 * `+1` (toward the end of the list) and "send backward" is `-1`. Returns the same array reference
 * when the window is missing or already at that end, so callers can skip a no-op command.
 */
export function reorderWindows(windows: readonly ContentWindow[], id: string, dir: 1 | -1): ContentWindow[] {
  const from = windows.findIndex(w => w.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= windows.length) return windows as ContentWindow[];
  const out = windows.slice();
  const [w] = out.splice(from, 1);
  out.splice(to, 0, w);
  return out;
}

/** True when `id` can still move in that direction (drives the disabled state of the menu items). */
export function canReorderWindow(windows: readonly ContentWindow[], id: string, dir: 1 | -1): boolean {
  const from = windows.findIndex(w => w.id === id);
  return from >= 0 && from + dir >= 0 && from + dir < windows.length;
}
