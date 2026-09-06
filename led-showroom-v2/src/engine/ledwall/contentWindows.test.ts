import { describe, it, expect } from 'vitest';
import type { ContentWindow } from '../document/types';
import { wallDims, type WallDims } from './layout';
import {
  ALIGN_KEYS, activeAlign, alignRect, canReorderWindow, clampWindowRect, defaultWindowRect, dragRect, lockedAspectRatio,
  promoteToCustomRect, pxToUnit, rectCoverage, rectInches, reorderWindows, setRectField, spanInfo, unitStep, unitToPx,
  windowAtPixel,
} from './contentWindows';

/** Real WallDims for an iPoster wall with bezels, so tsc validates the shape this module reads. */
function dims(cols: number, rows: number): WallDims {
  return wallDims({ cols, rows, bezels: true, product: 'iposter' });
}

function win(partial: Partial<ContentWindow>): ContentWindow {
  return {
    id: partial.id ?? 'cw_1',
    name: 'Window',
    mode: partial.mode ?? 'custom',
    rect: partial.rect ?? { x: 0, y: 0, w: 10, h: 10 },
    source: null,
    aspectLock: false,
    visible: partial.visible ?? true,
    opacity: 1,
  };
}

const D = dims(5, 5); // 1720 x 1290 px

describe('clampWindowRect', () => {
  it('forces fill/scaled to the full wall', () => {
    expect(clampWindowRect({ x: 5, y: 5, w: 10, h: 10 }, 'fill', D)).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
    expect(clampWindowRect({ x: 5, y: 5, w: 10, h: 10 }, 'scaled', D)).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
  });
  it('caps custom size at the wall and moves it inside', () => {
    expect(clampWindowRect({ x: 1700, y: 1280, w: 100, h: 100 }, 'custom', D)).toEqual({ x: 1620, y: 1190, w: 100, h: 100 });
    expect(clampWindowRect({ x: -5, y: -5, w: 5000, h: 5000 }, 'custom', D)).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
  });
  it('treats a zero size as the full wall (v1 `|| wallWPx`)', () => {
    expect(clampWindowRect({ x: 0, y: 0, w: 0, h: 0 }, 'custom', D)).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
  });
  it('does not mutate its input', () => {
    const r = { x: 1700, y: 0, w: 100, h: 100 };
    clampWindowRect(r, 'custom', D);
    expect(r).toEqual({ x: 1700, y: 0, w: 100, h: 100 });
  });
});

describe('defaultWindowRect', () => {
  it('first window fills the wall', () => {
    expect(defaultWindowRect(0, D)).toEqual({ mode: 'fill', rect: { x: 0, y: 0, w: 1720, h: 1290 } });
  });
  it('later windows are custom 50% x 50% centred, rounded', () => {
    const d3 = dims(3, 3); // 1032 x 774 -> 25% = 258 / 193.5 -> 194
    expect(defaultWindowRect(1, d3)).toEqual({ mode: 'custom', rect: { x: 258, y: 194, w: 516, h: 387 } });
    expect(defaultWindowRect(7, D)).toEqual({ mode: 'custom', rect: { x: 430, y: 323, w: 860, h: 645 } });
  });
});

