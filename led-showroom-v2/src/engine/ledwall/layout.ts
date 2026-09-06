/**
 * LED wall layout maths — PURE (no three.js, no DOM).
 *
 * Ported from the v1 single-file app (`index.html`):
 *   - wallDims                      v1 3091-3103
 *   - computeColumnLayout           v1 3106-3144
 *   - computeSegments               v1 3205-3220
 *   - miter cuts / corner extension v1 3852-3896 (inside buildWall)
 *   - isRectWall / wallFilledCells / wallBBox / wallFilledCount   v1 3146-3202
 *   - isAdjacentToSet / wouldStayContiguous                       v1 2536-2582
 *   - classifyShapeEdit / toggleShapeCell / paintShapeCell        v1 2591-2638
 *   - rebuildShapeGhosts (cell maths only)                        v1 2659-2713
 *   - normalizeShape                                              v1 2715-2756
 *   - computeShapeEdgeRuns                                        v1 4254-4306
 *   - wallBounds                                                  v1 4552-4571
 *   - worldToWallPixel (as a wall-LOCAL function)                 v1 5789-5810
 *   - buildAccessories placement maths                            v1 3951-3976
 *
 * Wall-local coordinate frame (v2 — differs from v1, which centred the wall vertically):
 *   - World unit = 1 inch, Y up.
 *   - The wall origin is on the FLOOR: local y = 0 is the bottom edge of the lowest panel row,
 *     local y = totalH is the top edge of the top row.
 *   - For a straight wall local x runs from -totalW/2 (left) to +totalW/2 (right).
 *   - The screen faces +Z; panels have depth panelD centred on z = 0 (front face at z = +panelD/2).
 *   - Corners fold the columns in the XZ plane walking left to right. As in v1, the XZ origin of a
 *     folded wall is the centroid of the column centres (for a straight wall that is exactly the
 *     centre of the unfolded width).
 *   - Angles stored in the document are DEGREES; `ColumnPlacement.rotY` is RADIANS (three.js ready).
 *
 * Sign convention for corners (reproduced from v1 exactly): a positive `Corner.angle` (convex — the
 * front/screen faces meet at the outer corner) rotates the following columns by `+angle` about Y
 * (`rotY = +angle * DEG`) and walks them towards -Z (behind the previous segment). A 90° corner
 * therefore yields rotY = +π/2 for every column after it, with those columns facing +X.
 */
import type { Corner, LedWallEntity } from '../document/types';
import { DEG } from '../units';
import type { Vec3 } from '../math';
import { clamp } from '../math';
import { inchesPerPx, panelSpec, type PanelSpec } from './specs';

/* ───────────────────────────── Dimensions ───────────────────────────── */

/** Derived physical/pixel dimensions of a wall (v1 wallDims, extended with the panel constants). */
export interface WallDims {
  cols: number;
  rows: number;
  /** Seam between adjacent panels, inches (0 when bezels are hidden). */
  gap: number;
  /** Unfolded width / height of the wall, inches (panels + gaps). */
  totalW: number;
  totalH: number;
  /** Wall resolution in pixels (gaps carry no pixels). */
  wallWPx: number;
  wallHPx: number;
  /** One panel's face width, height and depth, inches. */
  panelW: number;
  panelH: number;
  panelD: number;
  /** Inches per pixel in x and y (non-square pixels are possible). */
  inPerPxX: number;
  inPerPxY: number;
  spec: PanelSpec;
}

/**
 * Compute a wall's derived dimensions (v1 3091-3103).
 * `gap = bezels ? spec.gapIn : 0`. The 5x5 default with bezels gives 126.24 x 94.74 in, 1720 x 1290 px;
 * with bezels off — the manufacturer's assembly butts the panels flush — it is exactly 126.0 x 94.5 in.
 * (v1 read 125.865 x 94.615 in from its rounded inch panel constants; the CAD supersedes them — see
 * `specs.ts`.)
 */
