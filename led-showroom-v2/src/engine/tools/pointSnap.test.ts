import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { nearestGridPoint, projectOntoAxis, projectToScreen, projectedDistance, resolveHitFace, snapPoint } from './pointSnap';

const VIEW = { width: 800, height: 600 };

/** A camera 100" in front of the origin looking at it. */
function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(40, VIEW.width / VIEW.height, 1, 5000);
  c.position.set(0, 20, 100);
  c.lookAt(0, 20, 0);
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}

/** A 20" cube standing on the floor (bottom centre at the origin). */
function cube(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial());
  m.position.set(0, 10, 0);
  m.updateMatrixWorld(true);
  return m;
}

/** Raycast from the camera through a world point to get the face on `mesh`. */
function hitOn(mesh: THREE.Mesh, cam: THREE.Camera, toward: THREE.Vector3) {
  const rc = new THREE.Raycaster();
  const dir = toward.clone().sub(cam.position).normalize();
  rc.set(cam.position.clone(), dir);
  const h = rc.intersectObject(mesh, false)[0];
  expect(h).toBeTruthy();
  return { hit: h, rc };
}

describe('projectedDistance / projectToScreen', () => {
  it('is zero for the same point and grows with world separation', () => {
    const cam = camera();
    const a = new THREE.Vector3(0, 20, 0);
    expect(projectedDistance(cam, VIEW, a, a)).toBeCloseTo(0, 6);
    const d1 = projectedDistance(cam, VIEW, a, new THREE.Vector3(1, 20, 0));
    const d2 = projectedDistance(cam, VIEW, a, new THREE.Vector3(2, 20, 0));
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBeCloseTo(d1 * 2, 3);
  });

  it('projects the look-at point to the viewport centre', () => {
    const cam = camera();
    const p = projectToScreen(cam, VIEW, new THREE.Vector3(0, 20, 0))!;
    expect(p.x).toBeCloseTo(400, 5);
    expect(p.y).toBeCloseTo(300, 5);
  });

  it('returns Infinity for points behind the camera', () => {
    const cam = camera();
    expect(projectedDistance(cam, VIEW, new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 20, 200))).toBe(Infinity);
  });
});

