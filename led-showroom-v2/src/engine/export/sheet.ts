/**
 * Drawing-sheet layout: the pure maths behind "Generate CAD".
 *
 * A drawing is not four screenshots. Three things make it read as one:
 *
 *  - **Third-angle projection** (US convention, and this app works in inches): Top sits directly
 *    above Front, Right directly to the right of Front. The invariants are `front.cx === top.cx`
 *    and `front.cy === right.cy`, which is what lets you carry a dimension from one view to the
 *    next with a straightedge.
 *  - **One scale, and a standard one.** All three orthographic views share a single ratio picked
 *    from the standard set (1:24, 1:48, 1:96…), the largest that still fits every view. The
 *    camera frustums are then derived *from* that ratio rather than zoom-to-fit, so the printed
 *    "1 : 48" and the scale bar are exact rather than approximate.
 *  - **A title strip** across the bottom, so no view can ever collide with it. The sheet goes to
 *    clients, so it carries the build's specs there and nothing of how it is put together.
 *
 * The iso view is a courtesy pictorial: its own fit, labelled NTS.
 *
 * Nothing here touches three.js, the DOM or the document — it is arithmetic on a box size.
 */

/** Sheet stock, in inches of paper. Landscape. */
export interface Paper {
  id: PaperId;
  name: string;
  wIn: number;
  hIn: number;
}

export type PaperId = 'ansi-a' | 'ansi-b' | 'a4' | 'a3';

export const PAPERS: Record<PaperId, Paper> = {
  'ansi-a': { id: 'ansi-a', name: 'ANSI A (8.5 × 11)', wIn: 11, hIn: 8.5 },
  'ansi-b': { id: 'ansi-b', name: 'ANSI B (11 × 17)', wIn: 17, hIn: 11 },
  a4: { id: 'a4', name: 'A4 (210 × 297)', wIn: 297 / 25.4, hIn: 210 / 25.4 },
  a3: { id: 'a3', name: 'A3 (297 × 420)', wIn: 420 / 25.4, hIn: 297 / 25.4 },
};

/**
 * Standard drawing-scale denominators. 1:12 is 1" = 1'-0", 1:48 is 1/4" = 1'-0", 1:96 is
 * 1/8" = 1'-0" — the ratios a shop expects to read in a title block.
 */
export const STANDARD_SCALES = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024] as const;

export type ViewKey = 'front' | 'top' | 'right' | 'iso';

/** Every view that can appear on a sheet, with its label and third-angle grid slot. */
export const VIEW_LABELS: Record<ViewKey, string> = { front: 'FRONT', top: 'TOP', right: 'RIGHT', iso: 'ISOMETRIC' };

export interface Rect { x: number; y: number; w: number; h: number }

export interface Viewport extends Rect {
  key: ViewKey;
  label: string;
  /**
   * Centre of the clear area the view is drawn in — the cell less its padding and the label strip
   * at the bottom. The third-angle invariants are stated on these, not on the cell rect.
   */
  cx: number;
  cy: number;
  /** The clear area itself, for clipping and for placing dimension lines. */
  fit: Rect;
  /** Drawn size of the object in this view, in sheet pixels (0 for `iso`, which is fitted later). */
  drawnW: number;
  drawnH: number;
  /** False for `iso`: it is fitted to its cell, not drawn to the sheet scale. */
  toScale: boolean;
}

export interface SheetLayout {
  paper: Paper;
  dpi: number;
  /** Sheet pixel size. */
  wPx: number;
  hPx: number;
  /** Border frame (inside the paper margin). */
  border: Rect;
  /** Title strip across the bottom of the border. */
  titleBlock: Rect;
  /** The area the views are laid out in. */
  drawingArea: Rect;
  views: Viewport[];
  /** Height of the label strip reserved at the bottom of every cell. */
  labelH: number;
  /** Denominator of the sheet scale: 48 means 1:48. */
  scaleDenom: number;
  /** Sheet pixels per model inch, at the sheet scale. */
  pxPerIn: number;
  /** True when even the coarsest standard scale could not fit the model (the sheet is then 1:1024). */
  overflow: boolean;
}

