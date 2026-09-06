/**
 * Point snapping for the measure tool (three.js maths only — no scene, no DOM).
 *
 * Given a surface hit (world point + the mesh that was hit) find the best snap target within a
 * screen radius (default 10 px):
 *
 *   vertex    a vertex of the hit mesh (geometry position attribute → world; skipped for meshes
 *             with ≥ `maxVertices` vertices, default 20 000)
 *   midpoint  the midpoint of one of the three edges of the hit triangle
 *   grid      the nearest ground-grid intersection (`gridIn` pitch) when the floor was hit
 *   floor     the floor line y = 0 (a floor hit far from any grid node, or a surface hit whose
 *             point projects within the radius of y = 0)
 *   surface   nothing snapped — the raw hit point
 *
 * Candidates are compared in SCREEN space (`projectedDistance`), so snapping feels the same at
 * any zoom. Within the radius the kinds rank vertex > midpoint > grid > floor; ties inside a
 * kind go to the closest candidate.
 */
import * as THREE from 'three';

export type SnapKind = 'vertex' | 'midpoint' | 'grid' | 'surface' | 'floor';

export interface SnapResult {
  point: THREE.Vector3;
  kind: SnapKind;
}

/** Triangle of the hit face (indices into the geometry's position attribute). */
export interface HitFace { a: number; b: number; c: number }

export interface SnapHit {
  /** World-space hit point. */
  point: THREE.Vector3;
  /** The object that was hit (a Mesh for vertex / midpoint snapping); null for a pure plane hit. */
  object?: THREE.Object3D | null;
  /** The hit triangle, when known (from `Raycaster` intersections or {@link resolveHitFace}). */
  face?: HitFace | null;
  /** Instance index for `InstancedMesh` hits. */
  instanceId?: number | null;
  /** True when the hit is on the floor (env floor mesh, shadow catcher, or the y = 0 plane). */
  isFloor?: boolean;
}

export interface SnapOptions {
  camera: THREE.Camera;
  /** Viewport size in CSS pixels. */
  viewport: { width: number; height: number };
  /** Screen radius (px) inside which a candidate snaps. Default 10. */
  radiusPx?: number;
  /** Ground grid pitch in inches (document `environment.grid.minorIn`). 0 / undefined = no grid snap. */
  gridIn?: number;
  /** Meshes with at least this many vertices skip vertex snapping. Default 20 000. */
  maxVertices?: number;
  /** Floor height (world y). Default 0. */
  floorY?: number;
}

export const DEFAULT_SNAP_RADIUS_PX = 10;
export const DEFAULT_MAX_SNAP_VERTICES = 20_000;

/** Kind ranking used when several candidates are inside the radius (lower wins). */
const KIND_RANK: Record<SnapKind, number> = { vertex: 0, midpoint: 1, grid: 2, floor: 3, surface: 4 };

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _inst = new THREE.Matrix4();

/**
 * Distance in CSS pixels between the screen projections of two world points. Points behind the
 * camera project unreliably, so a point with clip w ≤ 0 returns `Infinity`.
 */
export function projectedDistance(
  camera: THREE.Camera,
  viewportSize: { width: number; height: number },
  worldA: THREE.Vector3,
  worldB: THREE.Vector3,
): number {
  const a = projectToScreen(camera, viewportSize, worldA, _pa);
  const b = projectToScreen(camera, viewportSize, worldB, _pb);
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** World → CSS pixel (x right, y down). Returns null when the point is behind the camera. */
export function projectToScreen(
  camera: THREE.Camera,
  viewportSize: { width: number; height: number },
  world: THREE.Vector3,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  // Vector3.project() divides by w; detect "behind" via the camera-space z first.
  out.copy(world).applyMatrix4(camera.matrixWorldInverse);
  const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
  if (persp && out.z >= 0) return null;
  out.applyMatrix4(camera.projectionMatrix);
  out.x = (out.x + 1) / 2 * viewportSize.width;
  out.y = (1 - out.y) / 2 * viewportSize.height;
  return out;
}

/**
 * Re-intersect a single object with `raycaster` to recover the hit triangle and instance id
 * (`pickSurface` only returns the point). Cheap: one object, no recursion.
 */
export function resolveHitFace(object: THREE.Object3D, raycaster: THREE.Raycaster): { face: HitFace | null; instanceId: number | null } {
  const hits = raycaster.intersectObject(object, false);
  const h = hits[0];
  if (!h) return { face: null, instanceId: null };
  return { face: h.face ? { a: h.face.a, b: h.face.b, c: h.face.c } : null, instanceId: h.instanceId ?? null };
}

/** World matrix of the hit mesh, including the instance matrix for instanced meshes. */
function hitWorldMatrix(object: THREE.Object3D, instanceId: number | null | undefined, out: THREE.Matrix4): THREE.Matrix4 {
  object.updateWorldMatrix(true, false);
  out.copy(object.matrixWorld);
  const im = object as THREE.InstancedMesh;
  if (im.isInstancedMesh && instanceId !== null && instanceId !== undefined && instanceId < im.count) {
    im.getMatrixAt(instanceId, _inst);
    out.multiply(_inst);
  }
  return out;
}

/** Read vertex `i` of `geometry` into world space through `matrix`. */
function vertexAt(geometry: THREE.BufferGeometry, i: number, matrix: THREE.Matrix4, out: THREE.Vector3): THREE.Vector3 {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  return out.fromBufferAttribute(pos, i).applyMatrix4(matrix);
}

/** Nearest grid node on the floor plane for a pitch of `gridIn` (y forced to `floorY`). */
export function nearestGridPoint(point: THREE.Vector3, gridIn: number, floorY = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.round(point.x / gridIn) * gridIn, floorY, Math.round(point.z / gridIn) * gridIn);
}