export function wallDims(wall: Pick<LedWallEntity, 'cols' | 'rows' | 'bezels' | 'product'>): WallDims {
  const spec = panelSpec(wall.product);
  const cols = wall.cols | 0;
  const rows = wall.rows | 0;
  const gap = wall.bezels ? spec.gapIn : 0;
  const ipp = inchesPerPx(spec);
  return {
    cols,
    rows,
    gap,
    totalW: cols * spec.widthIn + (cols - 1) * gap,
    totalH: rows * spec.heightIn + (rows - 1) * gap,
    wallWPx: cols * spec.pxW,
    wallHPx: rows * spec.pxH,
    panelW: spec.widthIn,
    panelH: spec.heightIn,
    panelD: spec.depthIn,
    inPerPxX: ipp.x,
    inPerPxY: ipp.y,
    spec,
  };
}

/* ───────────────────────────── Column layout ───────────────────────────── */

/** Placement of one column of panels in wall-local space. */
export interface ColumnPlacement {
  col: number;
  /** Centre of the column in wall-local XZ (inches). */
  x: number;
  z: number;
  /** Yaw of the column in RADIANS (three.js `rotation.y`). 0 = facing +Z. */
  rotY: number;
}

function cornerMapOf(corners: Corner[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of corners) m.set(c.afterCol, c.angle);
  return m;
}

/**
 * Lay the columns out left to right, folding at each corner (v1 3106-3144).
 *
 * Walking from column c to c+1 advances by `step = panelW + gap` on a flat run; across a corner the
 * advance is `panelW` (no gap — the mitred faces meet) split into two half-steps with the yaw change
 * in between. Finally the layout is re-centred on the centroid of the column centres, so a straight
 * wall spans x ∈ [-totalW/2, +totalW/2] at z = 0.
 *
 * Sign: positive corner angle → `rotY` increases by `angle·DEG` and subsequent columns walk towards
 * -Z (`z -= sin(rotY)·step`). See the module header.
 */
export function computeColumnLayout(dims: WallDims, corners: Corner[]): ColumnPlacement[] {
  const step = dims.panelW + dims.gap;
  const cornerMap = cornerMapOf(corners);
  const columns: ColumnPlacement[] = [];
  let x = 0, z = 0, walkAngle = 0;

  for (let c = 0; c < dims.cols; c++) {
    columns.push({ col: c, x, z, rotY: walkAngle });
    if (c < dims.cols - 1) {
      const angle = cornerMap.get(c);
      const isCorner = angle !== undefined;
      const hs = isCorner ? dims.panelW / 2 : step / 2;
      x += Math.cos(walkAngle) * hs;
      z -= Math.sin(walkAngle) * hs;
      if (isCorner) walkAngle += angle * DEG;
      x += Math.cos(walkAngle) * hs;
      z -= Math.sin(walkAngle) * hs;
    }
  }

  if (columns.length) {
    let cx = 0, cz = 0;
    for (const col of columns) { cx += col.x; cz += col.z; }
    cx /= columns.length;
    cz /= columns.length;
    for (const col of columns) { col.x -= cx; col.z -= cz; }
  }
  return columns;
}

/**
 * Drop corners that no longer sit on a real joint of a `cols`-wide wall (v1 pruneCorners, 5906).
 *
 * A joint exists between columns `afterCol` and `afterCol + 1`, so the valid range is
 * `0 <= afterCol < cols - 1` — exactly the range {@link computeColumnLayout} folds at. Call this
 * wherever `cols` is written (grid stepper, shape edits, custom → rect collapse, document
 * migration); a stale corner is otherwise invisible to the layout but still mitres a panel edge and
 * shows up as an unselectable entry in the corners list.
 *
 * Returns the SAME array when nothing needs pruning, so callers can skip a no-op write.
 */
export function pruneCorners(cols: number, corners: Corner[]): Corner[] {
  const kept = corners.filter(c => c.afterCol >= 0 && c.afterCol < cols - 1);
  return kept.length === corners.length ? corners : kept;
}

/** A flat run of columns between corners (inclusive indices). */
export interface Segment { startCol: number; endCol: number }

/** Split the columns into flat segments at each corner (v1 3205-3220). Always returns >= 1 segment. */
export function computeSegments(cols: number, corners: Corner[]): Segment[] {
  const cornerCols = new Set(corners.map(c => c.afterCol));
  const segments: Segment[] = [];
  let start = 0;
  for (let c = 0; c < cols - 1; c++) {
    if (cornerCols.has(c)) {
      segments.push({ startCol: start, endCol: c });
      start = c + 1;
    }
  }
  segments.push({ startCol: start, endCol: cols - 1 });
  return segments;
}

/* ───────────────────────────── Miters ───────────────────────────── */

