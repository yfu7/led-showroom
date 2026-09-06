import { describe, it, expect } from 'vitest';
import type { Vec3 } from '../math';
import type { Seg2 } from '../document/types';
import {
  coverFit, photoNormToView, viewToPhotoNorm, segPhotoNormToView,
  lineIntersection, solveTwoVanishingPoints, fovFromFocalPx, focalPxFromFov,
  calibrationGridSpec, calibrationGridSegments, PERSPECTIVE_DRAG_PLANE,
  cameraFromMeasurements, readExifFocal35, fovFromFocal35,
  IMPOSSIBLE_CAMERA_REASON, FOV_MIN_DEG, FOV_MAX_DEG,
} from './perspective';

/* ───────────── helpers: a synthetic pinhole camera ───────────── */

type M3 = number[][];
const DEG = Math.PI / 180;
const mul = (a: M3, b: M3): M3 => a.map((row, i) => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const Ry = (t: number): M3 => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]];
const Rx = (t: number): M3 => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
const col = (m: M3, j: number): Vec3 => [m[0][j], m[1][j], m[2][j]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

function makeCamera(yawDeg: number, pitchDeg: number, f: number, W: number, H: number, dist = 500) {
  const R = mul(Ry(yawDeg * DEG), Rx(pitchDeg * DEG));           // camera→world
  const right = col(R, 0), up = col(R, 1);
  const forward: Vec3 = [-R[0][2], -R[1][2], -R[2][2]];
  const C: Vec3 = [-forward[0] * dist, -forward[1] * dist, -forward[2] * dist];
  const project = (p: Vec3): [number, number] => {
    const d: Vec3 = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    // camera coords = Rᵀ d
    const cx = R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2];
    const cy = R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2];
    const cz = R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2];
    if (!(cz < 0)) throw new Error('point behind camera');
    return [W / 2 + f * cx / -cz, H / 2 - f * cy / -cz];
  };
  const seg = (a: Vec3, b: Vec3): Seg2 => {
    const [x1, y1] = project(a), [x2, y2] = project(b);
    return { x1, y1, x2, y2 };
  };
  return { R, right, up, forward, C, project, seg };
}

function rotateByQuat(q: [number, number, number, number], v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 * cross(q.xyz, v); v' = v + qw*t + cross(q.xyz, t)
  const tx = 2 * (qy * v[2] - qz * v[1]), ty = 2 * (qz * v[0] - qx * v[2]), tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

const expectVec = (a: Vec3, b: Vec3, eps = 1e-6) => {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(eps));
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(eps));
  expect(a[2]).toBeCloseTo(b[2], -Math.log10(eps));
};

/* ───────────── cover fit ───────────── */

describe('coverFit', () => {
  it('fills height and crops width for a photo wider than the view', () => {
    const fit = coverFit(4000, 2000, 1000, 1000);       // photo 2:1 into square
    expect(fit.h).toBe(1000);
    expect(fit.w).toBe(2000);
    expect(fit.y).toBe(0);
    expect(fit.x).toBe(-500);
    expect(fit.scale).toBeCloseTo(0.5);
  });
  it('fills width and crops height for a portrait photo in a landscape view', () => {
    const fit = coverFit(1000, 2000, 1600, 900);
    expect(fit.w).toBe(1600);
    expect(fit.h).toBe(3200);
    expect(fit.x).toBe(0);
    expect(fit.y).toBe((900 - 3200) / 2);
    expect(fit.scale).toBeCloseTo(1.6);
  });
  it('round-trips normalised photo points through view pixels', () => {
    const fit = coverFit(3000, 2000, 1280, 720);
    const p = { x: 0.25, y: 0.8 };
    const v = photoNormToView(p, fit);
    const back = viewToPhotoNorm(v, fit);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
    // centre of the photo lands on the centre of the view
    const c = photoNormToView({ x: 0.5, y: 0.5 }, fit);
    expect(c.x).toBeCloseTo(640);
    expect(c.y).toBeCloseTo(360);
    const s = segPhotoNormToView({ x1: 0, y1: 0, x2: 1, y2: 1 }, fit);
    expect(s.x1).toBeCloseTo(fit.x); expect(s.y2).toBeCloseTo(fit.y + fit.h);
  });
});

