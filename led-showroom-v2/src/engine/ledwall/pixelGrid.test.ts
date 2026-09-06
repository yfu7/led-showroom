import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { IPOSTER } from './specs';
import { wallDims, computeColumnLayout, computeSegments, type ColumnPlacement, type WallDims } from './layout';
import {
  PIXEL_GRID_LAYER,
  PIXEL_GRID_RENDER_ORDER,
  GRID_LINE_IN,
  GRID_COVERAGE,
  GRID_FADE_BAND_IN,
  GRID_THRESHOLD_OPTIONS_IN,
  GRID_THRESHOLD_DEFAULT_IN,
  makePixelGridMaterial,
  buildCellMaskTexture,
  segmentHasFilledCells,
  gridPlaneOffsetIn,
  segmentMiterExtensions,
  gridPlaneForSegment,
  gridOpacityForDistance,
  perpendicularDistanceToFace,
  brightnessCompensation,
  disposePixelGrid,
} from './pixelGrid';

const W = IPOSTER.widthIn, H = IPOSTER.heightIn, GAP = IPOSTER.gapIn;
/* CAD panel depth 1.77 in (44.958 mm): half-depth 0.885 in, grid standoff 0.945 in (v1: 1 / 1.06). */
const HD = IPOSTER.depthIn / 2;
const OFF = HD + 0.06;

function dims(cols: number, rows: number, bezels = true): WallDims {
  return wallDims({ cols, rows, bezels, product: IPOSTER.id });
}

/** Straight wall layout in the v2 frame: columns centred on x = 0, z = 0, rotY = 0. */
function straightLayout(cols: number, gap = GAP): ColumnPlacement[] {
  const totalW = cols * W + (cols - 1) * gap;
  return Array.from({ length: cols }, (_, c) => ({ col: c, x: -totalW / 2 + W / 2 + c * (W + gap), z: 0, rotY: 0 }));
}

describe('constants', () => {
  it('match v1', () => {
    expect(PIXEL_GRID_LAYER).toBe(1);
    expect(PIXEL_GRID_RENDER_ORDER).toBe(1000);
    expect(GRID_LINE_IN).toBeCloseTo(0.014173, 6);
    expect(GRID_COVERAGE).toBe(0.351);
    expect(GRID_FADE_BAND_IN).toBe(36);
    expect([...GRID_THRESHOLD_OPTIONS_IN]).toEqual([72, 96, 120, 144]);
    expect(GRID_THRESHOLD_DEFAULT_IN).toBe(72);
    expect(gridPlaneOffsetIn(IPOSTER.depthIn)).toBeCloseTo(OFF, 12);
    expect(gridPlaneOffsetIn(IPOSTER.depthIn)).toBeCloseTo(0.945, 9); // v1: 1.06, from its 2 in depth
  });
});

describe('makePixelGridMaterial', () => {
  it('sets the uniforms for a 2x3 segment with bezels', () => {
    const m = makePixelGridMaterial({ cols: 2, rows: 3, gapIn: GAP, spec: IPOSTER });
    const u = m.uniforms;
    expect(u.uOpacity.value).toBe(1);
    expect(u.uLineIn.value).toBeCloseTo(0.36 / 25.4, 9);
    expect(u.uCells.value.x).toBe(2 * 344);
    expect(u.uCells.value.y).toBe(3 * 258);
    expect(u.uPanelSizeIn.value.x).toBe(W);
    expect(u.uPanelSizeIn.value.y).toBe(H);
    expect(u.uGapIn.value).toBe(GAP);
    expect(u.uPanelCells.value.x).toBe(2);
    expect(u.uPanelCells.value.y).toBe(3);
    expect(u.uPlaneSizeIn.value.x).toBeCloseTo(2 * W + GAP, 9);
    expect(u.uPlaneSizeIn.value.y).toBeCloseTo(3 * H + 2 * GAP, 9);
    expect(u.uOriginIn.value.x).toBe(0);
    expect(u.uOriginIn.value.y).toBe(0);
    expect(u.uMask.value).toBeNull();
    expect(u.uHasMask.value).toBe(0);
    expect(u.uColor.value.getHex()).toBe(0x000000);

    expect(m.transparent).toBe(true);
    expect(m.depthTest).toBe(false);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.userData.isPixelGrid).toBe(true);
    expect(m.fragmentShader).toContain('fwidth');
    expect(m.fragmentShader).toContain('uMask');
  });

  it('binds a mask texture and applies miter extensions', () => {
    const cells = new Set(['0,0', '0,1', '1,1']);
    const tex = buildCellMaskTexture(cells, 0, 1, 2)!;
    const m = makePixelGridMaterial({ cols: 2, rows: 2, gapIn: 0, spec: IPOSTER, maskTex: tex, extendLeftIn: 1, extendRightIn: -0.5 });
    expect(m.uniforms.uMask.value).toBe(tex);
    expect(m.uniforms.uHasMask.value).toBe(1);
    expect(m.uniforms.uPlaneSizeIn.value.x).toBeCloseTo(2 * W + 0.5, 9);
    expect(m.uniforms.uOriginIn.value.x).toBe(1);
    expect(m.uniforms.uGapIn.value).toBe(0);
  });

  it('looks the mask cell up with the v1 bbox-uniform split (bbox / uPanelCells)', () => {
    const m = makePixelGridMaterial({ cols: 2, rows: 1, gapIn: GAP, spec: IPOSTER });
    expect(m.fragmentShader).toContain('floor(posIn / (bboxIn / uPanelCells))');
    expect(m.fragmentShader).not.toContain('posIn / (uPanelSizeIn + uGapIn)');
  });
});