describe('unit conversions', () => {
  it('px rounds', () => {
    expect(pxToUnit(12.6, 'x', 'px', D)).toBe(13);
    expect(unitToPx(12.4, 'y', 'px', D)).toBe(12);
  });
  it('panels use the panel pixel size per axis with 2 decimals', () => {
    expect(pxToUnit(344, 'x', 'panels', D)).toBe(1);
    expect(pxToUnit(258, 'y', 'panels', D)).toBe(1);
    expect(pxToUnit(100, 'x', 'panels', D)).toBe(0.29);
    expect(unitToPx(1.5, 'x', 'panels', D)).toBe(516);
    expect(unitToPx(0.25, 'y', 'panels', D)).toBe(65); // 64.5 rounds up
  });
  it('pct is relative to the wall size with 1 decimal', () => {
    expect(pxToUnit(860, 'x', 'pct', D)).toBe(50);
    expect(pxToUnit(645, 'y', 'pct', D)).toBe(50);
    expect(pxToUnit(100, 'x', 'pct', D)).toBe(5.8);
    expect(unitToPx(50, 'x', 'pct', D)).toBe(860);
    expect(unitToPx(25, 'y', 'pct', D)).toBe(323); // 322.5 rounds up
  });
  it('round-trips whole panels', () => {
    expect(unitToPx(pxToUnit(688, 'x', 'panels', D), 'x', 'panels', D)).toBe(688);
    expect(unitToPx(pxToUnit(688, 'x', 'pct', D), 'x', 'pct', D)).toBe(688);
  });
  it('handles a degenerate wall for pct', () => {
    expect(pxToUnit(10, 'x', 'pct', dims(0, 0))).toBe(0);
  });
});

describe('unitStep', () => {
  it('matches v1 input steps', () => {
    expect(unitStep('px')).toBe(1);
    expect(unitStep('panels')).toBe(0.25);
    expect(unitStep('pct')).toBe(1);
  });
});

