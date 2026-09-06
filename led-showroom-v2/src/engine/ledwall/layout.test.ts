import { describe, it, expect } from 'vitest';
import { IPOSTER } from './specs';
import {
  wallDims, computeColumnLayout, computeSegments, cornerExtension, miterCutsForColumn, pruneCorners,
  cellKey, parseCell, isRectWall, filledCells, shapeBBox, filledCount,
  isContiguous, wouldStayContiguous, classifyShapeEdit, toggleShapeCell, paintShapeCell,
  normalizeShape, ghostCells, computeShapeEdgeRuns,
  panelLocalPosition, rowCenterY, wallLocalBounds, localPointToWallPixel, wallPixelToLocal,
  accessoryPlacements, BASE_PLATE_Z_OFFSET_IN,
} from './layout';
import type { Corner } from '../document/types';

const set = (...keys: string[]) => new Set(keys);
const wall = (cols: number, rows: number, bezels = true) => ({ cols, rows, bezels, product: 'iposter' });

/* CAD panel constants: 25.2 x 18.9 x 1.77 in = 640.08 x 480.06 x 44.958 mm (see specs.ts). */
const W = IPOSTER.widthIn;   // 25.2 in
const H = IPOSTER.heightIn;  // 18.9 in
const D = IPOSTER.depthIn;   //  1.77 in
const HW = W / 2, HD = D / 2;

/* An L-shape: 3 wide on the top row, then a 1-wide leg down the left. */
const L = set('0,0', '1,0', '2,0', '0,1', '0,2');
/* A 3x3 ring with a hole in the middle. */
const RING = set('0,0', '1,0', '2,0', '0,1', '2,1', '0,2', '1,2', '2,2');

describe('wallDims', () => {
  it('matches the CAD numbers for the default 5x5 wall with bezels', () => {
    const d = wallDims(wall(5, 5));
    // 5 · 25.2 in + 4 · 0.06 in and 5 · 18.9 in + 4 · 0.06 in.
    expect(d.totalW).toBeCloseTo(126.24, 9);
    expect(d.totalH).toBeCloseTo(94.74, 9);
    expect(d.wallWPx).toBe(1720);
    expect(d.wallHPx).toBe(1290);
    expect(d.gap).toBe(0.06);
    expect(d.panelW).toBe(W);
    expect(d.panelH).toBe(H);
    expect(d.panelD).toBe(D);
    // The inch-authored solid exports as 640.08 x 480.06 x 44.958 mm.
    expect(d.panelW * 25.4).toBeCloseTo(640.08, 9);
    expect(d.panelH * 25.4).toBeCloseTo(480.06, 9);
    expect(d.panelD * 25.4).toBeCloseTo(44.958, 9);
    // Square pixels: 640.08/344 = 480.06/258 = 1.8606977 mm.
    expect(d.inPerPxX).toBeCloseTo(0.0732558, 7);
    expect(d.inPerPxY).toBeCloseTo(0.0732558, 7);
    expect(d.inPerPxX).toBeCloseTo(d.inPerPxY, 12);
    expect(d.inPerPxX * 25.4).toBeCloseTo(1.8606977, 7);
    expect(d.spec).toBe(IPOSTER);
  });
  it("reproduces the manufacturer's 6 x 5 wall assembly exactly", () => {
    // "Veloxity LED iPoster Wall.STEP" is 6 columns x 5 rows butted flush: x spans 3840.48 mm and
    // the panels span y 6.35..2406.65 mm above the 6.35 mm base plate, i.e. 2400.30 mm of panel.
    const d = wallDims(wall(6, 5, false));
    expect(d.totalW).toBeCloseTo(151.2, 9);
    expect(d.totalH).toBeCloseTo(94.5, 9);
    expect(d.totalW * 25.4).toBeCloseTo(3840.48, 6);
    expect(d.totalH * 25.4).toBeCloseTo(2400.30, 6);
  });
  it('drops the gap when bezels are hidden', () => {
    const d = wallDims(wall(5, 5, false));
    expect(d.gap).toBe(0);
    // Flush, exactly as the manufacturer's assembly stacks them.
    expect(d.totalW).toBeCloseTo(126, 9);
    expect(d.totalH).toBeCloseTo(94.5, 9);
  });
});

