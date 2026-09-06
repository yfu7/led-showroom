import { describe, it, expect } from 'vitest';
import {
  PATTERNS,
  RAINBOW_STOPS,
  SMPTE_BARS,
  SMPTE_REVERSE_BARS,
  SMPTE_BOTTOM,
  DEFAULT_TEST_LABEL,
  DEFAULT_SOLID_COLOR,
  testLabelFontSize,
  resolutionReadout,
  canRenderPatterns,
  renderPattern,
  patternBlob,
  patternTitle,
  resolvePatternOptions,
  type PatternKind,
} from './generators';
import { IPOSTER } from '@/engine/ledwall/specs';

describe('RAINBOW_STOPS', () => {
  it('matches the v1 gradient exactly', () => {
    expect(RAINBOW_STOPS).toEqual([
      { offset: 0, color: '#ff0000' },
      { offset: 0.17, color: '#ff8800' },
      { offset: 0.33, color: '#ffff00' },
      { offset: 0.5, color: '#00cc00' },
      { offset: 0.67, color: '#0066ff' },
      { offset: 0.83, color: '#8800ff' },
      { offset: 1, color: '#ff00ff' },
    ]);
  });

  it('is monotonic from 0 to 1', () => {
    for (let i = 1; i < RAINBOW_STOPS.length; i++) {
      expect(RAINBOW_STOPS[i].offset).toBeGreaterThan(RAINBOW_STOPS[i - 1].offset);
    }
    expect(RAINBOW_STOPS[0].offset).toBe(0);
    expect(RAINBOW_STOPS[RAINBOW_STOPS.length - 1].offset).toBe(1);
  });
});

describe('PATTERNS', () => {
  it('lists the five kinds once each with names and descriptions', () => {
    const ids = PATTERNS.map(p => p.id);
    const expected: PatternKind[] = ['test', 'panels', 'alignment', 'bars', 'solid'];
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(PATTERNS.length);
    for (const p of PATTERNS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe('SMPTE tables', () => {
  it('has seven bars and seven reverse bars', () => {
    expect(SMPTE_BARS).toHaveLength(7);
    expect(SMPTE_REVERSE_BARS).toHaveLength(7);
    expect(SMPTE_BARS[0]).toBe('#c0c0c0');
    expect(SMPTE_BARS[6]).toBe('#0000c0');
    // reverse bars: blue under grey, grey under blue
    expect(SMPTE_REVERSE_BARS[0]).toBe('#0000c0');
    expect(SMPTE_REVERSE_BARS[6]).toBe('#c0c0c0');
  });

  it('bottom strip widths sum to 7 bar-widths', () => {
    const total = SMPTE_BOTTOM.reduce((s, b) => s + b.width, 0);
    expect(total).toBeCloseTo(7, 9);
  });
});

describe('pure helpers', () => {
  it('testLabelFontSize clamps 8 % of height to 24..60', () => {
    expect(testLabelFontSize(100)).toBe(24); // 8 -> clamp
    expect(testLabelFontSize(500)).toBe(40);
    expect(testLabelFontSize(774)).toBe(60); // 61.9 -> clamp
    expect(testLabelFontSize(5000)).toBe(60);
  });

  it('resolutionReadout formats like v1', () => {
    expect(resolutionReadout(1032, 774, 3, 3)).toBe('1032 x 774 px  (3x3)');
  });

  it('defaults match v1', () => {
    expect(DEFAULT_TEST_LABEL).toBe('LED WALL TEST');
    expect(DEFAULT_SOLID_COLOR).toBe('#ffffff');
  });

  it('patternTitle matches v1 window titles', () => {
    expect(patternTitle('test')).toBe('Test Pattern');
    expect(patternTitle('solid', { color: '#ff0000' })).toBe('Solid #ff0000');
    expect(patternTitle('bars')).toBe('Colour bars');
  });
});

describe('resolvePatternOptions', () => {
  it('rounds sizes to integers >= 1 and applies v1 defaults', () => {
    const r = resolvePatternOptions({ wPx: 1031.6, hPx: 0.2, cols: 2.4, rows: 0 });
    expect(r.w).toBe(1032);
    expect(r.h).toBe(1);
    expect(r.cols).toBe(2);
    expect(r.rows).toBe(1);
    expect(r.pw).toBe(IPOSTER.pxW);
    expect(r.ph).toBe(IPOSTER.pxH);
    expect(r.color).toBe(DEFAULT_SOLID_COLOR);
    expect(r.label).toBe(DEFAULT_TEST_LABEL);
  });

  it('neutralises NaN / Infinity instead of leaking them into the canvas size or readout', () => {
    const r = resolvePatternOptions({
      wPx: NaN, hPx: Infinity, panelPxW: NaN, panelPxH: -Infinity, cols: NaN, rows: NaN,
    });
    expect(r).toMatchObject({ w: 1, h: 1, pw: IPOSTER.pxW, ph: IPOSTER.pxH, cols: 1, rows: 1 });
    for (const v of [r.w, r.h, r.pw, r.ph, r.cols, r.rows]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
    }
    expect(resolutionReadout(r.w, r.h, r.cols, r.rows)).not.toMatch(/NaN|Infinity/);
  });

  it('keeps the declared cols/rows as the panels grid even when wPx is not cols*panelPxW', () => {
    // 'panels' now loops over r.cols x r.rows, so a rounded/scaled wPx does not change the grid.
    const r = resolvePatternOptions({ wPx: 1000, hPx: 700, panelPxW: 344, panelPxH: 258, cols: 3, rows: 3 });
    expect(r.cols).toBe(3);
    expect(r.rows).toBe(3);
    expect(Math.ceil(r.w / r.pw)).toBe(3); // would still agree here...
    const r2 = resolvePatternOptions({ wPx: 1100, hPx: 800, panelPxW: 344, panelPxH: 258, cols: 3, rows: 3 });
    expect(Math.ceil(r2.w / r2.pw)).toBe(4); // ...but not here; the declared 3 wins
    expect(r2.cols).toBe(3);
  });
});

describe('renderPattern / patternBlob (DOM only)', () => {
  it('canRenderPatterns is false without a usable 2D context', () => {
    // Plain node has no `document`; jsdom without the optional `canvas` package returns a
    // null context. In both cases the guard must say false so renderPattern's error is consistent.
    const hasCtx = (() => {
      try {
        return typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d');
      } catch { return false; }
    })();
    expect(canRenderPatterns()).toBe(hasCtx);
  });

  it('renderPattern throws a clear error when no canvas is available', () => {
    if (canRenderPatterns()) return; // running under a real canvas: skip
    expect(() => renderPattern('test', { wPx: 344, hPx: 258, cols: 1, rows: 1 })).toThrow(/DOM canvas/);
  });

  it('patternBlob rejects rather than throwing synchronously', async () => {
    if (canRenderPatterns()) return; // running under a real canvas: skip
    let p: Promise<Blob> | undefined;
    expect(() => { p = patternBlob('solid', { wPx: 344, hPx: 258, cols: 1, rows: 1 }); }).not.toThrow();
    await expect(p).rejects.toThrow(/DOM canvas/);
  });
});
