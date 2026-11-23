import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createLedWall } from '../document/defaults';
import type { LedWallEntity } from '../document/types';
import { IPOSTER } from './specs';
import { computeColumnLayout, computeSegments, wallDims, type Segment, type WallDims } from './layout';
import {
  DIMENSION_RENDER_ORDER,
  DIMENSION_Z_STANDOFF_IN,
  buildWallDimensions,
  createLabelSprite,
  dimensionPiecesOf,
  disposeDimensionGroup,
  formatDimensionLength,
  formatEdgeDimensionLabel,
  formatRectDimensionLabel,
  updateLabelSpriteScale,
} from './dimensions';

/* ── Fixtures built with the real layout module (wallDims / computeColumnLayout / computeSegments) ── */

const W = IPOSTER.widthIn, H = IPOSTER.heightIn, GAP = IPOSTER.gapIn;

/** Build a wall plus everything `buildWallDimensions` needs from it, exactly as the renderer would. */
function fixture(wall: LedWallEntity, unit: 'in' | 'ft' | 'mm' | 'cm' | 'm' = 'in') {
  const dims = wallDims(wall);
  const layout = computeColumnLayout(dims, wall.corners);
  const segments = computeSegments(dims.cols, wall.corners);
  return { wall, dims, layout, segments, unit };
}

const lines = (g: THREE.Group) => g.children.filter(c => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments[];
const sprites = (g: THREE.Group) => g.children.filter(c => (c as THREE.Sprite).isSprite) as THREE.Sprite[];

/* ───────────────────────────── Tests ───────────────────────────── */

describe('label formatting', () => {
  it('rect labels show one-decimal inches plus the pixel readout (v1 format)', () => {
    const w = 5 * W + 4 * GAP; // 126.24
    expect(formatRectDimensionLabel(w, 5 * IPOSTER.pxW, 'in')).toBe('126.2" (1720 px)');
    expect(formatRectDimensionLabel(3 * H + 2 * GAP, 3 * IPOSTER.pxH, 'in')).toBe('56.8" (774 px)');
  });

  it('keeps the trailing .0 of whole-inch lengths like v1 toFixed(1)', () => {
    // Synthetic whole-inch lengths (a gap-free CAD wall does land on some: 5 x 25.2 = 126.0 in).
    // v1's rounded 25.125 x 18.875 in panel made an 8 x 8 wall exactly 201 x 151 in; the CAD panel
    // makes it 201.6 x 151.2.
    expect(formatDimensionLength(201, 'in')).toBe('201.0"');
    expect(formatRectDimensionLabel(201, 2752, 'in')).toBe('201.0" (2752 px)');
    expect(formatEdgeDimensionLabel(151, 'in')).toBe('151.0"');
    expect(formatDimensionLength(0, 'in')).toBe('0.0"');
  });

  it('labels honour the display unit', () => {
    const w = 5 * W + 4 * GAP; // the default 5x5 wall, 126.24 in
    expect(formatRectDimensionLabel(w, 1720, 'ft')).toBe('10\' 6.2" (1720 px)');
    expect(formatRectDimensionLabel(w, 1720, 'mm')).toBe('3206 mm (1720 px)');
    expect(formatRectDimensionLabel(w, 1720, 'm')).toBe('3.206 m (1720 px)');
  });

  it('custom edge labels are length only', () => {
    expect(formatEdgeDimensionLabel(2 * W + GAP, 'in')).toBe('50.5"');
    expect(formatEdgeDimensionLabel(2 * W + GAP, 'cm')).toBe('128.2 cm');
  });
});

describe('createLabelSprite', () => {
  it('builds a depthTest-off sprite at render order 999 sized by the v1 base height', () => {
    const s = createLabelSprite('125.9" (1720 px)');
    expect(s.isSprite).toBe(true);
    expect(s.renderOrder).toBe(DIMENSION_RENDER_ORDER);
    expect(s.material.depthTest).toBe(false);
    expect(s.material.transparent).toBe(true);
    expect(s.scale.y).toBeCloseTo(6);
    expect(s.userData.dimBaseH).toBe(6);
    expect(s.userData.label).toBe('125.9" (1720 px)');
    expect(s.scale.x).toBeCloseTo(6 * s.userData.dimAspect);
    expect(s.userData.dimAspect).toBeGreaterThan(1);
  });

  it('honours heightIn and grows with text length', () => {
    const short = createLabelSprite('1"', { heightIn: 4 });
    const long = createLabelSprite('1234.5" (12345 px)', { heightIn: 4 });
    expect(short.scale.y).toBeCloseTo(4);
    expect(long.userData.dimAspect).toBeGreaterThan(short.userData.dimAspect);
  });
});

describe('updateLabelSpriteScale', () => {
  it('keeps a fixed size in the room, so it grows as the camera zooms in, preserving aspect', () => {
    const s = createLabelSprite('42"');
    const aspect = s.userData.dimAspect as number;
    const cam = new THREE.PerspectiveCamera();
    for (const z of [10, 400, 800]) {
      cam.position.set(0, 0, z);
      cam.updateMatrixWorld();
      updateLabelSpriteScale(s, cam, 6);
      expect(s.scale.y).toBeCloseTo(12);
      expect(s.scale.x).toBeCloseTo(12 * aspect);
    }
  });

  it('stops shrinking far out, at half the size it used to hold on screen', () => {
    const s = createLabelSprite('42"');
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 0, 4000);
    cam.updateMatrixWorld();
    updateLabelSpriteScale(s, cam, 6);
    expect(s.scale.y).toBeCloseTo(6 * (4000 / 200) * 0.5);
  });

  it('leaves an orthographic view to its zoom', () => {
    const s = createLabelSprite('42"');
    const cam = new THREE.OrthographicCamera();
    cam.position.set(0, 0, 40000);
    cam.updateMatrixWorld();
    updateLabelSpriteScale(s, cam, 6);
    expect(s.scale.y).toBeCloseTo(12);
  });
});