/* ───────────── intersection ───────────── */

describe('lineIntersection', () => {
  it('intersects two crossing lines (extended beyond the segments)', () => {
    const r = lineIntersection({ x1: 0, y1: 0, x2: 1, y2: 1 }, { x1: 0, y1: 10, x2: 1, y2: 9 });
    expect(r).not.toBeNull();
    expect(r![0]).toBeCloseTo(5);
    expect(r![1]).toBeCloseTo(5);
  });
  it('returns null for parallel lines', () => {
    expect(lineIntersection({ x1: 0, y1: 0, x2: 10, y2: 0 }, { x1: 0, y1: 5, x2: 10, y2: 5 })).toBeNull();
  });
});

/* ───────────── two-VP solve ───────────── */

describe('solveTwoVanishingPoints', () => {
  const W = 1600, H = 900, f = 900;

  it('recovers focal, fov and orientation from a synthetic pinhole camera', () => {
    const cam = makeCamera(25, -12, f, W, H);
    const widthLines: [Seg2, Seg2] = [
      cam.seg([-100, 0, 0], [100, 0, 0]),
      cam.seg([-100, 60, 20], [100, 60, 20]),
    ];
    const depthLines: [Seg2, Seg2] = [
      cam.seg([-80, 0, -100], [-80, 0, 100]),
      cam.seg([80, 0, -100], [80, 0, 100]),
    ];
    const s = solveTwoVanishingPoints(widthLines, depthLines, W, H);
    expect(s.ok).toBe(true);
    expect(Math.abs(s.focalPx - f) / f).toBeLessThan(0.01);
    expect(s.fovDeg).toBeCloseTo(2 * Math.atan((H / 2) / f) * 180 / Math.PI, 2);

    // orthonormal
    expect(len(s.right)).toBeCloseTo(1, 9);
    expect(len(s.up)).toBeCloseTo(1, 9);
    expect(len(s.forward)).toBeCloseTo(1, 9);
    expect(dot(s.right, s.up)).toBeCloseTo(0, 9);
    expect(dot(s.right, s.forward)).toBeCloseTo(0, 9);
    expect(dot(s.up, s.forward)).toBeCloseTo(0, 9);

    // consistent with the known camera
    expectVec(s.right, cam.right, 1e-5);
    expectVec(s.up, cam.up, 1e-5);
    expectVec(s.forward, cam.forward, 1e-5);

    // quaternion rotates camera-local axes onto the same world vectors
    expectVec(rotateByQuat(s.quaternion, [1, 0, 0]), cam.right, 1e-5);
    expectVec(rotateByQuat(s.quaternion, [0, 1, 0]), cam.up, 1e-5);
    expectVec(rotateByQuat(s.quaternion, [0, 0, -1]), cam.forward, 1e-5);
    expect(Math.hypot(...s.quaternion)).toBeCloseTo(1, 9);
  });

  it('rejects vanishing points that cannot come from one camera', () => {
    // both VPs to the right of centre on the horizon → positive dot product
    const widthLines: [Seg2, Seg2] = [
      { x1: 0, y1: 400, x2: 1100, y2: 450 }, { x1: 0, y1: 500, x2: 1100, y2: 450 },
    ];
    const depthLines: [Seg2, Seg2] = [
      { x1: 0, y1: 300, x2: 1300, y2: 450 }, { x1: 0, y1: 600, x2: 1300, y2: 450 },
    ];
    const s = solveTwoVanishingPoints(widthLines, depthLines, W, H);
    expect(s.ok).toBe(false);
    expect(s.reason).toBe(IMPOSSIBLE_CAMERA_REASON);
  });

  it('falls back to the supplied FOV when one pair is parallel on screen', () => {
    const cam = makeCamera(0, -12, f, W, H);           // yaw 0 → X lines parallel in the image
    const widthLines: [Seg2, Seg2] = [
      cam.seg([-100, 0, 0], [100, 0, 0]),
      cam.seg([-100, 60, 0], [100, 60, 0]),
    ];
    const depthLines: [Seg2, Seg2] = [
      cam.seg([-80, 0, -100], [-80, 0, 100]),
      cam.seg([80, 0, -100], [80, 0, 100]),
    ];
    expect(lineIntersection(widthLines[0], widthLines[1])).toBeNull();
    const fovDeg = fovFromFocalPx(f, H);
    const s = solveTwoVanishingPoints(widthLines, depthLines, W, H, fovDeg);
    expect(s.ok).toBe(true);
    expect(s.focalPx).toBeCloseTo(f, 6);
    expect(focalPxFromFov(fovDeg, H)).toBeCloseTo(f, 6);
    expectVec(s.forward, cam.forward, 1e-5);
    expectVec(s.up, cam.up, 1e-5);
  });

  it('clamps the FOV to 8..110', () => {
    expect(fovFromFocalPx(10, 900)).toBe(110);
    expect(fovFromFocalPx(100000, 900)).toBe(8);
  });

  // Parallel width pair (VP at infinity) → focal comes from the fallback FOV.
  const parallelCam = makeCamera(0, -12, f, W, H);
  const parallelWidth: [Seg2, Seg2] = [
    parallelCam.seg([-100, 0, 0], [100, 0, 0]),
    parallelCam.seg([-100, 60, 0], [100, 60, 0]),
  ];
  const parallelDepth: [Seg2, Seg2] = [
    parallelCam.seg([-80, 0, -100], [-80, 0, 100]),
    parallelCam.seg([80, 0, -100], [80, 0, 100]),
  ];

  it('clamps an out-of-range fallback FOV to 8..110 instead of accepting a ~0 px focal', () => {
    // 180° would give tan(90°) ≈ 1.6e16 → f ≈ 3e-14 px; v1's slider never allowed it.
    const wide = solveTwoVanishingPoints(parallelWidth, parallelDepth, W, H, 180);
    expect(wide.ok).toBe(true);
    expect(wide.fovDeg).toBe(FOV_MAX_DEG);
    expect(wide.focalPx).toBeCloseTo(focalPxFromFov(FOV_MAX_DEG, H), 6);
    expect(wide.focalPx).toBeGreaterThan(100);
    // still a proper basis, not collapsed onto ±Z
    expect(len(wide.right)).toBeCloseTo(1, 9);
    expect(dot(wide.right, wide.forward)).toBeCloseTo(0, 9);
    expect(Math.abs(wide.right[0])).toBeGreaterThan(0.9);

    const narrow = solveTwoVanishingPoints(parallelWidth, parallelDepth, W, H, 2);
    expect(narrow.ok).toBe(true);
    expect(narrow.fovDeg).toBe(FOV_MIN_DEG);
    expect(narrow.focalPx).toBeCloseTo(focalPxFromFov(FOV_MIN_DEG, H), 6);

    // In-range values pass through untouched.
    const mid = solveTwoVanishingPoints(parallelWidth, parallelDepth, W, H, 55);
    expect(mid.ok).toBe(true);
    expect(mid.fovDeg).toBeCloseTo(55, 9);

    // Non-finite fallback cannot produce a focal length.
    const bad = solveTwoVanishingPoints(parallelWidth, parallelDepth, W, H, NaN);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/focal length/);
  });

  it('keeps a failed solve inside the documented FOV range', () => {
    const impossibleWidth: [Seg2, Seg2] = [
      { x1: 0, y1: 400, x2: 1100, y2: 450 }, { x1: 0, y1: 500, x2: 1100, y2: 450 },
    ];
    const impossibleDepth: [Seg2, Seg2] = [
      { x1: 0, y1: 300, x2: 1300, y2: 450 }, { x1: 0, y1: 600, x2: 1300, y2: 450 },
    ];
    for (const fallback of [40, 180, 2, NaN]) {
      const s = solveTwoVanishingPoints(impossibleWidth, impossibleDepth, W, H, fallback);
      expect(s.ok).toBe(false);
      expect(s.reason).toBe(IMPOSSIBLE_CAMERA_REASON);
      expect(s.fovDeg).toBeGreaterThanOrEqual(FOV_MIN_DEG);
      expect(s.fovDeg).toBeLessThanOrEqual(FOV_MAX_DEG);
      expect(Number.isFinite(s.fovDeg)).toBe(true);
      expect(Number.isFinite(s.focalPx)).toBe(true);
      expect(s.focalPx).toBeGreaterThan(0);
      expect(s.focalPx).toBeCloseTo(focalPxFromFov(s.fovDeg, H), 6);
      // identity orientation is still a sane camera
      expect(s.quaternion).toEqual([0, 0, 0, 1]);
    }
    // the fallback the caller passed is what a failed solve echoes back (clamped)
    expect(solveTwoVanishingPoints(impossibleWidth, impossibleDepth, W, H, 40).fovDeg).toBe(40);
    expect(solveTwoVanishingPoints(impossibleWidth, impossibleDepth, W, H, 180).fovDeg).toBe(FOV_MAX_DEG);
    expect(solveTwoVanishingPoints(impossibleWidth, impossibleDepth, W, H, 2).fovDeg).toBe(FOV_MIN_DEG);
    expect(solveTwoVanishingPoints(impossibleWidth, impossibleDepth, W, H, NaN).fovDeg).toBe(40);
  });
});