describe('buildCellMaskTexture', () => {
  it('returns null for a fully filled (rect) segment', () => {
    const cells = new Set(['0,0', '1,0', '0,1', '1,1']);
    expect(buildCellMaskTexture(cells, 0, 1, 2)).toBeNull();
  });

  it('writes an L-shape bottom-up (Y flip)', () => {
    // 2 cols x 3 rows, wall row 0 at top:  X .
    //                                      X .
    //                                      X X
    const cells = new Set(['0,0', '0,1', '0,2', '1,2']);
    const tex = buildCellMaskTexture(cells, 0, 1, 3)!;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex.image.width).toBe(2);
    expect(tex.image.height).toBe(3);
    expect(tex.format).toBe(THREE.RedFormat);
    expect(tex.type).toBe(THREE.UnsignedByteType);
    expect(tex.minFilter).toBe(THREE.NearestFilter);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.flipY).toBe(false);
    // data row 0 = wall row 2 (bottom), data row 2 = wall row 0 (top)
    expect(Array.from(tex.image.data as Uint8Array)).toEqual([255, 255, 255, 0, 255, 0]);
  });

  it('offsets by startCol for a segment in the middle of a wall', () => {
    const cells = new Set(['2,0', '3,1']);
    const tex = buildCellMaskTexture(cells, 2, 3, 2)!;
    // row 1 (bottom) -> data row 0: [0, 255]; row 0 (top) -> data row 1: [255, 0]
    expect(Array.from(tex.image.data as Uint8Array)).toEqual([0, 255, 255, 0]);
  });

  it('segmentHasFilledCells detects empty segments', () => {
    const cells = new Set(['0,0', '0,1']);
    expect(segmentHasFilledCells(cells, 0, 0, 2)).toBe(true);
    expect(segmentHasFilledCells(cells, 1, 2, 2)).toBe(false);
  });
});

describe('segmentMiterExtensions', () => {
  it('extends for convex, trims for concave, 0 without a corner', () => {
    const d = dims(3, 1);
    const seg = { startCol: 1, endCol: 1 };
    expect(segmentMiterExtensions(d, seg, [])).toEqual({ left: 0, right: 0 });
    // A 90 deg corner extends by (panelD/2)·tan(45 deg) = D/2.
    const conv = segmentMiterExtensions(d, seg, [{ afterCol: 0, angle: 90 }, { afterCol: 1, angle: 45 }]);
    expect(conv.left).toBeCloseTo(HD, 9);
    expect(conv.right).toBeCloseTo(HD * Math.tan(Math.PI / 8), 9);
    const conc = segmentMiterExtensions(d, seg, [{ afterCol: 0, angle: -90 }]);
    expect(conc.left).toBeCloseTo(-HD, 9);
    expect(conc.right).toBe(0);
    // v1 quirk: -270 folds like +90 and the negative tan makes it extend as well.
    expect(segmentMiterExtensions(d, seg, [{ afterCol: 1, angle: -270 }]).right).toBeCloseTo(HD, 9);
  });
});

