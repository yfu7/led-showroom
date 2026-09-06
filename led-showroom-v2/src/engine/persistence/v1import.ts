/**
 * v1 → v2 import (PURE: no three.js, no DOM).
 *
 * Reads the legacy single-file app's two localStorage records and converts them
 * into a v2 `Document`:
 *
 *  - `led-showroom-presets` — an array of presets (v1 `capturePreset`, index.html 8914-8946),
 *    applied by `applyPreset` (8966-9058). Three generations coexist in storage:
 *      gen 1  single wall:   { name, ts, cols, rows, corners, contentWindows | cwRect+cwMode, ...globals }
 *      gen 2  multi wall:    { walls: [{ id, name, cols, rows, corners, contentWindows }], ...globals,
 *                              plus the gen-1 fields mirrored for the active wall (backward compat) }
 *      gen 3  custom shape:  gen 2 + walls[].shape = { mode: 'rect' } | { mode: 'custom', cells: ['c,r', …] }
 *    `cells` is the sparse Set<"col,row"> serialised with Array.from; it is omitted / `{mode:'rect'}`
 *    for rectangular walls so older consumers keep working.
 *
 *  - `led-showroom-view` — camera + hand-placed wall transforms (index.html 9119-9213):
 *      { cam: {px,py,pz,tx,ty,tz}, fov, lock, userView, pm, pq, walls: [{x,y,z,r,rx,rz,s} | null] }
 *    with sanity bounds on restore: |pos| ≤ 3000 in, |r| < 100 rad, |rx| < 2, |rz| < 7, 0.1 ≤ s ≤ 10,
 *    8 ≤ fov ≤ 110. Wall rotations are three.js Euler XYZ **radians**; v2 stores **degrees**.
 *    (Corner angles, by contrast, were already degrees in v1 — no conversion there.)
 *
 * FRAME CHANGE (v1 → v2)
 * ----------------------
 * A v1 wall group is centred on the wall: panels span y ∈ [-totalH/2, +totalH/2] and the floor is
 * drawn at y = -totalH/2 of the *active* wall (every floor helper — `stagesFloorY` 7209, the venue
 * floor 6828, the perspective grid 6668 — calls `wallDims()`, which reads the active context's
 * rows). `applyPreset` ends with `selectWall(state.walls[0].id)` (9058), so in the canonical
 * post-apply state the floor is wall 1's and a wall at pos.y = 0 stands on it. Walls and camera are
 * all absolute world coordinates, so shifting everything by wall 1's +totalH/2 preserves relative
 * placement whichever wall the user last had selected. Rotation and scale are applied about the
 * group centre. A v2 wall's origin is on the floor at the bottom-centre of the unfolded wall
 * (y = 0 is the lowest panel's bottom edge) and rotation/scale act about that point.
 *
 * To keep the *visual* placement identical we map the v1 group origin to the v2 origin exactly:
 *
 *     v2.position = v1.pos + R(v1 euler) · (0, -totalH·scale/2, 0) + (0, totalH₁/2, 0)
 *
 * where totalH₁ is wall 1's unscaled height (the post-apply floor reference — `stagesFloorY` and
 * `arrangeWalls.firstBottom` both use the unscaled wall height). Consequences:
 *  - presets with no positions → every wall stands on the floor at y = 0 (bottom-aligned to wall 1,
 *    40 in gap to the right, z = 0 — the v1 `arrangeWalls` defaults, index.html 2868-2918);
 *  - a v1 wall the user lifted to pos.y = 10 → v2 y = 10;
 *  - a v1 wall scaled ×2 at pos.y = 0 had its bottom *below* the floor (scaled about the centre);
 *    it stays there in v2 (y = -totalH/2) because we preserve placement, not plausibility.
 */
import { RAD } from '../units';
import { clamp } from '../math';
import type { Vec3 } from '../math';
import { IPOSTER, LIMITS, WALL_GAP_IN } from '../ledwall/specs';
import type { PanelSpec } from '../ledwall/specs';
import { createContentWindow, createDocument, createLedWall } from '../document/defaults';
import type { ContentFitMode, ContentWindow, Corner, Document, LedWallEntity, PxRect, WallShape } from '../document/types';

/* ───────────────────────────── Storage keys ───────────────────────────── */