/**
 * Find the best snap target for `hit`. Always returns a result: when nothing is within the
 * radius the raw point is returned with kind `surface` (or `floor` for floor hits, with y
 * forced to `floorY`).
 */
export function snapPoint(hit: SnapHit, opts: SnapOptions): SnapResult {
  const radius = opts.radiusPx ?? DEFAULT_SNAP_RADIUS_PX;
  const maxVerts = opts.maxVertices ?? DEFAULT_MAX_SNAP_VERTICES;
  const floorY = opts.floorY ?? 0;
  const { camera, viewport } = opts;
  camera.updateMatrixWorld();
  const dist = (p: THREE.Vector3) => projectedDistance(camera, viewport, hit.point, p);

  const state: { best: { point: THREE.Vector3; kind: SnapKind; d: number } | null } = { best: null };
  const consider = (p: THREE.Vector3, kind: SnapKind) => {
    const d = dist(p);
    if (d > radius) return;
    const best = state.best;
    if (!best || KIND_RANK[kind] < KIND_RANK[best.kind] || (KIND_RANK[kind] === KIND_RANK[best.kind] && d < best.d)) {
      state.best = { point: p.clone(), kind, d };
    }
  };

  const mesh = hit.object as THREE.Mesh | null | undefined;
  const geometry = mesh && (mesh as THREE.Mesh).isMesh ? mesh.geometry : null;
  const posAttr = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;

  // Floor hits are conceptually an infinite plane: its four corner vertices are not meaningful.
  if (geometry && posAttr && !hit.isFloor) {
    const matrix = hitWorldMatrix(mesh!, hit.instanceId, _m4);
    const v = new THREE.Vector3();

    // ── vertices ──
    if (posAttr.count < maxVerts) {
      for (let i = 0; i < posAttr.count; i++) consider(vertexAt(geometry, i, matrix, v), 'vertex');
    } else if (hit.face) {
      // Large mesh: still allow the three corners of the hit triangle.
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) consider(vertexAt(geometry, i, matrix, v), 'vertex');
    }

    // ── edge midpoints of the hit face ──
    if (hit.face) {
      const a = vertexAt(geometry, hit.face.a, matrix, new THREE.Vector3());
      const b = vertexAt(geometry, hit.face.b, matrix, new THREE.Vector3());
      const c = vertexAt(geometry, hit.face.c, matrix, new THREE.Vector3());
      consider(v.addVectors(a, b).multiplyScalar(0.5), 'midpoint');
      consider(v.addVectors(b, c).multiplyScalar(0.5), 'midpoint');
      consider(v.addVectors(c, a).multiplyScalar(0.5), 'midpoint');
    }
  }

  if (hit.isFloor) {
    const onFloor = new THREE.Vector3(hit.point.x, floorY, hit.point.z);
    if (opts.gridIn && opts.gridIn > 0) consider(nearestGridPoint(onFloor, opts.gridIn, floorY), 'grid');
    if (state.best) return { point: state.best.point, kind: state.best.kind };
    return { point: onFloor, kind: 'floor' };
  }

  // Surface hit close to the floor line y = floorY → snap down onto it.
  consider(new THREE.Vector3(hit.point.x, floorY, hit.point.z), 'floor');

  if (state.best) return { point: state.best.point, kind: state.best.kind };
  return { point: hit.point.clone(), kind: 'surface' };
}

/** Project `b` onto the axis line through `a` (axis-lock while placing the second point). */
export function projectOntoAxis(a: THREE.Vector3, b: THREE.Vector3, axis: 'x' | 'y' | 'z', out = new THREE.Vector3()): THREE.Vector3 {
  out.copy(a);
  out[axis] = b[axis];
  return out;
}
