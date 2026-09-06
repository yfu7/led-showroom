/**
 * Pure snapping / ground-lock helpers shared by the Select (drag-move) and Transform (gizmo)
 * tools. No engine, no DOM — only three.js maths so the helpers are unit-testable in node.
 *
 * Units: inches (world unit), degrees for angles. Y is up, the floor is y = 0.
 */
import * as THREE from 'three';
import { clamp, snap, type Vec3 } from '../math';
import type { StageEntity, Transform } from '../document/types';

/** Smallest scale factor a snapped/propagated scale may reach (avoids inverted / zero-size objects). */
export const MIN_SCALE = 0.01;
/** Largest scale factor (v1 allowed 0.1..10; v2 is more permissive for imported models). */
export const MAX_SCALE = 100;
/** Tolerance (inches) used to decide whether an object rests on a support surface. */
export const REST_EPS_IN = 1e-3;

/** Snap each component of a translation to a multiple of `stepIn` (no-op when disabled or step <= 0). */
export function snapTranslation(v: Vec3, stepIn: number, enabled: boolean): Vec3 {
  if (!enabled || !(stepIn > 0)) return [v[0], v[1], v[2]];
  const s = (x: number) => { const r = snap(x, stepIn); return r === 0 ? 0 : r; }; // normalise -0
  return [s(v[0]), s(v[1]), s(v[2])];
}

/** Snap an angle (degrees) to a multiple of `stepDeg` (no-op when disabled or step <= 0). */
export function snapAngleDeg(deg: number, stepDeg: number, enabled: boolean): number {
  if (!enabled || !(stepDeg > 0)) return deg;
  return snap(deg, stepDeg);
}

/** Snap a scale factor to a multiple of `step`, never below MIN_SCALE (so snapping can't collapse an object). */
export function snapScale(s: number, step: number, enabled: boolean): number {
  const v = enabled && step > 0 ? snap(s, step) : s;
  return clamp(Number.isFinite(v) ? v : 1, MIN_SCALE, MAX_SCALE);
}

/**
 * Ground lock: the Y offset that must be added to an object's position so the bottom of its
 * footprint (`footprintMinY`, world) rests exactly on `supportY` (floor = 0, or a stage top).
 *
 * `newY = position.y + groundLockY(bounds.min.y, supportY)`.
 */
export function groundLockY(footprintMinY: number, supportY = 0): number {
  return supportY - footprintMinY;
}

/** A candidate support surface: the world AABB of a stage deck (top = bounds.max.y). */
export interface Support {
  id?: string;
  bounds: THREE.Box3;
}

export interface SupportHit {
  /** Height of the support surface (0 = floor). */
  y: number;
  /** Id of the supporting stage, or null when the object rests on the floor. */
  stageId: string | null;
}

/**
 * The highest stage top whose XZ footprint contains the centre of the object's XZ footprint.
 * Returns floor (y = 0, stageId null) when no stage is under the object.
 *
 * The footprint may be empty (renderer not ready yet); pass a degenerate box at the object's
 * position in that case (see `footprintAt`).
 */
export function supportUnder(stages: readonly Support[], footprint: THREE.Box3): SupportHit {
  if (footprint.isEmpty()) return { y: 0, stageId: null };
  const cx = (footprint.min.x + footprint.max.x) / 2;
  const cz = (footprint.min.z + footprint.max.z) / 2;
  let best: SupportHit = { y: 0, stageId: null };
  for (const s of stages) {
    const b = s.bounds;
    if (b.isEmpty()) continue;
    if (cx < b.min.x || cx > b.max.x || cz < b.min.z || cz > b.max.z) continue;
    const top = b.max.y;
    if (!Number.isFinite(top) || top <= best.y) continue;
    best = { y: top, stageId: s.id ?? null };
  }
  return best;
}

/** Numeric form of {@link supportUnder}: the height of the support surface under the footprint (0 = floor). */
export function supportHeightUnder(stages: readonly Support[], footprint: THREE.Box3): number {
  return supportUnder(stages, footprint).y;
}

/** A degenerate footprint box at a world point (fallback when an entity has no renderable bounds yet). */
export function footprintAt(position: Vec3 | THREE.Vector3, out = new THREE.Box3()): THREE.Box3 {
  const p = Array.isArray(position) ? new THREE.Vector3(position[0], position[1], position[2]) : position;
  return out.setFromPoints([p]);
}