describe('computeColumnLayout', () => {
  it('spreads a straight wall symmetrically about x = 0 at z = 0', () => {
    const d = wallDims(wall(5, 5));
    const layout = computeColumnLayout(d, []);
    expect(layout).toHaveLength(5);
    const step = d.panelW + d.gap;
    expect(layout[0].x).toBeCloseTo(-2 * step, 9);
    expect(layout[2].x).toBeCloseTo(0, 9);
    expect(layout[4].x).toBeCloseTo(2 * step, 9);
    expect(layout[0].x).toBeCloseTo(-d.totalW / 2 + d.panelW / 2, 9);
    for (const c of layout) { expect(c.z).toBeCloseTo(0, 9); expect(c.rotY).toBe(0); }
  });

  it('folds columns 2-3 by +90° (rotY = +π/2, walking towards -Z) for a 90° corner after col 1', () => {
    const d = wallDims(wall(4, 1, false));
    const layout = computeColumnLayout(d, [{ afterCol: 1, angle: 90 }]);
    // v1 sign convention: positive angle → positive rotY; folded columns walk to -Z.
    expect(layout[0].rotY).toBe(0);
    expect(layout[1].rotY).toBe(0);
    expect(layout[2].rotY).toBeCloseTo(Math.PI / 2, 12);
    expect(layout[3].rotY).toBeCloseTo(Math.PI / 2, 12);
    // Raw walk (before centring): col0 (0,0) col1 (W,0) col2 (1.5W,-0.5W) col3 (1.5W,-1.5W)
    // Centroid (W, -0.5W).
    expect(layout[0].x).toBeCloseTo(-W, 9); expect(layout[0].z).toBeCloseTo(HW, 9);
    expect(layout[1].x).toBeCloseTo(0, 9); expect(layout[1].z).toBeCloseTo(HW, 9);
    expect(layout[2].x).toBeCloseTo(HW, 9); expect(layout[2].z).toBeCloseTo(0, 9);
    expect(layout[3].x).toBeCloseTo(HW, 9); expect(layout[3].z).toBeCloseTo(-W, 9);
    expect(layout[3].z).toBeLessThan(layout[2].z);
  });

  it('uses a negative rotY for concave corners', () => {
    const d = wallDims(wall(2, 1, false));
    const layout = computeColumnLayout(d, [{ afterCol: 0, angle: -45 }]);
    expect(layout[1].rotY).toBeCloseTo(-Math.PI / 4, 12);
    expect(layout[1].z).toBeGreaterThan(layout[0].z);
  });
});

describe('computeSegments', () => {
  it('returns one segment for a straight wall', () => {
    expect(computeSegments(5, [])).toEqual([{ startCol: 0, endCol: 4 }]);
  });
  it('splits at each corner', () => {
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }, { afterCol: 3, angle: -45 }];
    expect(computeSegments(6, corners)).toEqual([
      { startCol: 0, endCol: 1 }, { startCol: 2, endCol: 3 }, { startCol: 4, endCol: 5 },
    ]);
  });
  it('ignores a corner after the last column', () => {
    expect(computeSegments(3, [{ afterCol: 2, angle: 90 }])).toEqual([{ startCol: 0, endCol: 2 }]);
  });
});

describe('pruneCorners', () => {
  const corners: Corner[] = [{ afterCol: 0, angle: 90 }, { afterCol: 3, angle: -45 }];
  it('keeps corners that still sit on a joint', () => {
    expect(pruneCorners(5, corners)).toEqual(corners);
  });
  it('drops corners at or past the last joint', () => {
    expect(pruneCorners(4, corners)).toEqual([{ afterCol: 0, angle: 90 }]);
    expect(pruneCorners(1, corners)).toEqual([]);
  });
  it('drops negative joints', () => {
    expect(pruneCorners(5, [{ afterCol: -1, angle: 90 }])).toEqual([]);
  });
  it('returns the same array when nothing is pruned', () => {
    expect(pruneCorners(5, corners)).toBe(corners);
  });
});