/**
 * How far a panel edge is extended/trimmed at a corner so the mitre face passes through the panel's
 * edge centre-line: `min((panelD/2)·tan(|θ|/2), panelW/2)` (v1 3864-3867).
 *
 * v1 quirk kept on purpose: for |θ| > 180° (the document allows down to -270°) tan(|θ|/2) is negative,
 * so the "extension" is negative. Because -270° is geometrically the same fold as +90°, the resulting
 * cuts for -270° come out identical to +90° (the negative amount flips the concave case back to convex).
 */
export function cornerExtension(angleDeg: number, panelD: number, panelW: number): number {
  return Math.min((panelD / 2) * Math.tan((Math.abs(angleDeg) / 2) * DEG), panelW / 2);
}

/**
 * Amount trimmed from a panel's vertical edge at the front (+Z, screen) and back (-Z, cabinet).
 * Negative = the edge is extended outward. Convex corners extend the front and trim the back;
 * concave corners trim the front and extend the back.
 */
export interface MiterCut { front: number; back: number }

function miterCut(angleDeg: number, dims: WallDims): MiterCut {
  const halfCut = cornerExtension(angleDeg, dims.panelD, dims.panelW);
  return angleDeg > 0
    ? { front: -halfCut, back: halfCut }   // convex: extend front, trim back
    : { front: halfCut, back: -halfCut };  // concave: trim front, extend back
}

/**
 * Mitre cuts for a column's left edge (corner `afterCol = col - 1`) and right edge (corner
 * `afterCol = col`), or null where there is no corner (v1 3852-3884).
 *
 * Only joints {@link computeColumnLayout} actually folds at count: a corner outside
 * `0 <= afterCol < cols - 1` is ignored, so a stale entry left behind by a column change can never
 * bevel the outer edge of the first or last column (see {@link pruneCorners}).
 */
export function miterCutsForColumn(col: number, dims: WallDims, corners: Corner[]): { left: MiterCut | null; right: MiterCut | null } {
  const cornerMap = cornerMapOf(corners);
  const leftAngle = col > 0 ? cornerMap.get(col - 1) : undefined;
  const rightAngle = col < dims.cols - 1 ? cornerMap.get(col) : undefined;
  return {
    left: leftAngle !== undefined ? miterCut(leftAngle, dims) : null,
    right: rightAngle !== undefined ? miterCut(rightAngle, dims) : null,
  };
}

/* ───────────────────────────── Cells / custom shapes ───────────────────────────── */

/** Key for a cell: `"col,row"` (row 0 = TOP row). */
export function cellKey(c: number, r: number): string {
  return c + ',' + r;
}

/** Parse a `"col,row"` key. */
export function parseCell(key: string): [number, number] {
  const i = key.indexOf(',');
  return [+key.slice(0, i), +key.slice(i + 1)];
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function neighbourKeys(key: string): string[] {
  const [c, r] = parseCell(key);
  return NEIGHBOURS.map(([dc, dr]) => cellKey(c + dc, r + dr));
}

/** A wall is rectangular when it has no shape or `shape.mode === 'rect'` (v1 3155-3157). */
export function isRectWall(wall: Pick<LedWallEntity, 'shape'>): boolean {
  return !wall.shape || wall.shape.mode === 'rect';
}

/**
 * The set of filled cells (v1 wallFilledCells, 3163-3173). Rect walls synthesise every cell of the
 * cols×rows grid; custom walls return their stored cells. Always a fresh Set — safe to mutate.
 */
export function filledCells(wall: Pick<LedWallEntity, 'cols' | 'rows' | 'shape'>): Set<string> {
  const out = new Set<string>();
  if (isRectWall(wall)) {
    const cols = wall.cols | 0, rows = wall.rows | 0;
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) out.add(cellKey(c, r));
    return out;
  }
  for (const k of wall.shape.cells ?? []) out.add(k);
  return out;
}

/** Bounding box of a cell set in cell space (v1 wallBBox, 3178-3195). Empty → all zeros. */
export function shapeBBox(cells: Iterable<string>): { cols: number; rows: number; minC: number; minR: number } {
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  let any = false;
  for (const key of cells) {
    any = true;
    const [c, r] = parseCell(key);
    if (c < minC) minC = c;
    if (r < minR) minR = r;
    if (c > maxC) maxC = c;
    if (r > maxR) maxR = r;
  }
  if (!any) return { cols: 0, rows: 0, minC: 0, minR: 0 };
  return { cols: maxC - minC + 1, rows: maxR - minR + 1, minC, minR };
}

