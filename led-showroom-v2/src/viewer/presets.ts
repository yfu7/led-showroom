/**
 * Camera stands for the standalone viewer, shared by the export (which writes them) and the page's
 * runtime (which fits them to its window). Plain number triples, no three.js: the runtime bundles
 * this file on its own, and the tests run it as is.
 *
 * Units are the GLB's: metres, in the app's world frame (the export only scales inches by 0.0254).
 */
export type V3 = [number, number, number];

/** A view that frames a box: the camera stands off `center` along `dir`, far enough to fit `w` x `h`. */
export interface ViewerPreset {
  id: string;
  label: string;
  center: V3;
  /** Width and height to fit, across the view; `depth` along it (half of it is added to the stand-off). */
  w: number;
  h: number;
  depth: number;
  /** Unit vector from the target to the camera. */
  dir: V3;
}

/** The app frames at 1.6x the fitting distance (CameraRig's FIT_PADDING): tighter crops a wall's edges. */
export const VIEWER_FIT_PADDING = 1.6;
/** Eye height for Walk, as the app's eye-level view: 66 in. */
export const VIEWER_EYE_HEIGHT_M = 66 * 0.0254;
/** Nearest a fitted camera stands, in metres (the app's 24 in). */
const MIN_FIT_M = 24 * 0.0254;

const len = (v: V3): number => Math.hypot(v[0], v[1], v[2]);
export const norm = (v: V3): V3 => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Where the camera stands for `p` at this vertical fov (degrees) and aspect (w / h). */
export function fitPose(p: ViewerPreset, fovDeg: number, aspect: number): { position: V3; target: V3 } {
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const d = Math.max((p.h / 2) / t, (p.w / 2) / t / Math.max(aspect, 1e-3), MIN_FIT_M) * VIEWER_FIT_PADDING + p.depth / 2;
  const dir = norm(p.dir);
  return { position: [p.center[0] + dir[0] * d, p.center[1] + dir[1] * d, p.center[2] + dir[2] * d], target: [...p.center] };
}

/** A box in metres, min and max corners. */
export interface Box { min: V3; max: V3 }

/** A wall as the export sees it: its world box and the way its face looks. */
export interface WallView { id: string; name: string; box: Box; normal: V3 }

const center = (b: Box): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const size = (b: Box): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

/**
 * The page's stands: an overview (the app's home view), front, top, then one square on to each wall's
 * face. A wall turned on the floor fits its own width across the view, not the box's.
 */
export function viewerPresets(scene: Box, walls: WallView[]): ViewerPreset[] {
  const c = center(scene), s = size(scene);
  const out: ViewerPreset[] = [
    { id: 'overview', label: 'Overview', center: c, w: s[0], h: s[1], depth: s[2], dir: norm([0.35, 0.22, 0.95]) },
    { id: 'front', label: 'Front', center: c, w: s[0], h: s[1], depth: s[2], dir: [0, 0, 1] },
    // A hair of +z keeps the orbit off its pole, as the app's top view does.
    { id: 'top', label: 'Top', center: c, w: s[0], h: s[2], depth: s[1], dir: norm([0, 1, 1e-3]) },
  ];
  // Two walls of one name get a number each, so every button says which it is.
  const seen = new Map<string, number>();
  const named = walls.map(w => w.name.trim() || 'Wall');
  const dupes = new Set(named.filter((n, i) => named.indexOf(n) !== i));
  for (const [i, wall] of walls.entries()) {
    const base = named[i];
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    const label = dupes.has(base) ? `${base} ${k}` : base;
    const n = norm([wall.normal[0], 0, wall.normal[2]]);
    const ws = size(wall.box);
    // Across the face: the box's extent along the horizontal perpendicular of the normal.
    const across = Math.abs(ws[0] * n[2]) + Math.abs(ws[2] * n[0]);
    const along = Math.abs(ws[0] * n[0]) + Math.abs(ws[2] * n[2]);
    out.push({ id: `wall:${wall.id}`, label, center: center(wall.box), w: across, h: ws[1], depth: along, dir: n });
  }
  return out;
}
