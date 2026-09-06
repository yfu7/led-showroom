import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Environment, PerspectiveCalibration, Seg2 } from '../document/types';
import {
  CalibrationSession, HANDLE_RADIUS_PX, MIN_LINE_LENGTH_PX,
  findHandle, instructionFor, lineColor, setPose, solveFromQuaternion, stepFor, vanishingPointsOf,
} from './CalibrationSession';
import { cameraFromMeasurements, coverFit } from './perspective';

// Photo 1600x900 (16:9) into an 800x600 (4:3) view → cover-fit: height 600, width 1066.67, x = -133.33.
const PW = 1600, PH = 900, VW = 800, VH = 600;

function session(existing?: PerspectiveCalibration | null): CalibrationSession {
  const s = new CalibrationSession();
  s.begin(PW, PH, VW, VH, existing ?? null, null);
  return s;
}

/** Draw a line with pointer down / move / up in view px. */
function draw(s: CalibrationSession, x1: number, y1: number, x2: number, y2: number): void {
  s.pointerDown(x1, y1);
  s.pointerMove((x1 + x2) / 2, (y1 + y2) / 2);
  s.pointerMove(x2, y2);
  s.pointerUp(x2, y2);
}

describe('pure helpers', () => {
  it('stepFor / instructionFor progress 1 → 4 → done', () => {
    expect(stepFor(0)).toBe(1);
    expect(stepFor(1)).toBe(2);
    expect(stepFor(2)).toBe(3);
    expect(stepFor(3)).toBe(4);
    expect(stepFor(4)).toBe('done');
    expect(instructionFor(1)).toContain('RED');
    expect(instructionFor(1)).toContain('0/2');
    expect(instructionFor(2)).toContain('1/2');
    expect(instructionFor(3)).toContain('GREEN');
    expect(instructionFor(4)).toContain('1/2');
    expect(instructionFor('done')).toContain('Solve');
  });

  it('lineColor: first two red, last two green', () => {
    expect(lineColor(0)).toBe('#ef4444');
    expect(lineColor(1)).toBe('#ef4444');
    expect(lineColor(2)).toBe('#22c55e');
    expect(lineColor(3)).toBe('#22c55e');
  });

  it('findHandle returns the endpoint within the radius, first line wins', () => {
    const lines: Seg2[] = [{ x1: 10, y1: 10, x2: 100, y2: 10 }, { x1: 10, y1: 50, x2: 100, y2: 50 }];
    expect(findHandle(lines, { x: 12, y: 13 })).toEqual({ line: 0, end: 0 });
    expect(findHandle(lines, { x: 104, y: 46 })).toEqual({ line: 1, end: 1 });
    expect(findHandle(lines, { x: 50, y: 10 })).toBeNull();
    expect(findHandle(lines, { x: 10 + HANDLE_RADIUS_PX + 0.5, y: 10 })).toBeNull();
    expect(findHandle(lines, { x: 10 + HANDLE_RADIUS_PX, y: 10 })).toEqual({ line: 0, end: 0 });
  });

  it('vanishingPointsOf needs four lines and intersects each pair', () => {
    expect(vanishingPointsOf([])).toBeNull();
    const lines: Seg2[] = [
      { x1: 0, y1: 0, x2: 100, y2: 100 }, { x1: 0, y1: 200, x2: 100, y2: 100 },   // meet at (100,100)
      { x1: 0, y1: 0, x2: 100, y2: 0 }, { x1: 0, y1: 10, x2: 100, y2: 10 },       // parallel
    ];
    const v = vanishingPointsOf(lines)!;
    expect(v.vx![0]).toBeCloseTo(100);
    expect(v.vx![1]).toBeCloseTo(100);
    expect(v.vz).toBeNull();
  });

  it('solveFromQuaternion derives forward/right/up from the quaternion', () => {
    const s = solveFromQuaternion([0, 0, 0, 1], 40, 600);
    expect(s.forward).toEqual([0, 0, -1]);
    expect(s.right).toEqual([1, 0, 0]);
    expect(s.up).toEqual([0, 1, 0]);
    expect(s.focalPx).toBeCloseTo(300 / Math.tan(20 * Math.PI / 180), 6);
    expect(s.ok).toBe(true);
  });
});