/** Model extents, in inches: width (x), height (y), depth (z). */
export interface Extents { w: number; h: number; d: number }

export interface SheetOptions {
  paper?: PaperId;
  dpi?: number;
  /** 'quad' is the four-up drawing; a single key fills the sheet with that one view. */
  views?: 'quad' | ViewKey;
  /** Paper margin, inches. */
  marginIn?: number;
  /** Clear space kept around a view inside its cell, inches. */
  padIn?: number;
}

/** Where the quad sheet's column and row lines may sit, as a share of the drawing area. */
const QUAD_SHARES = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75] as const;

/** Fraction of a cell a view may occupy before the next coarser scale is tried. */
const FILL = 1;

/**
 * Largest standard scale denominator at which every (needW, needH) pair of model inches fits its
 * (cellW, cellH) box of pixels. Returns the coarsest scale plus `overflow` when nothing fits.
 */
export function pickScale(
  needs: { needW: number; needH: number; cellW: number; cellH: number }[],
  dpi: number,
): { scaleDenom: number; pxPerIn: number; overflow: boolean } {
  for (const denom of STANDARD_SCALES) {
    const pxPerIn = dpi / denom;
    const fits = needs.every(n => n.needW * pxPerIn <= n.cellW * FILL && n.needH * pxPerIn <= n.cellH * FILL);
    if (fits) return { scaleDenom: denom, pxPerIn, overflow: false };
  }
  const denom = STANDARD_SCALES[STANDARD_SCALES.length - 1];
  return { scaleDenom: denom, pxPerIn: dpi / denom, overflow: true };
}

/** What each orthographic view has to fit, in model inches. Third-angle pairing of the axes. */
export function viewExtents(e: Extents, key: ViewKey): { w: number; h: number } {
  switch (key) {
    case 'front': return { w: e.w, h: e.h };     // looking along −Z: width × height
    case 'top': return { w: e.w, h: e.d };       // looking down −Y: width × depth
    case 'right': return { w: e.d, h: e.h };     // looking along −X: depth × height
    case 'iso': return { w: e.w + e.d, h: e.h + Math.max(e.w, e.d) / 2 }; // rough, it is fitted anyway
  }
}

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/**
 * Compose a sheet for a model of `extents`. Pure: same box in, same layout out.
 *
 * The title strip spans the full width at the bottom, which is both the ANSI habit and the reason
 * no view can overlap it. The views then tile the space above it: 2 × 2 for the quad sheet, one
 * cell for a 1-up.
 */
