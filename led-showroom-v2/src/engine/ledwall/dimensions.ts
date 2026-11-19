/**
 * Engineering-drawing style dimension annotations for LED walls (three.js).
 *
 * Port of v1 `createDimSprite` (index.html 4202-4236), the per-frame sprite distance
 * compensation (3790-3800), `buildCustomShapeDimensions` (4308-4413) and the rect-wall part of
 * `buildDimensions` (4415-4550).
 *
 * Everything built here lives in the WALL-LOCAL frame of v2: the origin is on the floor at the
 * horizontal centre of the wall, `y = 0` is the bottom edge of the lowest panel row, `y = totalH`
 * is the top, the screen faces +Z and the front face of the panels is at `z = +panelD / 2`.
 * (v1 centred the wall vertically; every `±totalH/2` of v1 becomes `0` / `totalH` here.)
 *
 * Label sprites need a 2D canvas. When `document` is not available (node tests, workers) a
 * map-less fallback sprite is produced so the geometry and scaling logic still runs.
 */
import * as THREE from 'three';
import type { LedWallEntity } from '../document/types';
import { formatLength, type Unit } from '../units';
import {
  computeShapeEdgeRuns,
  filledCells,
  isRectWall,
  type ColumnPlacement,
  type EdgeRun,
  type Segment,
  type WallDims,
} from './layout';

/* ───────────────────────────── Constants (v1 values) ───────────────────────────── */

/** v1 `DIMENSION_RENDER_ORDER` (index.html 2145): dimensions draw after everything else. */
export const DIMENSION_RENDER_ORDER = 999;

/**
 * Distance in front of the panel face at which dimension geometry is drawn.
 * v1 hard-coded `zFront = PANEL_D_IN / 2 + 0.15` = 1.15 in from its 2 in panel depth (the CAD's
 * 1.77 in depth supersedes it: 1.035 in); v2 keeps the 0.15 in stand-off and
 * derives the half depth from `dims.panelD` (the WallDims the wall geometry is drawn from).
 */
export const DIMENSION_Z_STANDOFF_IN = 0.15;

/** Line colour of the v1 `dimLineMat` (index.html 3234). */
export const DIMENSION_LINE_COLOR = 0x00bbff;
/** Text colour of the v1 dimension sprite (index.html 4220). */
export const DIMENSION_TEXT_COLOR = '#00ccff';
/** Background of the v1 dimension sprite (index.html 4215). */
export const DIMENSION_LABEL_BACKGROUND = 'rgba(0, 0, 0, 0.8)';

/** v1 label sprite: font size in canvas px, padding, base world height (inches). */
const LABEL_FONT_PX = 56;
const LABEL_PAD_PX = 20;
const LABEL_CORNER_RADIUS_PX = 10;
const LABEL_BASE_HEIGHT_IN = 6;
const LABEL_FONT_FAMILY = '"Courier New", monospace';

/** v1 distance compensation: `scale = max(0.4, camDist / 200)` (index.html 3792-3794). */
const LABEL_REF_DIST_IN = 200;
const LABEL_MIN_SCALE = 0.4;

/** Rect-wall dimension layout constants (index.html 4437-4444, 4498). */
const RECT = {
  /** Distance below the wall bottom to the width dimension line. */
  dimDrop: 4,
  /** Gap between the wall edge and the start of an extension line. */
  extGap: 1,
  /** How far extension lines run past the dimension line. */
  extOvershoot: 1.5,
  /** Half length of the serif ticks at each end of the dimension line. */
  tickHalf: 0.8,
  /** Distance left of the first segment to the height dimension line. */
  hOffset: 4,
  /** Label offset beyond the dimension line. */
  labelOffset: 2.5,
} as const;

/** Custom-shape dimension layout constants (index.html 4313-4317, 4370, 4405). */
const CUSTOM = {
  /** Inches from a panel edge to its dimension line. */
  offset: 3.0,
  tickHalf: 0.8,
  extGap: 0.8,
  extOvershoot: 0.6,
  labelOffset: 1.6,
} as const;

/**
 * Shared line material for every dimension line (v1 `dimLineMat`, created once and reused across
 * rebuilds). `disposeDimensionGroup` deliberately does not dispose it.
 */
export const dimensionLineMaterial = new THREE.LineBasicMaterial({ color: DIMENSION_LINE_COLOR, depthTest: false });

/* ───────────────────────────── Label sprites ───────────────────────────── */

