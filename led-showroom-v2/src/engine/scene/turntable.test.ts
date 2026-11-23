import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TURNTABLE_FILL, TURNTABLE_PITCH_MAX, TURNTABLE_PITCH_MIN, turntableFit } from './turntable';

/** The largest share of the frame any corner reaches, over the whole turn (1 = the frame edge). */
function worstFill(box: THREE.Box3, fov: number, aspect: number, from: THREE.Vector3): { worst: number; best: number } {
  const fit = turntableFit(box, from, fov, aspect);
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1e6);
  const off = fit.position.clone().sub(fit.target);
  let worst = 0, best = Infinity;
  for (let s = 0; s < 360; s += 3) {
    cam.position.copy(fit.target).add(off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(s)));
    cam.lookAt(fit.target);
    cam.updateMatrixWorld(true);
    let m = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
      m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
    }
    worst = Math.max(worst, m); best = Math.min(best, m);
  }
  return { worst, best };
}

describe('turntableFit', () => {
  const wall = new THREE.Box3(new THREE.Vector3(-180, 0, -10), new THREE.Vector3(180, 120, 10));
  const from = new THREE.Vector3(0.2, 0.3, 1).normalize();

  it('keeps the build inside the frame at every angle of the turn, filling most of it', () => {
    const { worst } = worstFill(wall, 40, 16 / 9, from);
    expect(worst).toBeLessThanOrEqual(TURNTABLE_FILL + 0.01);
    expect(worst).toBeGreaterThan(TURNTABLE_FILL - 0.03);
  });

  it('fills most of the frame even where the build is narrowest to the camera', () => {
    // A wide flat wall seen end-on is at its smallest; it still takes a good share of the frame.
    const { best } = worstFill(wall, 40, 16 / 9, from);
    expect(best).toBeGreaterThan(0.3);
  });

  it('fits a tall build in a tall frame and a deep one in a wide frame', () => {
    const tower = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 400, 20));
    expect(worstFill(tower, 40, 9 / 16, from).worst).toBeLessThanOrEqual(TURNTABLE_FILL + 0.01);
    const floor = new THREE.Box3(new THREE.Vector3(-400, 0, -300), new THREE.Vector3(400, 30, 300));
    expect(worstFill(floor, 40, 2.4, from).worst).toBeLessThanOrEqual(TURNTABLE_FILL + 0.01);
  });

  it('keeps the camera\'s pitch within a pleasant band, and its azimuth', () => {
    expect(turntableFit(wall, new THREE.Vector3(0, 1, 0), 40, 1.5).pitch).toBe(TURNTABLE_PITCH_MAX);
    expect(turntableFit(wall, new THREE.Vector3(1, -0.5, 0), 40, 1.5).pitch).toBe(TURNTABLE_PITCH_MIN);
    const fit = turntableFit(wall, new THREE.Vector3(1, 0.3, 0), 40, 1.5);
    expect(fit.pitch).toBeCloseTo(THREE.MathUtils.radToDeg(Math.atan(0.3)), 6);
    expect(fit.position.x).toBeGreaterThan(fit.target.x);
    expect(Math.abs(fit.position.z - fit.target.z)).toBeLessThan(1e-6);
  });

  it('aims at the middle of the build', () => {
    const fit = turntableFit(wall, from, 40, 1.5);
    expect(fit.target.toArray()).toEqual([0, 60, 0]);
    expect(fit.position.distanceTo(fit.target)).toBeCloseTo(fit.distance, 6);
  });
});
