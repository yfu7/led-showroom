/**
 * Perspective-calibration session (engine-side state for the venue-photo sightline overlay).
 *
 * Port of v1 index.html 6497-6772 (`persp*`) and 9454-9481 (`applyPerspCamMeasurements`).
 * The React overlay owns a <canvas> the size of the viewport, forwards pointer events here
 * (view pixels, top-left origin) and calls {@link drawOverlay} after every change.
 *
 * Lines are stored in NORMALISED photo coordinates (0..1 of the cover-fitted photo) exactly as
 * `PerspectiveCalibration` persists them, so they survive viewport resizes; all pointer maths
 * happens in view pixels through the current {@link CoverFit}.
 *
 * Steps: draw RED line 1, RED line 2 (width-parallel edges), GREEN line 3, GREEN line 4
 * (depth-receding edges), then `done` (adjust endpoints, solve). Pointer down on an existing
 * endpoint (8 px) drags it in any step; a drawn segment shorter than 25 view px is discarded.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { CameraRig } from '../scene/CameraRig';
import type { PerspectiveCalibration, Seg2 } from '../document/types';
import type { Vec3 } from '../math';
import {
  calibrationGridSegments, calibrationGridSpec, cameraFromMeasurements, coverFit, lineIntersection,
  photoNormToView, segPhotoNormToView, solveTwoVanishingPoints, viewToPhotoNorm,
  type CoverFit, type Pt2, type VpSolve,
} from './perspective';

/* ───────────────────────────── Types / constants ───────────────────────────── */

export type CalibrationStep = 1 | 2 | 3 | 4 | 'done';

export interface CalibrationHandle { line: number; end: 0 | 1 }

/** Endpoint grab radius in view px. */
export const HANDLE_RADIUS_PX = 8;
/** Minimum drawn length (view px) for a line to count (v1 `> 25`). */
export const MIN_LINE_LENGTH_PX = 25;
export const WIDTH_LINE_COLOR = '#ef4444';
export const DEPTH_LINE_COLOR = '#22c55e';
export const VANISHING_POINT_COLOR = '#facc15';
export const HORIZON_COLOR = '#facc15';

export interface CalibrationSessionState {
  photoW: number;
  photoH: number;
  viewW: number;
  viewH: number;
  fit: CoverFit;
  /** Committed lines in normalised photo coords: [0..1] width (red), [2..3] depth (green). */
  lines: Seg2[];
  /** In-progress line (normalised), while the pointer is down. */
  drawing: Seg2 | null;
  dragging: CalibrationHandle | null;
  step: CalibrationStep;
}

/* ───────────────────────────── Pure helpers ───────────────────────────── */

/** Step for a given number of committed lines (a line being drawn counts as in progress). */
export function stepFor(lineCount: number): CalibrationStep {
  if (lineCount >= 4) return 'done';
  return (lineCount + 1) as 1 | 2 | 3 | 4;
}

/** Instruction text per step (v1 `perspUpdateUI`). */
export function instructionFor(step: CalibrationStep): string {
  switch (step) {
    case 1: return 'Draw 2 RED lines on width-parallel edges (back wall top & bottom) — 0/2';
    case 2: return 'Draw 2 RED lines on width-parallel edges (back wall top & bottom) — 1/2';
    case 3: return 'Now 2 GREEN lines on depth-receding edges (floor/ceiling lines going away) — 0/2';
    case 4: return 'Now 2 GREEN lines on depth-receding edges (floor/ceiling lines going away) — 1/2';
    default: return 'Adjust endpoints if needed, then Solve & Lock';
  }
}

/** Colour of line `index` (0..1 red width lines, 2..3 green depth lines). */
export function lineColor(index: number): string {
  return index < 2 ? WIDTH_LINE_COLOR : DEPTH_LINE_COLOR;
}

/** Find the endpoint handle under `pt` (view px) among `linesView` (view px). First hit wins. */
export function findHandle(linesView: Seg2[], pt: Pt2, radius = HANDLE_RADIUS_PX): CalibrationHandle | null {
  for (let i = 0; i < linesView.length; i++) {
    const l = linesView[i];
    if (Math.hypot(l.x1 - pt.x, l.y1 - pt.y) <= radius) return { line: i, end: 0 };
    if (Math.hypot(l.x2 - pt.x, l.y2 - pt.y) <= radius) return { line: i, end: 1 };
  }
  return null;
}