export interface LabelSpriteOptions {
  /** Text colour (CSS). Default v1 cyan `#00ccff`. */
  color?: string;
  /** Background fill (CSS). Default translucent black `rgba(0, 0, 0, 0.8)`. */
  background?: string;
  /** Font size in canvas pixels. Default 56 (v1). */
  fontPx?: number;
  /** Sprite height in world inches before distance compensation. Default 6 (v1). */
  heightIn?: number;
}

/** Sprite `userData` written by `createLabelSprite`; read by `updateLabelSpriteScale` and tests. */
export interface LabelSpriteUserData {
  /** Base sprite height in inches (v1 `dimBaseH`). */
  dimBaseH: number;
  /** Canvas width / height (v1 `dimAspect`). */
  dimAspect: number;
  /** The label text, kept so callers/tests can inspect it without decoding the texture. */
  label: string;
  /** True when the sprite has a real canvas texture (false in the node fallback). */
  hasCanvas: boolean;
}

/** Return true when a 2D canvas can be created in this environment. */
function canUseCanvas(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/**
 * Approximate canvas size for a label without a canvas (node fallback). Monospace glyphs are
 * about 0.6 em wide, so the estimate tracks the real measurement closely.
 */
function estimateLabelSize(text: string, fontPx: number): { width: number; height: number } {
  return {
    width: Math.ceil(text.length * fontPx * 0.6 + LABEL_PAD_PX * 2),
    height: Math.ceil(fontPx * 1.4 + LABEL_PAD_PX * 2),
  };
}

/**
 * Create a camera-facing text label (v1 `createDimSprite`, index.html 4202-4236): bold monospace
 * text on a translucent dark rounded rectangle, `depthTest` off, render order 999. The sprite is
 * sized to `heightIn` inches tall with the canvas aspect ratio; `userData` carries
 * `{ dimBaseH, dimAspect, label, hasCanvas }` for `updateLabelSpriteScale`.
 *
 * Without a DOM (`typeof document === 'undefined'`) a map-less sprite of the same size is returned
 * so geometry code can run in node.
 */
export function createLabelSprite(text: string, opts: LabelSpriteOptions = {}): THREE.Sprite {
  const color = opts.color ?? DIMENSION_TEXT_COLOR;
  const background = opts.background ?? DIMENSION_LABEL_BACKGROUND;
  const fontPx = opts.fontPx ?? LABEL_FONT_PX;
  const baseH = opts.heightIn ?? LABEL_BASE_HEIGHT_IN;
  const font = `bold ${fontPx}px ${LABEL_FONT_FAMILY}`;

  let width: number;
  let height: number;
  let map: THREE.Texture | null = null;

  const ctx = canUseCanvas() ? document.createElement('canvas').getContext('2d') : null;
  if (ctx) {
    const canvas = ctx.canvas;
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    width = canvas.width = Math.ceil(tw + LABEL_PAD_PX * 2);
    height = canvas.height = Math.ceil(fontPx * 1.4 + LABEL_PAD_PX * 2);

    ctx.fillStyle = background;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(0, 0, width, height, LABEL_CORNER_RADIUS_PX);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, width, height);
    }

    // Font must be re-applied after resizing the canvas (resizing resets context state).
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    map = texture;
  } else {
    ({ width, height } = estimateLabelSize(text, fontPx));
  }

  const material = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
  if (!map) material.color.set(color);
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = DIMENSION_RENDER_ORDER;
  sprite.name = 'dim-label';

  const aspect = width / height;
  sprite.scale.set(baseH * aspect, baseH, 1);
  const ud: LabelSpriteUserData = { dimBaseH: baseH, dimAspect: aspect, label: text, hasCanvas: !!map };
  Object.assign(sprite.userData, ud);
  return sprite;
}

/**
 * Keep a label readable at any zoom (v1 index.html 3790-3800): the sprite is scaled by
 * `max(0.4, cameraDistance / 200)` around `baseHeightIn`, preserving the canvas aspect ratio.
 *
 * v1 measured the distance from the camera to the orbit-controls target (one scale for every
 * label). This module has no controls, so the distance is measured to the sprite's own world
 * position, which gives the same result for labels near the orbit target and a slightly better
 * one for labels far from it.
 */
