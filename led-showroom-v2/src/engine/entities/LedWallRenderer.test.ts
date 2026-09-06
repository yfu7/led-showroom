/**
 * Corner-mitre parity for the LED wall renderer (feature inventory items 19 and 20):
 * the bezel outline follows the extended mitre face, and content slices stretch over the same
 * extension so no bare panel shows at a fold. Runs in node — no content media, no DOM.
 */
import { afterEach, describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createDocument, createLedWall } from '../document/defaults';
import { assets } from '../persistence/AssetStore';
import type { RenderContext } from './EntityRenderer';
import { LedWallRenderer, sliceMiterExtensions, type Slice } from './LedWallRenderer';
import { IPOSTER } from '../ledwall/specs';
import { BASE_PLATE_Z_OFFSET_IN, computeSegments, wallDims } from '../ledwall/layout';
import { ACCESSORY_CAD, disposeGeometryCache, preloadAccessoryGeometry } from '../ledwall/geometry';
import { setCadLoader } from '../content/cadModels';
import type { Corner, LedWallEntity } from '../document/types';

function ctx(): RenderContext {
  return {
    doc: createDocument(), assets, camera: new THREE.PerspectiveCamera(), invalidate() {}, setLoading() {},
    unit: 'in', needs: { css3d: false, pixelGrid: false }, maxTextureSize: 4096,
  };
}

/** cornerExtension for a 90° fold of the 1.77 in deep iPoster: (D/2)·tan45 = 0.885 in (v1: 1 in). */
const EXT90 = IPOSTER.depthIn / 2;

function wallWith(corners: Corner[], cols = 4): LedWallEntity {
  const w = createLedWall({ cols, rows: 2 });
  w.corners = corners;
  w.bezels = true;
  return w;
}

/** Private-but-tested internals (the renderer builds them without any DOM). */
interface Internals {
  slices(vis: { x: number; y: number; w: number; h: number }): Slice[];
  placeSlice(obj: THREE.Object3D, sl: Slice, back: boolean, zIndex: number): { w: number; h: number };
}
const inner = (r: LedWallRenderer): Internals => r as unknown as Internals;

/** Local x extent of the bezel outline drawn for the panel in `col` (bezel lines follow panel order). */
function bezelXRange(r: LedWallRenderer, col: number): { min: number; max: number } {
  const lines: THREE.LineSegments[] = [];
  r.root.traverse(o => { if ((o as THREE.LineSegments).isLineSegments) lines.push(o as THREE.LineSegments); });
  const idx = r.selectionMeshes().findIndex(m => m.userData.col === col);
  const pos = lines[idx].geometry.getAttribute('position') as THREE.BufferAttribute;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pos.count; i++) { min = Math.min(min, pos.getX(i)); max = Math.max(max, pos.getX(i)); }
  return { min, max };
}

describe('bezel outline at a mitre (item 19)', () => {
  it('reaches the extended mitre face on both sides of a convex corner', () => {
    const wall = wallWith([{ afterCol: 1, angle: 90 }]);
    const r = new LedWallRenderer(wall, ctx());
    const hw = IPOSTER.widthIn / 2;

    // column 1 carries the corner on its RIGHT edge → outline extends past +hw
    expect(bezelXRange(r, 1).max).toBeCloseTo(hw + EXT90, 6);
    expect(bezelXRange(r, 1).min).toBeCloseTo(-hw, 6);
    // column 2 carries it on its LEFT edge → outline extends past -hw
    expect(bezelXRange(r, 2).min).toBeCloseTo(-hw - EXT90, 6);
    expect(bezelXRange(r, 2).max).toBeCloseTo(hw, 6);
    r.dispose();
  });

  it('trims the outline inward at a concave corner', () => {
    const wall = wallWith([{ afterCol: 1, angle: -90 }]);
    const r = new LedWallRenderer(wall, ctx());
    const meshes = r.selectionMeshes();
    const idx = meshes.findIndex(m => m.userData.col === 1);
    const line = r.root.getObjectsByProperty('type', 'LineSegments')[idx] as THREE.LineSegments;
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    let max = -Infinity;
    for (let i = 0; i < pos.count; i++) max = Math.max(max, pos.getX(i));
    expect(max).toBeCloseTo(IPOSTER.widthIn / 2 - EXT90, 6);
    r.dispose();
  });
});