/** localStorage key of the v1 preset list (index.html 8894). */
export const V1_PRESETS_KEY = 'led-showroom-presets';
/** localStorage key of the v1 camera / wall-placement record (index.html 9124). */
export const V1_VIEW_KEY = 'led-showroom-view';

/* ───────────────────────────── v1 schema ───────────────────────────── */

/** A fold after column `afterCol`. v1 already stored `angle` in DEGREES (default corner: 90). */
export interface V1Corner { afterCol: number; angle: number }

/** Content-window rect in wall pixels, origin top-left (same convention as v2 `PxRect`). */
export interface V1PxRect { x: number; y: number; w: number; h: number }

/** v1 content-window fit modes; identical to v2 `ContentFitMode`. */
export type V1ContentMode = 'fill' | 'scaled' | 'custom';

/** Serialised content window: only geometry survives a preset (no media source). */
export interface V1ContentWindow { rect: V1PxRect; mode?: V1ContentMode }

/** gen-3 shape: `cells` is `Array.from(Set<"col,row">)`, normalised so min col = min row = 0. */
export interface V1Shape { mode: 'rect' | 'custom'; cells?: string[] }

/** One wall of a gen-2/gen-3 preset. */
export interface V1PresetWall {
  id?: number;
  name?: string;
  cols: number;
  rows: number;
  corners?: V1Corner[];
  contentWindows?: V1ContentWindow[];
  /** gen 3 only. Absent (gen 2) means rect. */
  shape?: V1Shape;
}

/** Unit the v1 content-window editor displayed rects in. Has no v2 equivalent (v2 `settings.units` is a length unit). */
export type V1CwUnit = 'px' | 'panels' | 'pct';

/**
 * A v1 preset of any generation. Everything is optional because the reader must cope with
 * whatever was in storage; `convertV1Preset` validates every field it uses.
 */
export interface V1Preset {
  name?: string;
  /** Capture time (ms epoch). */
  ts?: number;

  /* gen 1 — single wall (also mirrored in gen 2/3 for the active wall; ignored there) */
  cols?: number;
  rows?: number;
  corners?: V1Corner[];
  contentWindows?: V1ContentWindow[];
  /** Oldest single-window form (pre `contentWindows`). */
  cwRect?: V1PxRect;
  cwMode?: V1ContentMode;

  /* gen 2 / 3 — multi wall */
  walls?: V1PresetWall[];

  /* globals (all generations) */
  cwUnit?: V1CwUnit;
  spanContent?: boolean;
  showBezels?: boolean;
  autoRotate?: boolean;
  doubleSided?: boolean;
  showAccessories?: boolean;
  showDimensions?: boolean;
  /** 0–100 %. */
  brightness?: number;
}

/** Camera position (px,py,pz) and orbit target (tx,ty,tz), inches. */
export interface V1ViewCamera { px: number; py: number; pz: number; tx: number; ty: number; tz: number }

/** Per-wall placement: `x,y,z` inches (group centre), `r/rx/rz` = rotY/rotX/rotZ RADIANS, `s` uniform scale. */
export interface V1ViewWall { x: number; y: number; z: number; r?: number; rx?: number; rz?: number; s?: number }

/** The `led-showroom-view` record. */
export interface V1View {
  cam?: V1ViewCamera;
  fov?: number;
  /** View locked (orbit controls disabled). */
  lock?: boolean;
  /** True once the user orbited/zoomed; only then is `cam` restored (auto-fit otherwise). */
  userView?: boolean;
  /** Perspective match solved (1/0). */
  pm?: number;
  /** Camera quaternion [x,y,z,w] when `pm`. Not representable in a v2 Document — see `convertV1Preset`. */
  pq?: number[];
  /** Indexed like the preset's walls; `null` for walls that had no position. */
  walls?: (V1ViewWall | null)[];
}

/* ───────────────────────────── Sanity bounds (v1 restoreViewState) ───────────────────────────── */

/** Positions beyond ±3000 in (250 ft) are rejected — a runaway drag once persisted walls miles away. */
export const V1_SANE_POS_IN = 3000;
const V1_MAX_ROT_Y = 100;   // rad, exclusive
const V1_MAX_ROT_X = 2;     // rad, exclusive
const V1_MAX_ROT_Z = 7;     // rad, exclusive
const V1_MIN_SCALE = 0.1, V1_MAX_SCALE = 10;
const V1_MIN_FOV = 8, V1_MAX_FOV = 110;