export function updateLabelSpriteScale(sprite: THREE.Sprite, camera: THREE.Camera, baseHeightIn: number): void {
  const aspect = (sprite.userData as Partial<LabelSpriteUserData>).dimAspect ?? 1;
  const pos = new THREE.Vector3();
  sprite.getWorldPosition(pos);
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  const camDist = camPos.distanceTo(pos);
  const scale = Math.max(LABEL_MIN_SCALE, camDist / LABEL_REF_DIST_IN);
  const h = baseHeightIn * scale;
  sprite.scale.set(h * aspect, h, 1);
}

/* ───────────────────────────── Label text ───────────────────────────── */

/**
 * Format a length for a dimension label in the display unit.
 *
 * v1 always printed `lengthIn.toFixed(1) + '"'`, so a whole-inch length reads `201.0"` (never
 * `201"`). Inches reproduce that fixed precision exactly here; feet keep one decimal of inches via
 * `formatLength` (which trims a trailing `.0`), metric units use their default decimals.
 */
export function formatDimensionLength(inches: number, unit: Unit): string {
  if (unit === 'in') return `${inches.toFixed(1)}"`;
  return formatLength(inches, unit, unit === 'ft' ? { decimals: 1 } : {});
}

/**
 * Rect-wall label: length in the display unit plus the pixel readout, e.g. `125.9" (1720 px)`
 * (v1 index.html 4488, 4537).
 */
export function formatRectDimensionLabel(inches: number, px: number, unit: Unit): string {
  return `${formatDimensionLength(inches, unit)} (${px} px)`;
}

/**
 * Custom-shape edge label: length only, e.g. `125.9"` (v1 index.html 4360, 4403 printed
 * inches only; v2 honours the display unit).
 */
export function formatEdgeDimensionLabel(inches: number, unit: Unit): string {
  return formatDimensionLength(inches, unit);
}

/* ───────────────────────────── Geometry helpers ───────────────────────────── */

/** Build a `LineSegments` from a flat xyz point list, tagged like every v1 dimension line. */
function makeLineSegments(pts: number[], name: string): THREE.LineSegments {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geom, dimensionLineMaterial);
  lines.renderOrder = DIMENSION_RENDER_ORDER;
  lines.name = name;
  return lines;
}

/**
 * A linear dimension drawn in the XY plane at `z`: two extension lines from the measured edge,
 * the dimension line itself and a serif tick at each end. `axis: 'x'` measures a horizontal
 * span from `a` to `b` at `edge` (the y of the measured edge) with the dimension line at `line`;
 * `axis: 'y'` is the vertical equivalent. `dir` is the outward direction (+1 / -1) from the
 * edge towards the dimension line.
 */
interface LinearDimSpec {
  axis: 'x' | 'y';
  a: number;
  b: number;
  edge: number;
  line: number;
  dir: 1 | -1;
  z: number;
  extGap: number;
  extOvershoot: number;
  tickHalf: number;
}

function linearDimensionPoints(s: LinearDimSpec): number[] {
  const pts: number[] = [];
  const extStart = s.edge + s.dir * s.extGap;
  const extEnd = s.line + s.dir * s.extOvershoot;
  const push = (along: number, across: number) => {
    if (s.axis === 'x') pts.push(along, across, s.z);
    else pts.push(across, along, s.z);
  };
  // Extension lines
  push(s.a, extStart); push(s.a, extEnd);
  push(s.b, extStart); push(s.b, extEnd);
  // Dimension line
  push(s.a, s.line); push(s.b, s.line);
  // Serif ticks
  push(s.a, s.line - s.tickHalf); push(s.a, s.line + s.tickHalf);
  push(s.b, s.line - s.tickHalf); push(s.b, s.line + s.tickHalf);
  return pts;
}

/* ───────────────────────────── Builders ───────────────────────────── */

/** Where a flat run of columns sits in the wall-local frame. */
interface Frame {
  /** Centre of the run in wall-local XZ. */
  cx: number;
  cz: number;
  /** Yaw of the run (three.js `rotation.y`). */
  rotY: number;
}

/** A {@link Frame} plus the column index at its centre, so column `c` is at local x `(c - mid) * pitch`. */
interface SegmentFrame extends Frame {
  mid: number;
}

/**
 * Map a point (lx, y, lz) in a segment's local frame to wall-local coordinates. three.js
 * `rotation.y = θ` maps local +x to (cos θ, −sin θ) and local +z to (sin θ, cos θ) in XZ, so a
 * label placed through this sits in front of the segment's face however the segment is folded.
 */
