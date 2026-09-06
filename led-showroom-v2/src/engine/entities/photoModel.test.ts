import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { faceCameraY, photoPlaneSize, wrapPi } from './photoModel';
import { VELOXITY_PRODUCTS } from '../catalog/equipment';

describe('photoPlaneSize', () => {
  it('takes the real height and derives width from the image aspect, never stretching', () => {
    // The 50" vertical screen is 27 W x 72 H; its cutout is 797 x 852.
    const s = photoPlaneSize([27, 72, 1], { width: 797, height: 852 });
    expect(s.h).toBe(72);
    expect(s.w).toBeCloseTo(72 * (797 / 852), 5);
    // aspect preserved exactly
    expect(s.w / s.h).toBeCloseTo(797 / 852, 10);
  });

  it('falls back to the declared width when the image has not been measured', () => {
    expect(photoPlaneSize([17.5, 65, 10], null)).toEqual({ w: 17.5, h: 65 });
    expect(photoPlaneSize([17.5, 65, 10], { width: 0, height: 0 })).toEqual({ w: 17.5, h: 65 });
  });

  it('never produces a degenerate plane', () => {
    const s = photoPlaneSize([0, 0, 0], { width: 100, height: 100 });
    expect(s.w).toBeGreaterThan(0);
    expect(s.h).toBeGreaterThan(0);
  });
});

describe('wrapPi', () => {
  it('normalises to (-pi, pi]', () => {
    expect(wrapPi(0)).toBeCloseTo(0, 10);
    expect(wrapPi(Math.PI * 2)).toBeCloseTo(0, 10);
    expect(wrapPi(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(wrapPi(-Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(wrapPi(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe('faceCameraY', () => {
  const cam = (x: number, z: number): THREE.Camera => {
    const c = new THREE.PerspectiveCamera();
    c.position.set(x, 60, z);
    c.updateMatrixWorld(true);
    return c;
  };

  it('turns the object so its +Z points at the camera', () => {
    const o = new THREE.Object3D();
    o.updateMatrixWorld(true);
    faceCameraY(o, cam(0, 100));
    expect(o.rotation.y).toBeCloseTo(0, 5);          // camera on +Z
    faceCameraY(o, cam(100, 0));
    expect(o.rotation.y).toBeCloseTo(Math.PI / 2, 5); // camera on +X
    faceCameraY(o, cam(0, -100));
    expect(Math.abs(wrapPi(o.rotation.y - Math.PI))).toBeLessThan(1e-5); // camera on -Z
  });

  it('cancels the entity yaw so the billboard is absolute, not compounded', () => {
    const o = new THREE.Object3D();
    o.updateMatrixWorld(true);
    faceCameraY(o, cam(100, 0), Math.PI / 2);
    expect(o.rotation.y).toBeCloseTo(0, 5);
  });

  it('reports no change when already facing the camera, so a still view stays idle', () => {
    const o = new THREE.Object3D();
    o.updateMatrixWorld(true);
    const c = cam(50, 50);
    expect(faceCameraY(o, c)).toBe(true);
    expect(faceCameraY(o, c)).toBe(false);
  });

  it('does nothing when the camera is directly overhead (degenerate horizontal direction)', () => {
    const o = new THREE.Object3D();
    o.updateMatrixWorld(true);
    expect(faceCameraY(o, cam(0, 0))).toBe(false);
    expect(o.rotation.y).toBe(0);
  });
});

describe('Veloxity product catalog', () => {
  // The whole fleet is photographed cutouts. The CAD meshes we ship are LED-wall accessories
  // (base plate, back supports), not catalog products — see cadModels.test.ts.
  const photographed = VELOXITY_PRODUCTS.filter(p => p.geometry === 'photo');

  it('every photographed product carries an image, real dims and a spec sheet', () => {
    expect(photographed.length).toBe(6);
    for (const p of photographed) {
      expect(p.photo).toBe(true);
      expect(p.image).toMatch(/^\/products\/.+\.webp$/);
      expect(p.dims.every(d => d > 0)).toBe(true);
      expect((p.specs ?? []).length).toBeGreaterThan(2);
    }
  });

  it('uses the dimensions published on each product page', () => {
    const by = (id: string) => VELOXITY_PRODUCTS.find(p => p.id === id)!;
    // width, height, depth in inches — from the "Dimensions: H x W x D" spec rows
    expect(by('portable-charger-kiosk').dims).toEqual([17.5, 65, 10]);
    expect(by('charging-lockers').dims).toEqual([17.5, 65, 12]);
    expect(by('charging-table').dims).toEqual([23, 45, 23]);
    expect(by('tabletop-chargers').dims).toEqual([11, 9, 4]);
    expect(by('touch-50-vertical').dims).toEqual([27, 72, 1]);
    expect(by('touch-43-horizontal').dims).toEqual([44, 43, 31]);
  });
});