/* ───────────── grid / drag plane ───────────── */

describe('calibration grid', () => {
  it('matches v1 constants', () => {
    expect(calibrationGridSpec()).toEqual({ halfExtentIn: 1440, pitchIn: 48, color: '#3b82f6', opacity: 0.3 });
    const pts = calibrationGridSegments();
    // 61 lines each way, 2 points × 3 comps each
    expect(pts.length).toBe(61 * 2 * 2 * 3);
    expect(pts[1]).toBe(0);
    expect(calibrationGridSegments(-50)[1]).toBe(-50);
    expect(PERSPECTIVE_DRAG_PLANE).toEqual({ normal: [0, 1, 0], constant: 0 });
  });
});

/* ───────────── camera measurements ───────────── */

describe('cameraFromMeasurements', () => {
  const cam = makeCamera(25, -12, 900, 1600, 900);
  const solve = solveTwoVanishingPoints(
    [cam.seg([-100, 0, 0], [100, 0, 0]), cam.seg([-100, 60, 20], [100, 60, 20])],
    [cam.seg([-80, 0, -100], [-80, 0, 100]), cam.seg([80, 0, -100], [80, 0, 100])],
    1600, 900,
  );
  it('reproduces v1 rescaling of an existing position', () => {
    const { position } = cameraFromMeasurements(solve, 60, 200, [30, 10, 40]);
    expect(position[1]).toBe(60);
    expect(Math.hypot(position[0], position[2])).toBeCloseTo(200);
    expect(position[0] / position[2]).toBeCloseTo(30 / 40);
    // within 1 in of the origin horizontally → z = dist
    expect(cameraFromMeasurements(solve, 60, 200, [0.2, 10, 0.2]).position).toEqual([0.2, 60, 200]);
    // invalid measurements leave components untouched
    expect(cameraFromMeasurements(solve, NaN, -1, [30, 10, 40]).position).toEqual([30, 10, 40]);
  });
  it('places the camera on the solved sightline when no position is supplied', () => {
    const { position, target } = cameraFromMeasurements(solve, 70, 300);
    expect(position[1]).toBe(70);
    expect(Math.hypot(position[0], position[2])).toBeCloseTo(300);
    // horizontal direction opposite to forward
    const fxz = Math.hypot(cam.forward[0], cam.forward[2]);
    expect(position[0]).toBeCloseTo(-cam.forward[0] / fxz * 300, 4);
    expect(position[2]).toBeCloseTo(-cam.forward[2] / fxz * 300, 4);
    // target lies ahead of the camera along forward
    const d: Vec3 = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
    expect(dot(d, cam.forward) / len(d)).toBeCloseTo(1, 4);
  });
});