function segmentToWall(f: Frame, lx: number, y: number, lz: number): THREE.Vector3 {
  const cos = Math.cos(f.rotY), sin = Math.sin(f.rotY);
  return new THREE.Vector3(f.cx + lx * cos + lz * sin, y, f.cz - lx * sin + lz * cos);
}

export interface BuildWallDimensionsArgs {
  wall: LedWallEntity;
  /** Wall dimensions (cols, rows, gap, totalW, totalH, wallWPx, wallHPx). */
  dims: WallDims;
  /** Per-column placement in the wall-local XZ plane (corners applied). */
  layout: ColumnPlacement[];
  /** Flat runs of columns between corners. Both wall kinds draw each dimension in its run's frame. */
  segments: Segment[];
  /** Display unit for labels. */
  unit: Unit;
}

/**
 * Build the dimension annotations for one LED wall as a `THREE.Group` in the wall-local frame
 * (origin on the floor at the wall's horizontal centre, screen facing +Z).
 *
 * - Rect walls (v1 `buildDimensions`, index.html 4415-4550): one width dimension below every
 *   flat segment between corners (label `125.9" (1720 px)`), plus one height dimension on the
 *   left of the first segment.
 * - Custom-shape walls (v1 `buildCustomShapeDimensions`, index.html 4308-4413): one dimension
 *   per boundary edge run from `computeShapeEdgeRuns`, offset outward along the edge normal, split
 *   at every fold so each piece lies on the face it measures.
 *
 * Every child has `renderOrder` 999 and a `depthTest: false` material. Children alternate
 * `LineSegments` (geometry) and `Sprite` (label), one pair per dimension.
 */
export function buildWallDimensions(args: BuildWallDimensionsArgs): THREE.Group {
  const { wall, dims, layout, segments, unit } = args;
  const group = new THREE.Group();
  group.name = 'dimensions';
  group.renderOrder = DIMENSION_RENDER_ORDER;

  // All panel constants come from `dims` (the single source the wall geometry is drawn from);
  // v1 read the equivalent global PANEL_* constants (index.html 4322-4324, 4437-4444, 4519).
  const zFront = dims.panelD / 2 + DIMENSION_Z_STANDOFF_IN;

  if (dims.cols <= 0 || dims.rows <= 0 || layout.length === 0) return group;

  // Same rect/custom decision as v1 (`if (_wall && !isRectWall(_wall))`, index.html 4427-4431):
  // a custom wall with no cells takes the custom path and draws nothing.
  if (!isRectWall(wall)) buildCustomShapeDimensions(group, wall, dims, layout, segments, zFront, unit);
  else buildRectDimensions(group, dims, layout, segments, zFront, unit);
  return group;
}

/** Rect-wall dimensions (v1 index.html 4415-4550), y measured from the floor. */
function buildRectDimensions(
  group: THREE.Group,
  d: WallDims,
  layout: ColumnPlacement[],
  segments: Segment[],
  zFront: number,
  unit: Unit,
): void {
  if (segments.length === 0) return;

  const panelW = d.panelW;
  const panelPxW = d.spec.pxW;
  const wallTop = d.totalH;
  const wallBottom = 0;
  const dimLineY = wallBottom - RECT.dimDrop;

  /** Segment centre + heading in the wall-local XZ plane. */
  const segFrame = (seg: Segment) => {
    const first = layout[seg.startCol] as ColumnPlacement | undefined;
    const last = layout[seg.endCol] as ColumnPlacement | undefined;
    if (!first || !last) {
      throw new Error(
        `buildWallDimensions: segment ${seg.startCol}..${seg.endCol} outside layout of ${layout.length} columns`,
      );
    }
    const cols = seg.endCol - seg.startCol + 1;
    return {
      cols,
      width: cols * panelW + (cols - 1) * d.gap,
      cx: (first.x + last.x) / 2,
      cz: (first.z + last.z) / 2,
      rotY: first.rotY,
    };
  };

  /**
   * v1 placed the label sprites at `cx - zFront*sin, cz - zFront*cos`, i.e. mirrored to
   * z = -zFront behind the wall for an unrotated segment (invisible only because the sprite has
   * depthTest off). `segmentToWall` uses the correct rotation, so labels sit in front of the face.
   */
  const toWall = segmentToWall;

  // ── Width dimension per segment/face ──
  for (let si = 0; si < segments.length; si++) {
    const f = segFrame(segments[si]);
    const halfW = f.width / 2;
    const pts = linearDimensionPoints({
      axis: 'x', a: -halfW, b: halfW, edge: wallBottom, line: dimLineY, dir: -1, z: zFront,
      extGap: RECT.extGap, extOvershoot: RECT.extOvershoot, tickHalf: RECT.tickHalf,
    });
    const lines = makeLineSegments(pts, `dim-width-${si}`);
    lines.position.set(f.cx, 0, f.cz);
    lines.rotation.y = f.rotY;
    group.add(lines);

    const label = createLabelSprite(formatRectDimensionLabel(f.width, f.cols * panelPxW, unit));
    label.position.copy(toWall(f, 0, dimLineY - RECT.labelOffset, zFront));
    group.add(label);
  }

  // ── Height dimension (left side of the first segment) ──
  const f = segFrame(segments[0]);
  const hDimX = -f.width / 2 - RECT.hOffset;
  const hPts = linearDimensionPoints({
    axis: 'y', a: wallTop, b: wallBottom, edge: -f.width / 2, line: hDimX, dir: -1, z: zFront,
    extGap: RECT.extGap, extOvershoot: RECT.extOvershoot, tickHalf: RECT.tickHalf,
  });
  const hLines = makeLineSegments(hPts, 'dim-height');
  hLines.position.set(f.cx, 0, f.cz);
  hLines.rotation.y = f.rotY;
  group.add(hLines);

  const hLabel = createLabelSprite(formatRectDimensionLabel(d.totalH, d.wallHPx, unit));
  // v1 put the height label at y = 0 (the vertical centre of a centred wall); in the floor
  // frame that is totalH / 2.
  hLabel.position.copy(toWall(f, hDimX - RECT.labelOffset, d.totalH / 2, zFront));
  group.add(hLabel);
}

