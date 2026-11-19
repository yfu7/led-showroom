/**
 * The property that matters for `shapeEditFields`: the fields it returns are a finished state, so
 * replaying the last step of a paint gesture against the wall the gesture *started* from lands on
 * exactly the state the stepwise gesture reached. That is what a merged history entry does on redo,
 * and a fold is the field that notices when it is wrong.
 */
import { describe, expect, it } from 'vitest';
import { createLedWall } from '../document/defaults';
import type { Corner, LedWallEntity } from '../document/types';
import { shapeEditFields } from './shapeEdit';
import { filledCells, paintShapeCell } from './layout';

/** A 4 × 2 wall folded after its second column (between columns 1 and 2). */
const folded = (corners: Corner[] = [{ afterCol: 1, angle: -45 }]): LedWallEntity =>
  ({ ...createLedWall({ cols: 4, rows: 2 }), corners });

/** Apply one paint to `wall` and return the wall it produces. */
const paint = (wall: LedWallEntity, key: string, mode: 'add' | 'remove'): LedWallEntity => {
  const next = paintShapeCell(filledCells(wall), key, mode);
  if (!next) throw new Error(`paint ${mode} ${key} was rejected`);
  return { ...wall, ...shapeEditFields(wall, next) };
};

describe('shapeEditFields', () => {
  it('re-keys a fold through the renumbering a leftward paint causes', () => {
    const after = paint(folded(), '-1,0', 'add');
    expect(after.cols).toBe(5);
    // Every column moved up by one, so the joint that was after column 1 is now after column 2.
    expect(after.corners).toEqual([{ afterCol: 2, angle: -45 }]);
  });

  it('leaves a fold alone when the paint does not renumber the columns', () => {
    const after = paint(folded(), '4,0', 'add');
    expect(after.cols).toBe(5);
    expect(after.corners).toEqual([{ afterCol: 1, angle: -45 }]);
  });

  it('drops a fold the shape no longer has a joint for', () => {
    // Trim to one column: a single-column wall has nothing to fold about.
    let w = folded();
    for (const key of ['3,0', '3,1', '2,0', '2,1', '1,0', '1,1']) w = paint(w, key, 'remove');
    expect(w.cols).toBe(1);
    expect(w.corners).toEqual([]);
  });

  /**
   * The regression this module exists for. A three-step leftward gesture merges into one history
   * entry; redo replays only the last step, against the pre-gesture wall. Because the fields are
   * absolute, that replay has to agree with the stepwise result — a patch that shifted the corners
   * by the last step's delta alone would land on `afterCol: 2` instead of 4.
   */
  it('redoes a merged multi-step gesture onto the same fold the gesture reached', () => {
    const start = folded();
    // Every step paints the cell left of the shape; normalisation renumbers in between, so the
    // key is '-1,0' each time.
    const step = (w: LedWallEntity) => paint(w, '-1,0', 'add');
    const live = step(step(step(start)));
    expect(live.cols).toBe(7);
    expect(live.corners).toEqual([{ afterCol: 4, angle: -45 }]);

    // What redo does: the last step's captured fields, applied to the pre-gesture wall.
    const beforeLast = step(step(start));
    const captured = shapeEditFields(beforeLast, paintShapeCell(filledCells(beforeLast), '-1,0', 'add')!);
    const redone = { ...start, ...captured };

    expect(redone.corners).toEqual(live.corners);
    expect(redone.cols).toBe(live.cols);
    expect(redone.rows).toBe(live.rows);
    expect(redone.shape).toEqual(live.shape);
  });

  it('normalises the cell set to the origin', () => {
    const after = paint(folded(), '-1,0', 'add');
    expect(after.shape.mode).toBe('custom');
    const cols = (after.shape.cells ?? []).map(k => Number(k.split(',')[0]));
    expect(Math.min(...cols)).toBe(0);
    expect(Math.max(...cols)).toBe(4);
  });

  it('re-clamps a content window that the new size no longer fits', () => {
    const base = folded();
    const wide = { ...base, ...shapeEditFields(base, filledCells(base)) };
    const withWindow: LedWallEntity = {
      ...wide,
      contentWindows: [{ id: 'w1', name: 'W', mode: 'fill', rect: { x: 0, y: 0, w: 10_000, h: 10_000 }, source: null } as never],
    };
    const after = paint(withWindow, '3,0', 'remove');
    const r = after.contentWindows[0].rect;
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(r.x + r.w).toBeLessThanOrEqual(10_000);
  });
});
