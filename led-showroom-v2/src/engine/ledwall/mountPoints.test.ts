/**
 * Mount hole PLACEMENT — where the four corner holes of each cabinet land on a built wall.
 *
 * `specs.test.ts` pins the pattern on one panel; this pins what the fold, the seam and a custom
 * shape do to it. The renderer has no tests of its own, and the two places this goes wrong are
 * both here: a yaw applied to the offset but not to the normal, and a mitre that cuts the back
 * face out from under a hole at a sharp fold.
 */
import { describe, it, expect } from 'vitest';
import {
  computeColumnLayout, filledCells, wallDims, wallMountPoints, rowCenterY,
  type MountPoint,
} from './layout';
import { IPOSTER, mountHoles } from './specs';
import type { Corner, LedWallEntity } from '../document/types';

type WallIn = Pick<LedWallEntity, 'cols' | 'rows' | 'bezels' | 'product' | 'shape'>;

const wall = (over: Partial<WallIn> = {}): WallIn =>
  ({ cols: 2, rows: 2, bezels: false, product: 'iposter', shape: { mode: 'rect' }, ...over } as WallIn);

function points(w: WallIn, corners: Corner[] = []): MountPoint[] {
  const dims = wallDims(w);
  return wallMountPoints(dims, computeColumnLayout(dims, corners), filledCells(w), corners);
}

/** Centre-to-near-side-of-hole, 1.19685 in on the iPoster. */
const INSET = IPOSTER.mount!.holeInsetIn + IPOSTER.mount!.boltDiaIn / 2;

