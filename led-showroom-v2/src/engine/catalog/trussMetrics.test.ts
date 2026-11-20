import { describe, expect, it } from 'vitest';
import {
  BASE_PLATE_THICK_IN, CHORD_OD_IN, DIAGONAL_OD_IN, GP_BASE_PLATE_IN, GP_SECTION_IN, braceNodesAlong,
  chordOffsetIn, chordOffsets, chordRadiusIn, clampFitsChord, clampMetrics, clearOfBraceNodes,
  diagonalRadiusIn, trussBaseProfile,
} from './trussMetrics';

/** Published sections, in inches. */
const GP = 11.16;              // DT-GP, the catalog dims
const F34 = 290 / 25.4;        // Global Truss F34, a 290 mm square
const CLAMP_8002: [number, number, number] = [1.26, 2.76, 3.15];

describe('tube sizes', () => {
  it('are the drawing figures in inches', () => {
    expect(CHORD_OD_IN).toBeCloseTo(1.9685039, 7);     // 50 mm
    expect(DIAGONAL_OD_IN).toBeCloseTo(0.9842520, 7);  // 25 mm
    expect(chordRadiusIn(GP)).toBeCloseTo(0.9842520, 7);
    expect(diagonalRadiusIn(GP)).toBeCloseTo(0.4921260, 7);
  });

  it('shrink with a section too small to carry a 50 mm tube', () => {
    // A junction block's nominal section can be a few inches across, and a 50 mm chord inside a
    // 3 in hub would be mostly tube.
    expect(chordRadiusIn(3)).toBeCloseTo(0.36, 9);
    expect(diagonalRadiusIn(3)).toBeCloseTo(0.18, 9);
    expect(chordRadiusIn(100)).toBeCloseTo(CHORD_OD_IN / 2, 9);
  });
});

describe('chordOffsetIn', () => {
  it('insets the chords by their own radius, because the section is the outside of the square', () => {
    expect(chordOffsetIn(GP)).toBeCloseTo(4.5957480, 7);
  });

  it('reproduces F34\'s published 240 mm chord centres', () => {
    // The cross-check on reading "section" as the outside: 290 mm square on 50 mm chords is the
    // system Global Truss specs at 240 mm between chord centres.
    expect(chordOffsetIn(F34) * 2 * 25.4).toBeCloseTo(240, 6);
  });

  it('puts the four chords at the corners of the section', () => {
    const o = chordOffsetIn(GP);
    expect(chordOffsets(GP)).toEqual([
      { right: -o, back: -o }, { right: o, back: -o },
      { right: -o, back: o }, { right: o, back: o },
    ]);
  });
});