/** Build a three.js matrix from a document transform (degrees → radians, Euler YXZ like applyTransform). */
export function transformToMatrix(t: Transform, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(t.rotation[0]),
    THREE.MathUtils.degToRad(t.rotation[1]),
    THREE.MathUtils.degToRad(t.rotation[2]),
    'YXZ',
  ));
  return out.compose(new THREE.Vector3(t.position[0], t.position[1], t.position[2]), q, new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]));
}

/**
 * World AABB of a stage deck computed from the document alone (origin at the bottom centre,
 * deck spans y ∈ [0, heightIn]). Ignores group parents — stages are expected at the top level.
 */
export function stageWorldBounds(stage: Pick<StageEntity, 'widthIn' | 'depthIn' | 'heightIn' | 'transform'>, out = new THREE.Box3()): THREE.Box3 {
  const hw = Math.max(0, stage.widthIn) / 2, hd = Math.max(0, stage.depthIn) / 2, h = Math.max(0, stage.heightIn);
  out.min.set(-hw, 0, -hd);
  out.max.set(hw, h, hd);
  return out.applyMatrix4(transformToMatrix(stage.transform));
}

/** Support candidates for every visible stage in `entities`, excluding `excludeIds` (the objects being moved). */
export function stageSupports(entities: readonly { id: string; type: string; visible: boolean }[], excludeIds: Iterable<string> = []): Support[] {
  const ex = new Set(excludeIds);
  const out: Support[] = [];
  for (const e of entities) {
    if (e.type !== 'stage' || !e.visible || ex.has(e.id)) continue;
    out.push({ id: e.id, bounds: stageWorldBounds(e as unknown as StageEntity) });
  }
  return out;
}

/**
 * Resolve where an object should rest given its footprint (already moved to the candidate XZ).
 * Returns the Y position the entity origin must take so `footprintMinY` sits on the support and
 * the id of the stage it lands on.
 */
export function restOnSupport(stages: readonly Support[], footprint: THREE.Box3, positionY: number): { y: number; stageId: string | null } {
  const hit = supportUnder(stages, footprint);
  const minY = footprint.isEmpty() ? positionY : footprint.min.y;
  return { y: positionY + groundLockY(minY, hit.y), stageId: hit.stageId };
}

/** True when `y` is (within tolerance) exactly the resting height. */
export function isResting(y: number, restY: number, eps = REST_EPS_IN): boolean {
  return Math.abs(y - restY) <= eps;
}

/** Clamp a drag delta so grazing-angle plane intersections can't fling objects to infinity. */
export function clampDelta(delta: THREE.Vector3, maxLen = 5000): THREE.Vector3 {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y) || !Number.isFinite(delta.z)) return delta.set(0, 0, 0);
  const l = delta.length();
  if (l > maxLen) delta.multiplyScalar(maxLen / l);
  return delta;
}

/** Round transform components to kill float noise from matrix decomposition (1e-4 in / deg). */
export function roundTransform(t: Transform, decimals = 4): Transform {
  const p = 10 ** decimals;
  const r = (v: number) => { const x = Math.round(v * p) / p; return Object.is(x, -0) ? 0 : x; };
  return {
    position: [r(t.position[0]), r(t.position[1]), r(t.position[2])],
    rotation: [r(t.rotation[0]), r(t.rotation[1]), r(t.rotation[2])],
    scale: [r(t.scale[0]), r(t.scale[1]), r(t.scale[2])],
  };
}

/* ───────────── selection / hierarchy helpers ───────────── */

/**
 * Members of `ids` that have no other member among their ancestors (`parentId` chain). Moving a
 * group and one of its children together would otherwise apply the delta twice to the child.
 * Order follows `ids`; cycles and dangling parent ids stop the walk.
 */
export function topLevelIds(entities: readonly { id: string; parentId?: string | null }[], ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const byId = new Map(entities.map(e => [e.id, e]));
  const out: string[] = [];
  for (const id of set) {
    const seen = new Set<string>([id]);
    let covered = false;
    for (let p = byId.get(id)?.parentId; p && !seen.has(p); p = byId.get(p)?.parentId) {
      seen.add(p);
      if (set.has(p)) { covered = true; break; }
    }
    if (!covered) out.push(id);
  }
  return out;
}