/** Vanishing points (view px) of the width and depth pairs, when four lines exist. */
export function vanishingPointsOf(linesView: Seg2[]): { vx: [number, number] | null; vz: [number, number] | null } | null {
  if (linesView.length < 4) return null;
  return { vx: lineIntersection(linesView[0], linesView[1]), vz: lineIntersection(linesView[2], linesView[3]) };
}

/** A `VpSolve`-shaped orientation from a camera quaternion (for measurement re-application). */
export function solveFromQuaternion(q: [number, number, number, number], fovDeg: number, viewH: number): VpSolve {
  const quat = new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const focalPx = (viewH / 2) / Math.tan(fovDeg * Math.PI / 360);
  return {
    focalPx, fovDeg, quaternion: [quat.x, quat.y, quat.z, quat.w],
    right: [right.x, right.y, right.z], up: [up.x, up.y, up.z], forward: [forward.x, forward.y, forward.z], ok: true,
  };
}

/**
 * Write an exact camera pose to the rig's perspective camera WITHOUT `controls.update()`.
 *
 * OrbitControls.update() re-derives the camera position from (target, spherical) and clamps the
 * polar angle to `maxPolarAngle` (0.495π) and the radius to [minDistance, maxDistance]. A
 * calibrated venue photo usually looks slightly upward (camera below the stage), which puts the
 * target above the camera → phi > π/2 → the clamp rewrites `camera.y`; even a level view sits on
 * the boundary and drifts. So the position, orbit target and quaternion are set directly, the
 * way v1 mutated `camera.position` (index.html 9454-9481). The orbit target is kept in sync so
 * unlocking later resumes orbiting around the solved look point.
 *
 * The pose only survives while the rig is NOT updated through OrbitControls: `CameraRig.update`
 * skips `controls.update()` while the view is locked (which `apply` / `restoreFromDocument`
 * set), an unlocked rig re-clamps on its next frame.
 */
export function setPose(rig: CameraRig, position: THREE.Vector3, target: THREE.Vector3, quaternion: THREE.Quaternion): void {
  if (rig.projection === 'orthographic') rig.setProjection('perspective');
  rig.setFlyMode(false);
  const cam = rig.persp;
  cam.position.copy(position);
  rig.controls.target.copy(target);
  rig.target.copy(target);
  cam.quaternion.copy(quaternion);
  cam.updateMatrixWorld(true);
  rig.userMoved = true;
  rig.emit('change', undefined);
}

/* ───────────────────────────── Session ───────────────────────────── */

export class CalibrationSession {
  private state: CalibrationSessionState = {
    photoW: 1, photoH: 1, viewW: 1, viewH: 1, fit: coverFit(1, 1, 1, 1),
    lines: [], drawing: null, dragging: null, step: 1,
  };
  private image: HTMLImageElement | null = null;
  private gridLines: THREE.LineSegments | null = null;
  private listeners = new Set<() => void>();
  /** Last solve error (from {@link solve}), for the overlay. */
  lastError: string | null = null;

  /** Subscribe to state changes (the React overlay redraws / re-renders). */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify(): void { for (const fn of Array.from(this.listeners)) fn(); }

  get snapshot(): Readonly<CalibrationSessionState> { return this.state; }
  get step(): CalibrationStep { return this.state.step; }
  get fit(): CoverFit { return this.state.fit; }
  get lines(): readonly Seg2[] { return this.state.lines; }
  get lineCount(): number { return this.state.lines.length; }
  get canSolve(): boolean { return this.state.lines.length >= 4; }
  /** Overlay text. Like v1 `perspUpdateUI` the line being drawn counts (`lines + (drawing ? 1 : 0)`). */
  get instruction(): string { return instructionFor(stepFor(this.state.lines.length + (this.state.drawing ? 1 : 0))); }
  get isDrawing(): boolean { return !!this.state.drawing; }
  get isDragging(): boolean { return !!this.state.dragging; }