/**
 * One dimension per boundary edge run of a custom shape (v1 index.html 4308-4413).
 *
 * v1 — and v2 until now — drew every one of them flat in the wall-local XY plane, on the comment's
 * assumption that "custom walls have no corners". They can: a shape is folded by the same
 * `corners` list a rect wall uses. Past a fold the columns are rotated away, so a flat dimension
 * line floated off the panels it measured and the far segment's labels piled up near the fold.
 *
 * Each run is therefore drawn in the frame of the segment that carries it, the way
 * {@link buildRectDimensions} already drew segment widths, and a horizontal run crossing a fold is
 * split there: a span bent through an angle has no single length, and the two faces it covers are
 * two distinct edges that a build has to cut to.
 */
function buildCustomShapeDimensions(
  group: THREE.Group,
  wall: LedWallEntity,
  d: WallDims,
  layout: ColumnPlacement[],
  segments: Segment[],
  zFront: number,
  unit: Unit,
): void {
  const panelW = d.panelW;
  const panelH = d.panelH;
  const pitch = panelW + d.gap;
  // v1 stored cells as a Set and computeShapeEdgeRuns calls `cells.has`; the document stores a
  // string[], so convert through the shared `filledCells` helper (index.html 4319-4320).
  const runs: EdgeRun[] = computeShapeEdgeRuns(filledCells(wall));
  if (runs.length === 0) return;

  // Columns inside a segment are evenly spaced along its heading (computeColumnLayout steps by
  // `panelW + gap` between them), so the segment's own centre is the midpoint of its first and last
  // column and column `c` sits at local x `(c - mid) * pitch`. A segment reaching past the layout is
  // skipped rather than thrown on: unlike a rect wall, a custom shape can carry cells for columns a
  // later edit removed, and they are already invisible.
  const frames = segments.map((seg): SegmentFrame | null => {
    const first = layout[seg.startCol] as ColumnPlacement | undefined;
    const last = layout[seg.endCol] as ColumnPlacement | undefined;
    if (!first || !last) return null;
    return {
      cx: (first.x + last.x) / 2,
      cz: (first.z + last.z) / 2,
      rotY: first.rotY,
      mid: (seg.startCol + seg.endCol) / 2,
    };
  });

  const localX = (f: SegmentFrame, c: number) => (c - f.mid) * pitch;
  const cellTopY = (r: number) => d.totalH - r * (panelH + d.gap);
  const cellBotY = (r: number) => cellTopY(r) - panelH;

  const dims: EdgeDim[] = [];
  for (const run of runs) {
    if (run.axis === 'h') {
      // Horizontal edge on the top (ny = +1) or bottom (ny = -1) of row `perpIdx`, one piece per
      // segment it covers. The pieces meet at the fold: computeColumnLayout steps half a panel
      // either side of a corner, so the last column's right edge and the next one's left edge are
      // the same point in two frames.
      const dir: 1 | -1 = run.ny > 0 ? 1 : -1;
      const edge = dir > 0 ? cellTopY(run.perpIdx) : cellBotY(run.perpIdx);
      for (let si = 0; si < segments.length; si++) {
        const f = frames[si];
        if (!f) continue;
        const from = Math.max(run.fromIdx, segments[si].startCol);
        const to = Math.min(run.toIdx, segments[si].endCol);
        if (from > to) continue;
        const span = to - from + 1;
        dims.push({
          frame: f, axis: 'x', dir, edge,
          lo: localX(f, from) - panelW / 2,
          hi: localX(f, to) + panelW / 2,
          lengthIn: span * panelW + (span - 1) * d.gap,
        });
      }
    } else {
      // Vertical edge on the left (nx = -1) or right (nx = +1) of column `perpIdx` — one column, so
      // one segment, and a fold cannot cut it.
      const si = segments.findIndex(seg => run.perpIdx >= seg.startCol && run.perpIdx <= seg.endCol);
      const f = si < 0 ? null : frames[si];
      if (!f) continue;
      const dir: 1 | -1 = run.nx < 0 ? -1 : 1;
      const span = run.toIdx - run.fromIdx + 1;
      dims.push({
        frame: f, axis: 'y', dir,
        edge: localX(f, run.perpIdx) + dir * (panelW / 2),
        lo: cellBotY(run.toIdx),
        hi: cellTopY(run.fromIdx),
        lengthIn: span * panelH + (span - 1) * d.gap,
      });
    }
  }

  dims.forEach((p, i) => {
    const horizontal = p.axis === 'x';
    // Two dimensions on the same side of a shape are never closer than a panel pitch — same side
    // and same offset means the same edge run, which `computeShapeEdgeRuns` has already merged —
    // so every line sits a flat `offset` out from the edge it measures, with nothing to stack.
    const line = p.edge + p.dir * CUSTOM.offset;
    const pts = linearDimensionPoints({
      // v1 ran a vertical dimension top-to-bottom; the geometry is the same either way.
      axis: p.axis, a: horizontal ? p.lo : p.hi, b: horizontal ? p.hi : p.lo,
      edge: p.edge, line, dir: p.dir, z: zFront,
      extGap: CUSTOM.extGap, extOvershoot: CUSTOM.extOvershoot, tickHalf: CUSTOM.tickHalf,
    });
    const lines = makeLineSegments(pts, `dim-edge-${i}`);
    lines.position.set(p.frame.cx, 0, p.frame.cz);
    lines.rotation.y = p.frame.rotY;
    group.add(lines);

    const along = (p.lo + p.hi) / 2;
    const across = line + p.dir * CUSTOM.labelOffset;
    const label = createLabelSprite(formatEdgeDimensionLabel(p.lengthIn, unit));
    label.position.copy(
      horizontal ? segmentToWall(p.frame, along, across, zFront) : segmentToWall(p.frame, across, along, zFront),
    );
    group.add(label);
  });
}

