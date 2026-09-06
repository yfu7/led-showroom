/**
 * Camera rig: perspective + orthographic cameras, orbit navigation, fly (walk) mode, named
 * views, framing/focus, smooth transitions, view lock and persistable state.
 *
 * Units: inches. Y up.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Emitter } from '../events';
import { clamp, type Vec3 } from '../math';
import type { ViewState } from '../document/types';
import { CONTEXT_DRAG_PX } from '../tools/Tool';

export type ViewPreset = 'home' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'three-quarter' | 'eye-level';
export type Projection = 'perspective' | 'orthographic';
export type NavigationScheme = 'orbit' | 'pan';

export interface CameraRigEvents extends Record<string, unknown> {
  change: void;
  projection: Projection;
  flyMode: boolean;
  lock: boolean;
}

const EYE_HEIGHT_IN = 66;
/** v1 framed everything at 1.6× the fitting distance; anything tighter crops the wall's edges. */
const FIT_PADDING = 1.6;
const MIN_FOV = 8, MAX_FOV = 110;

interface Tween { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number; onDone?: () => void }

export class CameraRig extends Emitter<CameraRigEvents> {
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly target = new THREE.Vector3(0, 45, 0);

  projection: Projection = 'perspective';
  flyMode = false;
  locked = false;
  autoOrthoOnAxisView = true;
  flySpeedInPerSec = 120;
  scheme: NavigationScheme = 'orbit';

  private el: HTMLElement;
  private aspect = 1;
  private tween: Tween | null = null;
  private keys = new Set<string>();
  private lastFlyLook: { x: number; y: number } | null = null;
  private flyYaw = 0;
  private flyPitch = 0;
  private lastOrthoDistance = 300;
  /** True once the user has moved the camera themselves (v1 "userViewDirty"). */
  userMoved = false;

  constructor(el: HTMLElement, aspect: number) {
    super();
    this.el = el;
    this.aspect = aspect;
    this.persp = new THREE.PerspectiveCamera(40, aspect, 1, 60000);
    this.persp.position.set(140, 90, 320);
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -60000, 60000);
    this.ortho.position.copy(this.persp.position);