/* ───────────────────────────── Small validators ───────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Strict finite number (preset fields — v1 read those without coercion). */
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/**
 * v1 `restoreViewState` semantics: the global `isFinite(v)` check *coerces* (`'10'` → 10,
 * `null`/`''` → 0, `true` → 1; `undefined`/`'abc'`/`{}` → rejected) and the value is then applied
 * with unary `+`. Returns the coerced number, or undefined when v1 would have rejected it.
 */
const coerced = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** v1 `sane`: coerced finite number within ±3000 in, else undefined. */
const sane = (v: unknown): number | undefined => {
  const n = coerced(v);
  return n !== undefined && Math.abs(n) <= V1_SANE_POS_IN ? n : undefined;
};
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

const CELL_RE = /^-?\d+,-?\d+$/;

/**
 * Validate and normalise a gen-3 `cells` array: keeps well-formed "col,row" entries, dedupes,
 * and shifts them so the minimum col and row are 0 (v1 `normalizeShape`, index.html 2715).
 * Returns null when nothing usable remains (the wall then falls back to rect).
 */
export function parseV1Cells(cells: unknown): string[] | null {
  if (!Array.isArray(cells)) return null;
  const parsed: [number, number][] = [];
  const seen = new Set<string>();
  for (const key of cells) {
    if (typeof key !== 'string' || !CELL_RE.test(key)) continue;
    const i = key.indexOf(',');
    const c = +key.slice(0, i), r = +key.slice(i + 1);
    const k = `${c},${r}`;
    if (seen.has(k)) continue;
    seen.add(k);
    parsed.push([c, r]);
  }
  if (parsed.length === 0) return null;
  let minC = Infinity, minR = Infinity;
  for (const [c, r] of parsed) { if (c < minC) minC = c; if (r < minR) minR = r; }
  return parsed.map(([c, r]) => `${c - minC},${r - minR}`);
}

/** Bounding box (in cells) of a normalised cell list — v1 `wallBBox` (index.html 3167). */
export function cellsBBox(cells: string[]): { cols: number; rows: number } {
  let maxC = -1, maxR = -1;
  for (const key of cells) {
    const i = key.indexOf(',');
    const c = +key.slice(0, i), r = +key.slice(i + 1);
    if (c > maxC) maxC = c;
    if (r > maxR) maxR = r;
  }
  return { cols: maxC + 1, rows: maxR + 1 };
}

/* ───────────────────────────── v1 geometry (pure ports) ───────────────────────────── */

/** v1 `wallDims` (index.html 3091): unfolded size of a cols×rows wall. Gap only when bezels are shown. */
export interface V1WallDims { cols: number; rows: number; gap: number; totalW: number; totalH: number; wallWPx: number; wallHPx: number }

/** Port of v1 `wallDims`. */
export function v1WallDims(cols: number, rows: number, bezels: boolean, spec: PanelSpec = IPOSTER): V1WallDims {
  const gap = bezels ? spec.gapIn : 0;
  return {
    cols, rows, gap,
    totalW: cols * spec.widthIn + (cols - 1) * gap,
    totalH: rows * spec.heightIn + (rows - 1) * gap,
    wallWPx: cols * spec.pxW,
    wallHPx: rows * spec.pxH,
  };
}

/**
 * Port of v1 `computeColumnLayout` (index.html 3106): walk the columns left→right in the XZ plane,
 * folding at corners (a corner column pair is spaced by panel width only — no gap — so the panel
 * edges meet), then centre the column positions on their mean. `rotY` in radians.
 */
