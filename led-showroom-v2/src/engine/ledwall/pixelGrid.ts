/**
 * LED pixel-structure overlay ("pixel grid").
 *
 * An analytic, moiré-free grid drawn over each straight segment of an LED wall. One
 * `PlaneGeometry` per segment carries a `ShaderMaterial` that paints a black line at every
 * LED-pixel boundary (cols·pxW × rows·pxH cells) using Inigo Quilez's filtered-grid
 * integral, so each fragment gets the exact fraction of its footprint covered by a line at
 * any zoom or viewing angle (no smoothstep interference bands).
 *
 * Ported from v1 `index.html`:
 *  - `makePixelGridMat`           (3254-3328) → {@link makePixelGridMaterial}
 *  - `buildCellMaskTex`           (3330-3354) → {@link buildCellMaskTexture}
 *  - `buildPixelGrid` placement   (4132-4198) → {@link gridPlaneForSegment}, {@link gridPlaneOffsetIn}
 *  - `checkGridAutoVisibility`    (3685-3741) → {@link gridOpacityForDistance}
 *  - `distanceToSelectedWall`     (3651-3662) → {@link perpendicularDistanceToFace}
 *  - `gridBrightnessCompensation` (7584-7599) → {@link brightnessCompensation}
 *
 * three.js only — no DOM. Everything that is not a material/texture factory is pure.
 */
import * as THREE from 'three';
import { clamp, type Vec3 } from '@/engine/math';
import type { PanelSpec } from './specs';
import type { Corner } from '@/engine/document/types';
import { miterCutsForColumn, type WallDims, type ColumnPlacement, type Segment } from './layout';

/* ───────────────────────────── Constants ───────────────────────────── */

/** three.js layer the grid planes live on, so it can be toggled per camera (v1 `mesh.layers.set(1)`). */
export const PIXEL_GRID_LAYER = 1;

/** Render order for grid planes; they are drawn last, on top of all content layers (v1 `renderOrder = 1000`). */
export const PIXEL_GRID_RENDER_ORDER = 1000;

/**
 * Physical width of one grid line in inches: 0.36 mm, the real inter-pixel gap
 * (1.86 mm pitch − 1.5 mm LED package).
 */
export const GRID_LINE_IN = 0.36 / 25.4;

/**
 * Fraction of the screen the grid lines cover when fully opaque. Content brightness is
 * boosted by 1 / (1 − GRID_COVERAGE·opacity) so apparent brightness stays constant.
 */
export const GRID_COVERAGE = 0.351;

/**
 * The grid fades in over this many inches *beyond* the threshold: opacity is 0 at
 * `threshold + band`, 1 at `threshold` and closer.
 */
export const GRID_FADE_BAND_IN = 36;

/** Selectable auto-visibility thresholds (inches): 6, 8, 10, 12 ft. */
export const GRID_THRESHOLD_OPTIONS_IN = [72, 96, 120, 144] as const;

/** Default threshold (6 ft). */
export const GRID_THRESHOLD_DEFAULT_IN = 72;

/**
 * How far the grid plane floats in front of the screen face, in inches. v1 placed the
 * plane at `PANEL_D_IN/2 + 0.06` from the wall mid-plane (= 1.06 in with v1's 2 in panel depth;
 * the CAD's 1.77 in depth supersedes it — 0.945 in for the iPoster);
 * expressed relative to the face that is a 0.06 in stand-off so the plane clears every
 * content layer without visible parallax.
 */
export const GRID_PLANE_STANDOFF_IN = 0.06;

/* ───────────────────────────── Material ───────────────────────────── */

