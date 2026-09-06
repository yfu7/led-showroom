/**
 * Perspective calibration of a venue photo (PURE — no three.js, no DOM).
 *
 * Ported from the v1 single-file app:
 *  - cover-fit photo mapping            (v1 6544-6552 / 8350-8358)
 *  - line-line intersection             (v1 6574-6583, `perspLineIntersect`)
 *  - two-vanishing-point solve          (v1 6585-6650, `perspSolve`)
 *  - sightline ground grid parameters   (v1 6652-6680, `buildPerspGrid`)
 *  - perspective-matched floor drag     (v1 7812-7835, plane only)
 *  - camera-measurement reinforcement   (v1 9454-9481, `applyPerspCamMeasurements`)
 *  - EXIF FocalLengthIn35mmFilm reader  (v1 6419-6473, `readExifFocal35` + FOV derivation)
 *
 * ── Coordinate conventions ────────────────────────────────────────────────
 *
 *  VIEW pixels     origin top-left of the viewport, x right, y DOWN. This is the
 *                  frame the user draws sightlines in (canvas / pointer events).
 *  PHOTO normalised  0..1 across the photo's own width/height (top-left origin,
 *                  y down). This is how `PerspectiveCalibration` stores lines so
 *                  they survive viewport resizes. `coverFit` maps between the two.
 *  CENTRED image   (u, v) pixels with the origin at the viewport centre, u right,
 *                  v UP:  u = x - W/2,  v = -(y - H/2).
 *  CAMERA space    right-handed, x right, y up, camera looks down -Z (three.js).
 *                  A centred image point (u, v) at focal length f (px) is the ray
 *                  direction (u, v, -f).
 *  WORLD space     right-handed, y up (v2: floor at y = 0). The two sightline
 *                  pairs define world +X (width lines, screen-parallel edges) and
 *                  world +Z (depth lines, edges receding into the photo). The
 *                  solve returns the CAMERA's orientation in that world frame.
 */
import { clamp, type Vec3 } from '../math';
import { RAD } from '../units';
import type { Seg2 } from '../document/types';

/* ───────────────────────────── Cover fit ───────────────────────────── */

/** A 2D point (pixels or normalised, per context). */
export interface Pt2 { x: number; y: number }

/**
 * Placement of a photo drawn with CSS `background-size: cover; background-position: center`
 * into a view. `x`/`y`/`w`/`h` are the drawn rectangle in VIEW pixels (x/y may be negative
 * when the photo is cropped); `scale` is view px per photo px (`w / photoW`).
 */
export interface CoverFit { x: number; y: number; w: number; h: number; scale: number }

/**
 * Cover-fit a photo of `photoW × photoH` into a `viewW × viewH` viewport — the photo is
 * scaled to fill the viewport and centre-cropped, exactly as the v1 CSS background and
 * its canvas replica (v1 6544-6552, 8350-8358).
 */
export function coverFit(photoW: number, photoH: number, viewW: number, viewH: number): CoverFit {
  const ar = photoW / photoH;
  const cAr = viewW / viewH;
  let w: number, h: number, x: number, y: number;
  if (ar > cAr) { h = viewH; w = viewH * ar; x = (viewW - w) / 2; y = 0; }
  else          { w = viewW; h = viewW / ar; x = 0; y = (viewH - h) / 2; }
  return { x, y, w, h, scale: w / photoW };
}

/** Map a normalised photo point (0..1, top-left origin, y down) into VIEW pixels. */
export function photoNormToView(pt: Pt2, fit: CoverFit): Pt2 {
  return { x: fit.x + pt.x * fit.w, y: fit.y + pt.y * fit.h };
}

/** Map a VIEW pixel point back to normalised photo coordinates (may fall outside 0..1). */
export function viewToPhotoNorm(pt: Pt2, fit: CoverFit): Pt2 {
  return { x: (pt.x - fit.x) / fit.w, y: (pt.y - fit.y) / fit.h };
}