describe('CalibrationSession.begin', () => {
  it('starts empty at step 1 with the cover fit of the sizes', () => {
    const s = session();
    expect(s.step).toBe(1);
    expect(s.lineCount).toBe(0);
    expect(s.canSolve).toBe(false);
    expect(s.fit).toEqual(coverFit(PW, PH, VW, VH));
    expect(s.fit.h).toBe(VH);
    expect(s.fit.x).toBeLessThan(0);
  });

  it('pre-loads an existing calibration and lands on done', () => {
    const existing: PerspectiveCalibration = {
      widthLines: [{ x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.25 }, { x1: 0.1, y1: 0.8, x2: 0.9, y2: 0.75 }],
      depthLines: [{ x1: 0.1, y1: 0.9, x2: 0.4, y2: 0.5 }, { x1: 0.9, y1: 0.9, x2: 0.6, y2: 0.5 }],
      solved: null, locked: false, showGrid: false,
    };
    const s = session(existing);
    expect(s.step).toBe('done');
    expect(s.lineCount).toBe(4);
    expect(s.canSolve).toBe(true);
    // lines are copied, not shared
    s.pointerDown(...Object.values(s.toView({ x: 0.1, y: 0.2 })) as [number, number]);
    s.pointerMove(400, 300);
    s.pointerUp();
    expect(existing.widthLines[0].x1).toBe(0.1);
    expect(s.lines[0].x1).not.toBe(0.1);
  });
});