/** Number of panels in the wall (v1 wallFilledCount, 3198-3201). */
export function filledCount(wall: Pick<LedWallEntity, 'cols' | 'rows' | 'shape'>): number {
  if (isRectWall(wall)) return (wall.cols | 0) * (wall.rows | 0);
  return wall.shape.cells ? wall.shape.cells.length : 0;
}

/** True if `key` shares a full edge with any cell in the set (v1 isAdjacentToSet, 2536-2541). */
export function isAdjacentToSet(cells: Set<string>, key: string): boolean {
  return neighbourKeys(key).some(k => cells.has(k));
}

/** Flood-fill from `start`, skipping `exclude`; returns the number of cells reached. */
function floodCount(cells: Set<string>, start: string, exclude: string | null): number {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nk of neighbourKeys(cur)) {
      if (nk === exclude || seen.has(nk) || !cells.has(nk)) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }
  return seen.size;
}

/** True if the cells form a single 4-connected component (empty and singleton sets count as contiguous). */
export function isContiguous(cells: Set<string>): boolean {
  if (cells.size <= 1) return true;
  const first = cells.values().next().value as string;
  return floodCount(cells, first, null) === cells.size;
}

/**
 * Would the set stay 4-connected after adding (`add = true`) or removing (`add = false`) `key`?
 *
 * Removal follows v1 wouldStayContiguous (2543-2582) exactly: a non-member or a singleton set is
 * trivially fine; an isolated speck (no neighbours) is fine too; otherwise BFS from a surviving
 * neighbour must reach every other remaining cell. Adding is fine when the set is empty or the new
 * cell touches it.
 */
export function wouldStayContiguous(cells: Set<string>, key: string, add: boolean): boolean {
  if (add) {
    if (cells.has(key)) return isContiguous(cells);
    return cells.size === 0 || isAdjacentToSet(cells, key);
  }
  if (!cells.has(key)) return true;
  if (cells.size <= 1) return true;
  const start = neighbourKeys(key).find(k => cells.has(k));
  if (!start) return true;
  return floodCount(cells, start, key) === cells.size - 1;
}

/**
 * Result of hovering/clicking a cell in the shape editor (v1 classifyShapeEdit, 2591-2600):
 *  - 'add'          empty cell adjacent to the set (legal place)
 *  - 'no-adjacent'  empty cell not touching the set (illegal place)
 *  - 'remove'       filled cell whose removal keeps the rest contiguous
 *  - 'last-cell'    filled cell that is the only one left (illegal remove)
 *  - 'would-split'  filled cell whose removal would disconnect the set
 */
export type ShapeEditKind = 'add' | 'remove' | 'no-adjacent' | 'would-split' | 'last-cell';

/** Classify a shape edit at `key` (v1 2591-2600). */
export function classifyShapeEdit(cells: Set<string>, key: string): ShapeEditKind {
  if (cells.has(key)) {
    if (cells.size <= 1) return 'last-cell';
    if (!wouldStayContiguous(cells, key, false)) return 'would-split';
    return 'remove';
  }
  if (cells.size > 0 && !isAdjacentToSet(cells, key)) return 'no-adjacent';
  return 'add';
}

/**
 * Click semantics (v1 toggleShapeCell, 2602-2612): flip the cell if legal. Returns a NEW set, or null
 * when the edit is illegal ('last-cell', 'no-adjacent', 'would-split'). The result is not normalised —
 * run {@link normalizeShape} before storing it.
 */
export function toggleShapeCell(cells: Set<string>, key: string): Set<string> | null {
  const action = classifyShapeEdit(cells, key);
  if (action !== 'add' && action !== 'remove') return null;
  const next = new Set(cells);
  if (action === 'remove') next.delete(key); else next.add(key);
  return next;
}

/**
 * Drag-paint semantics (v1 paintShapeCell, 2619-2638): apply only the edit matching `mode`, so an
 * add-drag never removes and a remove-drag never re-adds. Returns a NEW set, or null when nothing
 * changed (wrong state or illegal edit — the drag silently continues).
 */
