import { describe, expect, it } from 'vitest';
import {
  TUMBLE_DEG_PER_PX, TUMBLE_PITCH_MAX_DEG, TUMBLE_RAD_PER_PX, WHEEL_DELTA_CAP,
  scaleByFactor, tumbleRotation, wheelScaleFactor,
} from './tumble';
import { MAX_SCALE, MIN_SCALE } from './snapping';
import type { Vec3 } from '../math';

const rad = (deg: number): number => (deg * Math.PI) / 180;

describe('tumbleRotation', () => {
  it('yaws with horizontal travel at v1s 0.005 rad per pixel', () => {
    const r = tumbleRotation([0, 0, 0], 100, 0);
    expect(rad(r[1])).toBeCloseTo(100 * TUMBLE_RAD_PER_PX, 10);
    expect(r[0]).toBe(0);
    expect(r[2]).toBe(0);
  });

  it('pitches with vertical travel and leaves roll alone', () => {
    const r = tumbleRotation([0, 30, 12], 0, -40);
    expect(rad(r[0])).toBeCloseTo(-40 * TUMBLE_RAD_PER_PX, 10);
    expect(r[1]).toBe(30);
    expect(r[2]).toBe(12);
  });

  it('is absolute from the gesture base, not incremental', () => {
    const base: Vec3 = [5, 90, 0];
    expect(tumbleRotation(base, 200, 0)[1]).toBeCloseTo(90 + 200 * TUMBLE_DEG_PER_PX, 10);
    expect(tumbleRotation(base, 0, 0)).toEqual([5, 90, 0]);
  });

  it('clamps pitch short of the vertical flip in both directions', () => {
    expect(tumbleRotation([0, 0, 0], 0, 100000)[0]).toBeCloseTo(TUMBLE_PITCH_MAX_DEG, 10);
    expect(tumbleRotation([0, 0, 0], 0, -100000)[0]).toBeCloseTo(-TUMBLE_PITCH_MAX_DEG, 10);
    expect(TUMBLE_PITCH_MAX_DEG).toBeLessThan(90);
  });

  it('leaves yaw unbounded (v1 rotY has no clamp)', () => {
    expect(Math.abs(tumbleRotation([0, 0, 0], 100000, 0)[1])).toBeGreaterThan(360);
  });

  it('snaps the delta, keeping the base angles intact', () => {
    // 300 px ≈ 85.94° of yaw → 90° at a 15° step, added to a base of 7°
    const r = tumbleRotation([0, 7, 0], 300, 0, 15);
    expect(r[1]).toBeCloseTo(97, 6);
  });

  it('snapping can hold the rotation at the base for small travel', () => {
    expect(tumbleRotation([0, 7, 0], 10, 10, 15)).toEqual([0, 7, 0]);
  });
});

describe('wheelScaleFactor', () => {
  it('grows scrolling up and shrinks scrolling down', () => {
    expect(wheelScaleFactor(-100)).toBeGreaterThan(1);
    expect(wheelScaleFactor(100)).toBeLessThan(1);
    expect(wheelScaleFactor(0)).toBe(1);
  });

  it('matches v1 exp(-clamp(dy, +/-300) * 0.001)', () => {
    expect(wheelScaleFactor(120)).toBeCloseTo(Math.exp(-0.12), 12);
    expect(wheelScaleFactor(5000)).toBeCloseTo(Math.exp(-WHEEL_DELTA_CAP * 0.001), 12);
    expect(wheelScaleFactor(-5000)).toBeCloseTo(Math.exp(WHEEL_DELTA_CAP * 0.001), 12);
  });

  it('is inverse-symmetric and safe on rubbish input', () => {
    expect(wheelScaleFactor(120) * wheelScaleFactor(-120)).toBeCloseTo(1, 12);
    expect(wheelScaleFactor(Number.NaN)).toBe(1);
  });
});

describe('scaleByFactor', () => {
  it('multiplies every axis', () => {
    expect(scaleByFactor([1, 2, 4], 0.5)).toEqual([0.5, 1, 2]);
  });

  it('clamps to the engine scale limits', () => {
    expect(scaleByFactor([1, 1, 1], 1e6)).toEqual([MAX_SCALE, MAX_SCALE, MAX_SCALE]);
    expect(scaleByFactor([1, 1, 1], 1e-9)).toEqual([MIN_SCALE, MIN_SCALE, MIN_SCALE]);
  });

  it('ignores a degenerate factor', () => {
    expect(scaleByFactor([2, 2, 2], 0)).toEqual([2, 2, 2]);
    expect(scaleByFactor([2, 2, 2], Number.NaN)).toEqual([2, 2, 2]);
  });
});