/* ───────────── EXIF ───────────── */

function buildJpegWithExif(f35: number, little: boolean, opts: { type?: number; omitExif?: boolean } = {}): ArrayBuffer {
  const type = opts.type ?? 3;
  // TIFF block: header(8) + IFD0(2 + 12 + 4) + ExifIFD(2 + 12 + 4)
  const tiff = new Uint8Array(8 + 18 + 18);
  const dv = new DataView(tiff.buffer);
  tiff[0] = tiff[1] = little ? 0x49 : 0x4D;
  dv.setUint16(2, 0x2A, little);
  dv.setUint32(4, 8, little);                  // IFD0 offset
  let o = 8;
  dv.setUint16(o, 1, little); o += 2;          // 1 entry
  dv.setUint16(o, 0x8769, little); dv.setUint16(o + 2, 4, little); dv.setUint32(o + 4, 1, little);
  dv.setUint32(o + 8, 26, little); o += 12;    // ExifIFD at tiff+26
  dv.setUint32(o, 0, little); o += 4;          // next IFD
  dv.setUint16(o, 1, little); o += 2;
  dv.setUint16(o, 0xA405, little); dv.setUint16(o + 2, type, little); dv.setUint32(o + 4, 1, little);
  if (type === 4) dv.setUint32(o + 8, f35, little); else dv.setUint16(o + 8, f35, little);
  o += 12;
  dv.setUint32(o, 0, little);

  const app1Payload = new Uint8Array(6 + tiff.length);
  app1Payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);   // 'Exif\0\0'
  app1Payload.set(tiff, 6);
  const app0 = [0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00];      // a leading APP0 to skip over
  const parts: number[] = [0xFF, 0xD8, ...app0];
  if (!opts.omitExif) {
    const size = app1Payload.length + 2;
    parts.push(0xFF, 0xE1, size >> 8, size & 0xFF, ...app1Payload);
  }
  parts.push(0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9);
  return new Uint8Array(parts).buffer;
}