describe('wallMountPoints', () => {
  it('gives four holes per filled cell', () => {
    expect(points(wall({ cols: 1, rows: 1 }))).toHaveLength(4);
    expect(points(wall({ cols: 6, rows: 5 }))).toHaveLength(6 * 5 * 4);
  });

  it('tags each hole with the panel it belongs to', () => {
    const byCell = new Map<string, number>();
    for (const p of points(wall({ cols: 3, rows: 2 }))) {
      byCell.set(p.col + ',' + p.row, (byCell.get(p.col + ',' + p.row) ?? 0) + 1);
    }
    expect(byCell.size).toBe(6);
    expect([...byCell.values()]).toEqual([4, 4, 4, 4, 4, 4]);
  });

  it('puts them on the BACK face, half a panel depth behind the centre line', () => {
    for (const p of points(wall({ cols: 1, rows: 1 }))) {
      expect(p.pos[2]).toBeCloseTo(-IPOSTER.depthIn / 2, 10);
      expect(p.normal).toEqual([-0, 0, -1]);
    }
  });

  it('sets the heights from the row, not from the wall', () => {
    const dims = wallDims(wall({ cols: 1, rows: 3 }));
    const holeY = mountHoles(IPOSTER).map(h => h.y);
    for (let r = 0; r < 3; r++) {
      const ys = points(wall({ cols: 1, rows: 3 })).filter(p => p.row === r).map(p => p.pos[1]).sort((a, b) => a - b);
      const want = holeY.map(y => rowCenterY(dims, r) + y).sort((a, b) => a - b);
      expect(ys).toEqual(want.map(v => expect.closeTo(v, 10)));
    }
  });

  /**
   * What a rigger measures with a tape across a seam: two insets, plus the seam itself. Bezels
   * off the panels butt, so it is exactly 2 × 1.19685; bezels on it is 0.06 in more.
   */
  it('leaves two insets plus the seam between the holes either side of it', () => {
    for (const bezels of [false, true]) {
      const gap = bezels ? IPOSTER.gapIn : 0;
      const xs = points(wall({ cols: 2, rows: 1, bezels })).map(p => p.pos[0]).sort((a, b) => a - b);
      // Four distinct x: left panel's two, right panel's two. The middle pair straddles the seam.
      const distinct = [...new Set(xs.map(x => +x.toFixed(6)))];
      expect(distinct).toHaveLength(4);
      expect(distinct[2]! - distinct[1]!).toBeCloseTo(2 * INSET + gap, 9);
    }
  });

  it('spaces the holes across one panel by the face width less two insets', () => {
    const xs = points(wall({ cols: 1, rows: 1 })).map(p => p.pos[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(IPOSTER.widthIn - 2 * INSET, 9);
  });

  describe('folded walls', () => {
    const corner: Corner[] = [{ afterCol: 0, angle: 90 }];

    it('carries the second run round with its column, normals included', () => {
      const p = points(wall({ cols: 2, rows: 1 }), corner);
      const run0 = p.filter(h => h.col === 0), run1 = p.filter(h => h.col === 1);
      expect(run0).toHaveLength(4);
      expect(run1).toHaveLength(4);
      // rotY = +90° for every column after the fold, so that run faces +X and its back faces -X.
      for (const h of run0) {
        expect(h.normal[0]).toBeCloseTo(0, 9);
        expect(h.normal[2]).toBeCloseTo(-1, 9);
      }
      for (const h of run1) {
        expect(h.normal[0]).toBeCloseTo(-1, 9);
        expect(h.normal[2]).toBeCloseTo(0, 9);
      }
    });

    it('turns the offsets too — a folded run is not four holes at the unfolded x', () => {
      const flat = points(wall({ cols: 2, rows: 1 })).filter(h => h.col === 1).map(h => +h.pos[2]!.toFixed(4));
      const bent = points(wall({ cols: 2, rows: 1 }), corner).filter(h => h.col === 1).map(h => +h.pos[2]!.toFixed(4));
      expect(new Set(flat).size).toBe(1);  // flat: one z for the whole column
      expect(new Set(bent).size).toBe(2);  // folded: the two x offsets became two z
    });

    /**
     * The mitre trims the back face by panelD/2 · tan(θ/2). At 90° that is 0.885 in, inside the
     * hole's 1.19685 in offset, so every hole still has face under it.
     */
    it('keeps all four holes on the face at a 90° fold', () => {
      expect(points(wall({ cols: 2, rows: 1 }), corner).every(h => h.onFace)).toBe(true);
    });

    /**
     * At 135° the trim is 2.137 in and passes the hole. The cabinet still has four holes — the
     * count comes from the spec — but there is nothing left to draw this one on.
     */
    it('reports the holes a sharp fold has cut out from under, without dropping them', () => {
      const p = points(wall({ cols: 2, rows: 1 }), [{ afterCol: 0, angle: 135 }]);
      expect(p).toHaveLength(8);
      // Two per column, not one: a vertical edge carries a hole at the top AND at the bottom.
      const cut = p.filter(h => !h.onFace);
      expect(cut).toHaveLength(4);
      expect(cut.map(h => h.col).sort()).toEqual([0, 0, 1, 1]);
      // Only the mitred edge of each run: column 0 is cut on its right, column 1 on its left.
      expect(cut.filter(h => h.col === 0).map(h => h.pos[0] > 0)).toEqual([true, true]);
      // And the holes that remain are the ones on the outer edges.
      expect(p.filter(h => h.onFace)).toHaveLength(4);
    });

    it('is unbothered by a concave fold, which makes the back face larger', () => {
      expect(points(wall({ cols: 2, rows: 1 }), [{ afterCol: 0, angle: -135 }]).every(h => h.onFace)).toBe(true);
    });
  });

  describe('custom shapes', () => {
    const shape = { mode: 'custom' as const, cells: ['0,0', '1,0', '1,1'] };

    it('gives holes to the cells the wall actually has, and no others', () => {
      const p = points(wall({ cols: 2, rows: 2, shape } as Partial<WallIn>));
      expect(p).toHaveLength(12);
      expect([...new Set(p.map(h => h.col + ',' + h.row))].sort()).toEqual(['0,0', '1,0', '1,1']);
    });
  });

  it('has nothing to place for a product with no mount recorded', () => {
    const dims = wallDims(wall());
    const noMount = { ...dims, spec: { ...dims.spec, mount: undefined } };
    expect(wallMountPoints(noMount, computeColumnLayout(dims, []), filledCells(wall()), [])).toEqual([]);
  });

  it('models the back face only — a spec naming another face places nothing', () => {
    const dims = wallDims(wall());
    const other = { ...dims, spec: { ...dims.spec, mount: { ...IPOSTER.mount!, face: 'top' as unknown as 'back' } } };
    expect(wallMountPoints(other, computeColumnLayout(dims, []), filledCells(wall()), [])).toEqual([]);
  });
});