describe('clampMetrics', () => {
  it('measures the 8002 half coupler', () => {
    const m = clampMetrics(CLAMP_8002);
    expect(m.plateDIn).toBeCloseTo(0.7875, 9);
    expect(m.jawRadiusIn).toBeCloseTo(1.18125, 9);
    // The one number the whole rig hangs off: bolt face to the axis of the chord in the jaw.
    expect(m.reachIn).toBeCloseTo(1.96875, 9);
    expect(m.boreDiaIn).toBeCloseTo(1.9845, 9);
  });

  it('keeps the jaw inside the part when the box is tall and thin', () => {
    const m = clampMetrics([1, 8, 2]);
    expect(m.plateDIn).toBeCloseTo(0.5, 9);               // depth-limited, not height-limited
    expect(m.jawRadiusIn).toBeCloseTo(0.75, 9);
    expect(m.plateDIn + m.jawRadiusIn * 2).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('closes on a 50 mm chord, which is what the part is sold for', () => {
    // Sold to fit 48-51 mm, and ours are 50: the clamp and the chord are one engineered pair.
    expect(clampFitsChord(clampMetrics(CLAMP_8002), GP)).toBe(true);
    expect(clampFitsChord(clampMetrics(CLAMP_8002), F34)).toBe(true);
    // A coupler half the size does not, and the planner has to be able to tell.
    expect(clampFitsChord(clampMetrics([0.63, 1.38, 1.58]), GP)).toBe(false);
  });
});

describe('braceNodesAlong', () => {
  it('rings both ends and every panel boundary of a 35.5 in chord', () => {
    // Three bays of 11.8333 in, plus an end frame one diagonal radius in from each end.
    expect([...braceNodesAlong(35.5, GP)].map(x => Number(x.toFixed(5)))).toEqual([
      0, 0.49213, 11.83333, 23.66667, 35.00787, 35.5,
    ]);
  });

  it('keeps a short stick to a single bay', () => {
    expect([...braceNodesAlong(8, GP)].map(x => Number(x.toFixed(5)))).toEqual([0, 0.49213, 7.50787, 8]);
  });

  it('hands back the same frozen array for a repeated length', () => {
    const a = braceNodesAlong(48, GP);
    expect(braceNodesAlong(48, GP)).toBe(a);              // memoized: the lift search re-asks
    expect(Object.isFrozen(a)).toBe(true);                // and cannot be poisoned by a caller
  });
});

describe('clearOfBraceNodes', () => {
  const JAW_HALF = 1.26 / 2;                              // the 8002, across its jaw
  const SPAN = 35.5;                                      // a chord three bays long

  it('rejects a jaw that would land on the end-frame weld', () => {
    // 0.69685 in up the chord is the lowest mount hole of a wall standing on the floor, and the
    // weld is at 0.49213: 0.20 in apart against a 1.12 in keep-out.
    expect(clearOfBraceNodes(0.69685, SPAN, GP, JAW_HALF)).toBe(false);
  });

  it('takes it an inch higher, which is why the wall rises', () => {
    expect(clearOfBraceNodes(1.69685, SPAN, GP, JAW_HALF)).toBe(true);
  });

  it('holds the keep-out exactly at the boundary', () => {
    const keepOut = JAW_HALF + diagonalRadiusIn(GP);      // 1.1222 in
    expect(keepOut).toBeCloseTo(1.1221260, 7);
    expect(clearOfBraceNodes(0.49213 + keepOut + 1e-6, SPAN, GP, JAW_HALF)).toBe(true);
    expect(clearOfBraceNodes(0.49213 + keepOut - 1e-3, SPAN, GP, JAW_HALF)).toBe(false);
  });

  it('rejects anything off the end of the stick', () => {
    expect(clearOfBraceNodes(-0.1, SPAN, GP, JAW_HALF)).toBe(false);
    expect(clearOfBraceNodes(SPAN + 0.1, SPAN, GP, JAW_HALF)).toBe(false);
  });

  it('rejects the middle of a bay only when the jaw is wider than the bay', () => {
    const mid = 11.83333 / 2;
    expect(clearOfBraceNodes(mid, SPAN, GP, JAW_HALF)).toBe(true);
    expect(clearOfBraceNodes(mid, SPAN, GP, 8)).toBe(false);
  });
});

describe('trussBaseProfile', () => {
  it('draws the catalog base as the measured 36 in plate, an inch thick, with nothing standing on it', () => {
    expect(GP_SECTION_IN).toBe(GP);
    expect(GP_BASE_PLATE_IN).toEqual({ size: 36, thick: 1 });
    expect(trussBaseProfile([36, 1, 36])).toEqual({ plateThick: 1, section: GP, riserLen: 0 });
  });

  it('stands a riser on the plate only for height past it, never one wider than the plate', () => {
    // A base placed at 36.5 in before the catalog's became the plate alone keeps its riser.
    expect(trussBaseProfile([36, 36.5, 36])).toEqual({ plateThick: 1, section: GP, riserLen: 35.5 });
    expect(trussBaseProfile([20, 0.5, 20])).toEqual({ plateThick: 0.5, section: GP, riserLen: 0 });
    expect(trussBaseProfile([8, 36, 10]).section).toBe(8);
  });
});

describe('BASE_PLATE_THICK_IN', () => {
  it('matches the plate the upright builder draws', () => {
    expect(BASE_PLATE_THICK_IN).toBe(0.5);
  });
});