/** History merge key that changes with the set of edited ids, so merged nudges never span two selections. */
export function mergeKeyFor(prefix: string, ids: Iterable<string>): string {
  return `${prefix}:${Array.from(ids).sort().join(',')}`;
}

/* ───────────── drag plane / delta helpers ───────────── */

/** Smallest |ray.direction.y| at which the horizontal drag plane still gives a usable intersection. */
export const FLOOR_PLANE_MIN_SLOPE = 0.15;
/** Slope above which a drag that fell back to the side plane returns to the floor plane (hysteresis). */
export const FLOOR_PLANE_RESTORE_SLOPE = 0.3;

/**
 * Whether dragging on the horizontal plane `y = planeY` is sensible for `ray`: the ray must head
 * towards the plane (not away from it, e.g. grabbing a wall above eye level and pointing below
 * the horizon) and meet it at a slope of at least `minSlope`, otherwise the intersection runs
 * off to the horizon and the objects freeze or fly away (v1 avoided this with a camera-facing
 * plane, index.html 7690-7952).
 */
export function floorPlaneUsable(ray: THREE.Ray, planeY: number, minSlope = FLOOR_PLANE_MIN_SLOPE): boolean {
  const dy = ray.direction.y;
  if (!Number.isFinite(dy) || Math.abs(dy) < minSlope) return false;
  const dist = planeY - ray.origin.y;
  if (Math.abs(dist) < 1e-6) return true; // starting on the plane (ortho top view)
  return Math.sign(dist) === Math.sign(dy);
}

/** Longest drag delta allowed for a grab `camDistance` away from the camera (never below 120"). */
export function dragDeltaCap(camDistance: number): number {
  return Number.isFinite(camDistance) ? Math.max(120, 2 * camDistance) : 120;
}

/**
 * Snap a drag delta so the *absolute* position `base + delta` lands on the grid along the given
 * axes (what TransformControls does), instead of snapping the delta itself (which would keep an
 * off-grid object off-grid). Disabled axes keep their raw delta.
 */
export function snapDeltaAbsolute(base: Vec3, delta: Vec3, stepIn: number, enabled: boolean, axes: [boolean, boolean, boolean] = [true, true, true]): Vec3 {
  if (!enabled || !(stepIn > 0)) return [delta[0], delta[1], delta[2]];
  const out: Vec3 = [delta[0], delta[1], delta[2]];
  for (let i = 0; i < 3; i++) {
    if (!axes[i]) continue;
    const v = snap(base[i] + delta[i], stepIn) - base[i];
    out[i] = Math.abs(v) < 1e-9 ? 0 : v;
  }
  return out;
}

/** Express a world-space delta in a parent's local frame (linear part of the parent's inverse world matrix). */
export function localDelta(delta: THREE.Vector3, parentInv: THREE.Matrix4, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(delta).applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentInv));
}

/* ───────────── transform comparison ───────────── */

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _ea = new THREE.Euler();

/** Quaternion of a document rotation (degrees, Euler YXZ like `applyTransform`). */
export function quaternionOfRotation(rotation: Vec3, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(_ea.set(THREE.MathUtils.degToRad(rotation[0]), THREE.MathUtils.degToRad(rotation[1]), THREE.MathUtils.degToRad(rotation[2]), 'YXZ'));
}

/**
 * Keep the user's own Euler numbers when a decomposed rotation describes the same orientation
 * (e.g. 270 deg must not come back as -90 deg after a no-op gizmo gesture).
 */
export function preferBaseRotation(rotation: Vec3, base: Vec3, epsRad = 1e-6): Vec3 {
  quaternionOfRotation(rotation, _qa);
  quaternionOfRotation(base, _qb);
  return _qa.angleTo(_qb) <= epsRad ? [base[0], base[1], base[2]] : [rotation[0], rotation[1], rotation[2]];
}

/** Component-wise equality of two transforms within `eps`. */
export function transformEquals(a: Transform, b: Transform, eps = 1e-9): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > eps) return false;
    if (Math.abs(a.rotation[i] - b.rotation[i]) > eps) return false;
    if (Math.abs(a.scale[i] - b.scale[i]) > eps) return false;
  }
  return true;
}