describe('drawing lines', () => {
  it('progresses through the four steps and stores normalised coordinates', () => {
    const s = session();
    draw(s, 100, 100, 700, 120);
    expect(s.step).toBe(2);
    expect(s.lineCount).toBe(1);
    const l = s.lines[0];
    const fit = s.fit;
    expect(l.x1).toBeCloseTo((100 - fit.x) / fit.w, 9);
    expect(l.y1).toBeCloseTo(100 / fit.h, 9);
    expect(l.x2).toBeCloseTo((700 - fit.x) / fit.w, 9);
    // round-trips back to view px
    const v = s.linesInView()[0];
    expect(v.x1).toBeCloseTo(100, 6); expect(v.y1).toBeCloseTo(100, 6);
    expect(v.x2).toBeCloseTo(700, 6); expect(v.y2).toBeCloseTo(120, 6);

    draw(s, 100, 500, 700, 480);
    expect(s.step).toBe(3);
    draw(s, 100, 580, 300, 300);
    expect(s.step).toBe(4);
    expect(s.canSolve).toBe(false);
    draw(s, 700, 580, 500, 300);
    expect(s.step).toBe('done');
    expect(s.canSolve).toBe(true);
    expect(s.lineCount).toBe(4);
  });

  it('discards too-short lines and ignores a fifth line', () => {
    const s = session();
    draw(s, 100, 100, 100 + MIN_LINE_LENGTH_PX - 1, 100);
    expect(s.lineCount).toBe(0);
    expect(s.step).toBe(1);
    draw(s, 100, 100, 100 + MIN_LINE_LENGTH_PX + 1, 100);
    expect(s.lineCount).toBe(1);
    draw(s, 100, 200, 700, 200);
    draw(s, 100, 300, 700, 300);
    draw(s, 100, 400, 700, 400);
    expect(s.step).toBe('done');
    draw(s, 300, 50, 300, 550);   // starts away from any handle
    expect(s.lineCount).toBe(4);
  });

  it('reports drawing state while the pointer is down', () => {
    const s = session();
    s.pointerDown(100, 100);
    expect(s.isDrawing).toBe(true);
    expect(s.linesForDisplay()).toHaveLength(1);
    expect(s.linesForDisplay()[0].committed).toBe(false);
    s.pointerMove(400, 100);
    s.pointerUp();
    expect(s.isDrawing).toBe(false);
    expect(s.linesForDisplay()[0].committed).toBe(true);
  });

  it('instruction counts the line being drawn (v1), step only committed lines', () => {
    const s = session();
    expect(s.instruction).toContain('0/2');
    s.pointerDown(100, 100);
    expect(s.instruction).toContain('1/2');
    expect(s.instruction).toContain('RED');
    expect(s.step).toBe(1);
    s.pointerUp(400, 100);
    expect(s.instruction).toContain('1/2');
    expect(s.step).toBe(2);
    draw(s, 100, 200, 700, 200);
    expect(s.instruction).toContain('GREEN');
    expect(s.instruction).toContain('0/2');
    // third line in progress → GREEN 1/2 while still on step 3
    s.pointerDown(100, 300);
    expect(s.instruction).toContain('GREEN');
    expect(s.instruction).toContain('1/2');
    expect(s.step).toBe(3);
    s.pointerUp(700, 300);
    s.pointerDown(100, 400);
    expect(s.instruction).toContain('Solve');
    s.pointerUp(700, 400);
    expect(s.step).toBe('done');
  });

  it('editing the lines clears a previous solve error', () => {
    const s = session();
    s.solve();
    expect(s.lastError).toBeTruthy();
    s.pointerDown(100, 100);                 // starting a new line
    expect(s.lastError).toBeNull();
    s.pointerUp(700, 100);
    s.solve();
    expect(s.lastError).toBeTruthy();
    s.pointerDown(700, 100);                 // grabbing a handle
    expect(s.lastError).toBeNull();
    s.pointerUp(650, 120);
    s.solve();
    expect(s.lastError).toBeTruthy();
    s.undoLine();
    expect(s.lastError).toBeNull();
  });

  it('undoLine steps back and reset clears everything', () => {
    const s = session();
    draw(s, 100, 100, 700, 120);
    draw(s, 100, 500, 700, 480);
    expect(s.step).toBe(3);
    s.undoLine();
    expect(s.step).toBe(2);
    expect(s.lineCount).toBe(1);
    s.reset();
    expect(s.step).toBe(1);
    expect(s.lineCount).toBe(0);
  });
});

describe('handles', () => {
  it('handleAt finds endpoints in view px within 8 px', () => {
    const s = session();
    draw(s, 100, 100, 700, 120);
    expect(s.handleAt({ x: 103, y: 104 })).toEqual({ line: 0, end: 0 });
    expect(s.handleAt({ x: 695, y: 125 })).toEqual({ line: 0, end: 1 });
    expect(s.handleAt({ x: 400, y: 110 })).toBeNull();
    expect(s.handleAt({ x: 120, y: 100 })).toBeNull();
  });

  it('dragging an endpoint moves it without adding a line', () => {
    const s = session();
    draw(s, 100, 100, 700, 120);
    s.pointerDown(702, 118);
    expect(s.isDragging).toBe(true);
    s.pointerMove(650, 200);
    s.pointerUp();
    expect(s.isDragging).toBe(false);
    expect(s.lineCount).toBe(1);
    const v = s.linesInView()[0];
    expect(v.x2).toBeCloseTo(650, 6);
    expect(v.y2).toBeCloseTo(200, 6);
    expect(v.x1).toBeCloseTo(100, 6);
  });

  it('handles still work in the done state (no new lines)', () => {
    const s = session();
    draw(s, 100, 100, 700, 100);
    draw(s, 100, 200, 700, 200);
    draw(s, 100, 300, 700, 300);
    draw(s, 100, 400, 700, 400);
    s.pointerDown(100, 400);
    s.pointerMove(150, 450);
    s.pointerUp();
    expect(s.lineCount).toBe(4);
    expect(s.linesInView()[3].x1).toBeCloseTo(150, 6);
  });
});