describe('miters', () => {
  it('cornerExtension = min((panelD/2)·tan(|θ|/2), panelW/2)', () => {
    expect(cornerExtension(90, D, W)).toBeCloseTo(HD, 12);
    expect(cornerExtension(-90, D, W)).toBeCloseTo(HD, 12);
    expect(cornerExtension(60, D, W)).toBeCloseTo(HD * Math.tan(Math.PI / 6), 12);
    expect(cornerExtension(179, D, W)).toBe(HW); // clamped at half the panel width
  });
  it('convex corners extend the front and trim the back; concave the reverse', () => {
    const d = wallDims(wall(4, 1));
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }, { afterCol: 2, angle: -90 }];
    expect(miterCutsForColumn(0, d, corners)).toEqual({ left: null, right: null });
    // A 90 deg corner cuts by (panelD/2)·tan(45 deg) = D/2.
    const c1 = miterCutsForColumn(1, d, corners);
    expect(c1.left).toBeNull();
    expect(c1.right!.front).toBeCloseTo(-HD, 12);
    expect(c1.right!.back).toBeCloseTo(HD, 12);
    const c2 = miterCutsForColumn(2, d, corners);
    expect(c2.left!.front).toBeCloseTo(-HD, 12);
    expect(c2.left!.back).toBeCloseTo(HD, 12);
    expect(c2.right!.front).toBeCloseTo(HD, 12);
    expect(c2.right!.back).toBeCloseTo(-HD, 12);
    const c3 = miterCutsForColumn(3, d, corners);
    expect(c3.left!.front).toBeCloseTo(HD, 12);
    expect(c3.right).toBeNull();
  });
  it('ignores a stale corner on the outer edge of the first or last column', () => {
    const d = wallDims(wall(3, 1));
    // afterCol 2 is past the last joint of a 3-column wall — computeColumnLayout never folds there.
    expect(miterCutsForColumn(2, d, [{ afterCol: 2, angle: 90 }])).toEqual({ left: null, right: null });
    expect(miterCutsForColumn(0, d, [{ afterCol: -1, angle: 90 }])).toEqual({ left: null, right: null });
  });
  it('keeps the v1 quirk where -270° produces the same cuts as +90°', () => {
    const d = wallDims(wall(2, 1));
    const a = miterCutsForColumn(0, d, [{ afterCol: 0, angle: 90 }]).right!;
    const b = miterCutsForColumn(0, d, [{ afterCol: 0, angle: -270 }]).right!;
    expect(b.front).toBeCloseTo(a.front, 9);
    expect(b.back).toBeCloseTo(a.back, 9);
  });
});

describe('cell helpers', () => {
  it('round-trips keys', () => {
    expect(cellKey(3, 7)).toBe('3,7');
    expect(parseCell('3,7')).toEqual([3, 7]);
    expect(parseCell('-1,2')).toEqual([-1, 2]);
  });
  it('synthesises cells for rect walls and reads them for custom walls', () => {
    const rect = { cols: 2, rows: 3, shape: { mode: 'rect' as const } };
    expect(isRectWall(rect)).toBe(true);
    expect(filledCells(rect).size).toBe(6);
    expect(filledCount(rect)).toBe(6);
    const custom = { cols: 3, rows: 3, shape: { mode: 'custom' as const, cells: Array.from(L) } };
    expect(isRectWall(custom)).toBe(false);
    expect(filledCells(custom)).toEqual(L);
    expect(filledCount(custom)).toBe(5);
    expect(shapeBBox(L)).toEqual({ cols: 3, rows: 3, minC: 0, minR: 0 });
    expect(shapeBBox([])).toEqual({ cols: 0, rows: 0, minC: 0, minR: 0 });
    expect(shapeBBox(['2,3', '4,5'])).toEqual({ cols: 3, rows: 3, minC: 2, minR: 3 });
  });
});