describe('readExifFocal35 / fovFromFocal35', () => {
  it('reads tag 0xA405 from big- and little-endian EXIF', () => {
    expect(readExifFocal35(buildJpegWithExif(50, false))).toBe(50);
    expect(readExifFocal35(buildJpegWithExif(28, true))).toBe(28);
    expect(readExifFocal35(buildJpegWithExif(35, true, { type: 4 }))).toBe(35);
  });
  it('returns null for non-JPEG, missing EXIF or zero focal', () => {
    expect(readExifFocal35(new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer)).toBeNull();
    expect(readExifFocal35(buildJpegWithExif(50, false, { omitExif: true }))).toBeNull();
    expect(readExifFocal35(buildJpegWithExif(0, false))).toBeNull();
    expect(readExifFocal35(new ArrayBuffer(0))).toBeNull();
  });
  it('derives vertical FOV from a 35mm focal length', () => {
    expect(fovFromFocal35(24, true)).toBeCloseTo(2 * Math.atan(12 / 24) * 180 / Math.PI, 9);
    expect(fovFromFocal35(24, false)).toBeCloseTo(2 * Math.atan(18 / 24) * 180 / Math.PI, 9);
    expect(fovFromFocal35(4, true)).toBeNull();
    expect(fovFromFocal35(NaN, true)).toBeNull();
    expect(fovFromFocal35(5, false)).toBe(110);      // clamped
    expect(fovFromFocal35(1000, true)).toBe(8);       // clamped
  });
});
