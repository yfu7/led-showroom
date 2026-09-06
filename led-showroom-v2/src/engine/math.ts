/** Small numeric helpers shared by the engine (no three.js dependency). */
export type Vec3 = [number, number, number];

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const snap = (v: number, step: number): number => (step > 0 ? Math.round(v / step) * step : v);
export const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
export const round = (v: number, decimals = 3): number => { const p = 10 ** decimals; return Math.round(v * p) / p; };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const v3add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const v3dist = (a: Vec3, b: Vec3): number => v3len(v3sub(a, b));
export const v3eq = (a: Vec3, b: Vec3, eps = 1e-9): boolean => approx(a[0], b[0], eps) && approx(a[1], b[1], eps) && approx(a[2], b[2], eps);

/** Normalise an angle in degrees to (-180, 180]. */
export function wrapDeg(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Deep clone plain JSON data. */
export function cloneJson<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Shallow structural equality for plain JSON values. */
export function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!jsonEq((a as any)[k], (b as any)[k])) return false;
  return true;
}