export function paintShapeCell(cells: Set<string>, key: string, mode: 'add' | 'remove'): Set<string> | null {
  const action = classifyShapeEdit(cells, key);
  if (action !== mode) return null;
  const next = new Set(cells);
  if (mode === 'add') next.add(key); else next.delete(key);
  return next;
}

/**
 * Translate the cells so the bounding box starts at (0,0) and report its size (v1 normalizeShape
 * 2715-2733 + commitShapeEdit 2737-2741). `cols`/`rows` are clamped to >= 1 as v1 does when writing
 * them back to the wall. Always returns a fresh Set.
 */
export function normalizeShape(cells: Iterable<string>): { cells: Set<string>; cols: number; rows: number } {
  const src = Array.from(cells);
  const bbox = shapeBBox(src);
  const next = new Set<string>();
  for (const key of src) {
    const [c, r] = parseCell(key);
    next.add(cellKey(c - bbox.minC, r - bbox.minR));
  }
  return { cells: next, cols: Math.max(1, bbox.cols), rows: Math.max(1, bbox.rows) };
}

/**
 * Every empty cell that shares an edge with a filled cell — the "ghost" targets the on-model shape
 * editor shows for growing the shape (v1 rebuildShapeGhosts, 2670-2680). Keys may be negative or
 * beyond cols/rows; positions for those are extrapolated by {@link panelLocalPosition}. Sorted by
 * column then row for determinism.
 */
export function ghostCells(cells: Set<string>): string[] {
  const out = new Set<string>();
  for (const key of cells) for (const nk of neighbourKeys(key)) if (!cells.has(nk)) out.add(nk);
  return Array.from(out).sort((a, b) => {
    const [ac, ar] = parseCell(a), [bc, br] = parseCell(b);
    return ac - bc || ar - br;
  });
}

/**
 * A maximal straight run of exposed unit edges on the outline of a cell shape.
 *  - `axis`     'h' = horizontal edge (top/bottom of cells), 'v' = vertical edge (left/right).
 *  - `nx`,`ny`  outward normal in WALL space: `ny = +1` for a top edge (empty cell above, i.e. row-1;
 *               +y is up), `ny = -1` for a bottom edge; `nx = -1` left edge, `nx = +1` right edge.
 *  - `perpIdx`  the row ('h') or column ('v') the edge belongs to.
 *  - `fromIdx`,`toIdx`  inclusive column ('h') or row ('v') range the run spans.
 */
export interface EdgeRun {
  axis: 'h' | 'v';
  nx: number;
  ny: number;
  perpIdx: number;
  fromIdx: number;
  toIdx: number;
}

/**
 * Trace the outline of a cell shape as merged edge runs (v1 computeShapeEdgeRuns, 4254-4306). Holes
 * produce inward-facing runs as well. Output is sorted (axis, perpIdx, normal, fromIdx) for
 * determinism (v1 relied on object-key order). Accepts a Set or the document's `string[]` cells.
 */
export function computeShapeEdgeRuns(cellsIn: Iterable<string>): EdgeRun[] {
  const cells = cellsIn instanceof Set ? (cellsIn as Set<string>) : new Set(cellsIn);
  type Side = 'top' | 'bot' | 'left' | 'right';
  const buckets = new Map<string, { axis: 'h' | 'v'; side: Side; perpIdx: number; list: number[] }>();
  const push = (axis: 'h' | 'v', side: Side, perpIdx: number, idx: number) => {
    const k = axis + ':' + perpIdx + ':' + side;
    let b = buckets.get(k);
    if (!b) { b = { axis, side, perpIdx, list: [] }; buckets.set(k, b); }
    b.list.push(idx);
  };
  for (const key of cells) {
    const [c, r] = parseCell(key);
    if (!cells.has(cellKey(c, r - 1))) push('h', 'top', r, c);
    if (!cells.has(cellKey(c, r + 1))) push('h', 'bot', r, c);
    if (!cells.has(cellKey(c - 1, r))) push('v', 'left', c, r);
    if (!cells.has(cellKey(c + 1, r))) push('v', 'right', c, r);
  }

  const runs: EdgeRun[] = [];
  for (const b of buckets.values()) {
    const list = b.list.slice().sort((p, q) => p - q);
    const nx = b.axis === 'v' ? (b.side === 'left' ? -1 : 1) : 0;
    const ny = b.axis === 'h' ? (b.side === 'top' ? 1 : -1) : 0;
    let from = list[0], prev = list[0];
    for (let i = 1; i <= list.length; i++) {
      const cur = list[i];
      if (cur !== prev + 1) {
        runs.push({ axis: b.axis, nx, ny, perpIdx: b.perpIdx, fromIdx: from, toIdx: prev });
        from = cur;
      }
      prev = cur;
    }
  }
  return runs.sort((a, b) =>
    a.axis.localeCompare(b.axis) || a.perpIdx - b.perpIdx || (a.nx + a.ny) - (b.nx + b.ny) || a.fromIdx - b.fromIdx);
}