describe('contiguity and shape edits', () => {
  it('isContiguous', () => {
    expect(isContiguous(L)).toBe(true);
    expect(isContiguous(RING)).toBe(true);
    expect(isContiguous(set('0,0', '2,0'))).toBe(false);
    expect(isContiguous(set())).toBe(true);
    expect(isContiguous(set('0,0'))).toBe(true);
  });
  it('wouldStayContiguous on an L-shape', () => {
    expect(wouldStayContiguous(L, '0,1', false)).toBe(false); // removing the elbow's neighbour splits the leg off
    expect(wouldStayContiguous(L, '0,2', false)).toBe(true);
    expect(wouldStayContiguous(L, '0,0', false)).toBe(false);
    expect(wouldStayContiguous(L, '2,0', false)).toBe(true);
    expect(wouldStayContiguous(L, '1,1', true)).toBe(true);
    expect(wouldStayContiguous(L, '5,5', true)).toBe(false);
    expect(wouldStayContiguous(set(), '5,5', true)).toBe(true);
  });
  it('a ring stays contiguous when any single cell is removed', () => {
    for (const k of RING) expect(wouldStayContiguous(RING, k, false)).toBe(true);
  });
  it('classifyShapeEdit', () => {
    expect(classifyShapeEdit(L, '1,1')).toBe('add');
    expect(classifyShapeEdit(L, '2,2')).toBe('no-adjacent');
    expect(classifyShapeEdit(L, '2,0')).toBe('remove');
    expect(classifyShapeEdit(L, '0,1')).toBe('would-split');
    expect(classifyShapeEdit(set('0,0'), '0,0')).toBe('last-cell');
    expect(classifyShapeEdit(set(), '4,4')).toBe('add');
    expect(classifyShapeEdit(RING, '1,1')).toBe('add');
  });
  it('toggleShapeCell returns a new set or null for illegal edits', () => {
    const added = toggleShapeCell(L, '1,1')!;
    expect(added.has('1,1')).toBe(true);
    expect(L.has('1,1')).toBe(false);
    expect(toggleShapeCell(L, '2,0')!.has('2,0')).toBe(false);
    expect(toggleShapeCell(L, '0,1')).toBeNull();
    expect(toggleShapeCell(L, '2,2')).toBeNull();
    expect(toggleShapeCell(set('0,0'), '0,0')).toBeNull();
  });
  it('paintShapeCell only applies edits matching the drag mode', () => {
    expect(paintShapeCell(L, '1,1', 'add')!.size).toBe(6);
    expect(paintShapeCell(L, '1,1', 'remove')).toBeNull();
    expect(paintShapeCell(L, '2,0', 'remove')!.size).toBe(4);
    expect(paintShapeCell(L, '2,0', 'add')).toBeNull();
    expect(paintShapeCell(L, '0,1', 'remove')).toBeNull();
  });
});

describe('normalizeShape', () => {
  it('translates to the origin and reports the bbox', () => {
    const n = normalizeShape(['2,3', '3,3', '2,4']);
    expect(n.cells).toEqual(set('0,0', '1,0', '0,1'));
    expect(n.cols).toBe(2);
    expect(n.rows).toBe(2);
  });
  it('handles negative coordinates (growing left/up) and clamps to 1x1 for empty', () => {
    const n = normalizeShape(['-1,0', '0,0', '0,-1']);
    expect(n.cells).toEqual(set('0,1', '1,1', '1,0'));
    expect(normalizeShape([])).toEqual({ cells: set(), cols: 1, rows: 1 });
  });
});

describe('ghostCells', () => {
  it('lists every empty edge-neighbour of the L-shape, including outside the bbox', () => {
    expect(ghostCells(L)).toEqual(['-1,0', '-1,1', '-1,2', '0,-1', '0,3', '1,-1', '1,1', '1,2', '2,-1', '2,1', '3,0']);
  });
  it('includes the hole of a ring', () => {
    expect(ghostCells(RING)).toContain('1,1');
    expect(ghostCells(RING)).toHaveLength(13);
  });
});

