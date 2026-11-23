/**
 * The drawing sheet's contract: third-angle alignment, one honest scale, and no view ever landing
 * on the title block. These are the properties that make the printed sheet measurable rather than
 * decorative, so they are asserted rather than eyeballed.
 */
import { describe, expect, it } from 'vitest';
import { PAPERS, STANDARD_SCALES, pickScale, scaleBar, sheetLayout, viewExtents, viewOf } from './sheet';

const WALL = { w: 240, h: 120, d: 20 };   // a 20 ft × 10 ft wall, 20" deep
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('sheetLayout', () => {
  it('aligns the views in third angle: Top above Front, Right beside Front', () => {
    const l = sheetLayout(WALL);
    const front = viewOf(l, 'front')!, top = viewOf(l, 'top')!, right = viewOf(l, 'right')!;
    // The whole point of the convention: a width carries straight up from Front into Top, and a
    // height carries straight across into Right.
    expect(top.cx).toBe(front.cx);
    expect(right.cy).toBe(front.cy);
    expect(top.y).toBeLessThan(front.y);
    expect(right.x).toBeGreaterThan(front.x);
  });

  it('draws every to-scale view at one standard scale that fits its cell', () => {
    const l = sheetLayout(WALL);
    expect(STANDARD_SCALES).toContain(l.scaleDenom as never);
    expect(l.overflow).toBe(false);
    for (const v of l.views.filter(v => v.toScale)) {
      const e = viewExtents(WALL, v.key);
      expect(v.drawnW).toBeCloseTo(e.w * l.pxPerIn, 6);   // one pxPerIn for all of them
      expect(v.drawnH).toBeCloseTo(e.h * l.pxPerIn, 6);
      expect(v.drawnW).toBeLessThanOrEqual(v.fit.w);
      expect(v.drawnH).toBeLessThanOrEqual(v.fit.h);
    }
    // ...and the next finer scale would not have fitted, or it would have been chosen.
    const finer = STANDARD_SCALES[STANDARD_SCALES.indexOf(l.scaleDenom as never) - 1];
    if (finer) {
      const f = viewOf(l, 'front')!;
      expect(WALL.w * (l.dpi / finer) > f.fit.w || WALL.h * (l.dpi / finer) > f.fit.h).toBe(true);
    }
  });

  it('keeps the iso view off the shared scale and labels it separately', () => {
    const iso = viewOf(sheetLayout(WALL), 'iso')!;
    expect(iso.toScale).toBe(false);
    expect(iso.drawnW).toBe(0);
  });

  it('never lets a view cell reach the title block', () => {
    for (const paper of Object.keys(PAPERS) as (keyof typeof PAPERS)[]) {
      const l = sheetLayout(WALL, { paper });
      for (const v of l.views) expect(overlaps(v, l.titleBlock)).toBe(false);
      expect(l.titleBlock.y + l.titleBlock.h).toBe(l.border.y + l.border.h);
    }
  });

  it('gives the views the whole width above the title block, with no column beside them', () => {
    for (const paper of Object.keys(PAPERS) as (keyof typeof PAPERS)[]) {
      const l = sheetLayout(WALL, { paper });
      expect(l.drawingArea.w).toBe(l.border.w);
      const cells = l.views.reduce((s, v) => s + v.w * v.h, 0);
      expect(cells).toBe(l.drawingArea.w * l.drawingArea.h);
      for (const a of l.views) for (const b of l.views) if (a !== b) expect(overlaps(a, b)).toBe(false);
    }
  });

  it('moves the cell lines to draw a long, shallow build large, keeping third angle', () => {
    const run = { w: 778, h: 134, d: 54 };  // a 65 ft run of walls, 11 ft tall
    const l = sheetLayout(run);
    const front = viewOf(l, 'front')!, top = viewOf(l, 'top')!, right = viewOf(l, 'right')!;
    // Four even quarters only fit it at 1:192; widening the Front column fits 1:96.
    expect(l.scaleDenom).toBe(96);
    expect(front.w).toBeGreaterThan(right.w);
    expect(top.cx).toBe(front.cx);
    expect(right.cy).toBe(front.cy);
    for (const v of l.views.filter(v => v.toScale)) {
      expect(v.drawnW).toBeLessThanOrEqual(v.fit.w);
      expect(v.drawnH).toBeLessThanOrEqual(v.fit.h);
    }
  });

  it('keeps the even split when moving the lines buys no finer scale', () => {
    const l = sheetLayout({ w: 120, h: 120, d: 120 });
    const front = viewOf(l, 'front')!;
    expect(front.w).toBe(Math.floor(l.drawingArea.w / 2));
    expect(front.h).toBe(Math.floor(l.drawingArea.h / 2));
  });

  it('fills the sheet with one view when asked for a 1-up', () => {
    const l = sheetLayout(WALL, { views: 'front' });
    expect(l.views.map(v => v.key)).toEqual(['front']);
    expect(l.views[0].w).toBe(l.drawingArea.w);
    expect(l.views[0].h).toBe(l.drawingArea.h);
    // More room for one view means a finer scale than the four-up of the same model.
    expect(l.scaleDenom).toBeLessThanOrEqual(sheetLayout(WALL).scaleDenom);
  });

  it('scales a 1-up iso to its cell without claiming a sheet scale for it', () => {
    const l = sheetLayout(WALL, { views: 'iso' });
    expect(l.views[0].toScale).toBe(false);
    expect(STANDARD_SCALES).toContain(l.scaleDenom as never); // still a legible fallback for the block
  });

  it('reports overflow instead of inventing a scale for an absurd model', () => {
    const l = sheetLayout({ w: 12 * 12 * 5000, h: 1200, d: 1200 });
    expect(l.overflow).toBe(true);
    expect(l.scaleDenom).toBe(STANDARD_SCALES[STANDARD_SCALES.length - 1]);
  });

  it('is pure: the same box gives the same layout', () => {
    expect(sheetLayout(WALL, { dpi: 200 })).toEqual(sheetLayout(WALL, { dpi: 200 }));
  });

  it('sizes the sheet from paper and dpi', () => {
    const l = sheetLayout(WALL, { paper: 'ansi-b', dpi: 150 });
    expect([l.wPx, l.hPx]).toEqual([2550, 1650]);
  });
});