describe('snapPoint', () => {
  it('snaps to a nearby cube vertex', () => {
    const cam = camera();
    const mesh = cube();
    // Front-top-right corner is (10, 20, 10); hit the front face just inside it.
    const near = new THREE.Vector3(9.7, 19.7, 10);
    const { hit, rc } = hitOn(mesh, cam, near);
    const { face, instanceId } = resolveHitFace(mesh, rc);
    const r = snapPoint({ point: hit.point, object: mesh, face, instanceId, isFloor: false }, { camera: cam, viewport: VIEW, gridIn: 12 });
    expect(r.kind).toBe('vertex');
    expect(r.point.x).toBeCloseTo(10, 5);
    expect(r.point.y).toBeCloseTo(20, 5);
    expect(r.point.z).toBeCloseTo(10, 5);
  });

  it('snaps to an edge midpoint of the hit face', () => {
    const cam = camera();
    const mesh = cube();
    // Midpoint of the front face's top edge is (0, 20, 10).
    const near = new THREE.Vector3(0.3, 19.7, 10);
    const { hit, rc } = hitOn(mesh, cam, near);
    const { face } = resolveHitFace(mesh, rc);
    const r = snapPoint({ point: hit.point, object: mesh, face, isFloor: false }, { camera: cam, viewport: VIEW });
    expect(r.kind).toBe('midpoint');
    expect(r.point.x).toBeCloseTo(0, 5);
    expect(r.point.y).toBeCloseTo(20, 5);
    expect(r.point.z).toBeCloseTo(10, 5);
  });

  it('returns the raw surface point when nothing is near', () => {
    const cam = camera();
    const mesh = cube();
    const near = new THREE.Vector3(3, 12, 10); // middle-ish of the front face, away from edges
    const { hit, rc } = hitOn(mesh, cam, near);
    const { face } = resolveHitFace(mesh, rc);
    const r = snapPoint({ point: hit.point, object: mesh, face, isFloor: false }, { camera: cam, viewport: VIEW, gridIn: 12 });
    expect(r.kind).toBe('surface');
    expect(r.point.distanceTo(hit.point)).toBeLessThan(1e-6);
  });

  it('snaps a surface point near y = 0 onto the floor line', () => {
    const cam = camera();
    const mesh = cube();
    const near = new THREE.Vector3(3, 0.2, 10); // near the bottom of the front face, off the corner/midpoint
    const { hit, rc } = hitOn(mesh, cam, near);
    const { face } = resolveHitFace(mesh, rc);
    const r = snapPoint({ point: hit.point, object: mesh, face, isFloor: false }, { camera: cam, viewport: VIEW });
    expect(r.kind).toBe('floor');
    expect(r.point.y).toBe(0);
    expect(r.point.x).toBeCloseTo(hit.point.x, 5);
  });

  it('snaps floor hits to the grid when close, else to the floor', () => {
    const cam = camera();
    const g = snapPoint({ point: new THREE.Vector3(12.3, -0.05, 24.2), object: null, isFloor: true }, { camera: cam, viewport: VIEW, gridIn: 12 });
    expect(g.kind).toBe('grid');
    expect(g.point.toArray()).toEqual([12, 0, 24]);
    const f = snapPoint({ point: new THREE.Vector3(18, -0.05, 30), object: null, isFloor: true }, { camera: cam, viewport: VIEW, gridIn: 12 });
    expect(f.kind).toBe('floor');
    expect(f.point.toArray()).toEqual([18, 0, 30]);
    // no grid configured → floor
    const nf = snapPoint({ point: new THREE.Vector3(12.3, 0, 24.2), object: null, isFloor: true }, { camera: cam, viewport: VIEW });
    expect(nf.kind).toBe('floor');
  });

  it('ignores the floor mesh vertices for floor hits', () => {
    const cam = camera();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial());
    floor.rotation.x = -Math.PI / 2;
    floor.updateMatrixWorld(true);
    // Corner of the floor plane at (20, 0, 20) — right next to the hit, but must not be a 'vertex'.
    const r = snapPoint({ point: new THREE.Vector3(19.9, 0, 19.9), object: floor, face: { a: 0, b: 1, c: 2 }, isFloor: true }, { camera: cam, viewport: VIEW });
    expect(r.kind).not.toBe('vertex');
  });

  it('skips full vertex scans for huge meshes but keeps the hit triangle corners', () => {
    const cam = camera();
    const mesh = cube();
    const near = new THREE.Vector3(9.7, 19.7, 10);
    const { hit, rc } = hitOn(mesh, cam, near);
    const { face } = resolveHitFace(mesh, rc);
    const r = snapPoint({ point: hit.point, object: mesh, face, isFloor: false }, { camera: cam, viewport: VIEW, maxVertices: 4 });
    expect(r.kind).toBe('vertex');
  });

  it('honours instance matrices for InstancedMesh hits', () => {
    const cam = camera();
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial(), 2);
    im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 10, 0));
    im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(40, 10, 0));
    im.instanceMatrix.needsUpdate = true;
    im.updateMatrixWorld(true);
    // Hit near the front-top-left corner of instance 1: (30, 20, 10)
    const rc = new THREE.Raycaster();
    const near = new THREE.Vector3(30.3, 19.7, 10);
    rc.set(cam.position.clone(), near.clone().sub(cam.position).normalize());
    const h = rc.intersectObject(im, false)[0];
    expect(h?.instanceId).toBe(1);
    const r = snapPoint({ point: h.point, object: im, face: h.face ? { a: h.face.a, b: h.face.b, c: h.face.c } : null, instanceId: h.instanceId, isFloor: false }, { camera: cam, viewport: VIEW });
    expect(r.kind).toBe('vertex');
    expect(r.point.x).toBeCloseTo(30, 5);
    expect(r.point.y).toBeCloseTo(20, 5);
  });
});

describe('helpers', () => {
  it('nearestGridPoint rounds x/z and pins y', () => {
    expect(nearestGridPoint(new THREE.Vector3(6.1, 3, -6.1), 12).toArray()).toEqual([12, 0, -12]);
    expect(nearestGridPoint(new THREE.Vector3(5, 3, 5), 12, 2).toArray()).toEqual([0, 2, 0]);
  });

  it('projectOntoAxis keeps only the locked component of B', () => {
    const a = new THREE.Vector3(1, 2, 3), b = new THREE.Vector3(10, 20, 30);
    expect(projectOntoAxis(a, b, 'x').toArray()).toEqual([10, 2, 3]);
    expect(projectOntoAxis(a, b, 'y').toArray()).toEqual([1, 20, 3]);
    expect(projectOntoAxis(a, b, 'z').toArray()).toEqual([1, 2, 30]);
  });
});