/* ───────────────────────────── Positions in wall-local space ───────────────────────────── */

/** Wall-local y of the centre of row `row` (row 0 = TOP). v1 measured from the vertical centre; v2 from the floor. */
export function rowCenterY(dims: WallDims, row: number): number {
  return dims.totalH - dims.panelH / 2 - row * (dims.panelH + dims.gap);
}

/**
 * Column x/z for `col`, extrapolating straight along the end column's frame for columns outside the
 * layout (v1 rebuildShapeGhosts cellX/cellZ, 2683-2692 — ghost cells can sit beyond the bbox).
 *
 * v1 quirk: extrapolation moved x only (`layout[end].x + k·step`, z unchanged), which is wrong for a
 * folded end column. Here the extrapolation follows the end column's yaw, which coincides with v1 for
 * an unrotated end column and is the intended behaviour for a rotated one.
 */
function columnXZ(dims: WallDims, layout: ColumnPlacement[], col: number): { x: number; z: number; rotY: number } {
  if (!layout.length) return { x: 0, z: 0, rotY: 0 };
  if (col >= 0 && col < layout.length) return layout[col];
  const step = dims.panelW + dims.gap;
  const end = col < 0 ? layout[0] : layout[layout.length - 1];
  const k = col < 0 ? col : col - layout.length + 1;
  return { x: end.x + Math.cos(end.rotY) * k * step, z: end.z - Math.sin(end.rotY) * k * step, rotY: end.rotY };
}

/** Centre of the panel at (col,row) in wall-local space (row 0 = TOP row; y measured from the floor). */
export function panelLocalPosition(dims: WallDims, layout: ColumnPlacement[], col: number, row: number): Vec3 {
  const c = columnXZ(dims, layout, col);
  return [c.x, rowCenterY(dims, row), c.z];
}

/** Rotate a column-local offset (lx to the right, lz towards the screen) by the column's yaw and add the column centre. */
function columnLocalToWall(col: { x: number; z: number; rotY: number }, lx: number, ly: number, lz: number): Vec3 {
  const cos = Math.cos(col.rotY), sin = Math.sin(col.rotY);
  return [col.x + lx * cos + lz * sin, ly, col.z - lx * sin + lz * cos];
}

/**
 * Axis-aligned bounds of all panels in wall-local space, accounting for folded columns
 * (v1 wallBounds, 4552-4571). y spans the floor to the top of the wall.
 */
export function wallLocalBounds(dims: WallDims, layout: ColumnPlacement[]): { minX: number; maxX: number; minZ: number; maxZ: number; minY: 0; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const hw = dims.panelW / 2, hd = dims.panelD / 2;
  for (const col of layout) {
    for (const lx of [-hw, hw]) {
      for (const lz of [-hd, hd]) {
        const [wx, , wz] = columnLocalToWall(col, lx, 0, lz);
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
        minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
      }
    }
  }
  if (!layout.length) minX = maxX = minZ = maxZ = 0;
  return { minX, maxX, minZ, maxZ, minY: 0, maxY: dims.totalH };
}

/* ───────────────────────────── Pixel <-> local ───────────────────────────── */

/** Lateral slack (inches) beyond a column's edge that still maps to that column (v1 5802). */
const PIXEL_HIT_SLACK_IN = 0.5;

/**
 * Column/row index snap, in fractions of a step. A point placed exactly on a column (or row)
 * boundary by {@link wallPixelToLocal} can land 1 ULP short of it once the centroid offset has been
 * added and removed, so a bare `Math.floor` would pick the previous cell and the round-trip would
 * report the last pixel of the previous panel. 1e-9 of a step is 2.5e-8 in — far below any pixel.
 */
