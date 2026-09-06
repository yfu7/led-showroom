import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createDocument, createRoom } from '../document/defaults';
import { assets } from '../persistence/AssetStore';
import type { RenderContext } from './EntityRenderer';
import {
  ROOM_SIDES, RoomRenderer, createRoomRenderer, roomCenter, roomLocalBounds, roomPlanePlacement, surfaceMediaKey, surfaceToSource,
  type RoomSide,
} from './RoomRenderer';

const D = { widthIn: 480, heightIn: 156, depthIn: 360 };

function ctx(): RenderContext {
  const doc = createDocument();
  return {
    doc, assets, camera: new THREE.PerspectiveCamera(), invalidate() {}, setLoading() {},
    unit: 'in', needs: { css3d: false, pixelGrid: false }, maxTextureSize: 4096,
  };
}

/** Rotate the PlaneGeometry normal (+Z) by the placement's Euler. */
function rotatedNormal(rot: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
}

describe('roomPlanePlacement', () => {
  it('places every plane on its face of the box (origin = floor centre of the back wall)', () => {
    expect(roomPlanePlacement('back', D)).toMatchObject({ width: 480, height: 156, position: [0, 78, 0] });
    expect(roomPlanePlacement('floor', D)).toMatchObject({ width: 480, height: 360, position: [0, 0, 180] });
    expect(roomPlanePlacement('ceiling', D)).toMatchObject({ width: 480, height: 360, position: [0, 156, 180] });
    expect(roomPlanePlacement('left', D)).toMatchObject({ width: 360, height: 156, position: [-240, 78, 180] });
    expect(roomPlanePlacement('right', D)).toMatchObject({ width: 360, height: 156, position: [240, 78, 180] });
  });

  it('rotates each plane so its normal points into the room (single-sided render from inside)', () => {
    const centre = new THREE.Vector3(...roomCenter(D));
    for (const side of ROOM_SIDES) {
      const p = roomPlanePlacement(side, D);
      const n = rotatedNormal(p.rotation);
      expect(n.x).toBeCloseTo(p.normal[0]); expect(n.y).toBeCloseTo(p.normal[1]); expect(n.z).toBeCloseTo(p.normal[2]);
      const toCentre = centre.clone().sub(new THREE.Vector3(...p.position)).normalize();
      expect(n.dot(toCentre)).toBeCloseTo(1);
    }
  });

  it('rotated plane corners land on the room box faces', () => {
    const bounds = roomLocalBounds(D);
    for (const side of ROOM_SIDES) {
      const p = roomPlanePlacement(side, D);
      const geom = new THREE.PlaneGeometry(p.width, p.height);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rotation)), new THREE.Vector3(1, 1, 1));
      geom.applyMatrix4(m);
      geom.computeBoundingBox();
      const b = geom.boundingBox!;
      for (const k of ['x', 'y', 'z'] as const) {
        const i = k === 'x' ? 0 : k === 'y' ? 1 : 2;
        expect(b.min[k]).toBeGreaterThanOrEqual(bounds.min[i] - 1e-6);
        expect(b.max[k]).toBeLessThanOrEqual(bounds.max[i] + 1e-6);
      }
      // The plane is flat on its face: one axis is degenerate at the face coordinate.
      const flat: Record<RoomSide, ['x' | 'y' | 'z', number]> = { back: ['z', 0], floor: ['y', 0], ceiling: ['y', 156], left: ['x', -240], right: ['x', 240] };
      const [axis, at] = flat[side];
      expect(b.min[axis]).toBeCloseTo(at); expect(b.max[axis]).toBeCloseTo(at);
      geom.dispose();
    }
  });

  it('wall images read left-to-right for a viewer inside the room', () => {
    // PlaneGeometry local +X is the image's right edge; transform it and compare with the
    // viewer's right-hand direction when facing the wall from inside (right = facing × up).
    for (const side of ['back', 'left', 'right'] as RoomSide[]) {
      const p = roomPlanePlacement(side, D);
      const e = new THREE.Euler(...p.rotation);
      const imageRight = new THREE.Vector3(1, 0, 0).applyEuler(e);
      const facing = new THREE.Vector3(...p.normal).negate();
      const viewerRight = facing.clone().cross(new THREE.Vector3(0, 1, 0));
      expect(imageRight.dot(viewerRight)).toBeCloseTo(1);
    }
    // Floor: image top towards the back wall (-Z); ceiling: image top towards the front (+Z), as in v1.
    expect(new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...roomPlanePlacement('floor', D).rotation)).z).toBeCloseTo(-1);
    expect(new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...roomPlanePlacement('ceiling', D).rotation)).z).toBeCloseTo(1);
  });

  it('room bounds and centre', () => {
    expect(roomLocalBounds(D)).toEqual({ min: [-240, 0, 0], max: [240, 156, 360] });
    expect(roomCenter(D)).toEqual([0, 78, 180]);
  });
});