export function v1ColumnLayout(cols: number, corners: Corner[], gap: number, spec: PanelSpec = IPOSTER): { x: number; z: number; rotY: number }[] {
  const step = spec.widthIn + gap;
  const cornerMap = new Map<number, number>();
  for (const c of corners) cornerMap.set(c.afterCol, c.angle);   // last one wins, as v1's object map did

  const columns: { x: number; z: number; rotY: number }[] = [];
  let x = 0, z = 0, walkAngle = 0;
  for (let c = 0; c < cols; c++) {
    columns.push({ x, z, rotY: walkAngle });
    if (c < cols - 1) {
      const cornerDeg = cornerMap.get(c);
      const isCorner = cornerDeg !== undefined;
      const hs = isCorner ? spec.widthIn / 2 : step / 2;
      x += Math.cos(walkAngle) * hs;
      z -= Math.sin(walkAngle) * hs;
      if (isCorner) walkAngle += cornerDeg * Math.PI / 180;
      x += Math.cos(walkAngle) * hs;
      z -= Math.sin(walkAngle) * hs;
    }
  }
  if (cols > 0) {
    let cx = 0, cz = 0;
    for (const col of columns) { cx += col.x; cz += col.z; }
    cx /= cols; cz /= cols;
    for (const col of columns) { col.x -= cx; col.z -= cz; }
  }
  return columns;
}