describe('gridPlaneForSegment', () => {
  it('covers a straight 3x2 wall and floats panelD/2 + 0.06 in in front of the mid-plane at y = totalH/2', () => {
    const d = dims(3, 2);
    const p = gridPlaneForSegment(d, straightLayout(3), { startCol: 0, endCol: 2 }, []);
    expect(p.width).toBeCloseTo(3 * W + 2 * GAP, 9);
    expect(p.height).toBeCloseTo(d.totalH, 9);
    expect(p.center[0]).toBeCloseTo(0, 9);
    expect(p.center[1]).toBeCloseTo(d.totalH / 2, 9);
    expect(p.center[2]).toBeCloseTo(IPOSTER.depthIn / 2 + 0.06, 9);
    expect(p.rotY).toBe(0);
    expect(p.extendLeftIn).toBe(0);
    expect(p.extendRightIn).toBe(0);
  });

  it('follows a rotated column along its normal', () => {
    const d = dims(1, 1, false);
    const rotY = Math.PI / 2; // normal = (+1, 0, 0)
    const p = gridPlaneForSegment(d, [{ col: 0, x: 10, z: -5, rotY }], { startCol: 0, endCol: 0 }, []);
    expect(p.center[0]).toBeCloseTo(10 + OFF, 9);
    expect(p.center[2]).toBeCloseTo(-5, 9);
    expect(p.rotY).toBe(rotY);
  });

  it('adds convex miter extensions and shifts the centre by half the imbalance', () => {
    const d = dims(2, 1, false);
    // 90 deg corner after column 0: segment A = col 0 (rotY 0), segment B = col 1 (rotY 90 deg).
    const layout: ColumnPlacement[] = [{ col: 0, x: -6, z: 0, rotY: 0 }, { col: 1, x: 6, z: -12, rotY: Math.PI / 2 }];
    const corners = [{ afterCol: 0, angle: 90 }];

    const a = gridPlaneForSegment(d, layout, { startCol: 0, endCol: 0 }, corners);
    expect(a.extendLeftIn).toBe(0);
    expect(a.extendRightIn).toBeCloseTo(HD, 9);
    expect(a.width).toBeCloseTo(W + HD, 9);
    expect(a.center[0]).toBeCloseTo(-6 + HD / 2, 9);   // +x by half the right extension
    expect(a.center[2]).toBeCloseTo(OFF, 9);

    const b = gridPlaneForSegment(d, layout, { startCol: 1, endCol: 1 }, corners);
    expect(b.extendLeftIn).toBeCloseTo(HD, 9);
    expect(b.extendRightIn).toBe(0);
    expect(b.width).toBeCloseTo(W + HD, 9);
    // local +x for rotY = 90 deg is (0, 0, -1); shift = -HD/2 -> z += HD/2; normal (+1,0,0) -> x += OFF
    expect(b.center[0]).toBeCloseTo(6 + OFF, 9);
    expect(b.center[2]).toBeCloseTo(-12 + HD / 2, 9);
  });

  it('trims for concave corners', () => {
    const d = dims(2, 1, false);
    const layout: ColumnPlacement[] = [{ col: 0, x: -6, z: 0, rotY: 0 }, { col: 1, x: 6, z: 12, rotY: -Math.PI / 2 }];
    const a = gridPlaneForSegment(d, layout, { startCol: 0, endCol: 0 }, [{ afterCol: 0, angle: -90 }]);
    expect(a.extendRightIn).toBeCloseTo(-HD, 9);
    expect(a.width).toBeCloseTo(W - HD, 9);
    expect(a.center[0]).toBeCloseTo(-6 - HD / 2, 9);
  });

  it('works end-to-end with layout.computeColumnLayout / computeSegments on a 4x2 wall with a 90 deg corner', () => {
    const d = dims(4, 2);
    const corners = [{ afterCol: 1, angle: 90 }];
    const layout = computeColumnLayout(d, corners);
    const segments = computeSegments(d.cols, corners);
    expect(segments).toEqual([{ startCol: 0, endCol: 1 }, { startCol: 2, endCol: 3 }]);

    const [a, b] = segments.map(s => gridPlaneForSegment(d, layout, s, corners));
    // Both planes: two panels + one bezel gap + one D/2-in convex extension, full wall height.
    expect(a.width).toBeCloseTo(2 * W + GAP + HD, 9);
    expect(b.width).toBeCloseTo(2 * W + GAP + HD, 9);
    expect(a.height).toBeCloseTo(d.totalH, 9);
    expect(a.center[1]).toBeCloseTo(d.totalH / 2, 9);
    expect(a.rotY).toBe(0);
    expect(b.rotY).toBeCloseTo(Math.PI / 2, 12);
    // Segment A faces +Z: its plane is OFF in front of its columns' z.
    expect(a.center[2]).toBeCloseTo(layout[0].z + OFF, 9);
    expect(a.center[0]).toBeCloseTo((layout[0].x + layout[1].x) / 2 + HD / 2, 9);
    // Segment B faces +X: its plane is OFF in +X of its columns' x, and its
    // left extension shifts the centre HD/2 against its walk direction (-Z), i.e. +Z.
    expect(b.center[0]).toBeCloseTo((layout[2].x + layout[3].x) / 2 + OFF, 9);
    expect(b.center[2]).toBeCloseTo((layout[2].z + layout[3].z) / 2 + HD / 2, 9);
  });

  it('throws for a segment outside the layout', () => {
    expect(() => gridPlaneForSegment(dims(1, 1), straightLayout(1), { startCol: 0, endCol: 3 }, [])).toThrow();
  });
});