describe('content slice mitre stretch (item 20)', () => {
  const dims = wallDims({ cols: 4, rows: 2, bezels: true, product: 'iposter' });
  const segs = computeSegments(4, [{ afterCol: 1, angle: 90 }]);

  it('applies an extension only where a slice touches a segment end', () => {
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }];
    const left = sliceMiterExtensions(dims, segs[0], corners, { x: 0, y: 0, w: 2 * IPOSTER.pxW, h: dims.wallHPx });
    expect(left.left).toBe(0);
    expect(left.right).toBeCloseTo(EXT90, 6);
    const right = sliceMiterExtensions(dims, segs[1], corners, { x: 2 * IPOSTER.pxW, y: 0, w: 2 * IPOSTER.pxW, h: dims.wallHPx });
    expect(right.left).toBeCloseTo(EXT90, 6);
    expect(right.right).toBe(0);
  });

  it('leaves an interior slice alone', () => {
    const corners: Corner[] = [{ afterCol: 1, angle: 90 }];
    const mid = sliceMiterExtensions(dims, segs[0], corners, { x: 10, y: 0, w: IPOSTER.pxW, h: dims.wallHPx });
    expect(mid).toEqual({ left: 0, right: 0 });
  });

  it('is negative (pulled in) at a concave corner', () => {
    const corners: Corner[] = [{ afterCol: 1, angle: -90 }];
    const seg = computeSegments(4, corners)[0];
    expect(sliceMiterExtensions(dims, seg, corners, { x: 0, y: 0, w: 2 * IPOSTER.pxW, h: dims.wallHPx }).right).toBeCloseTo(-EXT90, 6);
  });

  it('widens the placed slice plane by the extension so the fold is covered', () => {
    const wall = wallWith([{ afterCol: 1, angle: 90 }]);
    const r = new LedWallRenderer(wall, ctx());
    const d = r.dims;
    const sl = inner(r).slices({ x: 0, y: 0, w: d.wallWPx, h: d.wallHPx });
    expect(sl).toHaveLength(2);
    const widths = sl.map(s => inner(r).placeSlice(new THREE.Object3D(), s, false, 0).w);
    // Nominal span of a 2-column slice by pxToInX, plus one 90° extension per slice.
    const nominal = 2 * (d.panelW + d.gap);
    for (const w of widths) expect(w).toBeCloseTo(nominal + EXT90, 6);
    r.dispose();
  });

  it('keeps a straight wall unchanged', () => {
    const wall = wallWith([]);
    const r = new LedWallRenderer(wall, ctx());
    const d = r.dims;
    const sl = inner(r).slices({ x: 0, y: 0, w: d.wallWPx, h: d.wallHPx });
    expect(sl).toHaveLength(1);
    expect(sl[0].extLeftIn).toBe(0);
    expect(sl[0].extRightIn).toBe(0);
    r.dispose();
  });
});

/**
 * Accessory placement, before and after the CAD swap. The numbers must be identical either way:
 * the CAD is framed at load time to the frame `accessoryPlacements` already places meshes in, so
 * swapping it in must not move anything. Stand-in CAD (boxes of the real part sizes, parked away
 * from the origin so the framing has work to do) keeps this in node.
 */