describe('computeShapeEdgeRuns', () => {
  it('traces the L-shape outline as 6 runs', () => {
    const runs = computeShapeEdgeRuns(L);
    expect(runs).toHaveLength(6);
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: 1, perpIdx: 0, fromIdx: 0, toIdx: 2 });   // top
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: -1, perpIdx: 0, fromIdx: 1, toIdx: 2 });  // under the arm
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: -1, perpIdx: 2, fromIdx: 0, toIdx: 0 });  // bottom of leg
    expect(runs).toContainEqual({ axis: 'v', nx: -1, ny: 0, perpIdx: 0, fromIdx: 0, toIdx: 2 });  // left
    expect(runs).toContainEqual({ axis: 'v', nx: 1, ny: 0, perpIdx: 0, fromIdx: 1, toIdx: 2 });   // right of leg
    expect(runs).toContainEqual({ axis: 'v', nx: 1, ny: 0, perpIdx: 2, fromIdx: 0, toIdx: 0 });   // right of arm
  });
  it('traces a ring as 4 outer + 4 inner runs', () => {
    const runs = computeShapeEdgeRuns(RING);
    expect(runs).toHaveLength(8);
    // outer
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: 1, perpIdx: 0, fromIdx: 0, toIdx: 2 });
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: -1, perpIdx: 2, fromIdx: 0, toIdx: 2 });
    expect(runs).toContainEqual({ axis: 'v', nx: -1, ny: 0, perpIdx: 0, fromIdx: 0, toIdx: 2 });
    expect(runs).toContainEqual({ axis: 'v', nx: 1, ny: 0, perpIdx: 2, fromIdx: 0, toIdx: 2 });
    // inner (facing the hole)
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: -1, perpIdx: 0, fromIdx: 1, toIdx: 1 });
    expect(runs).toContainEqual({ axis: 'h', nx: 0, ny: 1, perpIdx: 2, fromIdx: 1, toIdx: 1 });
    expect(runs).toContainEqual({ axis: 'v', nx: 1, ny: 0, perpIdx: 0, fromIdx: 1, toIdx: 1 });
    expect(runs).toContainEqual({ axis: 'v', nx: -1, ny: 0, perpIdx: 2, fromIdx: 1, toIdx: 1 });
  });
  it('splits non-consecutive edges into separate runs', () => {
    const runs = computeShapeEdgeRuns(set('0,0', '1,0', '2,0', '1,1'));
    const bottomsRow0 = runs.filter(r => r.axis === 'h' && r.ny === -1 && r.perpIdx === 0);
    expect(bottomsRow0).toEqual([
      { axis: 'h', nx: 0, ny: -1, perpIdx: 0, fromIdx: 0, toIdx: 0 },
      { axis: 'h', nx: 0, ny: -1, perpIdx: 0, fromIdx: 2, toIdx: 2 },
    ]);
  });
});

describe('positions and bounds', () => {
  it('row 0 is the top row, y measured from the floor', () => {
    const d = wallDims(wall(5, 5));
    expect(rowCenterY(d, 0)).toBeCloseTo(d.totalH - d.panelH / 2, 9);
    expect(rowCenterY(d, 4)).toBeCloseTo(d.panelH / 2, 9);
    const layout = computeColumnLayout(d, []);
    const p = panelLocalPosition(d, layout, 0, 4);
    expect(p[0]).toBeCloseTo(layout[0].x, 9);
    expect(p[1]).toBeCloseTo(d.panelH / 2, 9);
    expect(p[2]).toBeCloseTo(0, 9);
  });
  it('extrapolates ghost positions beyond the layout', () => {
    const d = wallDims(wall(3, 1));
    const layout = computeColumnLayout(d, []);
    const step = d.panelW + d.gap;
    expect(panelLocalPosition(d, layout, -1, 0)[0]).toBeCloseTo(layout[0].x - step, 9);
    expect(panelLocalPosition(d, layout, 3, 0)[0]).toBeCloseTo(layout[2].x + step, 9);
  });
  it('bounds of a straight wall span the unfolded width and panel depth', () => {
    const d = wallDims(wall(5, 5));
    const b = wallLocalBounds(d, computeColumnLayout(d, []));
    expect(b.minX).toBeCloseTo(-d.totalW / 2, 9);
    expect(b.maxX).toBeCloseTo(d.totalW / 2, 9);
    expect(b.minZ).toBeCloseTo(-HD, 9);
    expect(b.maxZ).toBeCloseTo(HD, 9);
    expect(b.minY).toBe(0);
    expect(b.maxY).toBeCloseTo(d.totalH, 9);
  });
  it('bounds of a folded wall include the folded leg', () => {
    const d = wallDims(wall(4, 1, false));
    const b = wallLocalBounds(d, computeColumnLayout(d, [{ afterCol: 1, angle: 90 }]));
    // cols 2-3 face +X at x = W/2 ± D/2 (depth), reaching z = -W - W/2
    expect(b.maxX).toBeCloseTo(HW + HD, 9);
    expect(b.minX).toBeCloseTo(-W - HW, 9);
    expect(b.minZ).toBeCloseTo(-W - HW, 9);
    expect(b.maxZ).toBeCloseTo(HW + HD, 9);
  });
});