describe('setRectField', () => {
  const r = { x: 100, y: 100, w: 400, h: 200 }; // ratio 2
  it('sets a field and clamps to the wall', () => {
    expect(setRectField(r, 'w', 500, D, false)).toEqual({ x: 100, y: 100, w: 500, h: 200 });
    expect(setRectField(r, 'x', 5000, D, false)).toEqual({ x: 1320, y: 100, w: 400, h: 200 });
    expect(setRectField(r, 'y', -20, D, false)).toEqual({ x: 100, y: 0, w: 400, h: 200 });
    expect(setRectField(r, 'h', 5000, D, false)).toEqual({ x: 100, y: 0, w: 400, h: 1290 });
  });
  it('never lets w/h drop below 1 and falls back for non-finite values', () => {
    expect(setRectField(r, 'w', 0, D, false).w).toBe(1);
    expect(setRectField(r, 'w', NaN, D, false).w).toBe(1);
    expect(setRectField(r, 'x', NaN, D, false).x).toBe(0);
  });
  it('aspect lock: width drives height', () => {
    expect(setRectField(r, 'w', 800, D, true)).toEqual({ x: 100, y: 100, w: 800, h: 400 });
  });
  it('aspect lock: height drives width', () => {
    expect(setRectField(r, 'h', 300, D, true)).toEqual({ x: 100, y: 100, w: 600, h: 300 });
  });
  it('aspect lock: clamps the derived dimension and re-derives the driver', () => {
    // w=1720 -> h=860 fits; h=2000 -> h clamped to 1290 -> w=2580 -> clamped 1720 -> h=860
    expect(setRectField(r, 'h', 2000, D, true)).toEqual({ x: 0, y: 100, w: 1720, h: 860 });
  });
  it('aspect lock does not affect x/y edits', () => {
    expect(setRectField(r, 'x', 50, D, true)).toEqual({ x: 50, y: 100, w: 400, h: 200 });
  });
  it('aspect lock with a zero-height rect uses ratio 1', () => {
    expect(setRectField({ x: 0, y: 0, w: 10, h: 0 }, 'w', 50, D, true)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
  });
  it('an explicit lockedRatio overrides the rect\'s own ratio', () => {
    // rect is 2:1 but the user locked at 16:9
    expect(setRectField(r, 'w', 320, D, true, 16 / 9)).toEqual({ x: 100, y: 100, w: 320, h: 180 });
    expect(setRectField(r, 'h', 180, D, true, 16 / 9)).toEqual({ x: 100, y: 100, w: 320, h: 180 });
  });
  it('a frozen lockedRatio does not drift across many rounded edits (v1 cwLockedRatio)', () => {
    const locked = lockedAspectRatio({ x: 0, y: 0, w: 320, h: 180 });
    expect(locked).toBeCloseTo(16 / 9, 12);
    // 30 width edits ending back at 320 px.
    const widths = [505, 370, 362, 358, 413, 671, 303, 655, 355, 390, 411, 617, 463, 517, 660,
      479, 373, 472, 636, 433, 401, 540, 343, 685, 524, 628, 531, 307, 593, 320];
    let frozen = { x: 0, y: 0, w: 320, h: 180 };
    let drifting = { x: 0, y: 0, w: 320, h: 180 };
    for (const w of widths) {
      frozen = setRectField(frozen, 'w', w, D, true, locked);
      drifting = setRectField(drifting, 'w', w, D, true); // fallback: re-derives from the rounded rect
    }
    expect(frozen).toEqual({ x: 0, y: 0, w: 320, h: 180 });
    // Demonstrates why the frozen ratio matters: the fallback compounds rounding error.
    expect(drifting).toEqual({ x: 0, y: 0, w: 320, h: 179 });
  });
  it('a frozen lockedRatio survives a wall shrink that clamps the rect', () => {
    const locked2to1 = lockedAspectRatio({ x: 0, y: 0, w: 1720, h: 860 });
    expect(locked2to1).toBe(2);
    // Shrink the wall from 5x5 to 2x5: clampWindowRect squashes the rect to 688x860 (ratio 0.8).
    const small = dims(2, 5);
    const clamped = clampWindowRect({ x: 0, y: 0, w: 1720, h: 860 }, 'custom', small);
    expect(clamped).toEqual({ x: 0, y: 0, w: 688, h: 860 });
    // The user's 2:1 lock still wins over the accidental clamped ratio.
    expect(setRectField(clamped, 'w', 400, small, true, locked2to1)).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    // Without the frozen ratio the lock would enforce 0.8 instead.
    expect(setRectField(clamped, 'w', 400, small, true)).toEqual({ x: 0, y: 0, w: 400, h: 500 });
  });
  it('a non-finite lockedRatio falls back to the rect ratio', () => {
    expect(setRectField(r, 'w', 800, D, true, NaN)).toEqual({ x: 100, y: 100, w: 800, h: 400 });
  });
});

describe('lockedAspectRatio', () => {
  it('captures w/h, or 1 when the rect has no height (v1 lock toggle)', () => {
    expect(lockedAspectRatio({ x: 0, y: 0, w: 400, h: 200 })).toBe(2);
    expect(lockedAspectRatio({ x: 0, y: 0, w: 400, h: 0 })).toBe(1);
    expect(lockedAspectRatio({ x: 0, y: 0, w: 0, h: 10 })).toBe(0);
  });
});

describe('alignRect / activeAlign', () => {
  const r = { x: 7, y: 9, w: 400, h: 200 };
  it('exposes the nine keys in grid order', () => {
    expect(ALIGN_KEYS).toEqual(['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']);
  });
  it('places the rect at every position without resizing', () => {
    expect(alignRect(r, D, 'tl')).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    expect(alignRect(r, D, 'mc')).toEqual({ x: 660, y: 545, w: 400, h: 200 });
    expect(alignRect(r, D, 'br')).toEqual({ x: 1320, y: 1090, w: 400, h: 200 });
    expect(alignRect(r, D, 'tr')).toEqual({ x: 1320, y: 0, w: 400, h: 200 });
    expect(alignRect(r, D, 'bl')).toEqual({ x: 0, y: 1090, w: 400, h: 200 });
    expect(alignRect(r, D, 'ml')).toEqual({ x: 0, y: 545, w: 400, h: 200 });
    expect(alignRect(r, D, 'mr')).toEqual({ x: 1320, y: 545, w: 400, h: 200 });
    expect(alignRect(r, D, 'tc')).toEqual({ x: 660, y: 0, w: 400, h: 200 });
    expect(alignRect(r, D, 'bc')).toEqual({ x: 660, y: 1090, w: 400, h: 200 });
  });
  it('rounds the centre position', () => {
    const odd = { x: 0, y: 0, w: 401, h: 201 }; // (1720-401)/2 = 659.5 -> 660; (1290-201)/2 = 544.5 -> 545
    expect(alignRect(odd, D, 'mc')).toEqual({ x: 660, y: 545, w: 401, h: 201 });
  });
  it('detects every aligned position (round-trip)', () => {
    for (const k of ALIGN_KEYS) expect(activeAlign(alignRect(r, D, k), D)).toBe(k);
  });
  it('returns null when off-grid or only one axis matches', () => {
    expect(activeAlign(r, D)).toBeNull();
    expect(activeAlign({ x: 0, y: 9, w: 400, h: 200 }, D)).toBeNull();
    expect(activeAlign({ x: 7, y: 0, w: 400, h: 200 }, D)).toBeNull();
  });
  it('tolerates +-1 px at the centre', () => {
    expect(activeAlign({ x: 661, y: 544, w: 400, h: 200 }, D)).toBe('mc');
    expect(activeAlign({ x: 662, y: 545, w: 400, h: 200 }, D)).toBeNull();
  });
  it('a full-wall rect reads as top-left (edges are tested before the centre, as v1)', () => {
    expect(activeAlign({ x: 0, y: 0, w: 1720, h: 1290 }, D)).toBe('tl');
  });
});

describe('windowAtPixel', () => {
  const a = win({ id: 'a', rect: { x: 0, y: 0, w: 100, h: 100 } });
  const b = win({ id: 'b', rect: { x: 50, y: 50, w: 100, h: 100 } });
  const hidden = win({ id: 'h', rect: { x: 0, y: 0, w: 500, h: 500 }, visible: false });
  it('returns the top-most (later) window in the overlap', () => {
    expect(windowAtPixel([a, b], 75, 75)?.id).toBe('b');
    expect(windowAtPixel([b, a], 75, 75)?.id).toBe('a');
  });
  it('uses half-open bounds', () => {
    expect(windowAtPixel([a], 0, 0)?.id).toBe('a');
    expect(windowAtPixel([a], 99, 99)?.id).toBe('a');
    expect(windowAtPixel([a], 100, 50)).toBeNull();
    expect(windowAtPixel([a], 50, 100)).toBeNull();
  });
  it('returns null when nothing is hit and skips hidden windows', () => {
    expect(windowAtPixel([], 10, 10)).toBeNull();
    expect(windowAtPixel([a, b], 400, 400)).toBeNull();
    expect(windowAtPixel([a, hidden], 300, 300)).toBeNull();
    expect(windowAtPixel([a, hidden], 10, 10)?.id).toBe('a');
  });
});

describe('rectInches / rectCoverage', () => {
  it('converts pixels to inches per axis', () => {
    // Square pixels: one panel across = 25.2 in (640.08 mm), one down = 18.9 in (480.06 mm).
    const r = rectInches({ x: 344, y: 258, w: 688, h: 516 }, D);
    expect(r.x).toBeCloseTo(25.2, 9);
    expect(r.y).toBeCloseTo(18.9, 9);
    expect(r.w).toBeCloseTo(50.4, 9);
    expect(r.h).toBeCloseTo(37.8, 9);
  });
  it('coverage is the area fraction, clamped to 0..1', () => {
    expect(rectCoverage({ x: 0, y: 0, w: 1720, h: 1290 }, D)).toBe(1);
    expect(rectCoverage({ x: 0, y: 0, w: 860, h: 645 }, D)).toBeCloseTo(0.25, 9);
    expect(rectCoverage({ x: 0, y: 0, w: 0, h: 100 }, D)).toBe(0);
    expect(rectCoverage({ x: 0, y: 0, w: 9999, h: 9999 }, D)).toBe(1);
    expect(rectCoverage({ x: 0, y: 0, w: 10, h: 10 }, dims(0, 0))).toBe(0);
  });
});

describe('dragRect', () => {
  const r = { x: 100, y: 100, w: 400, h: 200 };
  it('moves by the delta and rounds', () => {
    expect(dragRect(r, 10.4, -20.6, D)).toEqual({ x: 110, y: 79, w: 400, h: 200 });
  });
  it('clamps to the wall on every edge', () => {
    expect(dragRect(r, -500, -500, D)).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    expect(dragRect(r, 5000, 5000, D)).toEqual({ x: 1320, y: 1090, w: 400, h: 200 });
  });
  it('does not mutate its input', () => {
    dragRect(r, 5000, 5000, D);
    expect(r).toEqual({ x: 100, y: 100, w: 400, h: 200 });
  });
});

describe('spanInfo', () => {
  it('lays walls left to right, bottom-aligned, gap ignored', () => {
    const sp = spanInfo([
      { id: 'w1', dims: dims(5, 5) },
      { id: 'w2', dims: dims(3, 2) },
      { id: 'w3', dims: dims(2, 6) },
    ]);
    expect(sp.totalWPx).toBe(1720 + 1032 + 688);
    expect(sp.maxHPx).toBe(6 * 258);
    expect(sp.walls).toEqual([
      { id: 'w1', xOffsetPx: 0, yOffsetPx: 1548 - 1290, wPx: 1720, hPx: 1290 },
      { id: 'w2', xOffsetPx: 1720, yOffsetPx: 1548 - 516, wPx: 1032, hPx: 516 },
      { id: 'w3', xOffsetPx: 2752, yOffsetPx: 0, wPx: 688, hPx: 1548 },
    ]);
  });
  it('a single wall is the whole canvas', () => {
    expect(spanInfo([{ id: 'w', dims: D }])).toEqual({
      totalWPx: 1720, maxHPx: 1290, walls: [{ id: 'w', xOffsetPx: 0, yOffsetPx: 0, wPx: 1720, hPx: 1290 }],
    });
  });
  it('handles no walls', () => {
    expect(spanInfo([])).toEqual({ totalWPx: 0, maxHPx: 0, walls: [] });
  });
});

describe('promoteToCustomRect', () => {
  it('fill/scaled become a full-wall custom rect', () => {
    const w = win({ mode: 'fill', rect: { x: 0, y: 0, w: 1720, h: 1290 } });
    const out = promoteToCustomRect(w, D);
    expect(out.mode).toBe('custom');
    expect(out.rect).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
    expect(out).not.toBe(w);
    expect(w.mode).toBe('fill');
    expect(promoteToCustomRect(win({ mode: 'scaled', rect: { x: 1, y: 2, w: 3, h: 4 } }), D).rect).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
  });
  it('an existing custom rect is kept (clamped)', () => {
    const w = win({ mode: 'custom', rect: { x: 1700, y: 10, w: 100, h: 50 } });
    expect(promoteToCustomRect(w, D).rect).toEqual({ x: 1620, y: 10, w: 100, h: 50 });
  });
});

describe('reorderWindows', () => {
  const win = (id: string): ContentWindow => ({ id, name: id, mode: 'custom', rect: { x: 0, y: 0, w: 10, h: 10 }, source: null, aspectLock: false, visible: true, opacity: 1 });
  const list = [win('a'), win('b'), win('c')];

  it('brings a window forward (later = drawn on top)', () => {
    expect(reorderWindows(list, 'a', 1).map(w => w.id)).toEqual(['b', 'a', 'c']);
  });

  it('sends a window backward', () => {
    expect(reorderWindows(list, 'c', -1).map(w => w.id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at either end, or for an unknown id', () => {
    expect(reorderWindows(list, 'c', 1)).toBe(list);
    expect(reorderWindows(list, 'a', -1)).toBe(list);
    expect(reorderWindows(list, 'zzz', 1)).toBe(list);
  });

  it('never mutates the input', () => {
    reorderWindows(list, 'a', 1);
    expect(list.map(w => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('canReorderWindow agrees with what reorderWindows will do', () => {
    expect(canReorderWindow(list, 'a', 1)).toBe(true);
    expect(canReorderWindow(list, 'a', -1)).toBe(false);
    expect(canReorderWindow(list, 'c', 1)).toBe(false);
    expect(canReorderWindow(list, 'zzz', -1)).toBe(false);
  });
});