describe('viewExtents', () => {
  it('pairs the axes the way third-angle projection does', () => {
    expect(viewExtents(WALL, 'front')).toEqual({ w: 240, h: 120 }); // W × H
    expect(viewExtents(WALL, 'top')).toEqual({ w: 240, h: 20 });    // W × D
    expect(viewExtents(WALL, 'right')).toEqual({ w: 20, h: 120 });  // D × H
  });
});

describe('pickScale', () => {
  it('returns the largest standard scale at which every view fits', () => {
    // 240" across 750px of cell at 150dpi: 1:48 gives 750px exactly, 1:32 would need 1125.
    const r = pickScale([{ needW: 240, needH: 120, cellW: 750, cellH: 400 }], 150);
    expect(r.scaleDenom).toBe(48);
    expect(r.pxPerIn).toBeCloseTo(150 / 48, 9);
    expect(r.overflow).toBe(false);
  });

  it('answers to the tightest view, not the first one', () => {
    const roomy = { needW: 10, needH: 10, cellW: 1000, cellH: 1000 };
    const tight = { needW: 2400, needH: 10, cellW: 1000, cellH: 1000 };
    expect(pickScale([roomy, tight], 150).scaleDenom).toBe(pickScale([tight], 150).scaleDenom);
  });
});

describe('scaleBar', () => {
  it('measures a round number of feet that fits the space', () => {
    const b = scaleBar(150 / 48, 400);   // 400px ≈ 128 ft of room
    expect([1, 2, 5, 10, 20, 50, 100, 200]).toContain(b.feet);
    expect(b.px).toBeLessThanOrEqual(400);
    expect(b.px).toBeCloseTo(b.feet * 12 * (150 / 48), 6);
  });

  it('falls back to the smallest step rather than a zero-length bar', () => {
    // At 1:1024 even one foot is under two pixels, so nothing fits the space given: a one-foot bar
    // that slightly overruns still reads, a zero-length one does not.
    expect(scaleBar(150 / 1024, 0.1).feet).toBe(1); // not even an inch fits
  });

  it('drops to inches when a foot overruns the space, as at 1:8 in a narrow scale cell', () => {
    const pxPerIn = 150 / 8;                 // 1:8 at 150 dpi: one foot is 225 px
    const b = scaleBar(pxPerIn, 72);         // the SCALE cell's room on ANSI A
    expect(b.px).toBeLessThanOrEqual(72);
    expect(b.label).toBe('3 in');
    expect(b.feet).toBe(0.25);
    expect(scaleBar(150 / 48, 400).label).toMatch(/ ft$/);
  });
});