describe('pixel <-> local', () => {
  it('round-trips on a straight wall', () => {
    const d = wallDims(wall(5, 5));
    const layout = computeColumnLayout(d, []);
    const segs = computeSegments(d.cols, []);
    // Includes every column/row boundary pixel — those land exactly on a panel edge.
    for (const [px, py] of [[0, 0], [343, 0], [344, 257], [344, 258], [688, 516], [1032, 774], [1376, 1032], [1000, 700], [1719, 1289]] as const) {
      const p = wallPixelToLocal(d, layout, px, py);
      expect(p[2]).toBeCloseTo(HD, 9); // on the screen plane
      expect(localPointToWallPixel(d, layout, segs, p)).toEqual({ px, py });
    }
    // top-left pixel is at the top-left of the wall
    const tl = wallPixelToLocal(d, layout, 0, 0);
    expect(tl[0]).toBeCloseTo(-d.totalW / 2, 9);
    expect(tl[1]).toBeCloseTo(d.totalH, 9);
  });
  it('returns null far outside the wall and clamps near the edges', () => {
    const d = wallDims(wall(5, 5));
    const layout = computeColumnLayout(d, []);
    const segs = computeSegments(d.cols, []);
    expect(localPointToWallPixel(d, layout, segs, [500, 10, 1])).toBeNull();
    expect(localPointToWallPixel(d, layout, segs, [-d.totalW / 2 - 0.4, -5, 1])).toEqual({ px: 0, py: 1289 });
  });
  it('round-trips on a folded wall and picks the segment nearest the point', () => {
    const d = wallDims(wall(4, 2, false));
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }];
    const layout = computeColumnLayout(d, corners);
    const segs = computeSegments(d.cols, corners);
    for (const [px, py] of [[10, 10], [500, 100], [700, 300], [1375, 515]] as const) {
      const p = wallPixelToLocal(d, layout, px, py);
      expect(localPointToWallPixel(d, layout, segs, p)).toEqual({ px, py });
    }
    // A pixel in col 2 sits on the +X-facing screen: x = col.x + panelD/2
    const p = wallPixelToLocal(d, layout, 2 * 344 + 172, 0);
    expect(p[0]).toBeCloseTo(layout[2].x + HD, 9);
    expect(p[2]).toBeCloseTo(layout[2].z, 6);
  });

  it('maps y per row so pixel rows sit exactly on the physical panel rows (corrects v1 5806)', () => {
    const d = wallDims(wall(5, 5)); // bezels on: gap = 0.06 in between rows
    const layout = computeColumnLayout(d, []);
    const segs = computeSegments(d.cols, []);
    // Centre pixel of each row lands on that row's centre line, not row*gap above it.
    for (let r = 0; r < 5; r++) {
      const p = wallPixelToLocal(d, layout, 100, r * 258 + 129);
      expect(p[1]).toBeCloseTo(rowCenterY(d, r), 9);
      // ...and the row centre line maps back to that row's centre pixel.
      expect(localPointToWallPixel(d, layout, segs, [0, rowCenterY(d, r), 1])).toEqual({ px: 860, py: r * 258 + 129 });
    }
    // Top edge of row 0 is the top of the wall; bottom edge of the last row is the floor.
    expect(wallPixelToLocal(d, layout, 100, 0)[1]).toBeCloseTo(d.totalH, 9);
    expect(wallPixelToLocal(d, layout, 100, 1290)[1]).toBeCloseTo(0, 9);
    // First pixel row of row 1 starts one gap below the bottom of row 0.
    expect(wallPixelToLocal(d, layout, 100, 258)[1]).toBeCloseTo(d.totalH - d.panelH - d.gap, 9);
    // A point inside the seam between rows 0 and 1 clamps into row 0's last pixel row.
    const seamY = d.totalH - d.panelH - d.gap / 2;
    expect(localPointToWallPixel(d, layout, segs, [0, seamY, 1])!.py).toBe(257);
    // Floor line maps to the last pixel row.
    expect(localPointToWallPixel(d, layout, segs, [0, 0, 1])!.py).toBe(1289);
  });

  it('clamps a slack-zone hit at the start of a folded segment into the first column of that segment', () => {
    const d = wallDims(wall(4, 1, false));
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }];
    const layout = computeColumnLayout(d, corners);
    const segs = computeSegments(d.cols, corners);
    // Point on column 2's screen plane, 0.3 in to the left of its left edge (in the mitre region).
    const col2 = layout[2];
    const cos = Math.cos(col2.rotY), sin = Math.sin(col2.rotY);
    const toWall = (lx: number, lz: number): [number, number, number] =>
      [col2.x + lx * cos + lz * sin, d.totalH, col2.z - lx * sin + lz * cos];
    for (const over of [0.1, 0.3, 0.45]) {
      const hit = localPointToWallPixel(d, layout, segs, toWall(-d.panelW / 2 - over, d.panelD / 2));
      // v1 (5805) reported 687/684/682 here — the rightmost pixels of column 1, on the other leg.
      expect(hit).toEqual({ px: 2 * 344, py: 0 });
    }
    // Symmetrically, past the right edge of the segment's last column clamps to its last pixel.
    const col3 = layout[3];
    const hitR = localPointToWallPixel(d, layout, segs, [col3.x + (d.panelW / 2 + 0.3) * cos + sin, d.totalH, col3.z - (d.panelW / 2 + 0.3) * sin + cos]);
    expect(hitR).toEqual({ px: 4 * 344 - 1, py: 0 });
  });

  it('uses the correct inverse rotation (v1 5798-5800 mirrored x within rotated columns)', () => {
    const d = wallDims(wall(4, 1, false));
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }];
    const layout = computeColumnLayout(d, corners);
    const segs = computeSegments(d.cols, corners);
    const px = 2 * 344 + 50;
    const p = wallPixelToLocal(d, layout, px, 0);
    expect(localPointToWallPixel(d, layout, segs, p)!.px).toBe(px);
    // Reproduce v1's formula for column 2 to show it would have mirrored the pixel to 982.
    const col = layout[2];
    const dx = p[0] - col.x, dz = p[2] - col.z;
    const v1LocalX = dx * Math.cos(-col.rotY) - dz * Math.sin(-col.rotY);
    const v1Px = 2 * 344 + Math.round(((v1LocalX + d.panelW / 2) / d.panelW) * 344);
    expect(v1Px).toBe(982);
    expect(v1Px).not.toBe(px);
  });
});