    this.controls = new OrbitControls(this.persp, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 6000;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.target.copy(this.target);
    this.applyScheme();
    this.controls.addEventListener('change', () => { this.target.copy(this.controls.target); this.emit('change', undefined); });
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.tween = null;
      if (this.projection === 'orthographic' && this.autoOrthoOnAxisView && this.pendingAxisView) this.setProjection('perspective');
    });
    this.controls.update();

    el.addEventListener('keydown', this.onKey);
    el.addEventListener('keyup', this.onKey);
    el.addEventListener('pointerdown', this.onFlyPointerDown);
    el.addEventListener('pointerdown', this.onRightPointerDown);
    window.addEventListener('pointermove', this.onFlyPointerMove);
    window.addEventListener('pointerup', this.onFlyPointerUp);
    window.addEventListener('blur', this.onWindowBlur);
  }

  /** Keys cannot be released while the window is in the background, so drop them all. */
  private onWindowBlur = (): void => { this.keys.clear(); };

  /** Tears down the transient window listeners of an in-flight right press (see below). */
  private endRightPress: (() => void) | null = null;

  /**
   * The right button both pans (drag) and opens the context menu (click). OrbitControls cannot
   * tell them apart, so a right press always enters its PAN state and fires `start`, which marks
   * the viewpoint as hand-placed. A press that never moves is a menu click, not a camera
   * gesture — its `userMoved` side effect is rolled back here so right-clicking does not
   * silently cancel automatic framing. The pan itself moves nothing with a stationary pointer.
   */
  private onRightPointerDown = (e: PointerEvent): void => {
    if (e.button !== 2) return;
    this.endRightPress?.();
    const start = { x: e.clientX, y: e.clientY, userMoved: this.userMoved };
    let moved = false;
    const onMove = (m: PointerEvent): void => {
      if (Math.hypot(m.clientX - start.x, m.clientY - start.y) > CONTEXT_DRAG_PX) moved = true;
    };
    // Held in a field as well, so dispose() can drop these three even if the press never ends
    // (the rig torn down mid-drag, or a pointerup the browser never delivers).
    const end = (): void => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (this.endRightPress === end) this.endRightPress = null;
    };
    const onUp = (): void => {
      end();
      if (!moved) this.userMoved = start.userMoved;
    };
    this.endRightPress = end;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  /** The camera currently used for rendering and picking. */
  get camera(): THREE.Camera { return this.projection === 'perspective' ? this.persp : this.ortho; }
  get position(): THREE.Vector3 { return this.camera.position; }
  get fov(): number { return this.persp.fov; }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  setFov(fov: number): void {
    this.persp.fov = clamp(fov, MIN_FOV, MAX_FOV);
    this.persp.updateProjectionMatrix();
    this.emit('change', undefined);
  }

  setScheme(scheme: NavigationScheme): void {
    this.scheme = scheme;
    this.applyScheme();
  }

  private applyScheme(): void {
    if (this.scheme === 'orbit') {
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    } else {
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    }
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  /** Tools call this while they own the left button (drag-move, box select). */
  setRotateEnabled(on: boolean): void { this.controls.enableRotate = on && !this.locked; }
  setPanEnabled(on: boolean): void { this.controls.enablePan = on && !this.locked; }
  setZoomEnabled(on: boolean): void { this.controls.enableZoom = on && !this.locked; }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.controls.enabled = !locked;
    this.emit('lock', locked);
  }

  /* ───────── projection ───────── */

  private pendingAxisView = false;

  private updateOrthoFrustum(): void {
    const dist = this.lastOrthoDistance;
    const halfH = dist * Math.tan((this.persp.fov * Math.PI) / 360);
    const halfW = halfH * this.aspect;
    this.ortho.left = -halfW; this.ortho.right = halfW; this.ortho.top = halfH; this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  setProjection(p: Projection): void {
    if (p === this.projection) return;
    this.projection = p;
    if (p === 'orthographic') {
      this.lastOrthoDistance = this.persp.position.distanceTo(this.controls.target);
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
      this.controls.object = this.ortho;
    } else {
      // keep the same view: place the perspective camera where the ortho one is, at the ortho "distance"
      const dir = new THREE.Vector3().subVectors(this.ortho.position, this.controls.target).normalize();
      const dist = this.lastOrthoDistance / this.ortho.zoom;
      this.persp.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.persp.quaternion.copy(this.ortho.quaternion);
      this.controls.object = this.persp;
      this.pendingAxisView = false;
    }
    this.controls.update();
    this.emit('projection', p);
    this.emit('change', undefined);
  }

  toggleProjection(): void { this.setProjection(this.projection === 'perspective' ? 'orthographic' : 'perspective'); }

  /* ───────── framing ───────── */

  /** Distance needed for the perspective camera to fit a box of `w` x `h` (screen-aligned) with padding. */
  fitDistance(w: number, h: number, padding = FIT_PADDING): number {
    const fov = (this.persp.fov * Math.PI) / 180;
    const distH = (h / 2) / Math.tan(fov / 2);
    const distW = (w / 2) / Math.tan(fov / 2) / this.aspect;
    return Math.max(distH, distW, 24) * padding;
  }

  /** Move the camera so `bounds` fills the view, keeping the current viewing direction. */
  frame(bounds: THREE.Box3, animate = true): void {
    if (bounds.isEmpty()) return;
    if (this.projection === 'orthographic' && this.pendingAxisView) this.setProjection('perspective');
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1).normalize();
    // screen-aligned extents: project the box onto the camera's right/up
    const q = this.camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const w = Math.abs(size.x * right.x) + Math.abs(size.y * right.y) + Math.abs(size.z * right.z);
    const h = Math.abs(size.x * up.x) + Math.abs(size.y * up.y) + Math.abs(size.z * up.z);
    const depth = size.length() / 2;
    const dist = this.fitDistance(w, h) + depth;
    const pos = center.clone().addScaledVector(dir, dist);
    this.moveTo(pos, center, animate);
    if (this.projection === 'orthographic') {
      this.lastOrthoDistance = dist;
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    }
  }

  /** Re-target on `bounds` centre without changing distance (F key). */
  focus(bounds: THREE.Box3, animate = true): void {
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    this.moveTo(center.clone().add(offset), center, animate);
  }

  /** Canonical views around `bounds` (all walls / selection / scene). */
  setView(preset: ViewPreset, bounds: THREE.Box3, animate = true): void {
    if (bounds.isEmpty()) bounds = new THREE.Box3(new THREE.Vector3(-60, 0, -10), new THREE.Vector3(60, 96, 10));
    const c = bounds.getCenter(new THREE.Vector3());
    const s = bounds.getSize(new THREE.Vector3());
    const axisDist = (w: number, h: number, depth: number) => this.fitDistance(w, h) + depth / 2;
    let pos: THREE.Vector3;
    let axis = false;
    switch (preset) {
      case 'front': pos = new THREE.Vector3(c.x, c.y, c.z + axisDist(s.x, s.y, s.z)); axis = true; break;
      case 'back': pos = new THREE.Vector3(c.x, c.y, c.z - axisDist(s.x, s.y, s.z)); axis = true; break;
      case 'left': pos = new THREE.Vector3(c.x - axisDist(s.z, s.y, s.x), c.y, c.z); axis = true; break;
      case 'right': pos = new THREE.Vector3(c.x + axisDist(s.z, s.y, s.x), c.y, c.z); axis = true; break;
      case 'top': pos = new THREE.Vector3(c.x, c.y + axisDist(s.x, s.z, s.y), c.z + 0.001); axis = true; break;
      case 'bottom': pos = new THREE.Vector3(c.x, c.y - axisDist(s.x, s.z, s.y), c.z + 0.001); axis = true; break;
      case 'iso': {
        const d = this.fitDistance(Math.hypot(s.x, s.z), s.y) + s.length() / 2;
        pos = c.clone().add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(d));
        break;
      }
      case 'eye-level': {
        const d = this.fitDistance(s.x, s.y) + s.z / 2;
        pos = new THREE.Vector3(c.x, EYE_HEIGHT_IN, c.z + d);
        this.moveTo(pos, new THREE.Vector3(c.x, Math.min(c.y, EYE_HEIGHT_IN + (c.y - EYE_HEIGHT_IN) * 0.5), c.z), animate);
        return;
      }
      case 'three-quarter': {
        const d = this.fitDistance(s.x, s.y) + s.z / 2;
        pos = new THREE.Vector3(c.x + d * 0.55, c.y + d * 0.25, c.z + d * 0.85);
        break;
      }
      case 'home':
      default: {
        const d = this.fitDistance(s.x, s.y) + s.z / 2;
        pos = new THREE.Vector3(c.x + d * 0.35, c.y + d * 0.22, c.z + d * 0.95);
        break;
      }
    }
    if (axis && this.autoOrthoOnAxisView && this.projection === 'perspective') {
      this.moveTo(pos, c, animate, () => { this.setProjection('orthographic'); this.pendingAxisView = true; });
    } else if (axis && this.projection === 'orthographic') {
      // already orthographic (previous axis view): just re-aim
      this.moveTo(pos, c, animate);
      this.lastOrthoDistance = pos.distanceTo(c);
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
      this.pendingAxisView = true;
    } else if (!axis && this.projection === 'orthographic' && this.pendingAxisView) {
      // leaving an auto-ortho axis view for a free view: back to perspective
      this.setProjection('perspective');
      this.moveTo(pos, c, animate);
    } else {
      this.moveTo(pos, c, animate);
      if (this.projection === 'orthographic') {
        this.lastOrthoDistance = pos.distanceTo(c);
        this.ortho.zoom = 1;
        this.updateOrthoFrustum();
      }
    }
  }

  /** Move camera + target, optionally animated. */
  moveTo(position: THREE.Vector3, target: THREE.Vector3, animate = true, onDone?: () => void): void {
    if (!animate) {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.target.copy(target);
      this.controls.update();
      this.emit('change', undefined);
      onDone?.();
      return;
    }
    this.tween = { from: this.camera.position.clone(), to: position.clone(), fromT: this.controls.target.clone(), toT: target.clone(), t: 0, dur: 0.38, onDone };
  }

  /** Place the camera at exactly `dist` inches from `target` along the current direction. */
  setDistance(dist: number, target = this.controls.target.clone()): void {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this.moveTo(target.clone().addScaledVector(dir, clamp(dist, this.controls.minDistance, this.controls.maxDistance)), target, true);
  }

  distanceToTarget(): number { return this.camera.position.distanceTo(this.controls.target); }

  /* ───────── fly / walk mode ───────── */

  setFlyMode(on: boolean): void {
    if (on === this.flyMode) return;
    this.flyMode = on;
    if (on) {
      if (this.projection === 'orthographic') this.setProjection('perspective');
      const dir = new THREE.Vector3().subVectors(this.controls.target, this.persp.position);
      this.flyYaw = Math.atan2(-dir.x, -dir.z);
      this.flyPitch = Math.asin(clamp(dir.y / Math.max(1e-6, dir.length()), -1, 1));
      this.controls.enabled = false;
      this.el.focus();
    } else {
      this.controls.enabled = !this.locked;
      this.controls.update();
    }
    this.emit('flyMode', on);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.flyMode) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      if (e.type === 'keydown') this.keys.add(k); else this.keys.delete(k);
      e.preventDefault();
    }
  };

  private onFlyPointerDown = (e: PointerEvent): void => {
    if (!this.flyMode || e.button !== 0) return;
    this.lastFlyLook = { x: e.clientX, y: e.clientY };
    this.el.setPointerCapture?.(e.pointerId);
  };
  private onFlyPointerMove = (e: PointerEvent): void => {
    if (!this.flyMode || !this.lastFlyLook) return;
    const dx = e.clientX - this.lastFlyLook.x, dy = e.clientY - this.lastFlyLook.y;
    this.lastFlyLook = { x: e.clientX, y: e.clientY };
    this.flyYaw -= dx * 0.0035;
    this.flyPitch = clamp(this.flyPitch - dy * 0.0035, -1.4, 1.4);
    this.applyFlyLook();
  };
  private onFlyPointerUp = (): void => { this.lastFlyLook = null; };

  private applyFlyLook(): void {
    const dir = new THREE.Vector3(-Math.sin(this.flyYaw) * Math.cos(this.flyPitch), Math.sin(this.flyPitch), -Math.cos(this.flyYaw) * Math.cos(this.flyPitch));
    this.controls.target.copy(this.persp.position).addScaledVector(dir, 120);
    this.target.copy(this.controls.target);
    this.persp.lookAt(this.controls.target);
    this.userMoved = true;
    this.emit('change', undefined);
  }

  /** Called once per frame. */
  update(dt: number): boolean {
    let changed = false;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const k = 1 - Math.pow(1 - tw.t, 3);
      this.camera.position.lerpVectors(tw.from, tw.to, k);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, k);
      this.target.copy(this.controls.target);
      if (this.projection === 'orthographic') this.ortho.position.copy(this.camera.position);
      this.camera.lookAt(this.controls.target);
      if (tw.t >= 1) { this.tween = null; tw.onDone?.(); }
      changed = true;
    }
    if (this.flyMode) {
      const speed = this.flySpeedInPerSec * (this.keys.has('shift') ? 3 : 1) * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.flyYaw), 0, -Math.cos(this.flyYaw));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x).negate();
      const move = new THREE.Vector3();
      if (this.keys.has('w') || this.keys.has('arrowup')) move.add(fwd);
      if (this.keys.has('s') || this.keys.has('arrowdown')) move.sub(fwd);
      if (this.keys.has('d') || this.keys.has('arrowright')) move.add(right);
      if (this.keys.has('a') || this.keys.has('arrowleft')) move.sub(right);
      if (this.keys.has('e')) move.y += 1;
      if (this.keys.has('q')) move.y -= 1;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed);
        this.persp.position.add(move);
        this.persp.position.y = Math.max(6, this.persp.position.y);
        this.applyFlyLook();
        changed = true;
      }
    } else if (!this.tween && this.controls.enabled) {
      changed = this.controls.update(dt) || changed;
    }
    return changed;
  }

  /* ───────── state ───────── */

  getState(): ViewState['position'] extends Vec3 ? Pick<ViewState, 'projection' | 'position' | 'target' | 'fov' | 'locked'> : never {
    const p = this.camera.position, t = this.controls.target;
    return { projection: this.projection, position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: this.persp.fov, locked: this.locked };
  }

  setState(s: Partial<Pick<ViewState, 'projection' | 'position' | 'target' | 'fov' | 'locked'>>): void {
    const ok = (v: number[] | undefined) => !!v && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) < 100000);
    if (s.fov !== undefined && Number.isFinite(s.fov)) this.setFov(s.fov);
    if (ok(s.position) && ok(s.target)) {
      const pos = new THREE.Vector3(...(s.position as Vec3));
      const tgt = new THREE.Vector3(...(s.target as Vec3));
      if (pos.distanceTo(tgt) > 1) this.moveTo(pos, tgt, false);
    }
    if (s.projection && s.projection !== this.projection) this.setProjection(s.projection);
    if (s.locked !== undefined) this.setLocked(s.locked);
    this.userMoved = true;
  }

  dispose(): void {
    this.controls.dispose();
    this.el.removeEventListener('keydown', this.onKey);
    this.el.removeEventListener('keyup', this.onKey);
    this.el.removeEventListener('pointerdown', this.onFlyPointerDown);
    this.el.removeEventListener('pointerdown', this.onRightPointerDown);
    window.removeEventListener('pointermove', this.onFlyPointerMove);
    window.removeEventListener('pointerup', this.onFlyPointerUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.endRightPress?.();
  }
}