export interface PixelGridMaterialOptions {
  /** Panel columns in this segment. */
  cols: number;
  /** Panel rows in this segment. */
  rows: number;
  /** Bezel gap between panels in inches (0 when bezels are hidden). */
  gapIn: number;
  /** Panel product (pixel counts and face size). */
  spec: PanelSpec;
  /** Optional per-panel-cell mask from {@link buildCellMaskTexture}; `null` for rectangular segments. */
  maskTex?: THREE.DataTexture | null;
  /**
   * Signed miter extension of the plane's left/right edge beyond the nominal panel bbox,
   * in inches (positive = the plane is wider than the panels). Lets the plane cover a
   * mitered front face while the pixel pitch stays true. Default 0.
   */
  extendLeftIn?: number;
  extendRightIn?: number;
}

/** Uniform block of a pixel-grid material (typed view of `material.uniforms`). A type literal (not an interface) so it satisfies three's `{ [uniform: string]: IUniform }`. */
export type PixelGridUniforms = {
  /** Line colour (black). */
  uColor: THREE.IUniform<THREE.Color>;
  /** Global fade 0..1 driven by {@link gridOpacityForDistance}. */
  uOpacity: THREE.IUniform<number>;
  /** Physical line width in inches ({@link GRID_LINE_IN}). */
  uLineIn: THREE.IUniform<number>;
  /** LED cells across the segment: (cols·pxW, rows·pxH). */
  uCells: THREE.IUniform<THREE.Vector2>;
  /** Panel face size in inches (widthIn, heightIn). */
  uPanelSizeIn: THREE.IUniform<THREE.Vector2>;
  /** Bezel gap in inches. */
  uGapIn: THREE.IUniform<number>;
  /** Panel cell counts (cols, rows) for the mask lookup. */
  uPanelCells: THREE.IUniform<THREE.Vector2>;
  /** Physical size of the plane the material is drawn on, in inches. */
  uPlaneSizeIn: THREE.IUniform<THREE.Vector2>;
  /** Inch offset from the plane's bottom-left corner to the nominal bbox's bottom-left corner. */
  uOriginIn: THREE.IUniform<THREE.Vector2>;
  /** Per-panel-cell mask (RED, 255 = filled). */
  uMask: THREE.IUniform<THREE.Texture | null>;
  /** 1 when `uMask` is bound, else 0. */
  uHasMask: THREE.IUniform<number>;
};

/** A {@link THREE.ShaderMaterial} whose `uniforms` are known to be {@link PixelGridUniforms}. */
export type PixelGridMaterial = THREE.ShaderMaterial & { uniforms: PixelGridUniforms };

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Fragment shader.
 *
 * Coordinates: `vUv` spans the plane; `posIn = vUv·uPlaneSizeIn − uOriginIn` is the
 * position in inches relative to the nominal bbox origin (bottom-left of the lowest-left
 * panel). The bbox is `uPanelCells·uPanelSizeIn + (uPanelCells−1)·uGapIn` inches and, as in
 * v1, is divided *uniformly* into `uCells` LED cells (bezel gaps are absorbed into the cell
 * pitch so adjacent panels share continuous lines with no delineation).
 *
 * Line coverage per axis (Quilez filtered grid): a line of width 2h (cell units) centred on
 * every integer. `F(y) = floor(y)·2h + min(fract(y), 2h)` is the integral of the line
 * indicator; the coverage of the fragment footprint `[t − d/2, t + d/2]` (d = fwidth) is
 * `(F(b) − F(a)) / d` with the half-line shift `+h`. It asymptotes to the line density 2h
 * when the footprint spans many cells, so no interference bands form. The two axes are
 * combined with `cx + cy − cx·cy` (union of independent coverages).
 *
 * Mask: for custom shapes the panel cell `floor(posIn / (bbox / uPanelCells))` is looked up
 * in `uMask` (nearest, clamped) and the fragment is discarded when unfilled. As in v1
 * (`floor(vUv * uPanelCells)`) the bbox is split *uniformly* into `uPanelCells` cells, so the
 * cell boundary sits at `k·bbox/cols` (inside the k-th bezel gap) rather than at
 * `k·(panelW + gap)`; with no extensions this is byte-exact v1. Cells outside the nominal
 * bbox (miter extensions) clamp to the edge cell.
 *
 * `fwidth` is core in WebGL2 (three r185 targets WebGL2 only), so no derivatives extension
 * flag is needed — v1's `extensions: { derivatives: true }` no longer exists.
 */
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uLineIn;
uniform vec2 uCells;
uniform vec2 uPanelSizeIn;
uniform float uGapIn;
uniform vec2 uPanelCells;
uniform vec2 uPlaneSizeIn;
uniform vec2 uOriginIn;
uniform sampler2D uMask;
uniform float uHasMask;