describe('surface media helpers', () => {
  it('keys media by kind + id/url and treats empty media as none', () => {
    expect(surfaceMediaKey(null)).toBe('');
    expect(surfaceMediaKey(undefined)).toBe('');
    expect(surfaceMediaKey({ kind: 'image' })).toBe('');
    const k1 = surfaceMediaKey({ kind: 'image', assetId: 'a1' });
    const k2 = surfaceMediaKey({ kind: 'video', assetId: 'a1' });
    const k3 = surfaceMediaKey({ kind: 'image', url: 'https://x/y.jpg' });
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it('maps surface media to a looping muted content source', () => {
    expect(surfaceToSource({ kind: 'video', assetId: 'v1', name: 'clip.mp4' })).toEqual({ type: 'video', url: undefined, assetId: 'v1', name: 'clip.mp4', loop: true, muted: true });
  });
});

describe('RoomRenderer', () => {
  it('creates five planes, honours show flags and reports bounds of the visible ones', () => {
    const e = createRoom(40, 13, 30);
    const r = createRoomRenderer(e, ctx()) as RoomRenderer;
    expect(r.root.userData.entityType).toBe('room');
    const meshes = r.root.children.filter(c => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    expect(meshes).toHaveLength(5);
    expect(meshes.map(m => m.userData.part).sort()).toEqual([...ROOM_SIDES].sort());
    for (const m of meshes) {
      expect(m.receiveShadow).toBe(true);
      expect((m.material as THREE.MeshStandardMaterial).side).toBe(THREE.FrontSide);
    }
    // default: ceiling hidden
    expect(r.selectionMeshes().map(m => m.userData.part).sort()).toEqual(['back', 'floor', 'left', 'right']);
    const b = r.bounds();
    expect(b.min.x).toBeCloseTo(-240); expect(b.max.x).toBeCloseTo(240);
    expect(b.min.y).toBeCloseTo(0); expect(b.max.y).toBeCloseTo(156);
    expect(b.min.z).toBeCloseTo(0); expect(b.max.z).toBeCloseTo(360);

    // Only the floor visible → bounds flatten to y = 0
    const e2 = { ...e, show: { back: false, floor: true, ceiling: false, left: false, right: false } };
    r.update(e2, ctx());
    expect(r.selectionMeshes()).toHaveLength(1);
    const b2 = r.bounds();
    expect(b2.min.y).toBeCloseTo(0); expect(b2.max.y).toBeCloseTo(0);
    r.dispose();
  });

  it('applies colour and opacity to untextured planes', () => {
    const e = createRoom();
    e.color = '#336699'; e.opacity = 0.5;
    const r = new RoomRenderer(e, ctx());
    const back = r.root.children.find(c => c.userData.part === 'back') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
    expect(back.material.color.getHexString()).toBe('336699');
    expect(back.material.opacity).toBe(0.5);
    expect(back.material.transparent).toBe(true);
    expect(back.material.depthWrite).toBe(false);
    r.update({ ...e, opacity: 1 }, ctx());
    expect(back.material.transparent).toBe(false);
    expect(back.material.depthWrite).toBe(true);
    r.dispose();
  });

  it('bumps the material version when transparency toggles so the program is recompiled', () => {
    const e = createRoom();
    const r = new RoomRenderer(e, ctx());
    const back = r.root.children.find(c => c.userData.part === 'back') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
    const v0 = back.material.version;
    r.update({ ...e, opacity: 0.5 }, ctx());
    expect(back.material.transparent).toBe(true);
    expect(back.material.version).toBe(v0 + 1);
    // Same transparency state again: no needless recompile.
    r.update({ ...e, opacity: 0.25 }, ctx());
    expect(back.material.version).toBe(v0 + 1);
    expect(back.material.opacity).toBe(0.25);
    r.update({ ...e, opacity: 1 }, ctx());
    expect(back.material.transparent).toBe(false);
    expect(back.material.version).toBe(v0 + 2);
    r.dispose();
  });

  it('pauses a surface video while its side is hidden and resumes it when shown', () => {
    const e = createRoom();
    const r = new RoomRenderer(e, ctx());
    const calls: string[] = [];
    const player = { play: () => calls.push('play'), pause: () => calls.push('pause'), dispose() {} };
    const media = { kind: 'texture', width: 1, height: 1, texture: null, element: null, ready: Promise.resolve(), update: () => false, player, dispose() {} };
    // Inject a live player on the ceiling plane (hidden by default).
    const planes = (r as unknown as { planes: Map<string, { media: unknown }> }).planes;
    planes.get('ceiling')!.media = media;
    r.update(e, ctx());
    expect(calls).toEqual(['pause']);
    r.update({ ...e, show: { ...e.show, ceiling: true } }, ctx());
    expect(calls).toEqual(['pause', 'play']);
    planes.get('ceiling')!.media = null;
    r.dispose();
  });
});