  /**
   * Start (or restart) a session. `existing` pre-loads the four lines of a stored calibration
   * so endpoints can be adjusted; `image` is drawn by {@link drawOverlay}.
   */
  begin(photoW: number, photoH: number, viewW: number, viewH: number, existing?: PerspectiveCalibration | null, image?: HTMLImageElement | null): void {
    const pw = Math.max(1, photoW), ph = Math.max(1, photoH), vw = Math.max(1, viewW), vh = Math.max(1, viewH);
    const lines: Seg2[] = existing
      ? [...existing.widthLines, ...existing.depthLines].map(l => ({ ...l }))
      : [];
    this.state = {
      photoW: pw, photoH: ph, viewW: vw, viewH: vh, fit: coverFit(pw, ph, vw, vh),
      lines, drawing: null, dragging: null, step: stepFor(lines.length),
    };
    if (image !== undefined) this.image = image;
    this.lastError = null;
    this.notify();
  }

  setImage(image: HTMLImageElement | null): void { this.image = image; this.notify(); }

  /** The overlay canvas was resized: lines are normalised so only the fit changes. */
  resize(viewW: number, viewH: number): void {
    const s = this.state;
    s.viewW = Math.max(1, viewW); s.viewH = Math.max(1, viewH);
    s.fit = coverFit(s.photoW, s.photoH, s.viewW, s.viewH);
    this.notify();
  }

  reset(): void {
    this.state.lines = [];
    this.state.drawing = null;
    this.state.dragging = null;
    this.state.step = 1;
    this.lastError = null;
    this.notify();
  }

  /** Remove the last committed line (v1 "Undo line"). */
  undoLine(): void {
    this.state.drawing = null;
    this.state.dragging = null;
    this.state.lines.pop();
    this.state.step = stepFor(this.state.lines.length);
    this.lastError = null;
    this.notify();
  }

  /** Committed lines in view pixels. */
  linesInView(): Seg2[] { return this.state.lines.map(l => segPhotoNormToView(l, this.state.fit)); }

  /** All lines including the one being drawn, in view pixels. */
  private allLinesInView(): Seg2[] {
    const out = this.linesInView();
    if (this.state.drawing) out.push(segPhotoNormToView(this.state.drawing, this.state.fit));
    return out;
  }

  /** Endpoint handle under a view point (8 px), or null. */
  handleAt(viewPt: Pt2): CalibrationHandle | null {
    return findHandle(this.linesInView(), viewPt, HANDLE_RADIUS_PX);
  }

  /* ───────── pointer (view px) ───────── */

  pointerDown(viewX: number, viewY: number): void {
    const s = this.state;
    const h = this.handleAt({ x: viewX, y: viewY });
    // Editing the lines invalidates a previous solve failure: show the step text again.
    if (h) { s.dragging = h; this.lastError = null; this.notify(); return; }
    if (s.lines.length >= 4) return;
    this.lastError = null;
    const n = viewToPhotoNorm({ x: viewX, y: viewY }, s.fit);
    s.drawing = { x1: n.x, y1: n.y, x2: n.x, y2: n.y };
    this.notify();
  }

  pointerMove(viewX: number, viewY: number): void {
    const s = this.state;
    const n = viewToPhotoNorm({ x: viewX, y: viewY }, s.fit);
    if (s.dragging) {
      const l = s.lines[s.dragging.line];
      if (!l) { s.dragging = null; return; }
      if (s.dragging.end === 0) { l.x1 = n.x; l.y1 = n.y; } else { l.x2 = n.x; l.y2 = n.y; }
      this.notify();
      return;
    }
    if (s.drawing) {
      s.drawing.x2 = n.x; s.drawing.y2 = n.y;
      this.notify();
    }
  }

  pointerUp(viewX?: number, viewY?: number): void {
    const s = this.state;
    if (viewX !== undefined && viewY !== undefined) this.pointerMove(viewX, viewY);
    if (s.dragging) { s.dragging = null; this.notify(); return; }
    if (s.drawing) {
      const d = s.drawing;
      s.drawing = null;
      const v = segPhotoNormToView(d, s.fit);
      if (Math.hypot(v.x2 - v.x1, v.y2 - v.y1) > MIN_LINE_LENGTH_PX) s.lines.push(d);
      s.step = stepFor(s.lines.length);
      this.notify();
    }
  }