describe('resize', () => {
  it('keeps normalised lines and re-fits the view', () => {
    const s = session();
    draw(s, 100, 100, 700, 120);
    const before = { ...s.lines[0] };
    s.resize(1600, 1200);
    expect(s.lines[0]).toEqual(before);
    expect(s.fit).toEqual(coverFit(PW, PH, 1600, 1200));
    const v = s.linesInView()[0];
    expect(v.x1).toBeCloseTo(200, 6);
    expect(v.y1).toBeCloseTo(200, 6);
  });
});

describe('solve / toCalibration', () => {
  /** A synthetic one-point-ish photo: width lines converge far right, depth lines converge below centre. */
  function fourLines(s: CalibrationSession): void {
    // width pair (red): nearly horizontal, meeting far to the right
    draw(s, 100, 250, 700, 280);
    draw(s, 100, 350, 700, 320);
    // depth pair (green): converge toward a point below the view centre
    draw(s, 100, 100, 350, 500);
    draw(s, 700, 100, 450, 500);
  }

  it('refuses to solve before four lines', () => {
    const s = session();
    const r = s.solve();
    expect(r.ok).toBe(false);
    expect(s.lastError).toBeTruthy();
  });

  it('solves and produces a calibration record with the normalised lines', () => {
    const s = session();
    fourLines(s);
    const r = s.solve(40);
    expect(r.fovDeg).toBeGreaterThanOrEqual(8);
    expect(r.fovDeg).toBeLessThanOrEqual(110);
    const c = s.toCalibration(r, { locked: true, showGrid: true })!;
    expect(c.widthLines).toHaveLength(2);
    expect(c.depthLines).toHaveLength(2);
    expect(c.locked).toBe(true);
    expect(c.showGrid).toBe(true);
    expect(c.solved?.fovDeg).toBe(r.fovDeg);
    expect(c.solved?.quaternion).toEqual(r.quaternion);
    // normalised, independent copies
    expect(c.widthLines[0]).not.toBe(s.lines[0]);
    expect(c.widthLines[0]).toEqual(s.lines[0]);
  });

  it('toCalibration is null before four lines', () => {
    const s = session();
    draw(s, 100, 100, 700, 100);
    expect(s.toCalibration()).toBeNull();
  });
});