float F(float y, float twoH) {
  return floor(y) * twoH + min(fract(y), twoH);
}
float axisCoverage(float t, float halfWidth) {
  float d = max(fwidth(t), 1e-6);
  float twoH = 2.0 * halfWidth;
  float a = t - 0.5 * d + halfWidth;
  float b = t + 0.5 * d + halfWidth;
  return clamp((F(b, twoH) - F(a, twoH)) / d, 0.0, 1.0);
}

void main() {
  vec2 posIn = vUv * uPlaneSizeIn - uOriginIn;
  vec2 bboxIn = uPanelCells * uPanelSizeIn + (uPanelCells - 1.0) * uGapIn;

  if (uHasMask > 0.5) {
    vec2 cellId = clamp(floor(posIn / (bboxIn / uPanelCells)), vec2(0.0), uPanelCells - 1.0);
    vec2 sampleUv = (cellId + 0.5) / uPanelCells;
    if (texture2D(uMask, sampleUv).r < 0.5) discard;
  }

  vec2 cellIn = bboxIn / uCells;
  vec2 uvPx = posIn / cellIn;
  vec2 halfLineCells = (0.5 * uLineIn) / cellIn;
  float cx = axisCoverage(uvPx.x, halfLineCells.x);
  float cy = axisCoverage(uvPx.y, halfLineCells.y);
  float alpha = (cx + cy - cx * cy) * uOpacity;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * Create the pixel-grid material for one straight segment of `cols × rows` panels.
 * See the fragment-shader notes above for the shading model. Transparent, depth-test off,
 * double-sided; `uOpacity` starts at 1 (v1 factory default) — drive it with
 * {@link gridOpacityForDistance}. `material.userData.isPixelGrid` is `true`.
 */
export function makePixelGridMaterial(opts: PixelGridMaterialOptions): PixelGridMaterial {
  const { cols, rows, gapIn, spec } = opts;
  const maskTex = opts.maskTex ?? null;
  const extL = opts.extendLeftIn ?? 0;
  const extR = opts.extendRightIn ?? 0;
  const totalW = cols * spec.widthIn + (cols - 1) * gapIn;
  const totalH = rows * spec.heightIn + (rows - 1) * gapIn;

  const uniforms: PixelGridUniforms = {
    uColor: { value: new THREE.Color(0x000000) },
    uOpacity: { value: 1.0 },
    uLineIn: { value: GRID_LINE_IN },
    uCells: { value: new THREE.Vector2(cols * spec.pxW, rows * spec.pxH) },
    uPanelSizeIn: { value: new THREE.Vector2(spec.widthIn, spec.heightIn) },
    uGapIn: { value: gapIn },
    uPanelCells: { value: new THREE.Vector2(cols, rows) },
    uPlaneSizeIn: { value: new THREE.Vector2(totalW + extL + extR, totalH) },
    uOriginIn: { value: new THREE.Vector2(extL, 0) },
    uMask: { value: maskTex },
    uHasMask: { value: maskTex ? 1 : 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  }) as PixelGridMaterial;
  mat.name = 'PixelGrid';
  mat.userData.isPixelGrid = true;
  return mat;
}

/* ───────────────────────────── Mask texture ───────────────────────────── */

/**
 * Build a `cols × rows` RED/8-bit mask marking which panel cells of a segment are filled
 * (255) or void (0). `cells` holds `"col,row"` keys in wall cell space with row 0 at the
 * **top**; the segment spans wall columns `startCol..endCol` inclusive.
 *
 * The texture is stored bottom-up (row 0 of the data = bottom, matching plane UV v = 0),
 * so wall row `r` is written to data row `rows − 1 − r` (v1 Y flip). Nearest filtering,
 * clamped, `needsUpdate` set.
 *
 * Returns `null` when every cell in the segment is filled (rectangular segment — no mask
 * needed), exactly as v1 did; pass the result straight to {@link makePixelGridMaterial}.
 */
export function buildCellMaskTexture(cells: ReadonlySet<string>, startCol: number, endCol: number, rows: number): THREE.DataTexture | null {
  const cols = endCol - startCol + 1;
  let needMask = false;
  for (let r = 0; r < rows && !needMask; r++) {
    for (let c = 0; c < cols && !needMask; c++) {
      if (!cells.has(`${c + startCol},${r}`)) needMask = true;
    }
  }
  if (!needMask) return null;

  const data = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const tr = rows - 1 - r;
    for (let c = 0; c < cols; c++) {
      data[tr * cols + c] = cells.has(`${c + startCol},${r}`) ? 255 : 0;
    }
  }
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** True when at least one cell of `startCol..endCol` × `rows` is in `cells` (v1 "anyFilled" segment skip). */
export function segmentHasFilledCells(cells: ReadonlySet<string>, startCol: number, endCol: number, rows: number): boolean {
  for (let c = startCol; c <= endCol; c++) {
    for (let r = 0; r < rows; r++) if (cells.has(`${c},${r}`)) return true;
  }
  return false;
}

/* ───────────────────────────── Plane placement ───────────────────────────── */

/**
 * Distance from the wall mid-plane (z = 0) to the grid plane: `panelD/2 + 0.06`.
 * v1 read 1.06 in from its 2 in panel depth; the CAD's 1.77 in depth makes it 0.945 in.
 */
export function gridPlaneOffsetIn(panelD: number): number {
  return panelD / 2 + GRID_PLANE_STANDOFF_IN;
}

/**
 * Signed front-edge miter extension at a segment's left and right ends, in inches
 * (v1 3856-3885 miter maths via `layout.miterCutsForColumn`). Positive = the front face is
 * **extended** (convex corner); negative = trimmed (concave); 0 where there is no corner.
 * Only the segment's outermost columns can carry a corner (corners split segments).
 */
export function segmentMiterExtensions(dims: WallDims, segment: Segment, corners: Corner[]): { left: number; right: number } {
  const leftCut = miterCutsForColumn(segment.startCol, dims, corners).left;
  const rightCut = miterCutsForColumn(segment.endCol, dims, corners).right;
  // MiterCut.front is the amount TRIMMED (negative = extended); flip to an extension.
  return { left: leftCut ? -leftCut.front : 0, right: rightCut ? -rightCut.front : 0 };
}

/** Result of {@link gridPlaneForSegment}. */
export interface GridPlanePlacement {
  /** Plane width in inches (segment bbox + bezel gaps + signed miter extensions). */
  width: number;
  /** Plane height in inches (wall `totalH`). */
  height: number;
  /** Plane centre in the v2 wall-local frame (floor origin, y up, screen faces +Z). */
  center: Vec3;
  /** Yaw in radians for `mesh.rotation.y`. */
  rotY: number;
  /** Signed left/right miter extension applied (inches) — pass to {@link makePixelGridMaterial}. */
  extendLeftIn: number;
  extendRightIn: number;
}

/**
 * Size and place the grid plane for one straight segment (v1 `buildPixelGrid`, 4132-4198).
 *
 * The plane covers the segment's full bbox — `n·panelW + (n−1)·gap` wide, `totalH` tall —
 * plus the signed miter extension of its front edge at each corner end, and floats
 * {@link gridPlaneOffsetIn} in front of the wall mid-plane along the segment's normal
 * `(sin rotY, 0, cos rotY)`. Its centre is the mean of the end columns' XZ positions (they
 * share `rotY`), shifted along the segment's +x direction `(cos rotY, 0, −sin rotY)` by
 * half the extension imbalance, at `y = totalH/2` (v2 floor-origin frame; v1 used y = 0).
 *
 * `ColumnPlacement.rotY` is radians, as v1's `computeColumnLayout` produced.
 */
export function gridPlaneForSegment(
  dims: WallDims,
  layout: readonly ColumnPlacement[],
  segment: Segment,
  corners: Corner[],
): GridPlanePlacement {
  const segCols = segment.endCol - segment.startCol + 1;
  const segW = segCols * dims.panelW + (segCols - 1) * dims.gap;
  const { left: extL, right: extR } = segmentMiterExtensions(dims, segment, corners);

  const first = layout[segment.startCol];
  const last = layout[segment.endCol];
  if (!first || !last) throw new Error(`gridPlaneForSegment: segment ${segment.startCol}..${segment.endCol} outside layout of ${layout.length} columns`);
  const rotY = first.rotY;
  const sin = Math.sin(rotY), cos = Math.cos(rotY);
  const off = gridPlaneOffsetIn(dims.panelD);
  const shift = (extR - extL) / 2;

  const cx = (first.x + last.x) / 2 + off * sin + shift * cos;
  const cz = (first.z + last.z) / 2 + off * cos - shift * sin;

  return {
    width: segW + extL + extR,
    height: dims.totalH,
    center: [cx, dims.totalH / 2, cz],
    rotY,
    extendLeftIn: extL,
    extendRightIn: extR,
  };
}

/* ───────────────────────────── Auto-visibility ───────────────────────────── */

/**
 * Grid opacity for a camera `distIn` inches from the selected wall's front face
 * (v1 `checkGridAutoVisibility`, 3685-3741): 1 at or inside `thresholdIn`, linear fade to
 * 0 at `thresholdIn + GRID_FADE_BAND_IN`, 0 beyond. Callers may drop the grid meshes
 * entirely once this returns 0.
 */
export function gridOpacityForDistance(distIn: number, thresholdIn: number = GRID_THRESHOLD_DEFAULT_IN): number {
  const fadeStart = thresholdIn + GRID_FADE_BAND_IN;
  // Negated "in band" test as in v1 (`inBand = camDist <= fadeStart`): a NaN distance
  // fails the comparison and yields 0 instead of leaking NaN into uOpacity.
  if (!(distIn <= fadeStart)) return 0;
  return clamp((fadeStart - distIn) / GRID_FADE_BAND_IN, 0, 1);
}

/**
 * Perpendicular distance from a camera to a wall's screen face, in world inches
 * (v1 `distanceToSelectedWall`, 3651-3662). `localZ` is the camera position's z in the
 * wall's local frame (mid-plane at z = 0), `scale` the wall's uniform scale. Never negative.
 */
export function perpendicularDistanceToFace(localZ: number, panelD: number, scale = 1): number {
  return Math.max(0, (Math.abs(localZ) - panelD / 2) * scale);
}

/**
 * Content brightness multiplier that cancels the darkening of the grid lines:
 * `1 / (1 − GRID_COVERAGE·gridOpacity)` (v1 `gridBrightnessCompensation`, 7584-7599).
 * 1 with no grid, ≈1.541 fully opaque; clamped against division by zero.
 */
export function brightnessCompensation(gridOpacity: number): number {
  return 1 / Math.max(0.001, 1 - GRID_COVERAGE * gridOpacity);
}

/* ───────────────────────────── Disposal ───────────────────────────── */

/**
 * Release a grid material and its mask texture (v1 4134-4143). If `maskTex` is omitted the
 * texture bound to `uMask` is disposed instead.
 */
export function disposePixelGrid(material: THREE.ShaderMaterial, maskTex?: THREE.Texture | null): void {
  const tex = maskTex ?? (material.uniforms?.uMask?.value as THREE.Texture | null | undefined);
  if (tex) tex.dispose();
  material.dispose();
}