const CELL_INDEX_EPS = 1e-9;

/**
 * Map a wall-local point (e.g. a raycast hit on the screen) to a wall pixel (v1 worldToWallPixel,
 * 5789-5810, expressed in the local frame). Returns null when the point is not laterally over any
 * segment. x is mapped per column and y per row (gaps carry no pixels); the result is clamped to the
 * wall. Exact inverse of {@link wallPixelToLocal}.
 *
 * Deviations from v1 (all deliberate):
 *  - Segment selection: v1 returned the first column whose lateral range contained the point. On a
 *    folded wall two segments can both contain a point laterally, so this version evaluates every
 *    segment and picks the one whose screen plane is closest to the point (identical to v1 for a
 *    straight wall).
 *  - Inverse rotation sign (v1 bug, 5798-5800): v1 computed `localX = dx·cos(-rotY) - dz·sin(-rotY)`
 *    = dx·cos(rotY) + dz·sin(rotY), which is NOT the inverse of a mesh with `rotation.y = rotY` and
 *    mirrored pixel x within every rotated column. The correct lateral coordinate, used here, is
 *    dx·cos(rotY) - dz·sin(rotY) (verified against THREE.Object3D.localToWorld). Do not "restore" v1.
 *  - Slack handling: the ±{@link PIXEL_HIT_SLACK_IN} lateral slack past a segment's end columns is
 *    kept, but the pixel is clamped INSIDE the selected column. v1 (5805) let a hit in the slack zone
 *    of a folded segment's first column produce the last pixels of the previous column, i.e. a pixel
 *    on the other leg of the fold.
 *  - Row gaps (v1 5806): v1 used `py = (totalH/2 - y) / IN_PER_PX_H`, which ignores the (rows-1)·gap
 *    contained in totalH, so pixel rows drifted row·gap from the physical panel rows (0.24 in on the
 *    default 5-row wall). Here y is mapped per row exactly like x per column.
 */
export function localPointToWallPixel(dims: WallDims, layout: ColumnPlacement[], segments: Segment[], p: Vec3): { px: number; py: number } | null {
  const step = dims.panelW + dims.gap;
  const hw = dims.panelW / 2;
  let best: { px: number; dist: number } | null = null;

  for (const seg of segments) {
    const first = layout[seg.startCol];
    if (!first) continue;
    const n = seg.endCol - seg.startCol + 1;
    const cos = Math.cos(-first.rotY), sin = Math.sin(-first.rotY);
    const dx = p[0] - first.x, dz = p[2] - first.z;
    // Point in the segment's frame (x to the right, z towards the screen).
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    const segRight = (n - 1) * step + hw;
    if (localX < -hw - PIXEL_HIT_SLACK_IN || localX > segRight + PIXEL_HIT_SLACK_IN) continue;

    const k = clamp(Math.floor((localX + hw) / step + CELL_INDEX_EPS), 0, n - 1);
    const c = seg.startCol + k;
    const pxW = dims.spec.pxW;
    const fracX = (localX + hw - k * step) / dims.panelW;
    // Clamp inside the selected column so slack/gap hits never report a neighbouring column's pixels.
    const px = clamp(c * pxW + Math.round(fracX * pxW), c * pxW, (c + 1) * pxW - 1);
    const dist = Math.abs(localZ - dims.panelD / 2);
    if (!best || dist < best.dist) best = { px, dist };
  }
  if (!best) return null;

  // y per row (row 0 = top), mirroring the per-column x mapping; row gaps carry no pixels.
  const pxH = dims.spec.pxH;
  const rowStep = dims.panelH + dims.gap;
  const fromTop = dims.totalH - p[1];
  const r = clamp(Math.floor(fromTop / rowStep + CELL_INDEX_EPS), 0, Math.max(0, dims.rows - 1));
  const py = clamp(r * pxH + Math.round(((fromTop - r * rowStep) / dims.panelH) * pxH), r * pxH, (r + 1) * pxH - 1);
  return {
    px: clamp(best.px, 0, dims.wallWPx - 1),
    py: clamp(py, 0, dims.wallHPx - 1),
  };
}