describe('camera measurements', () => {
  /** A view pitched 15° upward (camera on the floor looking up at a stage). */
  function pitchedQuaternion(): [number, number, number, number] {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(15 * Math.PI / 180, 0, 0));
    return [q.x, q.y, q.z, q.w];
  }

  it('cameraFromMeasurements pins the height and horizontal distance exactly', () => {
    const solve = solveFromQuaternion(pitchedQuaternion(), 40, VH);
    expect(solve.forward[1]).toBeGreaterThan(0);   // looking upward
    const r = cameraFromMeasurements(solve, 60, 300, [0, 90, 320]);
    expect(r.position[1]).toBe(60);
    expect(Math.hypot(r.position[0], r.position[2])).toBeCloseTo(300, 9);
    // target lies along the solved forward from the position
    const len = Math.hypot(300, 60);
    expect(r.target[0]).toBeCloseTo(r.position[0] + solve.forward[0] * len, 9);
    expect(r.target[1]).toBeCloseTo(r.position[1] + solve.forward[1] * len, 9);
    expect(r.target[2]).toBeCloseTo(r.position[2] + solve.forward[2] * len, 9);
  });

  /**
   * Minimal stand-in for `Engine` + `CameraRig`: a real PerspectiveCamera and orbit target, no
   * OrbitControls (so nothing clamps), recording the environment patches.
   */
  function fakeEngine(calibration: PerspectiveCalibration | null) {
    const persp = new THREE.PerspectiveCamera(40, VW / VH, 1, 60000);
    persp.position.set(0, 90, 320);
    const controls = { target: new THREE.Vector3(0, 45, 0), update: () => { throw new Error('controls.update() must not run while applying a calibrated pose'); } };
    const events: string[] = [];
    const rig = {
      persp,
      controls,
      target: new THREE.Vector3(0, 45, 0),
      projection: 'perspective' as 'perspective' | 'orthographic',
      flyMode: false,
      locked: true,
      userMoved: false,
      get fov() { return persp.fov; },
      setProjection(p: 'perspective' | 'orthographic') { this.projection = p; },
      setFlyMode(on: boolean) { this.flyMode = on; },
      setFov(f: number) { persp.fov = f; persp.updateProjectionMatrix(); },
      setLocked(l: boolean) { this.locked = l; },
      distanceToTarget() { return persp.position.distanceTo(controls.target); },
      emit(name: string) { events.push(name); },
    };
    let env: Environment = { backdrop: { photo: 'blob:photo', calibration } } as unknown as Environment;
    const patches: string[] = [];
    const engine = {
      camera: rig,
      get doc() { return { environment: env }; },
      patchEnvironment(fn: (e: Environment) => Environment, label: string) { env = fn(env); patches.push(label); },
      invalidate() { /* noop */ },
      toast() { /* noop */ },
    };
    return { engine: engine as unknown as Engine, rig, persp, events, patches, env: () => env };
  }

  it('setPose writes position, target and quaternion directly (no controls.update)', () => {
    const { rig } = fakeEngine(null);
    rig.projection = 'orthographic';
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.3, 0));
    setPose(rig as unknown as Parameters<typeof setPose>[0], new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6), q);
    expect(rig.projection).toBe('perspective');
    expect(rig.persp.position.toArray()).toEqual([1, 2, 3]);
    expect(rig.controls.target.toArray()).toEqual([4, 5, 6]);
    expect(rig.target.toArray()).toEqual([4, 5, 6]);
    expect(rig.persp.quaternion.angleTo(q)).toBeLessThan(1e-6);
    expect(rig.userMoved).toBe(true);
  });

  it('applyMeasurements honours the entered height / distance for an upward-pitched solve', () => {
    const q = pitchedQuaternion();
    const calib: PerspectiveCalibration = {
      widthLines: [{ x1: 0, y1: 0, x2: 1, y2: 0 }, { x1: 0, y1: 1, x2: 1, y2: 1 }],
      depthLines: [{ x1: 0, y1: 0, x2: 0, y2: 1 }, { x1: 1, y1: 0, x2: 1, y2: 1 }],
      solved: { quaternion: q, fovDeg: 40 }, locked: true, showGrid: true,
    };
    const { engine, persp, rig, patches, env } = fakeEngine(calib);
    const s = session();
    s.applyMeasurements(engine, 60, 300);
    expect(persp.position.y).toBe(60);
    expect(Math.hypot(persp.position.x, persp.position.z)).toBeCloseTo(300, 9);
    // orientation is the solved one, not a lookAt re-derivation
    expect(persp.quaternion.angleTo(new THREE.Quaternion(...q))).toBeLessThan(1e-9);
    // orbit target sits on the solved forward ray (above the camera for an upward pitch)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(persp.quaternion);
    const toTarget = rig.controls.target.clone().sub(persp.position).normalize();
    expect(toTarget.angleTo(fwd)).toBeLessThan(1e-9);
    expect(rig.controls.target.y).toBeGreaterThan(persp.position.y);
    expect(rig.target.equals(rig.controls.target)).toBe(true);
    // measurements persisted
    expect(patches).toContain('Set camera measurements');
    expect(env().backdrop.calibration?.cameraHeightIn).toBe(60);
    expect(env().backdrop.calibration?.cameraDistanceIn).toBe(300);
  });
});
