/** Raycasting helpers shared by tools. */
import * as THREE from 'three';
import { LAYER_MAIN } from './Renderer';

export interface Hit {
  entityId: string;
  object: THREE.Object3D;
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  distance: number;
  /** Extra data set by renderers (e.g. { part: 'panel', col, row }). */
  userData: Record<string, unknown>;
}

const _raycaster = new THREE.Raycaster();
_raycaster.layers.set(LAYER_MAIN);
const _plane = new THREE.Plane();
const _v = new THREE.Vector3();

/** Pointer position → normalised device coords for `el`. */
export function pointerToNdc(e: { clientX: number; clientY: number }, el: HTMLElement, out = new THREE.Vector2()): THREE.Vector2 {
  const r = el.getBoundingClientRect();
  out.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  out.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  return out;
}

export function rayFromNdc(ndc: THREE.Vector2, camera: THREE.Camera): THREE.Raycaster {
  _raycaster.setFromCamera(ndc, camera);
  return _raycaster;
}

/** Walk up from a hit object to the object carrying `userData.entityId`. */
export function entityIdOf(obj: THREE.Object3D | null): string | null {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && typeof o.userData.entityId === 'string') return o.userData.entityId as string;
    o = o.parent;
  }
  return null;
}

/** First entity under the pointer (skips helpers, gizmos, non-pickable). */
export function pickEntity(ndc: THREE.Vector2, camera: THREE.Camera, root: THREE.Object3D, opts: { exclude?: Set<string>; onlyTypes?: Set<string> } = {}): Hit | null {
  const rc = rayFromNdc(ndc, camera);
  const hits = rc.intersectObject(root, true);
  for (const h of hits) {
    if (h.object.userData.unpickable) continue;
    if (!h.object.visible) continue;
    const id = entityIdOf(h.object);
    if (!id) continue;
    if (opts.exclude?.has(id)) continue;
    if (opts.onlyTypes) {
      const t = entityTypeOf(h.object);
      if (!t || !opts.onlyTypes.has(t)) continue;
    }
    const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    return { entityId: id, object: h.object, point: h.point.clone(), normal, distance: h.distance, userData: h.object.userData };
  }
  return null;
}

export function entityTypeOf(obj: THREE.Object3D | null): string | null {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && typeof o.userData.entityType === 'string') return o.userData.entityType as string;
    o = o.parent;
  }
  return null;
}

/** Any surface (entities or the floor) under the pointer, for measuring. */
export function pickSurface(ndc: THREE.Vector2, camera: THREE.Camera, root: THREE.Object3D): { point: THREE.Vector3; normal: THREE.Vector3 | null; entityId: string | null; object: THREE.Object3D } | null {
  const rc = rayFromNdc(ndc, camera);
  const hits = rc.intersectObject(root, true);
  for (const h of hits) {
    if (h.object.userData.unpickable || !h.object.visible) continue;
    const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    return { point: h.point.clone(), normal, entityId: entityIdOf(h.object), object: h.object };
  }
  return null;
}

/** Intersect the pointer ray with the horizontal plane y = `y`. */
export function pickGround(ndc: THREE.Vector2, camera: THREE.Camera, y = 0, out = new THREE.Vector3()): THREE.Vector3 | null {
  const rc = rayFromNdc(ndc, camera);
  _plane.set(new THREE.Vector3(0, 1, 0), -y);
  return rc.ray.intersectPlane(_plane, out) ? out : null;
}

/** Intersect the pointer ray with an arbitrary plane. */
export function pickPlane(ndc: THREE.Vector2, camera: THREE.Camera, plane: THREE.Plane, out = new THREE.Vector3()): THREE.Vector3 | null {
  const rc = rayFromNdc(ndc, camera);
  return rc.ray.intersectPlane(plane, out) ? out : null;
}

/** A plane facing the camera through `point`. */
export function cameraFacingPlane(camera: THREE.Camera, point: THREE.Vector3, out = new THREE.Plane()): THREE.Plane {
  camera.getWorldDirection(_v);
  return out.setFromNormalAndCoplanarPoint(_v.negate(), point);
}

/** A vertical plane through `point` facing the camera (for Shift-drag vertical moves). */
export function verticalPlane(camera: THREE.Camera, point: THREE.Vector3, out = new THREE.Plane()): THREE.Plane {
  camera.getWorldDirection(_v);
  _v.y = 0;
  if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
  return out.setFromNormalAndCoplanarPoint(_v.normalize().negate(), point);
}

/** World bounds of an object's visible, pickable meshes. */
export function objectBounds(obj: THREE.Object3D, out = new THREE.Box3()): THREE.Box3 {
  out.makeEmpty();
  obj.updateWorldMatrix(true, true);
  obj.traverse(o => {
    if (o.userData.helper || o.userData.unpickable || !o.visible) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      out.union(b);
    }
  });
  return out;
}

/** Project a world point to CSS pixel coords inside `el`. */
export function worldToScreen(p: THREE.Vector3, camera: THREE.Camera, el: HTMLElement, out = new THREE.Vector2()): THREE.Vector2 {
  _v.copy(p).project(camera);
  out.x = (_v.x + 1) / 2 * el.clientWidth;
  out.y = (1 - _v.y) / 2 * el.clientHeight;
  return out;
}