/**
 * Wall-local point on the screen plane (z = +panelD/2 in the column's frame) for wall pixel (px,py).
 * Inverse of {@link localPointToWallPixel}: px selects the column and a fraction across it, py selects
 * the row (row 0 = top) and a fraction down it. Gaps carry no pixels in either axis, so pixel row r
 * always lands on physical panel row r (v1's worldToWallPixel ignored row gaps in y — see
 * {@link localPointToWallPixel}; this mapping is new in v2 and is the general pixel -> 3D mapping,
 * so it must not drift from the panel geometry).
 */
export function wallPixelToLocal(dims: WallDims, layout: ColumnPlacement[], px: number, py: number): Vec3 {
  const pxW = dims.spec.pxW, pxH = dims.spec.pxH;
  const c = clamp(Math.floor(px / pxW), 0, Math.max(0, dims.cols - 1));
  const fracX = (px - c * pxW) / pxW;
  const lx = -dims.panelW / 2 + fracX * dims.panelW;
  const r = clamp(Math.floor(py / pxH), 0, Math.max(0, dims.rows - 1));
  const fracY = (py - r * pxH) / pxH;
  const y = dims.totalH - r * (dims.panelH + dims.gap) - fracY * dims.panelH;
  return columnLocalToWall(columnXZ(dims, layout, c), lx, y, dims.panelD / 2);
}

/* ───────────────────────────── Accessories ───────────────────────────── */

/** Placement of one column's base plate and back-support brackets in wall-local space. */
export interface AccessoryPlacement {
  col: number;
  /**
   * Base plate origin: the panel's bottom centre, pushed {@link BASE_PLATE_Z_OFFSET_IN} toward the
   * screen (the plate extends `base.thick` below the origin).
   */
  base: { position: Vec3; rotY: number };
  /**
   * Back supports: origin at the panel bottom (y = 0 — the brackets stand ON the base plate, not on
   * the floor), at the panel back (z = -panelD/2 in the column frame), flush with the left/right
   * panel edges. `mirrored` is true for the right-hand bracket (the CAD part is the LH support);
   * v1 used the identical, width-symmetric geometry for both.
   */
  supports: { position: Vec3; rotY: number; mirrored: boolean }[];
}

/**
 * How far forward (toward the screen, +Z in the column frame) the base plate's centre sits from the
 * panel's mid-depth, inches. The manufacturer's assembly centres the 477.012 mm-deep plate on
 * z = 0 while the panel spans z -29.464..15.494 mm (mid -6.985), so the plate leads the panel by
 * 6.985 mm = 0.275 in and protrudes 8.78 in in front of the screen and 8.23 in behind the cabinet.
 */
export const BASE_PLATE_Z_OFFSET_IN = 0.275;

/**
 * Base plate + two back supports per column (v1 buildAccessories, 3951-3976). Returns [] when the
 * spec has no accessories. Custom-shape walls do not get accessories in v1 — the caller decides.
 *
 * Heights follow the manufacturer's assembly ("Veloxity LED iPoster Wall.STEP"): the base plates
 * span y 0..6.35 mm, the panels start at y = 6.35 mm, and every back support spans y 6.35..543.306
 * mm — that is, the brackets stand ON TOP of the plate at the panel-bottom level, not on the floor.
 * So in this frame (panel bottom = y 0) both the panel and the bracket feet sit at y = 0 and the
 * plate hangs from 0 down to -base.thick. A renderer that wants the plate bottom on the floor lifts
 * the whole wall by `base.thick` when accessories are shown (`LedWallRenderer` does).
 */
export function accessoryPlacements(dims: WallDims, layout: ColumnPlacement[], spec: PanelSpec): AccessoryPlacement[] {
  const acc = spec.accessories;
  if (!acc) return [];
  const panelBottom = 0;
  // The brackets' feet sit on the plate's TOP face, which is the panel bottom — see the CAD note above.
  const footY = panelBottom;
  const offsets: [number, boolean][] = [
    [-dims.panelW / 2 + acc.support.width / 2, false],
    [dims.panelW / 2 - acc.support.width / 2, true],
  ];
  return layout.map(col => ({
    col: col.col,
    base: { position: columnLocalToWall(col, 0, panelBottom, BASE_PLATE_Z_OFFSET_IN), rotY: col.rotY },
    supports: offsets.map(([lx, mirrored]) => ({
      position: columnLocalToWall(col, lx, footY, -dims.panelD / 2),
      rotY: col.rotY,
      mirrored,
    })),
  }));
}