/** One boundary edge run, resolved into the frame of the segment that carries it. */
interface EdgeDim {
  frame: SegmentFrame;
  /** `x` measures a horizontal span, `y` a vertical one — the axis of {@link linearDimensionPoints}. */
  axis: 'x' | 'y';
  /** Outward direction from the measured edge towards the dimension line. */
  dir: 1 | -1;
  /** The measured span along `axis`, low to high. */
  lo: number;
  hi: number;
  /** Position of the measured edge across `axis`. */
  edge: number;
  lengthIn: number;
}

/* ───────────────────────────── Disposal ───────────────────────────── */

/**
 * Release the GPU resources of a group built by `buildWallDimensions` (v1 index.html 4417-4421):
 * line geometries, sprite textures and sprite materials. The shared `dimensionLineMaterial` is
 * kept for reuse. The group is also detached from its parent and emptied.
 */
export function disposeDimensionGroup(group: THREE.Object3D): void {
  group.traverse(obj => {
    if (obj === group) return;
    if ((obj as THREE.LineSegments).isLineSegments || (obj as THREE.Line).isLine) {
      (obj as THREE.LineSegments).geometry.dispose();
    } else if ((obj as THREE.Sprite).isSprite) {
      const mat = (obj as THREE.Sprite).material;
      mat.map?.dispose();
      mat.dispose();
    }
  });
  group.clear();
  group.removeFromParent();
}