describe('buildWallDimensions — rect walls', () => {
  it('a 2-segment wall gets 2 width dims + 1 height dim (6 children)', () => {
    const wall = createLedWall({ cols: 4, rows: 3 });
    wall.corners = [{ afterCol: 1, angle: 90 }];

    const g = buildWallDimensions(fixture(wall));
    expect(g.children.length).toBe(6);
    expect(lines(g).length).toBe(3);
    expect(sprites(g).length).toBe(3);

    for (const c of g.children) {
      expect(c.renderOrder).toBe(DIMENSION_RENDER_ORDER);
      const mat = (c as THREE.Mesh).material as THREE.Material;
      expect(mat.depthTest).toBe(false);
    }
    // Each dimension: 2 extension lines + 1 dim line + 2 ticks = 5 segments = 10 vertices.
    for (const l of lines(g)) expect(l.geometry.getAttribute('position').count).toBe(10);

    const labels = sprites(g).map(s => s.userData.label as string);
    expect(labels).toEqual(['50.5" (688 px)', '50.5" (688 px)', '56.8" (774 px)']);
  });

  it('a straight 5x3 wall gets 1 width + 1 height dim in the floor-based frame', () => {
    const wall = createLedWall({ cols: 5, rows: 3 });
    const { dims } = fixture(wall);
    expect(dims.totalW).toBeCloseTo(126.24, 9);
    const g = buildWallDimensions(fixture(wall));
    expect(g.children.length).toBe(4);

    const [wLines, hLines] = lines(g);
    const zFront = IPOSTER.depthIn / 2 + DIMENSION_Z_STANDOFF_IN; // 1.035 (v1: 1.15, from its 2 in panel depth)
    const wp = wLines.geometry.getAttribute('position');
    // Width dim line sits dimDrop = 4 in below the floor (y = 0), spans ±totalW/2, at z = 1.15.
    expect(wp.getX(4)).toBeCloseTo(-dims.totalW / 2);
    expect(wp.getX(5)).toBeCloseTo(dims.totalW / 2);
    expect(wp.getY(4)).toBeCloseTo(-4);
    expect(wp.getZ(4)).toBeCloseTo(zFront);
    // Extension lines start extGap (1 in) below the bottom edge and overshoot 1.5 in past the line.
    expect(wp.getY(0)).toBeCloseTo(-1);
    expect(wp.getY(1)).toBeCloseTo(-5.5);
    // Ticks are ±0.8 around the dim line.
    expect(wp.getY(6)).toBeCloseTo(-4.8);
    expect(wp.getY(7)).toBeCloseTo(-3.2);

    // Height dim: vertical line from totalH down to 0, hOffset = 4 in left of the wall edge.
    const hp = hLines.geometry.getAttribute('position');
    expect(hp.getX(4)).toBeCloseTo(-dims.totalW / 2 - 4);
    expect(hp.getY(4)).toBeCloseTo(dims.totalH);
    expect(hp.getY(5)).toBeCloseTo(0);

    // Labels: width label 2.5 in under the line, in FRONT of the face (v1 mirrored it behind).
    const [wLabel, hLabel] = sprites(g);
    expect(wLabel.position.y).toBeCloseTo(-6.5);
    expect(wLabel.position.z).toBeCloseTo(zFront);
    expect(hLabel.position.x).toBeCloseTo(-dims.totalW / 2 - 6.5);
    expect(hLabel.position.y).toBeCloseTo(dims.totalH / 2);
    expect(hLabel.userData.label).toBe('56.8" (774 px)');
    expect(wLabel.userData.label).toBe('126.2" (1720 px)');
  });

  it('derives panel constants and px readouts from the WallDims passed in, not from the product', () => {
    const wall = createLedWall({ cols: 2, rows: 2 });
    const real = fixture(wall);
    // Same wall, but a caller hands in dims with a different panel depth and pixel pitch.
    const dims: WallDims = {
      ...real.dims,
      panelD: 10,
      wallHPx: 999,
      spec: { ...real.dims.spec, pxW: 100, pxH: 50 },
    };
    const g = buildWallDimensions({ ...real, dims });
    const [wLines] = lines(g);
    expect(wLines.geometry.getAttribute('position').getZ(0)).toBeCloseTo(5 + DIMENSION_Z_STANDOFF_IN);
    const [wLabel, hLabel] = sprites(g);
    expect(wLabel.userData.label).toBe(`${dims.totalW.toFixed(1)}" (200 px)`);
    expect(hLabel.userData.label).toBe(`${dims.totalH.toFixed(1)}" (999 px)`);
    expect(hLabel.position.z).toBeCloseTo(5 + DIMENSION_Z_STANDOFF_IN);
  });

  it('bezels off: an 8x8 wall prints the gap-free panel totals', () => {
    const wall = createLedWall({ cols: 8, rows: 8 });
    wall.bezels = false;
    const f = fixture(wall);
    expect(f.dims.gap).toBe(0);
    const g = buildWallDimensions(f);
    const labels = sprites(g).map(s => s.userData.label as string);
    // 8 x 25.2 in = 201.6 in, 8 x 18.9 in = 151.2 in (v1's rounded panel gave a flat 201 x 151).
    expect(labels).toEqual(['201.6" (2752 px)', '151.2" (2064 px)']);
  });

  it('throws a descriptive error for a segment outside the layout', () => {
    const wall = createLedWall({ cols: 3, rows: 1 });
    const f = fixture(wall);
    const badSegments: Segment[] = [{ startCol: 0, endCol: 7 }];
    expect(() => buildWallDimensions({ ...f, segments: badSegments })).toThrow(/segment 0\.\.7 outside layout of 3 columns/);
  });

  it('rotates a folded segment with its columns', () => {
    const wall = createLedWall({ cols: 4, rows: 2 });
    wall.corners = [{ afterCol: 1, angle: 90 }];
    const f = fixture(wall);
    const { layout } = f;
    const g = buildWallDimensions(f);
    const [seg0, seg1] = lines(g);
    expect(seg0.rotation.y).toBeCloseTo(0);
    expect(seg1.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(seg1.position.x).toBeCloseTo((layout[2].x + layout[3].x) / 2);
    expect(seg1.position.z).toBeCloseTo((layout[2].z + layout[3].z) / 2);
  });

  it('returns an empty group for degenerate input', () => {
    const wall = createLedWall({ cols: 0, rows: 0 });
    const g = buildWallDimensions(fixture(wall));
    expect(g.children.length).toBe(0);
  });
});

describe('buildWallDimensions — custom shapes', () => {
  it('an L-shaped wall gets one dimension per edge run', () => {
    // (0,0)
    // (0,1) (1,1)   -> 6 boundary runs: top x2, bottom x1, left x1, right x2
    const wall = createLedWall({ cols: 2, rows: 2 });
    wall.shape = { mode: 'custom', cells: ['0,0', '0,1', '1,1'] };
    const g = buildWallDimensions(fixture(wall));

    expect(lines(g).length).toBe(6);
    expect(sprites(g).length).toBe(6);
    expect(g.children.length).toBe(12);
    for (const c of g.children) expect(c.renderOrder).toBe(DIMENSION_RENDER_ORDER);

    const labels = sprites(g).map(s => s.userData.label as string).sort();
    // Four single-panel runs (25.2" wide / 18.9" tall) and two 2-panel runs (50.5" / 37.9").
    expect(labels).toEqual(['18.9"', '18.9"', '25.2"', '25.2"', '37.9"', '50.5"']);
  });

  it('splits a folded custom shape at the fold and draws each piece on the face it measures', () => {
    //  col  0 1 2 | 3 4 5     folded 90 deg after column 2
    //  r0   # # # | # # #
    //  r1   # # # | # # #
    //  r2   # #
    //  r3   # #
    const wall = createLedWall({ cols: 6, rows: 4 });
    wall.shape = { mode: 'custom', cells: [
      '0,0', '0,1', '0,2', '0,3', '1,0', '1,1', '1,2', '1,3',
      '2,0', '2,1', '3,0', '3,1', '4,0', '4,1', '5,0', '5,1',
    ] };
    wall.corners = [{ afterCol: 2, angle: 90 }];
    const g = buildWallDimensions(fixture(wall));

    // Six boundary runs, but the top run (cols 0..5) and the row-1 bottom run (cols 2..5) each
    // cross the fold, and a span bent through 90 deg is two edges, not one.
    expect(lines(g).length).toBe(8);
    expect(sprites(g).length).toBe(8);

    // Five pieces belong to the near face and three to the folded one, each carrying its own yaw
    // rather than being drawn flat across the fold.
    const yaws = lines(g).map(l => l.rotation.y);
    expect(yaws.filter(y => Math.abs(y) < 1e-9).length).toBe(5);
    expect(yaws.filter(y => Math.abs(y - Math.PI / 2) < 1e-9).length).toBe(3);

    // 3 panels = 75.7" and 4 rows = 75.8"; nothing reads 151.5" (6 panels) or 101.0" (4 panels),
    // which is what a single straight line through the fold used to claim.
    const labels = sprites(g).map(s => s.userData.label as string).sort();
    expect(labels).toEqual(['25.2"', '37.9"', '37.9"', '50.5"', '75.7"', '75.7"', '75.7"', '75.8"']);
  });

  it('places the bottom edge of the lowest row at y = 0 and the top at totalH', () => {
    const wall = createLedWall({ cols: 1, rows: 2 });
    wall.shape = { mode: 'custom', cells: ['0,0', '0,1'] };
    const f = fixture(wall);
    const { dims } = f;
    const g = buildWallDimensions(f);
    // 4 runs: top, bottom, left, right.
    expect(lines(g).length).toBe(4);
    const ys = lines(g).map(l => l.geometry.getAttribute('position').getY(4));
    const xs = lines(g).map(l => l.geometry.getAttribute('position').getX(4));
    // Bottom run: dim line 3 in below y = 0; top run: 3 in above totalH.
    expect(ys).toContainEqual(expect.closeTo(-3, 5));
    expect(ys).toContainEqual(expect.closeTo(dims.totalH + 3, 5));
    // Left / right runs: 3 in outside the panel edges.
    expect(xs).toContainEqual(expect.closeTo(-W / 2 - 3, 5));
    expect(xs).toContainEqual(expect.closeTo(W / 2 + 3, 5));
  });

  it('a custom wall with no cells draws nothing (v1 isRectWall semantics)', () => {
    const wall = createLedWall({ cols: 2, rows: 2 });
    wall.shape = { mode: 'custom', cells: [] };
    const g = buildWallDimensions(fixture(wall));
    expect(g.children.length).toBe(0);
  });

  it('a rect-mode shape with a stale cell list still gets rect dimensions', () => {
    const wall = createLedWall({ cols: 2, rows: 2 });
    wall.shape = { mode: 'rect', cells: ['0,0'] };
    const g = buildWallDimensions(fixture(wall));
    expect(g.children.length).toBe(4);
  });
});

describe('disposeDimensionGroup', () => {
  it('disposes geometries and sprite materials, keeps the shared line material, detaches the group', () => {
    const wall = createLedWall({ cols: 2, rows: 1 });
    const g = buildWallDimensions(fixture(wall));
    const parent = new THREE.Group();
    parent.add(g);

    let geomDisposed = 0, spriteMatDisposed = 0;
    const lineMat = lines(g)[0].material as THREE.Material;
    let lineMatDisposed = 0;
    lineMat.addEventListener('dispose', () => lineMatDisposed++);
    for (const l of lines(g)) l.geometry.addEventListener('dispose', () => geomDisposed++);
    for (const s of sprites(g)) s.material.addEventListener('dispose', () => spriteMatDisposed++);

    disposeDimensionGroup(g);
    expect(geomDisposed).toBe(2);
    expect(spriteMatDisposed).toBe(2);
    expect(lineMatDisposed).toBe(0);
    expect(g.children.length).toBe(0);
    expect(parent.children.length).toBe(0);
  });
});

describe('dimensionPiecesOf', () => {
  it('flattens lines and labels to world space, skipping hidden ones', () => {
    const parent = new THREE.Group();
    parent.position.set(10, 0, -5);
    parent.rotation.y = Math.PI / 2;
    const g = new THREE.Group();
    parent.add(g);
    const seg = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 2, 0),
    ]));
    const strip = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 3, 1),
    ]));
    const hidden = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 1, 1)]));
    hidden.visible = false;
    const label = createLabelSprite('125.9"', { heightIn: 6 });
    label.position.set(2, 1, 0);
    g.add(seg, strip, hidden, label);
    parent.updateWorldMatrix(true, true);

    const p = dimensionPiecesOf(g);
    // Two pieces from the LineSegments, two from the strip; nothing from the hidden one.
    expect(p.segs.length).toBe(4 * 6);
    // (4,0,0) turned a quarter about y lands at (0,0,-4), then moves by the parent's offset.
    expect(p.segs.slice(3, 6).map(n => +n.toFixed(9) + 0)).toEqual([10, 0, -9]);
    expect(p.labels).toHaveLength(1);
    expect(p.labels[0].text).toBe('125.9"');
    expect(p.labels[0].h).toBe(6);
    expect(p.labels[0].p.map(n => +n.toFixed(9) + 0)).toEqual([10, 1, -7]);
  });
});