/** Port of v1 `wallBounds` (index.html 4553): XZ extent of the folded wall (unrotated, unscaled) plus its height. */
export function v1WallBounds(cols: number, rows: number, corners: Corner[], bezels: boolean, spec: PanelSpec = IPOSTER): { w: number; h: number; depth: number } {
  const d = v1WallDims(cols, rows, bezels, spec);
  const layout = v1ColumnLayout(cols, corners, d.gap, spec);
  if (layout.length === 0) return { w: 0, h: d.totalH, depth: 0 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const hw = spec.widthIn / 2, hd = spec.depthIn / 2;
  for (const col of layout) {
    const cos = Math.cos(col.rotY), sin = Math.sin(col.rotY);
    for (const lx of [-hw, hw]) {
      for (const lz of [-hd, hd]) {
        const wx = col.x + lx * cos - lz * sin;
        const wz = col.z - lx * sin - lz * cos;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
      }
    }
  }
  return { w: maxX - minX, h: d.totalH, depth: maxZ - minZ };
}

/**
 * Rotate a local offset by a three.js Euler XYZ (radians) — the matrix `Matrix4.makeRotationFromEuler`
 * builds for order 'XYZ' (R = Rx · Ry · Rz). Only what the frame shift needs; no three.js dependency.
 */
export function rotateEulerXYZ(v: Vec3, euler: Vec3): Vec3 {
  const [x, y, z] = euler;
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  const m00 = c * e, m01 = -c * f, m02 = d;
  const m10 = a * f + b * e * d, m11 = a * e - b * f * d, m12 = -b * c;
  const m20 = b * f - a * e * d, m21 = b * e + a * f * d, m22 = a * c;
  return [
    m00 * v[0] + m01 * v[1] + m02 * v[2],
    m10 * v[0] + m11 * v[1] + m12 * v[2],
    m20 * v[0] + m21 * v[1] + m22 * v[2],
  ];
}

/**
 * Map a v1 wall-group origin (wall centre; rotation/scale about it) to the v2 origin
 * (bottom-centre of the unfolded wall, on the floor).
 *
 * @param pos        v1 `wall.pos` (inches)
 * @param eulerRad   v1 [rotX, rotY, rotZ] in radians
 * @param scale      v1 uniform scale
 * @param totalH     unscaled wall height (inches)
 * @param floorY     v1 world y of the floor (= -totalH₁/2 of wall 1); v2's floor is y = 0
 */
export function v1CentreToV2Origin(pos: Vec3, eulerRad: Vec3, scale: number, totalH: number, floorY: number): Vec3 {
  const off = rotateEulerXYZ([0, -totalH * scale / 2, 0], eulerRad);
  return [pos[0] + off[0], pos[1] + off[1] - floorY, pos[2] + off[2]];
}

/* ───────────────────────────── Generation resolution ───────────────────────────── */

/** A preset wall after generation resolution and validation. */
export interface ResolvedV1Wall {
  name: string | null;
  cols: number;
  rows: number;
  corners: Corner[];
  shape: WallShape;
  /**
   * `null` = the preset said nothing about windows and v1 would have kept whatever the wall
   * already had (gen 1 only) — the converter gives such a wall the default full-wall window.
   * `[]` = explicitly no windows (gen 2/3 walls without `contentWindows`, which v1 emptied).
   */
  windows: { rect: PxRect; mode: ContentFitMode }[] | null;
}

function resolveCorners(raw: unknown, cols: number): Corner[] {
  if (!Array.isArray(raw)) return [];
  const byCol = new Map<number, Corner>();
  for (const c of raw) {
    if (!isObj(c)) continue;
    const afterCol = num(c.afterCol), angle = num(c.angle);
    if (afterCol === undefined || angle === undefined) continue;
    const col = Math.trunc(afterCol);
    if (col < 0 || col >= cols - 1) continue;             // v1 pruneCorners (5906): afterCol < cols - 1
    byCol.delete(col);                                    // duplicate afterCol: last wins (v1 cornerMap)
    byCol.set(col, { afterCol: col, angle: clamp(angle, -270, 90) });
  }
  return [...byCol.values()];
}

function parseRect(raw: unknown): PxRect | null {
  if (!isObj(raw)) return null;
  const x = num(raw.x), y = num(raw.y), w = num(raw.w), h = num(raw.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return { x, y, w, h };
}

function resolveWindows(raw: unknown, d: V1WallDims): { rect: PxRect; mode: ContentFitMode }[] {
  if (!Array.isArray(raw)) return [];
  const out: { rect: PxRect; mode: ContentFitMode }[] = [];
  for (const w of raw) {
    if (out.length >= LIMITS.maxContentWindows) break;   // v1 addContentWindow returns null past the cap
    if (!isObj(w)) continue;
    const mode: ContentFitMode = w.mode === 'scaled' || w.mode === 'custom' ? w.mode : 'fill';   // v1: pw.mode || 'fill'
    // v1 copied the rect blindly; a malformed rect is replaced by the full wall so the window stays renderable.
    const rect = parseRect(w.rect) ?? { x: 0, y: 0, w: d.wallWPx, h: d.wallHPx };
    out.push({ rect, mode });
  }
  return out;
}

function positiveInt(v: unknown, dflt: number, max: number): number {
  const n = num(v);
  if (n === undefined) return dflt;
  return clamp(Math.floor(n), 1, max);
}

function resolveWall(pw: Record<string, unknown>, bezels: boolean, gen1: boolean): ResolvedV1Wall {
  let cols = positiveInt(pw.cols, 5, LIMITS.maxCols);
  let rows = positiveInt(pw.rows, 5, LIMITS.maxRows);

  // gen 3: a custom shape's cells are authoritative; cols/rows are its bounding box
  // (v1 commitShapeEdit keeps them in sync, we recompute defensively). Empty/invalid cells → rect.
  let shape: WallShape = { mode: 'rect' };
  if (isObj(pw.shape) && pw.shape.mode === 'custom') {
    const cells = parseV1Cells(pw.shape.cells);
    if (cells) {
      const bb = cellsBBox(cells);
      if (bb.cols <= LIMITS.maxCols && bb.rows <= LIMITS.maxRows) {
        cols = bb.cols;
        rows = bb.rows;
        shape = { mode: 'custom', cells };
      }
    }
  }

  const d = v1WallDims(cols, rows, bezels);
  let windows: ResolvedV1Wall['windows'];
  if (gen1) {
    if (Array.isArray(pw.contentWindows) && pw.contentWindows.length > 0) windows = resolveWindows(pw.contentWindows, d);
    else if (isObj(pw.cwRect)) windows = resolveWindows([{ rect: pw.cwRect, mode: pw.cwMode }], d);
    else windows = null;                                  // v1 left the existing windows untouched
  } else {
    windows = resolveWindows(pw.contentWindows, d);       // v1 removed all windows first, so missing ⇒ none
  }

  return {
    // gen 1: `pw` is the preset itself and its `name` is the *preset* name; v1 left the wall's own name alone.
    name: !gen1 && typeof pw.name === 'string' && pw.name ? pw.name : null,
    cols,
    rows,
    corners: resolveCorners(pw.corners, cols),
    shape,
    windows,
  };
}

/**
 * Resolve a preset of any generation into a validated wall list, mirroring v1 `applyPreset`'s
 * branch: `walls[]` (gen 2/3, capped at 10 walls like `addWall`) wins; otherwise the gen-1 fields
 * describe a single wall.
 */
export function resolveV1Walls(preset: V1Preset): ResolvedV1Wall[] {
  const p = preset as unknown as Record<string, unknown>;
  const bezels = bool(p.showBezels, true);
  if (Array.isArray(p.walls) && p.walls.length > 0) {
    return p.walls.slice(0, LIMITS.maxWalls).map(w => resolveWall(isObj(w) ? w : {}, bezels, false));
  }
  return [resolveWall(p, bezels, true)];
}

/* ───────────────────────────── View record ───────────────────────────── */

/** A validated per-wall placement from the view record (v1 frame: centre origin, radians). */
export interface SanitizedV1Placement { pos: Vec3; eulerRad: Vec3; scale: number }

/**
 * Apply v1 `restoreViewState`'s per-wall sanity rules (index.html 9164-9172): the entry is used
 * only when x,y,z are all finite and within ±3000 in; each rotation/scale is used only inside its
 * own bound (else 0 / 1).
 *
 * Mirrors v1's coercion exactly: v1 tested with the global `isFinite` and applied with unary `+`,
 * so numeric strings (`'10'`) and `null` (→ 0) are accepted, while `undefined`, non-numeric strings
 * and objects are rejected. `persistViewState` only ever writes numbers, so this only matters for
 * hand-edited storage — but a record v1 restored must restore here too.
 */
export function sanitizeV1ViewWall(p: unknown): SanitizedV1Placement | null {
  if (!isObj(p)) return null;
  const x = sane(p.x), y = sane(p.y), z = sane(p.z);
  if (x === undefined || y === undefined || z === undefined) return null;
  const r = coerced(p.r), rx = coerced(p.rx), rz = coerced(p.rz), s = coerced(p.s);
  return {
    pos: [x, y, z],
    eulerRad: [
      rx !== undefined && Math.abs(rx) < V1_MAX_ROT_X ? rx : 0,
      r !== undefined && Math.abs(r) < V1_MAX_ROT_Y ? r : 0,
      rz !== undefined && Math.abs(rz) < V1_MAX_ROT_Z ? rz : 0,
    ],
    scale: s !== undefined && s >= V1_MIN_SCALE && s <= V1_MAX_SCALE ? s : 1,
  };
}

/* ───────────────────────────── Conversion ───────────────────────────── */

/**
 * Convert a v1 preset (any generation) and, optionally, the v1 view record into a v2 Document.
 *
 * Walls become `led-wall` entities in preset order. Placement follows v1: positions from the view
 * record (matched by index, validated) are honoured; walls without one get the `arrangeWalls`
 * default slot (wall 1 at the origin, later walls 40 in right of the rightmost wall, bottom-aligned
 * to wall 1, z = 0). Everything is then re-expressed in the v2 floor/bottom-centre frame — see the
 * module doc. Rotations are converted radians → degrees.
 *
 * Not carried over (no v2 slot): `cwUnit` (editor display unit), the perspective-match quaternion
 * `pm/pq` (v2 keeps a camera orientation only inside a full backdrop calibration, which needs the
 * vanishing lines v1 never stored). `pixelGrid` was never in a preset and defaults to off.
 */
export function convertV1Preset(preset: V1Preset, view?: V1View | null): Document {
  const p = (isObj(preset) ? preset : {}) as V1Preset;
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Imported v1 preset';
  const doc = createDocument(name);
  const ts = num(p.ts);
  if (ts !== undefined && ts > 0) doc.createdAt = ts;

  /* ── globals (v1 applyPreset 9043-9050). Missing booleans fall back to the v1 *initial-state*
        defaults (index.html 2175-2184) rather than v1's literal `state.x = undefined` (a wart). */
  const bezels = bool(p.showBezels, true);
  const doubleSided = bool(p.doubleSided, false);
  const accessories = bool(p.showAccessories, false);
  const showDimensions = bool(p.showDimensions, false);
  const brightnessRaw = num(p.brightness);
  const brightness = brightnessRaw === undefined ? 100 : clamp(brightnessRaw, 0, 100);
  doc.settings.autoRotate = bool(p.autoRotate, false);
  doc.settings.spanContent = p.spanContent === true;        // v1: preset.spanContent || false

  /* ── walls ── */
  const resolved = resolveV1Walls(p);
  const spec = IPOSTER;
  const entities: LedWallEntity[] = resolved.map((w, i) => {
    const e = createLedWall({
      name: w.name ?? `Wall ${i + 1}`,        // v1: pw.name || 'Wall 1' / 'Wall ' + id
      cols: w.cols,
      rows: w.rows,
      product: spec.id,
      bezels,
      accessories,
    });
    e.shape = w.shape;
    e.corners = w.corners;
    e.doubleSided = doubleSided;
    e.brightness = brightness;
    e.showDimensions = showDimensions;
    if (w.windows !== null) {
      e.contentWindows = w.windows.map((cw, k): ContentWindow => createContentWindow({ mode: cw.mode, rect: { ...cw.rect } }, k));
    }
    // else: gen 1 with no window data — keep the full-wall 'fill' window createLedWall made.
    return e;
  });

  /* ── placement: v1 arrangeWalls (2868-2918) in the v1 frame ── */
  const viewWalls = isObj(view) && Array.isArray(view.walls) ? view.walls : [];
  const placements: (SanitizedV1Placement | null)[] = entities.map((_, i) => sanitizeV1ViewWall(viewWalls[i]));
  const geo = entities.map(e => ({
    b: v1WallBounds(e.cols, e.rows, e.corners, bezels, spec),
    d: v1WallDims(e.cols, e.rows, bezels, spec),
  }));

  let rightmost = -Infinity;
  let firstBottom: number | null = null;
  entities.forEach((_, i) => {
    const pl = placements[i];
    if (pl) rightmost = Math.max(rightmost, pl.pos[0] + geo[i].b.w / 2);   // v1 ignores rotation/scale here
    if (firstBottom === null) firstBottom = (pl ? pl.pos[1] : 0) - geo[i].d.totalH / 2;
  });
  entities.forEach((_, i) => {
    if (placements[i]) return;
    let pos: Vec3;
    if (!Number.isFinite(rightmost)) {
      pos = [0, 0, 0];                                                       // first wall
    } else {
      pos = [rightmost + WALL_GAP_IN + geo[i].b.w / 2, (firstBottom ?? 0) + geo[i].b.h / 2, 0];   // next free slot right
    }
    rightmost = pos[0] + geo[i].b.w / 2;
    placements[i] = { pos, eulerRad: [0, 0, 0], scale: 1 };
  });

  /* ── v1 frame → v2 frame ── */
  const floorY = entities.length ? -geo[0].d.totalH / 2 : 0;   // v1 floor = wall 1's (unscaled) bottom edge
  entities.forEach((e, i) => {
    const pl = placements[i]!;
    e.transform.position = v1CentreToV2Origin(pl.pos, pl.eulerRad, pl.scale, geo[i].d.totalH, floorY);
    e.transform.rotation = [pl.eulerRad[0] * RAD, pl.eulerRad[1] * RAD, pl.eulerRad[2] * RAD];
    e.transform.scale = [pl.scale, pl.scale, pl.scale];
  });
  doc.entities = entities;

  /* ── camera (v1 restoreViewState 9174-9197) ── */
  if (isObj(view)) {
    // v1 gated on truthiness (`data.cam && data.userView`, `data.lock`) and used the same coercive
    // `sane` as the walls; we mirror that, additionally storing the coerced numbers (v1 passed raw
    // values to camera.position.set, which would have kept a numeric string as-is).
    const c = view.cam;
    if (view.userView && isObj(c)) {
      const px = sane(c.px), py = sane(c.py), pz = sane(c.pz), tx = sane(c.tx), ty = sane(c.ty), tz = sane(c.tz);
      if (px !== undefined && py !== undefined && pz !== undefined && tx !== undefined && ty !== undefined && tz !== undefined) {
        // Camera coordinates live in the same world as the walls, so they get the same floor shift.
        doc.view.position = [px, py - floorY, pz];
        doc.view.target = [tx, ty - floorY, tz];
      }
    }
    const fov = coerced(view.fov);
    if (fov !== undefined && fov >= V1_MIN_FOV && fov <= V1_MAX_FOV) doc.view.fov = Math.round(fov);   // v1 setVenueCameraFov rounds
    doc.view.locked = !!view.lock;
  }

  doc.updatedAt = Date.now();
  return doc;
}

/* ───────────────────────────── Storage readers ───────────────────────────── */

/**
 * Safe read of the v1 preset list (v1 `loadPresets`, index.html 8902): a missing key, a storage
 * that throws, malformed JSON, or a non-array all yield `[]`. Non-object entries are dropped.
 */
export function readV1PresetsFromStorage(storage: Pick<Storage, 'getItem'>): V1Preset[] {
  let raw: string | null = null;
  try { raw = storage.getItem(V1_PRESETS_KEY); } catch { return []; }
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.filter(isObj) as unknown as V1Preset[];
}

/** Safe read of the v1 view record; `null` when absent or unparseable. */
export function readV1ViewFromStorage(storage: Pick<Storage, 'getItem'>): V1View | null {
  let raw: string | null = null;
  try { raw = storage.getItem(V1_VIEW_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return isObj(data) ? (data as V1View) : null;
  } catch { return null; }
}

/* ───────────────────────────── Preferences ───────────────────────────── */

/**
 * The four legacy per-machine preferences v1 kept outside its preset/view records. They are plain
 * strings, written by the settings widgets in index.html:
 *   `pixelGridDistIn` — pixel-grid distance threshold in inches, one of 72|96|120|144 (7566-7574)
 *   `useHighPerfGPU`  — 'true'|'false', discrete-GPU request (9524, 9540)
 *   `gpuLiveWebsite`  — 'true'|'false', keep live websites during a recording (9527, 9548)
 *   `gpuHighRes`      — 'true'|'false', the 1.5× render-scale option (9528, 9553)
 */
export const V1_PIXEL_GRID_DIST_KEY = 'pixelGridDistIn';
export const V1_HIGH_PERF_GPU_KEY = 'useHighPerfGPU';
export const V1_LIVE_WEBSITE_KEY = 'gpuLiveWebsite';
export const V1_HIGH_RES_KEY = 'gpuHighRes';

/** v1's high-res option is v2's `qualityScale` 1.5× (TopBar render-quality menu). */
export const V1_HIGH_RES_QUALITY_SCALE = 1.5;

/** The v1 pixel-grid distances the select offered (index.html 7567). */
const V1_PIXEL_GRID_DISTANCES = [72, 96, 120, 144];

/**
 * v2 equivalents of the legacy preferences. Every field is optional: only keys the user actually
 * set are reported, so a returning v1 user keeps their choices and everyone else keeps the v2
 * defaults. `gpu` matches `GpuPreference` structurally (Renderer.ts) without importing three.
 */
export interface V1Preferences {
  gpu?: 'high-performance' | 'low-power';
  qualityScale?: number;
  liveWebsiteInRecordings?: boolean;
  pixelGridDistIn?: number;
}

/**
 * Read the legacy preferences (v1 `useHighPerfGPU` / `gpuHighRes` / `gpuLiveWebsite` /
 * `pixelGridDistIn`) and translate them to their v2 shape. A storage that throws, a missing key
 * or an unrecognised value simply leaves the field out.
 */
export function readV1Preferences(storage: Pick<Storage, 'getItem'>): V1Preferences {
  const read = (key: string): string | null => {
    try { return storage.getItem(key); } catch { return null; }
  };
  const out: V1Preferences = {};
  const hp = read(V1_HIGH_PERF_GPU_KEY);
  if (hp === 'true') out.gpu = 'high-performance';
  else if (hp === 'false') out.gpu = 'low-power';
  // v1 only ever applied the 1.5× render scale together with the discrete GPU (9534), but the
  // stored flag is the user's choice; v2 keeps the two settings independent.
  if (read(V1_HIGH_RES_KEY) === 'true') out.qualityScale = V1_HIGH_RES_QUALITY_SCALE;
  if (read(V1_LIVE_WEBSITE_KEY) === 'true') out.liveWebsiteInRecordings = true;
  const dist = parseInt(read(V1_PIXEL_GRID_DIST_KEY) ?? '', 10);
  if (V1_PIXEL_GRID_DISTANCES.includes(dist)) out.pixelGridDistIn = dist;
  return out;
}

/* ───────────────────────────── Summary ───────────────────────────── */

/**
 * One-line description for an import picker, e.g. `3 walls · 5×5, 3×2 (custom), 4×4`.
 * Custom-shape walls report their bounding box.
 */
export function summarizeV1Preset(preset: V1Preset): string {
  const walls = resolveV1Walls(isObj(preset) ? preset : {});
  const n = walls.length;
  const parts = walls.map(w => `${w.cols}×${w.rows}${w.shape.mode === 'custom' ? ' (custom)' : ''}`);
  return `${n} wall${n === 1 ? '' : 's'} · ${parts.join(', ')}`;
}