describe('accessoryPlacements', () => {
  it('places a base at the panel bottom and two supports standing on it behind the panel', () => {
    const d = wallDims(wall(2, 1, false));
    const layout = computeColumnLayout(d, []);
    const acc = accessoryPlacements(d, layout, IPOSTER);
    expect(acc).toHaveLength(2);
    const a = acc[0];
    // The plate leads the panel's mid-depth by 0.275 in, as the manufacturer's assembly has it.
    expect(a.base.position).toEqual([layout[0].x, 0, BASE_PLATE_Z_OFFSET_IN]);
    expect(a.supports).toHaveLength(2);
    const [l, r] = a.supports;
    expect(l.mirrored).toBe(false);
    expect(r.mirrored).toBe(true);
    expect(l.position[0]).toBeCloseTo(layout[0].x - HW + 1, 9);
    expect(r.position[0]).toBeCloseTo(layout[0].x + HW - 1, 9);
    // Feet on the plate's TOP face = the panel bottom (CAD: plate y 0..6.35, supports y 6.35..543.306).
    expect(l.position[1]).toBe(0);
    expect(r.position[1]).toBe(0);
    expect(l.position[2]).toBeCloseTo(-HD, 9); // panel back
  });
  it('rotates with folded columns', () => {
    const d = wallDims(wall(2, 1, false));
    const layout = computeColumnLayout(d, [{ afterCol: 0, angle: 90 }]);
    const acc = accessoryPlacements(d, layout, IPOSTER);
    const s = acc[1].supports[0];
    expect(s.rotY).toBeCloseTo(Math.PI / 2, 12);
    // Column 1 faces +X, so "behind" is -X: support x = col.x - D/2; the left edge is at +Z.
    expect(s.position[0]).toBeCloseTo(layout[1].x - HD, 9);
    expect(s.position[2]).toBeCloseTo(layout[1].z + HW - 1, 9);
    expect(s.position[1]).toBe(0);
    // The plate offset rotates with the column too: +Z in the column frame is +X in wall space.
    expect(acc[1].base.position[0]).toBeCloseTo(layout[1].x + BASE_PLATE_Z_OFFSET_IN, 9);
  });
  it('returns nothing for a spec without accessories', () => {
    const d = wallDims(wall(2, 1));
    expect(accessoryPlacements(d, computeColumnLayout(d, []), { ...IPOSTER, accessories: undefined })).toEqual([]);
  });
});