describe('accessories', () => {
  const acc = IPOSTER.accessories!;

  function fakeCad(url: string): THREE.BufferGeometry {
    const s = url.includes('base')
      ? [acc.base.backW, acc.base.thick, acc.base.depth]
      : [acc.support.width, acc.support.totalH, acc.support.footD];
    const g = new THREE.BoxGeometry(s[0], s[1], s[2]);
    g.translate(60, -40, 25);
    return g;
  }

  /** World-space box of every mesh tagged `part`, in document order. */
  function boxesOf(r: LedWallRenderer, part: string): THREE.Box3[] {
    r.root.updateMatrixWorld(true);
    const out: THREE.Box3[] = [];
    r.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.part !== part) return;
      m.geometry.computeBoundingBox();
      out.push(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
    });
    return out;
  }

  /** Everything the accessory contract promises, checked against the panels themselves. */
  function expectPlacement(r: LedWallRenderer, cols: number): void {
    const panels = boxesOf(r, 'panel');
    const bases = boxesOf(r, 'base');
    const supports = boxesOf(r, 'support');
    expect(bases).toHaveLength(cols);
    expect(supports).toHaveLength(cols * 2);

    const panelBottom = Math.min(...panels.map(b => b.min.y));
    const panelBack = Math.min(...panels.map(b => b.min.z));
    const panelFront = Math.max(...panels.map(b => b.max.z));
    // The wall is lifted by the plate thickness, so the plate stands on the floor under it.
    expect(panelBottom).toBeCloseTo(acc.base.thick, 6);

    for (const b of bases) {
      expect(b.max.y).toBeCloseTo(panelBottom, 4); // plate top flush with the panel bottom
      expect(b.min.y).toBeCloseTo(0, 4); // …and its underside on the ground
      expect(b.max.x - b.min.x).toBeCloseTo(acc.base.backW, 4);
      expect(b.max.z - b.min.z).toBeCloseTo(acc.base.depth, 4);
      // Centred on a column: some panel shares this x centre.
      const cx = (b.min.x + b.max.x) / 2;
      expect(panels.some(p => Math.abs((p.min.x + p.max.x) / 2 - cx) < 1e-3)).toBe(true);
      // In z the plate leads the panel's mid-depth by BASE_PLATE_Z_OFFSET_IN (the CAD assembly).
      expect((b.min.z + b.max.z) / 2).toBeCloseTo((panelBack + panelFront) / 2 + BASE_PLATE_Z_OFFSET_IN, 4);
    }

    for (const s of supports) {
      // Feet on the plate's TOP face — the panel-bottom level, as in the manufacturer's assembly.
      expect(s.min.y).toBeCloseTo(panelBottom, 4);
      expect(s.max.y - s.min.y).toBeCloseTo(acc.support.totalH, 4);
      expect(s.max.z).toBeCloseTo(panelBack, 4); // bar against the cabinet back…
      expect(s.min.z).toBeCloseTo(panelBack - acc.support.footD, 4); // …foot running behind it
      // Flush with a panel's left or right edge.
      const flush = panels.some(p =>
        Math.abs(s.min.x - p.min.x) < 1e-3 || Math.abs(s.max.x - p.max.x) < 1e-3);
      expect(flush).toBe(true);
    }
  }

  afterEach(() => {
    setCadLoader(null);
    disposeGeometryCache();
  });

  it('places the extruded placeholders under the wall', () => {
    const wall = createLedWall({ cols: 2, rows: 2, accessories: true });
    const r = new LedWallRenderer(wall, ctx());
    expectPlacement(r, 2);
    r.dispose();
  });

  it('lands the CAD in exactly the same place, without rebuilding a mesh', async () => {
    setCadLoader(async url => fakeCad(url));
    const wall = createLedWall({ cols: 3, rows: 2, accessories: true });
    const c = ctx();
    const r = new LedWallRenderer(wall, c);
    const before = boxesOf(r, 'base').map(b => b.clone());

    await preloadAccessoryGeometry();

    const after = boxesOf(r, 'base');
    expect(after).toHaveLength(before.length); // same meshes, new contents
    expectPlacement(r, 3);
    after.forEach((b, i) => {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(b.min[axis]).toBeCloseTo(before[i].min[axis], 4);
        expect(b.max[axis]).toBeCloseTo(before[i].max[axis], 4);
      }
    });
    r.dispose();
  });

  it('uses the left part on the left and the right part on the right', async () => {
    const urls: string[] = [];
    setCadLoader(async url => { urls.push(url); return fakeCad(url); });
    const wall = createLedWall({ cols: 1, rows: 1, accessories: true });
    const r = new LedWallRenderer(wall, ctx());
    await preloadAccessoryGeometry();
    expect(boxesOf(r, 'support')).toHaveLength(2);
    expect(urls.filter(u => u.includes('support')).sort()).toEqual([
      ACCESSORY_CAD['support-lh'].url, ACCESSORY_CAD['support-rh'].url,
    ]);
    // Neither bracket is flipped by a negative scale (which would invert its winding).
    r.root.traverse(o => { if ((o as THREE.Mesh).userData.part === 'support') expect(o.scale.x).toBe(1); });
    r.dispose();
  });
});