  /* ───────── solve / apply ───────── */

  /** The stored calibration shape for the current lines (unsolved unless `solved` given). */
  toCalibration(solved?: VpSolve | null, extra: Partial<PerspectiveCalibration> = {}): PerspectiveCalibration | null {
    const l = this.state.lines;
    if (l.length < 4) return null;
    const c = (s: Seg2): Seg2 => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
    return {
      widthLines: [c(l[0]), c(l[1])],
      depthLines: [c(l[2]), c(l[3])],
      solved: solved ? { quaternion: [...solved.quaternion] as [number, number, number, number], fovDeg: solved.fovDeg } : null,
      locked: false,
      showGrid: false,
      ...extra,
    };
  }

  /** Two-vanishing-point solve over the current lines (view pixels). Requires four lines. */
  solve(fallbackFovDeg = 40): VpSolve {
    const s = this.state;
    if (s.lines.length < 4) {
      this.lastError = 'Draw all four sightlines first.';
      return { focalPx: 1, fovDeg: fallbackFovDeg, quaternion: [0, 0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1], ok: false, reason: this.lastError };
    }
    const v = this.linesInView();
    const res = solveTwoVanishingPoints([v[0], v[1]], [v[2], v[3]], s.viewW, s.viewH, fallbackFovDeg);
    this.lastError = res.ok ? null : (res.reason ?? 'Could not solve the sightlines.');
    this.notify();
    return res;
  }

  /**
   * Apply a solve to the live camera (fov + orientation, locked) and persist it into the
   * document's backdrop calibration (lines, solved, locked, showGrid). Also shows the grid.
   */
  apply(engine: Engine, solve: VpSolve): boolean {
    if (!solve.ok) { engine.toast('error', solve.reason ?? 'Could not solve the sightlines.'); return false; }
    this.orientCamera(engine, solve.quaternion, solve.fovDeg, true);
    const prev = engine.doc.environment.backdrop.calibration;
    const calib = this.toCalibration(solve, {
      locked: true,
      showGrid: true,
      cameraHeightIn: prev?.cameraHeightIn,
      cameraDistanceIn: prev?.cameraDistanceIn,
    });
    if (!calib) return false;
    engine.patchEnvironment(env => ({ ...env, backdrop: { ...env.backdrop, calibration: calib } }), 'Calibrate perspective');
    this.setGrid(engine, true);
    return true;
  }

