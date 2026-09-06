/**
 * Object tumble (middle-drag) and object wheel-scale maths — pure ports of v1 Move mode
 * (index.html 7838-7902, inventory F70). No engine, no DOM, so both are unit-testable.
 *
 * v1 tumbled every checked wall in place: `Δyaw = ΔX · 0.005 rad`, `Δpitch = ΔY · 0.005 rad`,
 * `rotY = startY + Δyaw` (unbounded), `rotX = clamp(startX + Δpitch, ±(π/2 − 0.05))`. v2 stores
 * document angles in degrees, so the per-pixel rate and the pitch clamp are converted once here.
 *
 * v1 wheel-scale: `factor = exp(−clamp(ΔY, ±300) · 0.001)`, `scale = clamp(scale · factor, 0.1, 10)`.
 * v2 keeps the response curve and clamps to the engine-wide scale limits instead.
 */
import { clamp, snap, type Vec3 } from '../math';
import { MAX_SCALE, MIN_SCALE } from './snapping';

const RAD_TO_DEG = 180 / Math.PI;

/** v1 tumble rate: 0.005 rad per pixel of pointer travel. */
export const TUMBLE_RAD_PER_PX = 0.005;
/** The same rate in document units (degrees per pixel). */
export const TUMBLE_DEG_PER_PX = TUMBLE_RAD_PER_PX * RAD_TO_DEG;
/** Pitch clamp, kept short of the vertical flip (v1 `π/2 − 0.05`). */
export const TUMBLE_PITCH_MAX_DEG = (Math.PI / 2 - 0.05) * RAD_TO_DEG;
/** Wheel deltas are clamped before the exponential so one flick cannot jump the whole range. */
export const WHEEL_DELTA_CAP = 300;
/** Exponent per unit of wheel delta. */
export const WHEEL_SCALE_RATE = 0.001;

/**
 * Rotation (degrees, document order `[pitch, yaw, roll]`) after tumbling from `base` by a pointer
 * travel of `dxPx` / `dyPx`. Horizontal travel yaws, vertical travel pitches, roll is untouched.
 * With `snapDeg > 0` the *delta* is snapped, so the object keeps whatever base angles it had.
 */
export function tumbleRotation(base: Vec3, dxPx: number, dyPx: number, snapDeg = 0): Vec3 {
  const step = snapDeg > 0 ? snapDeg : 0;
  const dYaw = step ? snap(dxPx * TUMBLE_DEG_PER_PX, step) : dxPx * TUMBLE_DEG_PER_PX;
  const dPitch = step ? snap(dyPx * TUMBLE_DEG_PER_PX, step) : dyPx * TUMBLE_DEG_PER_PX;
  const pitch = clamp(base[0] + dPitch, -TUMBLE_PITCH_MAX_DEG, TUMBLE_PITCH_MAX_DEG);
  return [pitch, base[1] + dYaw, base[2]];
}

/** Scale factor for one wheel event (> 1 scrolling up / away from the user). */
export function wheelScaleFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-clamp(deltaY, -WHEEL_DELTA_CAP, WHEEL_DELTA_CAP) * WHEEL_SCALE_RATE);
}

/** `scale × factor`, clamped per axis to the engine's scale limits. */
export function scaleByFactor(scale: Vec3, factor: number): Vec3 {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const s = (v: number): number => clamp(Number.isFinite(v) ? v * f : 1, MIN_SCALE, MAX_SCALE);
  return [s(scale[0]), s(scale[1]), s(scale[2])];
}