describe('gridOpacityForDistance', () => {
  it('is 1 at/inside the threshold, fades linearly over the band, 0 beyond', () => {
    expect(gridOpacityForDistance(0, 72)).toBe(1);
    expect(gridOpacityForDistance(72, 72)).toBe(1);
    expect(gridOpacityForDistance(90, 72)).toBeCloseTo(0.5, 9);
    expect(gridOpacityForDistance(108, 72)).toBe(0);
    expect(gridOpacityForDistance(500, 72)).toBe(0);
    // other thresholds
    expect(gridOpacityForDistance(144, 144)).toBe(1);
    expect(gridOpacityForDistance(153, 144)).toBeCloseTo(0.75, 9);
    expect(gridOpacityForDistance(181, 144)).toBe(0);
    // default threshold is 72
    expect(gridOpacityForDistance(90)).toBeCloseTo(0.5, 9);
  });

  it('returns 0 (not NaN) for a NaN / non-finite distance, as v1 did', () => {
    expect(gridOpacityForDistance(NaN, 72)).toBe(0);
    expect(gridOpacityForDistance(NaN)).toBe(0);
    expect(gridOpacityForDistance(Infinity, 72)).toBe(0);
    expect(gridOpacityForDistance(-Infinity, 72)).toBe(1);
  });
});

describe('perpendicularDistanceToFace', () => {
  it('measures from the front face, never negative, scaled', () => {
    expect(perpendicularDistanceToFace(50, 2)).toBe(49);
    expect(perpendicularDistanceToFace(-50, 2)).toBe(49);
    expect(perpendicularDistanceToFace(0.5, 2)).toBe(0);
    expect(perpendicularDistanceToFace(50, 2, 2)).toBe(98);
  });
});

describe('brightnessCompensation', () => {
  it('is 1 with no grid and 1/(1-0.351) fully opaque', () => {
    expect(brightnessCompensation(0)).toBe(1);
    expect(brightnessCompensation(1)).toBeCloseTo(1 / 0.649, 9);
    expect(brightnessCompensation(0.5)).toBeCloseTo(1 / (1 - 0.1755), 9);
  });
});

describe('disposePixelGrid', () => {
  it('disposes the material and the bound mask texture', () => {
    const tex = buildCellMaskTexture(new Set(['0,0']), 0, 1, 1)!;
    const m = makePixelGridMaterial({ cols: 2, rows: 1, gapIn: 0, spec: IPOSTER, maskTex: tex });
    const texSpy = vi.spyOn(tex, 'dispose');
    const matSpy = vi.spyOn(m, 'dispose');
    disposePixelGrid(m);
    expect(texSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
  });
});