  /**
   * Orient the live perspective camera: keep its position, set fov, point the orbit target
   * along `forward` at the current distance, apply the solved quaternion, then lock. The
   * CameraRig has no "set quaternion" API, so the pose is written through {@link setPose}
   * (never via `controls.update()`); the lock stops OrbitControls from overwriting it until the
   * user unlocks the view.
   */
  private orientCamera(engine: Engine, quaternion: [number, number, number, number], fovDeg: number, lock: boolean): void {
    const rig = engine.camera;
    if (rig.projection === 'orthographic') rig.setProjection('perspective');
    rig.setFlyMode(false);
    rig.setFov(fovDeg);
    const cam = rig.persp;
    const q = new THREE.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]).normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const pos = cam.position.clone();
    const dist = rig.distanceToTarget() || 300;
    const target = pos.clone().addScaledVector(forward, dist);
    setPose(rig, pos, target, q);
    rig.setLocked(lock);
    engine.invalidate();
  }

  /* ───────── sightline grid ───────── */

  get gridVisible(): boolean { return !!this.gridLines?.parent; }

  /** Show / hide (add / remove) the blue ground grid drawn in the solved perspective. */
  toggleGrid(engine: Engine, on?: boolean): boolean {
    const next = on ?? !this.gridVisible;
    this.setGrid(engine, next);
    const c = engine.doc.environment.backdrop.calibration;
    if (c && c.showGrid !== next) {
      engine.patchEnvironment(env => ({ ...env, backdrop: { ...env.backdrop, calibration: env.backdrop.calibration ? { ...env.backdrop.calibration, showGrid: next } : env.backdrop.calibration } }), 'Toggle calibration grid', 'calibration:grid');
    }
    return next;
  }

  private setGrid(engine: Engine, on: boolean): void {
    if (on) {
      if (!this.gridLines) {
        const spec = calibrationGridSpec();
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(calibrationGridSegments(0), 3));
        const mat = new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: spec.opacity, depthWrite: false });
        this.gridLines = new THREE.LineSegments(geom, mat);
        this.gridLines.name = 'calibration-grid';
        this.gridLines.userData.helper = true;
        this.gridLines.userData.unpickable = true;
        this.gridLines.frustumCulled = false;
      }
      if (!this.gridLines.parent) engine.scene.scene.add(this.gridLines);
    } else if (this.gridLines) {
      this.gridLines.removeFromParent();
    }
    engine.invalidate();
  }

  /** Remove the grid and release its GPU resources. */
  disposeGrid(): void {
    if (!this.gridLines) return;
    this.gridLines.removeFromParent();
    this.gridLines.geometry.dispose();
    (this.gridLines.material as THREE.Material).dispose();
    this.gridLines = null;
  }

  /* ───────── measurements / restore ───────── */

  /**
   * Pin the solved perspective to absolute scale from real camera measurements (v1 9454-9481):
   * camera height above the floor and horizontal distance from the origin (inches). Uses the
   * document's solved orientation (or the live camera when none), keeps the current position
   * as the seed exactly like v1, and stores the values in the calibration.
   */
  applyMeasurements(engine: Engine, heightIn: number, distanceIn: number): void {
    const rig = engine.camera;
    // Like orientCamera: the pose is written to the PERSPECTIVE camera, so make it the live one.
    if (rig.projection === 'orthographic') rig.setProjection('perspective');
    rig.setFlyMode(false);
    const calib = engine.doc.environment.backdrop.calibration;
    const cam = rig.persp;
    const q: [number, number, number, number] = calib?.solved?.quaternion ?? [cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w];
    const solve = solveFromQuaternion(q, calib?.solved?.fovDeg ?? rig.fov, this.state.viewH);
    const cur: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
    const r = cameraFromMeasurements(solve, heightIn, distanceIn, cur);
    // NOT rig.moveTo(): that runs controls.update(), whose polar/radius clamps silently rewrite
    // the position (see setPose) so the entered height / distance would not be honoured.
    setPose(rig, new THREE.Vector3(...r.position), new THREE.Vector3(...r.target), new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize());
    if (calib) {
      const h = Number.isFinite(heightIn) && heightIn > 0 ? heightIn : calib.cameraHeightIn;
      const d = Number.isFinite(distanceIn) && distanceIn > 0 ? distanceIn : calib.cameraDistanceIn;
      engine.patchEnvironment(env => ({
        ...env,
        backdrop: { ...env.backdrop, calibration: env.backdrop.calibration ? { ...env.backdrop.calibration, cameraHeightIn: h, cameraDistanceIn: d } : env.backdrop.calibration },
      }), 'Set camera measurements', 'calibration:measurements');
    }
    engine.invalidate();
  }

  /**
   * A document with a solved calibration was loaded: re-apply the camera orientation + fov,
   * the view lock and the grid. Returns true when a calibration was restored.
   */
  restoreFromDocument(engine: Engine): boolean {
    const calib = engine.doc.environment.backdrop.calibration;
    const photo = engine.doc.environment.backdrop.photo;
    if (!calib || !calib.solved || !photo) { this.setGrid(engine, false); return false; }
    this.orientCamera(engine, calib.solved.quaternion, calib.solved.fovDeg, calib.locked);
    this.setGrid(engine, !!calib.showGrid);
    return true;
  }

  /** Drop the calibration from the document, unlock the view and remove the grid. */
  clear(engine: Engine): void {
    this.setGrid(engine, false);
    if (engine.doc.environment.backdrop.calibration) {
      engine.patchEnvironment(env => ({ ...env, backdrop: { ...env.backdrop, calibration: null } }), 'Clear calibration');
    }
    engine.camera.setLocked(false);
    this.reset();
  }

  /* ───────── overlay drawing ───────── */

  /**
   * Draw the overlay: cover-fitted photo, the four sightlines with extended dashed guides and
   * endpoint handles, the vanishing points + horizon once all four exist, and the step text.
   * `ctx.canvas` is expected to be `viewW × viewH` (call {@link resize} when it changes).
   */
  drawOverlay(ctx: CanvasRenderingContext2D): void {
    const s = this.state;
    const W = s.viewW, H = s.viewH;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    const img = this.image;
    if (img && (img.complete ?? true) && (img.naturalWidth ?? 1) > 0) {
      ctx.drawImage(img, s.fit.x, s.fit.y, s.fit.w, s.fit.h);
    }
    // Dim the photo slightly so the lines read.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);

    const all = this.allLinesInView();
    all.forEach((l, i) => {
      const color = lineColor(i);
      const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ex = dx / len * 4000, ey = dy / len * 4000;
      // Extended dashed guide
      ctx.strokeStyle = color; ctx.globalAlpha = 0.28; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(l.x1 - ex, l.y1 - ey); ctx.lineTo(l.x2 + ex, l.y2 + ey); ctx.stroke();
      // Main segment
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke();
      // Endpoints (6 px)
      for (const [px, py] of [[l.x1, l.y1], [l.x2, l.y2]] as [number, number][]) {
        ctx.fillStyle = '#0a0a0a'; ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
      }
    });

    // Vanishing points + horizon
    const vps = vanishingPointsOf(this.linesInView());
    if (vps) {
      const drawVp = (p: [number, number] | null, color: string) => {
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
        ctx.globalAlpha = 1; ctx.setLineDash([]);
        ctx.strokeStyle = VANISHING_POINT_COLOR; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p[0] - 9, p[1]); ctx.lineTo(p[0] + 9, p[1]); ctx.moveTo(p[0], p[1] - 9); ctx.lineTo(p[0], p[1] + 9); ctx.stroke();
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2); ctx.fill();
      };
      drawVp(vps.vx, WIDTH_LINE_COLOR);
      drawVp(vps.vz, DEPTH_LINE_COLOR);
      if (vps.vx && vps.vz) {
        const dx = vps.vz[0] - vps.vx[0], dy = vps.vz[1] - vps.vx[1];
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) {
          const ex = dx / len * 20000, ey = dy / len * 20000;
          ctx.strokeStyle = HORIZON_COLOR; ctx.globalAlpha = 0.5; ctx.setLineDash([10, 6]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(vps.vx[0] - ex, vps.vx[1] - ey); ctx.lineTo(vps.vz[0] + ex, vps.vz[1] + ey); ctx.stroke();
          ctx.globalAlpha = 1; ctx.setLineDash([]);
        }
      }
    }

    // Step instructions
    const text = this.lastError ?? this.instruction;
    ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const padX = 12, boxH = 30;
    const tw = ctx.measureText(text).width;
    const bx = 16, by = 16;
    ctx.fillStyle = this.lastError ? 'rgba(127,29,29,0.85)' : 'rgba(0,0,0,0.72)';
    if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(bx, by, tw + padX * 2, boxH, 8); ctx.fill(); }
    else ctx.fillRect(bx, by, tw + padX * 2, boxH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, bx + padX, by + boxH / 2);
    ctx.restore();
  }

  /** Convenience for the overlay: the in-progress or committed lines in view px + colours. */
  linesForDisplay(): { seg: Seg2; color: string; committed: boolean }[] {
    const out = this.linesInView().map((seg, i) => ({ seg, color: lineColor(i), committed: true }));
    if (this.state.drawing) out.push({ seg: segPhotoNormToView(this.state.drawing, this.state.fit), color: lineColor(out.length), committed: false });
    return out;
  }

  /** Photo-normalised → view px (exposed for overlay hit-testing / labels). */
  toView(pt: Pt2): Pt2 { return photoNormToView(pt, this.state.fit); }
  /** View px → photo-normalised. */
  toPhoto(pt: Pt2): Pt2 { return viewToPhotoNorm(pt, this.state.fit); }
}