/** Convert a segment in normalised photo coordinates to VIEW pixels. */
export function segPhotoNormToView(s: Seg2, fit: CoverFit): Seg2 {
  const a = photoNormToView({ x: s.x1, y: s.y1 }, fit);
  const b = photoNormToView({ x: s.x2, y: s.y2 }, fit);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Convert a segment in VIEW pixels to normalised photo coordinates. */
export function segViewToPhotoNorm(s: Seg2, fit: CoverFit): Seg2 {
  const a = viewToPhotoNorm({ x: s.x1, y: s.y1 }, fit);
  const b = viewToPhotoNorm({ x: s.x2, y: s.y2 }, fit);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/* ───────────────────────────── Lines ───────────────────────────── */

/**
 * Intersection of the two infinite lines through segments `a` and `b` (any 2D frame).
 * Returns `null` when the lines are parallel on screen (|det| < 1e-9) — for sightlines
 * that means the vanishing point is at infinity. (v1 6574-6583 `perspLineIntersect`.)
 */
export function lineIntersection(a: Seg2, b: Seg2): [number, number] | null {
  const d = (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2);
  if (Math.abs(d) < 1e-9) return null;
  const p = a.x1 * a.y2 - a.y1 * a.x2;
  const q = b.x1 * b.y2 - b.y1 * b.x2;
  return [
    (p * (b.x1 - b.x2) - (a.x1 - a.x2) * q) / d,
    (p * (b.y1 - b.y2) - (a.y1 - a.y2) * q) / d,
  ];
}

/* ───────────────────────────── Two-VP solve ───────────────────────────── */

/** Result of {@link solveTwoVanishingPoints}. */
export interface VpSolve {
  /**
   * Focal length in VIEW pixels (vertical and horizontal — square pixels assumed).
   * Always finite and positive: when `ok` is false this is the focal length implied by
   * the (clamped) fallback FOV, so a failed solve never yields a degenerate projection.
   */
  focalPx: number;
  /**
   * Vertical field of view in degrees, always within 8..110 ({@link FOV_MIN_DEG} /
   * {@link FOV_MAX_DEG}) — including when `ok` is false, where it is the clamped
   * fallback FOV (v1 left the camera FOV untouched on failure; v2 returns that same
   * "unchanged" value so callers copying the solve into a document or camera stay safe).
   */
  fovDeg: number;
  /** Camera orientation (camera→world rotation) as [x, y, z, w], three.js order. */
  quaternion: [number, number, number, number];
  /** Camera local +X expressed in world space (unit). */
  right: Vec3;
  /** Camera local +Y expressed in world space (unit). */
  up: Vec3;
  /** Camera viewing direction (local -Z) expressed in world space (unit). */
  forward: Vec3;
  /** False when the sightlines describe an impossible camera or a degenerate basis. */
  ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
}

/** Minimum admissible f² (px²) — v1 rejected `!(f2 > 100)`. */
export const MIN_FOCAL_SQ_PX = 100;
/** FOV clamp range shared by the solve and the EXIF path (v1 `Math.max(8, Math.min(110, ..))`). */
export const FOV_MIN_DEG = 8;
export const FOV_MAX_DEG = 110;
/** Message shown by v1 when the two vanishing points cannot come from one pinhole camera. */
export const IMPOSSIBLE_CAMERA_REASON =
  'Those sightlines describe an impossible camera — make sure the RED pair and GREEN pair follow edges that are perpendicular to each other in the real room.';

type V3 = Vec3;
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/**
 * three.js `Quaternion.setFromRotationMatrix` on a row-major 3×3 rotation `r[row][col]`.
 * Returns [x, y, z, w].
 */
function quatFromRotation(r: number[][]): [number, number, number, number] {
  const m11 = r[0][0], m12 = r[0][1], m13 = r[0][2];
  const m21 = r[1][0], m22 = r[1][1], m23 = r[1][2];
  const m31 = r[2][0], m32 = r[2][1], m33 = r[2][2];
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

/** Vertical FOV (deg) for a focal length in px over a viewport `viewH` px tall, clamped. */
export function fovFromFocalPx(focalPx: number, viewH: number): number {
  return clamp(2 * Math.atan((viewH / 2) / focalPx) * RAD, FOV_MIN_DEG, FOV_MAX_DEG);
}

/** Focal length in px for a vertical FOV (deg) over a viewport `viewH` px tall. */
export function focalPxFromFov(fovDeg: number, viewH: number): number {
  return (viewH / 2) / Math.tan(fovDeg * Math.PI / 360);
}

/**
 * Two-vanishing-point camera solve (v1 6585-6650 `perspSolve`).
 *
 * `widthLines` are two sightlines along real-world edges parallel to world +X (the RED pair
 * in v1), `depthLines` two along edges parallel to world +Z (GREEN pair). All four are in
 * VIEW pixels (y down) over a `viewW × viewH` viewport — convert stored normalised photo
 * lines with {@link segPhotoNormToView} first.
 *
 * Algorithm:
 *  1. Vanishing points vX = widthLines[0] ∩ widthLines[1], vZ = depthLines[0] ∩ depthLines[1].
 *  2. Move both to CENTRED coordinates (u = x - W/2, v = -(y - H/2), i.e. y flips to up).
 *  3. Two orthogonal world axes give f² = -(vX · vZ) (principal point at the centre).
 *     `f² ≤ 100` → `ok: false` with {@link IMPOSSIBLE_CAMERA_REASON}.
 *     If either pair is parallel on screen (VP at infinity) that axis lies in the image
 *     plane and f cannot be recovered: f falls back to `fallbackFovDeg` (v1 used the
 *     current camera FOV; v2 passes it in — default 40, the document default).
 *     `fallbackFovDeg` is clamped to 8..110 before use — v1's camera FOV was always kept
 *     in that range by its slider, so this reproduces the effective domain and rejects
 *     values such as 180 that would otherwise give a ~1e-14 px focal length. A
 *     non-finite fallback is rejected (`ok: false`).
 *  4. World axis directions in camera space: wx = norm(vX.u, vX.v, -f) (or the in-image
 *     line direction for a VP at infinity), recede = likewise for vZ, wz = -recede
 *     (world +Z points toward the viewer, receding edges go into the photo).
 *     Sign fixes: wx.x ≥ 0 (world +X to the right), wz.z ≥ 0.
 *  5. wx is orthonormalised against wz, wy = wz × wx, and (wx, wy) are negated together if
 *     wy.y < 0 so world up points up in the image.
 *  6. The matrix with columns (wx, wy, wz) is the world→camera rotation; the camera's
 *     orientation is its transpose, returned as a quaternion plus right/up/forward.
 *  7. fovDeg = 2·atan((H/2)/f), clamped 8..110.
 *
 * Note: v1 rounded the FOV to an integer for the slider; this returns the exact value.
 */
export function solveTwoVanishingPoints(
  widthLines: [Seg2, Seg2],
  depthLines: [Seg2, Seg2],
  viewW: number,
  viewH: number,
  fallbackFovDeg = 40,
): VpSolve {
  // Clamp the fallback to the slider range v1 enforced (see step 3). A non-finite input
  // would survive `clamp` as NaN, so pin it to the default first.
  const safeFovDeg = clamp(Number.isFinite(fallbackFovDeg) ? fallbackFovDeg : 40, FOV_MIN_DEG, FOV_MAX_DEG);
  const safeFocalPx = focalPxFromFov(safeFovDeg, viewH);

  // A failed solve still carries an in-range FOV / positive focal length so a caller that
  // copies it into the document or a camera without checking `ok` never gets fov = 0
  // (which makes PerspectiveCamera.updateProjectionMatrix divide by tan(0)).
  const fail = (reason: string): VpSolve => ({
    focalPx: safeFocalPx, fovDeg: safeFovDeg, quaternion: [0, 0, 0, 1],
    right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1], ok: false, reason,
  });

  const vpX = lineIntersection(widthLines[0], widthLines[1]);
  const vpZ = lineIntersection(depthLines[0], depthLines[1]);
  // Centred image coords, y up
  const toC = (p: [number, number] | null): [number, number] | null =>
    p ? [p[0] - viewW / 2, -(p[1] - viewH / 2)] : null;
  const cX = toC(vpX), cZ = toC(vpZ);

  let f: number;
  if (cX && cZ) {
    const f2 = -(cX[0] * cZ[0] + cX[1] * cZ[1]);
    if (!(f2 > MIN_FOCAL_SQ_PX)) return fail(IMPOSSIBLE_CAMERA_REASON);
    f = Math.sqrt(f2);
  } else {
    // A parallel pair means that axis is parallel to the image plane;
    // fall back to the supplied (clamped) FOV for focal length.
    if (!Number.isFinite(fallbackFovDeg)) return fail('Could not derive a focal length from the sightlines.');
    f = safeFocalPx;
  }
  if (!Number.isFinite(f) || f <= 0) return fail('Could not derive a focal length from the sightlines.');

  // World axis directions in camera space (camera looks down -Z)
  const dirFrom = (c: [number, number]): V3 => normalize([c[0], c[1], -f]);
  // In-image direction for a VP at infinity (axis parallel to image plane)
  const lineDir = (l: Seg2): V3 => normalize([l.x2 - l.x1, -(l.y2 - l.y1), 0]);

  let wx: V3 = cX ? dirFrom(cX) : lineDir(widthLines[0]);
  const recede: V3 = cZ ? dirFrom(cZ) : lineDir(depthLines[0]);
  let wz: V3 = neg(recede);                       // world +Z toward the viewer
  if (wx[0] < 0) wx = neg(wx);                    // world +X to the right
  if (wz[2] < 0) wz = neg(wz);                    // receding lines go into the photo
  // Orthonormalize X against Z, derive up
  const k = dot(wx, wz);
  const wxo: V3 = [wx[0] - wz[0] * k, wx[1] - wz[1] * k, wx[2] - wz[2] * k];
  if (Math.hypot(wxo[0], wxo[1], wxo[2]) < 1e-9 || Math.hypot(wz[0], wz[1], wz[2]) < 1e-9) {
    return fail('The width and depth sightlines point the same way — they must follow perpendicular edges.');
  }
  wx = normalize(wxo);
  let wy: V3 = cross(wz, wx);
  if (wy[1] < 0) { wx = neg(wx); wy = neg(wy); }  // keep world up pointing up

  // v1: makeBasis(wx, wy, wz) has the world axes as COLUMNS = the world→camera rotation M;
  // the camera's orientation is its transpose R = Mᵀ, whose ROWS are (wx, wy, wz).
  // Camera local axes in world space are then the COLUMNS of R.
  const R: number[][] = [
    [wx[0], wx[1], wx[2]],
    [wy[0], wy[1], wy[2]],
    [wz[0], wz[1], wz[2]],
  ];
  const quaternion = quatFromRotation(R);
  const right: V3   = [R[0][0], R[1][0], R[2][0]];
  const up: V3      = [R[0][1], R[1][1], R[2][1]];
  const forward: V3 = [-R[0][2], -R[1][2], -R[2][2]];

  return { focalPx: f, fovDeg: fovFromFocalPx(f, viewH), quaternion, right, up, forward, ok: true };
}

/* ───────────────────────────── Sightline grid ───────────────────────────── */

/** Parameters of the sightline ground grid. */
export interface CalibrationGridSpec {
  /** Half side of the square grid, inches (1440 = 120 ft square). */
  halfExtentIn: 1440;
  /** Line pitch, inches (48 = 4 ft). */
  pitchIn: 48;
  /** Line colour (CSS hex). */
  color: string;
  /** Line opacity (material is transparent, depthWrite off). */
  opacity: number;
}

/**
 * Ground-plane grid drawn in the solved perspective so the user can see it seat onto the
 * photo's floor (v1 6652-6680 `buildPerspGrid`): a 120 ft square of lines every 4 ft,
 * blue at 30 % opacity. In v2 the grid lies on the world floor y = 0 (v1 used
 * y = -totalH/2 because its wall was centred on the origin).
 */
export function calibrationGridSpec(): CalibrationGridSpec {
  return { halfExtentIn: 1440, pitchIn: 48, color: '#3b82f6', opacity: 0.3 };
}

/**
 * Build the grid line segments as a flat [x,y,z, x,y,z, ...] array at floor height `floorY`
 * (default 0 in v2). Suitable for a `Float32BufferAttribute(…, 3)` + `LineSegments`.
 */
export function calibrationGridSegments(floorY = 0): number[] {
  const { halfExtentIn: EXT, pitchIn: STEP } = calibrationGridSpec();
  const pts: number[] = [];
  for (let x = -EXT; x <= EXT; x += STEP) pts.push(x, floorY, -EXT, x, floorY, EXT);
  for (let z = -EXT; z <= EXT; z += STEP) pts.push(-EXT, floorY, z, EXT, floorY, z);
  return pts;
}

/* ───────────────────────────── Floor drag plane ───────────────────────────── */

/**
 * Drag plane used while the view is perspective-matched (v1 7812-7835). Entities slide along
 * the photo's floor so movements recede/approach along the solved sightlines rather than
 * across a camera-facing plane. Expressed as `normal · p + constant = 0` (three.js `Plane`).
 * v1 used `Plane((0,1,0), totalH/2)` — the floor at y = -totalH/2 in its centred wall frame;
 * in v2 the floor is y = 0, so the constant is 0.
 */
export const PERSPECTIVE_DRAG_PLANE: { normal: Vec3; constant: number } = { normal: [0, 1, 0], constant: 0 };

/* ───────────────────────────── Camera measurements ───────────────────────────── */

/**
 * Pin the solved perspective to absolute scale from real camera measurements
 * (v1 9454-9481 `applyPerspCamMeasurements`): `heightIn` is the camera's height above the
 * venue floor, `distanceIn` its horizontal distance from the scene origin.
 *
 * v1 mutated the live camera: `y = floor + h`, then scaled the existing (x, z) so their
 * length equals `dist` (or set `z = dist` when the camera sat within 1 in of the origin
 * horizontally). Pass `currentPosition` to reproduce that exactly. Without it the camera is
 * placed on the solved sightline: horizontally at `-forward.xz` (normalised) × `dist`, so the
 * camera looks over the origin, falling back to +Z when the camera looks straight down.
 * Non-positive / non-finite measurements leave that component untouched, as in v1.
 *
 * `target` is `position + forward × hypot(dist, h)` (v1 kept whatever orbit distance it had).
 */
export function cameraFromMeasurements(
  solve: VpSolve,
  heightIn: number,
  distanceIn: number,
  currentPosition?: Vec3,
): { position: Vec3; target: Vec3 } {
  const fwd = solve.forward;
  const fxz = Math.hypot(fwd[0], fwd[2]);
  let pos: Vec3 = currentPosition
    ? [currentPosition[0], currentPosition[1], currentPosition[2]]
    : (fxz > 1e-6 ? [-fwd[0] / fxz * 300, 0, -fwd[2] / fxz * 300] : [0, 0, 300]);

  if (Number.isFinite(heightIn) && heightIn > 0) pos = [pos[0], heightIn, pos[2]];
  if (Number.isFinite(distanceIn) && distanceIn > 0) {
    const dxz = Math.hypot(pos[0], pos[2]);
    if (dxz > 1) {
      const k = distanceIn / dxz;
      pos = [pos[0] * k, pos[1], pos[2] * k];
    } else {
      pos = [pos[0], pos[1], distanceIn];
    }
  }
  const len = Math.hypot(Math.hypot(pos[0], pos[2]), pos[1]) || 300;
  const target: Vec3 = [pos[0] + fwd[0] * len, pos[1] + fwd[1] * len, pos[2] + fwd[2] * len];
  return { position: pos, target };
}

/* ───────────────────────────── EXIF ───────────────────────────── */

/**
 * Minimal JPEG EXIF reader for FocalLengthIn35mmFilm (tag 0xA405) — v1 6438-6473.
 * Scans the APP1 "Exif" segment, follows IFD0 → ExifIFD (0x8769) and returns the tag's
 * value, or `null` when the buffer is not a JPEG, has no EXIF, or lacks the tag (or the
 * value is 0). Pass the first ~256 KB of the file (v1 sliced `file.slice(0, 256*1024)`).
 *
 * v1 always read the value as a 16-bit SHORT; this also honours a LONG-typed entry.
 */
export function readExifFocal35(buf: ArrayBuffer): number | null {
  try {
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);
    if (bytes.length < 4 || dv.getUint16(0) !== 0xFFD8) return null;   // not a JPEG
    let off = 2;
    while (off + 4 < bytes.length) {
      if (bytes[off] !== 0xFF) break;
      const marker = bytes[off + 1];
      const size = dv.getUint16(off + 2);
      if (marker === 0xE1 && off + 8 <= bytes.length &&
          String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]) === 'Exif') {
        const tiff = off + 10;
        if (tiff + 8 > bytes.length) return null;
        const little = dv.getUint16(tiff) === 0x4949;
        const g16 = (o: number) => dv.getUint16(o, little);
        const g32 = (o: number) => dv.getUint32(o, little);
        const ifd0 = tiff + g32(tiff + 4);
        if (ifd0 + 2 > bytes.length) return null;
        let exifPtr = 0;
        const n = g16(ifd0);
        for (let i = 0; i < n; i++) {
          const e = ifd0 + 2 + i * 12;
          if (e + 12 > bytes.length) break;
          if (g16(e) === 0x8769) exifPtr = tiff + g32(e + 8);
        }
        if (!exifPtr || exifPtr > bytes.length - 2) return null;
        const m = g16(exifPtr);
        for (let i = 0; i < m; i++) {
          const e = exifPtr + 2 + i * 12;
          if (e + 12 > bytes.length) break;
          if (g16(e) === 0xA405) {
            const type = g16(e + 2);
            const v = type === 4 ? g32(e + 8) : g16(e + 8);
            return v > 0 ? v : null;
          }
        }
        return null;
      }
      off += 2 + size;
    }
  } catch { /* malformed — treat as no EXIF */ }
  return null;
}

/**
 * Vertical FOV (deg) implied by a 35 mm-equivalent focal length (v1 6419-6435). The 35 mm
 * frame is 36 × 24 mm, so the vertical half-height is 12 mm in landscape and 18 mm in
 * portrait: `vfov = 2·atan(half / f35)`, clamped to 8..110. Returns `null` for f35 < 5
 * (or non-finite), which v1 ignored as bogus. Not rounded (v1 rounded for its slider).
 */
export function fovFromFocal35(f35: number, landscape: boolean): number | null {
  if (!Number.isFinite(f35) || f35 < 5) return null;
  const halfMM = landscape ? 12 : 18;
  return clamp(2 * Math.atan(halfMM / f35) * RAD, FOV_MIN_DEG, FOV_MAX_DEG);
}
