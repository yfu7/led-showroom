/**
 * Where a turntable camera stands so the build fills the frame for the WHOLE turn.
 *
 * OrbitControls' auto-rotate spins the camera about the vertical through its target at a fixed
 * pitch and distance, so the fit has to hold at every azimuth, not just the one the take starts
 * at. Each azimuth is checked against every corner of the bounds: a corner at `x` across and `y`
 * up in camera space, `a` towards the camera, is inside the frame when `|x| <= (d - a) tanH fill`
 * and `|y| <= (d - a) tanV fill`, which gives the least distance `d` in closed form. The largest
 * over all azimuths is the distance the turn needs: at that one the build just fills `fill` of the
 * frame, and at the others a little less.
 */
import * as THREE from 'three';

/** How much of the frame the build fills at its widest point of the turn. */
export const TURNTABLE_FILL = 0.9;
/** The turn's pitch, degrees above level: the camera's own, held within these. */
export const TURNTABLE_PITCH_MIN = 8;
export const TURNTABLE_PITCH_MAX = 30;
/** Azimuths checked around the turn. */
const STEPS = 72;

export interface TurntableFit {
  target: THREE.Vector3;
  position: THREE.Vector3;
  distance: number;
  /** Degrees above level. */
  pitch: number;
}

/**
 * Fit a turntable around `bounds`. `fromDir` is the current camera-from-target direction, whose
 * azimuth the turn starts at and whose pitch it keeps, within the limits. `fovDeg` is the vertical
 * field of view and `aspect` the frame's width over height.
 */
export function turntableFit(
  bounds: THREE.Box3, fromDir: THREE.Vector3, fovDeg: number, aspect: number, fill = TURNTABLE_FILL,
): TurntableFit {
  const target = bounds.getCenter(new THREE.Vector3());
  const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const level = Math.hypot(fromDir.x, fromDir.z);
  const az0 = level > 1e-6 ? Math.atan2(fromDir.x, fromDir.z) : 0;
  const rawPitch = THREE.MathUtils.radToDeg(Math.atan2(fromDir.y, level > 1e-6 ? level : 0));
  const pitch = THREE.MathUtils.clamp(Number.isFinite(rawPitch) ? rawPitch : TURNTABLE_PITCH_MIN, TURNTABLE_PITCH_MIN, TURNTABLE_PITCH_MAX);
  const ph = THREE.MathUtils.degToRad(pitch);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * fill;
  const tanH = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * Math.max(1e-3, aspect) * fill;

  const dir = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), p = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  let distance = 1;
  for (let s = 0; s < STEPS; s++) {
    const az = az0 + (2 * Math.PI * s) / STEPS;
    dir.set(Math.cos(ph) * Math.sin(az), Math.sin(ph), Math.cos(ph) * Math.cos(az));
    right.crossVectors(Y, dir).normalize();          // camera right: up x back
    up.crossVectors(dir, right).normalize();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? half.x : -half.x, i & 2 ? half.y : -half.y, i & 4 ? half.z : -half.z);
      const a = p.dot(dir);
      distance = Math.max(distance, a + Math.abs(p.dot(right)) / tanH, a + Math.abs(p.dot(up)) / tanV, a + 1);
    }
  }
  dir.set(Math.cos(ph) * Math.sin(az0), Math.sin(ph), Math.cos(ph) * Math.cos(az0));
  return { target, position: target.clone().addScaledVector(dir, distance), distance, pitch };
}