export function sheetLayout(extents: Extents, opts: SheetOptions = {}): SheetLayout {
  const paper = PAPERS[opts.paper ?? 'ansi-b'];
  const dpi = Math.max(36, Math.round(opts.dpi ?? 150));
  const wPx = Math.round(paper.wIn * dpi);
  const hPx = Math.round(paper.hIn * dpi);
  const margin = Math.round((opts.marginIn ?? 0.4) * dpi);
  const pad = Math.round((opts.padIn ?? 0.3) * dpi);

  const border = rect(margin, margin, wPx - margin * 2, hPx - margin * 2);
  // Sized to its contents (logo, label, value, graphic scale) rather than to a fraction of the
  // sheet: the rest of the paper belongs to the views.
  const stripH = Math.round(Math.min(0.92, paper.hIn * 0.12) * dpi);
  const titleBlock = rect(border.x, border.y + border.h - stripH, border.w, stripH);
  const gap = Math.round(0.12 * dpi);
  const drawingArea = rect(border.x, border.y, border.w, border.h - stripH - gap);

  const single = opts.views && opts.views !== 'quad' ? (opts.views as ViewKey) : null;
  const keys: ViewKey[] = single ? [single] : ['top', 'iso', 'front', 'right'];

  // Clear space inside a cell: the pad all round, plus a strip under the view for its label and
  // the overall dimension line that sits below it.
  const labelH = Math.round(0.42 * dpi);
  const scaled = keys.filter(k => k !== 'iso');
  const answer = (cells: Partial<Record<ViewKey, Rect>>) => pickScale((scaled.length ? scaled : (['front'] as ViewKey[])).map(k => {
    const v = viewExtents(extents, k), c = cells[k] ?? cells[keys[0]]!;
    return { needW: v.w, needH: v.h, cellW: c.w - pad * 2, cellH: c.h - pad * 2 - labelH };
  }), dpi);

  // Cells. Third angle: Top above Front (same column), Right beside Front (same row). The column
  // and row lines move with what the cells hold (Front's width against Right's depth, Top's depth
  // against Front's height), so a long, shallow build is drawn large rather than in a quarter of
  // the sheet. The split giving the finest standard scale wins; a tie goes to the evener split,
  // which keeps the iso cell roomy.
  const quad = (sc: number, sr: number): Record<ViewKey, Rect> => {
    const w0 = Math.floor(drawingArea.w * sc), h1 = Math.floor(drawingArea.h * sr);
    const x1 = drawingArea.x + w0, y1 = drawingArea.y + drawingArea.h - h1;
    return {
      top: rect(drawingArea.x, drawingArea.y, w0, y1 - drawingArea.y),
      iso: rect(x1, drawingArea.y, drawingArea.w - w0, y1 - drawingArea.y),
      front: rect(drawingArea.x, y1, w0, h1),
      right: rect(x1, y1, drawingArea.w - w0, h1),
    };
  };
  let cells: Partial<Record<ViewKey, Rect>> = single ? { [single]: { ...drawingArea } } : quad(0.5, 0.5);
  let best = answer(cells);
  if (!single) {
    let bestSkew = 0;
    for (const sc of QUAD_SHARES) for (const sr of QUAD_SHARES) {
      const c = quad(sc, sr), r = answer(c), skew = Math.abs(sc - 0.5) + Math.abs(sr - 0.5);
      if (r.scaleDenom < best.scaleDenom || (r.scaleDenom === best.scaleDenom && skew < bestSkew)) {
        cells = c; best = r; bestSkew = skew;
      }
    }
  }
  const { scaleDenom, pxPerIn, overflow } = best;

  const views: Viewport[] = keys.map(key => {
    const { x, y, w, h } = cells[key]!;
    const v = viewExtents(extents, key);
    const toScale = key !== 'iso';
    const fit = rect(x + pad, y + pad, Math.max(1, w - pad * 2), Math.max(1, h - pad * 2 - labelH));
    return {
      key, label: VIEW_LABELS[key], x, y, w, h,
      cx: fit.x + fit.w / 2, cy: fit.y + fit.h / 2, fit,
      drawnW: toScale ? v.w * pxPerIn : 0,
      drawnH: toScale ? v.h * pxPerIn : 0,
      toScale,
    };
  });

  return { paper, dpi, wPx, hPx, border, titleBlock, drawingArea, views, labelH, scaleDenom, pxPerIn, overflow };
}

/** Look a view up by key. */
export const viewOf = (layout: SheetLayout, key: ViewKey): Viewport | undefined => layout.views.find(v => v.key === key);

/**
 * A scale bar whose length is a round number: the longest of 1 to 200 ft that fits `maxPx` at the
 * sheet scale, or of 1, 2, 3 or 6 in when not even a foot fits (a fine scale in a narrow cell).
 * When nothing fits, one foot: a bar that overruns a little still reads, a zero-length one does not.
 */
export function scaleBar(pxPerIn: number, maxPx: number): { feet: number; px: number; ticks: number; label: string } {
  const feetSteps = [1, 2, 5, 10, 20, 50, 100, 200];
  const inchSteps = [6, 3, 2, 1];
  let feet = 0;
  for (const s of feetSteps) if (s * 12 * pxPerIn <= maxPx) feet = s;
  if (!feet) {
    const inches = inchSteps.find(s => s * pxPerIn <= maxPx);
    if (inches) return { feet: inches / 12, px: inches * pxPerIn, ticks: inches === 1 ? 2 : inches, label: `${inches} in` };
    feet = 1;
  }
  return { feet, px: feet * 12 * pxPerIn, ticks: feet <= 2 ? feet * 2 : 4, label: `${feet} ft` };
}
