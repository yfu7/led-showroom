/**
 * Transform tool: a three.js TransformControls gizmo (translate / rotate / scale) driven through
 * the command system. Register the class three times — ids 'move', 'rotate' and 'scale' — each
 * instance owns one gizmo mode; W / E / R hop between them, X toggles world/local space, Escape
 * returns to the Select tool.
 *
 * The gizmo never drives entity roots directly. It is attached to an invisible pivot proxy placed
 * at the primary selection's origin (or the selection's bounds centre, see {@link setPivot}); the
 * proxy's delta (position, rotation about the pivot, scale ratio) is propagated to every selected
 * entity — v1 applyGizmoDelta (index.html 9230-9296) — and written with one merged command per
 * gesture (mergeKey 'gizmo', history.commit() on mouse up). Because the document stays the single
 * source of truth, undo / inspector edits / external changes simply re-sync the proxy.
 *
 * While the pointer is not over a gizmo handle the tool behaves exactly like the Select tool
 * (click / hover / drag-move / marquee / hotkeys / middle-drag tumble / Alt+wheel scale) through
 * an internal SelectTool delegate.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Engine } from '../Engine';
import type { PointerInfo, Tool, ToolId } from './Tool';
import { LAYER_GIZMO } from '../scene/Renderer';
import { cmdUpdateEntities } from '../commands/entity';
import type { Entity, Transform } from '../document/types';
import { SelectTool } from './SelectTool';
import { MAX_SCALE, MIN_SCALE, isResting, preferBaseRotation, restOnSupport, roundTransform, stageSupports, topLevelIds, transformEquals, type Support } from './snapping';
import { hiddenEntityIds } from './BoxSelect';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformToolId = Extract<ToolId, 'move' | 'rotate' | 'scale'>;
export type PivotMode = 'origin' | 'center';
export type GizmoSpace = 'world' | 'local';

const MODE_BY_ID: Record<TransformToolId, TransformMode> = { move: 'translate', rotate: 'rotate', scale: 'scale' };
const ID_BY_MODE: Record<TransformMode, TransformToolId> = { translate: 'move', rotate: 'rotate', scale: 'scale' };
const GIZMO_SIZE = 0.85;

interface GestureItem {
  id: string;
  /** Document transform when the gesture started. */
  base: Transform;
  /** World matrix of the entity root at gesture start (decomposed). */
  wp: THREE.Vector3;
  wq: THREE.Quaternion;
  ws: THREE.Vector3;
  /** Inverse of the root parent's world matrix (world → local). */
  parentInv: THREE.Matrix4;
  /** Footprint bounds relative to the entity position (empty when unknown). */
  footRel: THREE.Box3;
}

interface Gesture {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  items: GestureItem[];
  stages: Support[];
  label: string;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

export class TransformTool implements Tool {
  readonly id: TransformToolId;
  readonly hint: string;
  cursor = '';

  private engine: Engine;
  private mode: TransformMode;
  private tc: TransformControls | null = null;
  /** Invisible pivot the gizmo is attached to; the selection follows its delta. */
  private readonly proxy = new THREE.Object3D();
  private inner: SelectTool;
  private gesture: Gesture | null = null;
  private pivot: PivotMode = 'origin';
  private spaceMode: GizmoSpace = 'world';
  private ctrlHeld = false;
  private pressOnGizmo = false;
  private clickOnGizmo = false;
  private active = false;
  private offs: (() => void)[] = [];

  constructor(engine: Engine, id: TransformToolId) {
    this.engine = engine;
    this.id = id;
    this.mode = MODE_BY_ID[id];
    this.hint = `${id === 'move' ? 'Move' : id === 'rotate' ? 'Rotate' : 'Scale'} gizmo: drag handles · W/E/R: move/rotate/scale · X: world/local · Ctrl: invert snap · Middle-drag a selected object: tumble · Alt+wheel: scale · Esc: select tool · click / drag objects as in Select`;
    this.inner = new SelectTool(engine);
    this.proxy.name = 'gizmo-pivot';
    this.proxy.userData.helper = true;
    this.proxy.userData.unpickable = true;
  }

  /* ───────────── public API ───────────── */

  get transformMode(): TransformMode { return this.mode; }
  get space(): GizmoSpace { return this.spaceMode; }
  get pivotMode(): PivotMode { return this.pivot; }
  /** True while a handle is being dragged. */
  get dragging(): boolean { return this.tc?.dragging ?? false; }

  /** Change this instance's gizmo mode in place (the tool id stays; prefer activating 'move'/'rotate'/'scale'). */
  setMode(mode: TransformMode): void {
    this.mode = mode;
    this.tc?.setMode(mode);
    this.engine.invalidate();
  }

  /** Gizmo axes: world or the primary selection's local frame. */
  setSpace(space: GizmoSpace): void {
    this.spaceMode = space;
    this.tc?.setSpace(space);
    this.engine.invalidate();
  }
  toggleSpace(): void {
    this.setSpace(this.spaceMode === 'world' ? 'local' : 'world');
    this.engine.toast('info', `Gizmo: ${this.spaceMode} space`);
  }

  /** Where the gizmo sits and what rotation / scale pivot around: the entity origin (on the floor) or the selection centre. */
  setPivot(mode: PivotMode): void {
    this.pivot = mode;
    this.syncTarget();
  }

  /* ───────────── lifecycle ───────────── */

  private ensureControls(): TransformControls {
    if (this.tc) return this.tc;
    const e = this.engine;
    const tc = new TransformControls(e.camera.camera, e.renderer.inputEl);
    tc.setSize(GIZMO_SIZE);
    tc.setMode(this.mode);
    tc.setSpace(this.spaceMode);
    tc.enabled = false;
    const helper = tc.getHelper();
    helper.traverse(o => {
      o.layers.set(LAYER_GIZMO);
      o.userData.helper = true;
      o.userData.unpickable = true;
    });
    // the shared picking raycaster only sees layer 0 by default
    tc.getRaycaster().layers.enableAll();
    tc.addEventListener('change', this.onChange);
    tc.addEventListener('mouseDown', this.onMouseDown);
    tc.addEventListener('objectChange', this.onObjectChange);
    tc.addEventListener('mouseUp', this.onMouseUp);
    tc.addEventListener('dragging-changed', this.onDraggingChanged);
    this.tc = tc;
    return tc;
  }

  onActivate(): void {
    this.active = true;
    const e = this.engine;
    const tc = this.ensureControls();
    tc.camera = e.camera.camera;
    tc.enabled = true;
    e.scene.scene.add(this.proxy);
    e.scene.scene.add(tc.getHelper());
    this.offs.push(
      e.on('selection', () => this.syncTarget()),
      e.on('document', () => { this.updateSnap(); this.syncTarget(); }),
      e.camera.on('projection', () => { if (this.tc) this.tc.camera = e.camera.camera; e.invalidate(); }),
    );
    const onBlur = () => { this.ctrlHeld = false; this.updateSnap(); };
    window.addEventListener('blur', onBlur);
    this.offs.push(() => window.removeEventListener('blur', onBlur));
    this.updateSnap();
    this.syncTarget();
    this.inner.onActivate();
  }

  onDeactivate(): void {
    this.active = false;
    const tc = this.tc;
    if (tc) {
      // Finish a handle drag through TransformControls itself: its own DOM pointerup is ignored
      // once `enabled` is false, so `dragging` would otherwise stay true for the session and
      // syncTarget would never re-attach the gizmo. pointerUp(null) dispatches mouseUp (→ endGesture).
      if (tc.dragging) tc.pointerUp(null);
      if (this.gesture) this.endGesture();
      tc.detach();
      tc.enabled = false;
      tc.getHelper().removeFromParent();
    }
    this.proxy.removeFromParent();
    for (const off of this.offs) off();
    this.offs = [];
    this.gesture = null;
    this.pressOnGizmo = this.clickOnGizmo = false;
    this.ctrlHeld = false;
    this.inner.onDeactivate();
    this.engine.camera.setRotateEnabled(true);
    this.engine.camera.setPanEnabled(true);
    this.engine.invalidate();
  }

  dispose(): void {
    if (this.active) this.onDeactivate();
    if (this.tc) {
      this.tc.removeEventListener('change', this.onChange);
      this.tc.removeEventListener('mouseDown', this.onMouseDown);
      this.tc.removeEventListener('objectChange', this.onObjectChange);
      this.tc.removeEventListener('mouseUp', this.onMouseUp);
      this.tc.removeEventListener('dragging-changed', this.onDraggingChanged);
      this.tc.dispose();
      this.tc = null;
    }
    this.inner.dispose();
  }

  /* ───────────── target sync ───────────── */

  /**
   * Movable (unlocked, visible, no selected ancestor) selected entities that have a root in the
   * scene, in selection order. A group selected with its children moves the children itself.
   */
  private targets(): Entity[] {
    const e = this.engine;
    const hidden = hiddenEntityIds(e.doc.entities);
    const movable = e.selectedEntities().filter(x => !x.locked && !hidden.has(x.id) && !!e.scene.rootOf(x.id));
    const top = new Set(topLevelIds(e.doc.entities, movable.map(x => x.id)));
    return movable.filter(x => top.has(x.id));
  }

  /** Place the proxy on the last movable selected entity and (re)attach the gizmo; hide it when nothing movable is selected. */
  private syncTarget(): void {
    const tc = this.tc;
    if (!tc || !this.active || tc.dragging) return;
    const e = this.engine;
    const targets = this.targets();
    const primary = targets[targets.length - 1];
    const root = primary ? e.scene.rootOf(primary.id) : undefined;
    if (!primary || !root) {
      if (tc.object) tc.detach();
      e.invalidate();
      return;
    }
    root.updateWorldMatrix(true, false);
    root.matrixWorld.decompose(_p, _q, _s);
    if (this.pivot === 'center') {
      const b = e.boundsOf(e.selection);
      if (!b.isEmpty()) b.getCenter(_p);
    }
    this.proxy.position.copy(_p);
    this.proxy.quaternion.copy(_q);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld(true);
    if (tc.object !== this.proxy) tc.attach(this.proxy);
    e.invalidate();
  }

  private updateSnap(): void {
    const tc = this.tc;
    if (!tc) return;
    const s = this.engine.doc.settings.snap;
    const on = s.enabled !== this.ctrlHeld; // Ctrl temporarily inverts
    tc.setTranslationSnap(on && s.translateIn > 0 ? s.translateIn : null);
    tc.setRotationSnap(on && s.rotateDeg > 0 ? THREE.MathUtils.degToRad(s.rotateDeg) : null);
    tc.setScaleSnap(on && s.scale > 0 ? s.scale : null);
  }

  /* ───────────── gizmo events ───────────── */

  private onChange = (): void => { this.engine.invalidate(); };

  private onDraggingChanged = (ev: { value: unknown }): void => {
    const dragging = !!ev.value;
    // OrbitControls may already be panning (Shift / Ctrl held, pan-first scheme): hold off both
    this.engine.camera.setRotateEnabled(!dragging);
    this.engine.camera.setPanEnabled(!dragging);
    if (!dragging && this.gesture) this.endGesture();
    this.engine.invalidate();
  };

  private onMouseDown = (): void => { this.beginGesture(); };

  private onMouseUp = (): void => { this.endGesture(); };

  private onObjectChange = (): void => { this.applyGesture(); };

  private beginGesture(): void {
    const e = this.engine;
    const targets = this.targets();
    if (!targets.length) { this.gesture = null; return; }
    const items: GestureItem[] = targets.map(ent => {
      const root = e.scene.rootOf(ent.id)!;
      root.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
      root.matrixWorld.decompose(wp, wq, ws);
      const parentInv = root.parent ? root.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
      const b = e.boundsOf([ent.id]);
      const footRel = new THREE.Box3();
      if (!b.isEmpty()) {
        const p = ent.transform.position;
        footRel.min.set(b.min.x - p[0], b.min.y - p[1], b.min.z - p[2]);
        footRel.max.set(b.max.x - p[0], b.max.y - p[1], b.max.z - p[2]);
      }
      return { id: ent.id, base: structuredCloneTransform(ent.transform), wp, wq, ws, parentInv, footRel };
    });
    const verb = this.mode === 'translate' ? 'Move' : this.mode === 'rotate' ? 'Rotate' : 'Scale';
    this.gesture = {
      pos: this.proxy.position.clone(),
      quat: this.proxy.quaternion.clone(),
      scale: this.proxy.scale.clone(),
      items,
      stages: stageSupports(e.doc.entities, targets.map(t => t.id)),
      label: targets.length === 1 ? `${verb} ${targets[0].name}` : `${verb} ${targets.length} objects`,
    };
    e.setHover(null);
    e.tools.setCursor('grabbing');
  }

  /** Propagate the proxy's delta since gesture start to every target and write one merged command. */
  private applyGesture(): void {
    const g = this.gesture;
    const tc = this.tc;
    if (!g || !tc) return;
    const e = this.engine;
    const proxy = this.proxy;
    const groundLock = e.doc.settings.snap.groundLock;
    const axis = tc.axis ?? '';
    const axisHasY = axis.includes('Y') || axis === 'XYZ' || axis === 'E' || axis === 'XYZE';

    const dPos = new THREE.Vector3().subVectors(proxy.position, g.pos);
    const dQuat = new THREE.Quaternion().copy(proxy.quaternion).multiply(g.quat.clone().invert());
    const ratio = new THREE.Vector3(
      safeRatio(proxy.scale.x, g.scale.x),
      safeRatio(proxy.scale.y, g.scale.y),
      safeRatio(proxy.scale.z, g.scale.z),
    );
    const pivot = g.pos;
    const pivotQuat = g.quat;
    const pivotQuatInv = g.quat.clone().invert();

    const patches: { id: string; patch: Partial<Entity> }[] = [];
    for (const it of g.items) {
      const wp = it.wp.clone(), wq = it.wq.clone(), ws = it.ws.clone();
      if (this.mode === 'translate') {
        wp.add(dPos);
      } else if (this.mode === 'rotate') {
        wp.sub(pivot).applyQuaternion(dQuat).add(pivot);
        wq.premultiply(dQuat);
      } else {
        // scale about the pivot in the pivot's local frame; each entity scales along its own axes
        const r = wp.clone().sub(pivot).applyQuaternion(pivotQuatInv).multiply(ratio).applyQuaternion(pivotQuat);
        wp.copy(pivot).add(r);
        ws.multiply(ratio);
        ws.x = THREE.MathUtils.clamp(ws.x, MIN_SCALE, MAX_SCALE);
        ws.y = THREE.MathUtils.clamp(ws.y, MIN_SCALE, MAX_SCALE);
        ws.z = THREE.MathUtils.clamp(ws.z, MIN_SCALE, MAX_SCALE);
      }
      // world → local (respects group parents)
      _m.compose(wp, wq, ws).premultiply(it.parentInv).decompose(_p, _q, _s);
      _e.setFromQuaternion(_q, 'YXZ');
      const t: Transform = roundTransform({
        position: [_p.x, _p.y, _p.z],
        rotation: [THREE.MathUtils.radToDeg(_e.x), THREE.MathUtils.radToDeg(_e.y), THREE.MathUtils.radToDeg(_e.z)],
        scale: [_s.x, _s.y, _s.z],
      });
      if (!isFiniteTransform(t)) continue;
      // the Euler decomposition rewrites equivalent angles (270 → -90); keep the user's numbers when nothing turned
      t.rotation = preferBaseRotation(t.rotation, it.base.rotation);
      const patch: Partial<Entity> = { transform: t };
      if (this.mode === 'translate') {
        const pv = new THREE.Vector3(t.position[0], t.position[1], t.position[2]);
        const foot = it.footRel.isEmpty() ? new THREE.Box3().setFromPoints([pv]) : it.footRel.clone().translate(pv);
        const rest = restOnSupport(g.stages, foot, t.position[1]);
        if (groundLock) {
          // X/Z handles keep the object resting on its support; Y handles may lift it but never push it below
          t.position[1] = axisHasY ? Math.max(t.position[1], rest.y) : rest.y;
        }
        patch.attachedTo = isResting(t.position[1], rest.y) ? rest.stageId : null;
      }
      // skip entities the gesture leaves exactly where they are (no-op history entries after Escape / a still handle)
      const cur = e.entity(it.id);
      if (cur && transformEquals(cur.transform, t) && (patch.attachedTo === undefined || (cur.attachedTo ?? null) === patch.attachedTo)) continue;
      patches.push({ id: it.id, patch });
    }
    if (!patches.length) return;
    e.run(cmdUpdateEntities(e, patches, { label: g.label, mergeKey: 'gizmo' }));
  }

  private endGesture(): void {
    if (!this.gesture) return;
    this.gesture = null;
    this.engine.history.commit();
    this.engine.tools.setCursor(null);
    this.syncTarget();
    this.engine.invalidate();
  }

  /* ───────────── pointer (delegate to Select unless a handle is hovered) ───────────── */

  private get gizmoHot(): boolean {
    const tc = this.tc;
    return !!tc && tc.enabled && !!tc.object && (tc.axis !== null || tc.dragging);
  }

  onPointerDown(p: PointerInfo): boolean {
    // refresh the hovered handle from this exact pointer (the gizmo may have appeared under a still pointer)
    const tc = this.tc;
    if (tc && tc.enabled && tc.object && !tc.dragging) tc.pointerHover({ x: p.ndc.x, y: p.ndc.y, button: p.button } as unknown as PointerEvent);
    if (this.gizmoHot) {
      // TransformControls' own pointerdown listener (registered on the same element) starts the drag
      this.pressOnGizmo = this.clickOnGizmo = true;
      this.ctrlHeld = p.ctrl; this.updateSnap();
      return true;
    }
    this.pressOnGizmo = this.clickOnGizmo = false;
    return this.inner.onPointerDown(p);
  }

  onPointerMove(p: PointerInfo): void {
    if (p.ctrl !== this.ctrlHeld) { this.ctrlHeld = p.ctrl; this.updateSnap(); }
    if (this.pressOnGizmo || this.tc?.dragging) { this.engine.invalidate(); return; }
    if (this.gizmoHot && !this.inner.busy) {
      this.engine.setHover(null);
      this.engine.tools.setCursor('pointer');
      this.engine.invalidate();
      return;
    }
    this.inner.onPointerMove(p);
  }

  onPointerUp(p: PointerInfo): void {
    if (this.pressOnGizmo) { this.pressOnGizmo = false; this.engine.invalidate(); return; }
    this.inner.onPointerUp(p);
  }

  onClick(p: PointerInfo): void {
    if (this.clickOnGizmo) { this.clickOnGizmo = false; return; }
    this.inner.onClick(p);
  }

  onDoubleClick(p: PointerInfo): void {
    if (this.gizmoHot) return;
    this.inner.onDoubleClick(p);
  }

  /** Middle-drag tumble and Alt+wheel scale come from the Select delegate; a live handle drag wins. */
  onMiddlePointerDown(p: PointerInfo): boolean {
    if (this.pressOnGizmo || this.tc?.dragging) return false;
    return this.inner.onMiddlePointerDown(p);
  }

  onWheel(ev: WheelEvent): boolean {
    if (this.pressOnGizmo || this.tc?.dragging) return false;
    return this.inner.onWheel(ev);
  }

  /* ───────────── keys ───────────── */

  onKeyDown(e: KeyboardEvent): boolean {
    // the camera rig preventDefaults the keys it owns in walk mode (W / E fly, arrows)
    if (e.defaultPrevented) return false;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'control' || k === 'meta') { if (!this.ctrlHeld) { this.ctrlHeld = true; this.updateSnap(); } return false; }
    // Shift+W / Shift+S belong to the global shortcuts (walk mode, shape paint); walk mode keeps the letters too
    if (!ctrl && !e.altKey && !e.shiftKey && !this.engine.camera.flyMode) {
      if (k === 'w' || k === 'e' || k === 'r' || k === 'x') {
        // never hop modes / spaces mid handle-drag (the gizmo would be torn down under the pointer)
        if (this.tc?.dragging) return true;
        if (k === 'x') { this.toggleSpace(); return true; }
        const target = ID_BY_MODE[k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale'];
        if (target !== this.id) this.engine.tools.activate(target);
        return true;
      }
    }
    if (k === 'escape') {
      if (this.tc?.dragging) {
        // abort the handle drag: reset restores the proxy (objectChange → applyGesture puts the entities
        // back), pointerUp(null) then finishes the drag (mouseUp → endGesture) instead of continuing it
        this.tc.reset();
        this.tc.pointerUp(null);
        return true;
      }
      if (this.inner.busy) { this.inner.cancelGesture(true); return true; }
      this.engine.tools.activate('select');
      return true;
    }
    return this.inner.onKeyDown(e);
  }

  onKeyUp(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === 'control' || k === 'meta') { this.ctrlHeld = false; this.updateSnap(); }
  }

  frame(): boolean {
    return this.inner.frame();
  }
}

/* ───────────── helpers ───────────── */

function structuredCloneTransform(t: Transform): Transform {
  return { position: [...t.position] as Transform['position'], rotation: [...t.rotation] as Transform['rotation'], scale: [...t.scale] as Transform['scale'] };
}

function safeRatio(now: number, start: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(start) || Math.abs(start) < 1e-9) return 1;
  const r = now / start;
  return Number.isFinite(r) && Math.abs(r) > 1e-6 ? Math.abs(r) : 1;
}

function isFiniteTransform(t: Transform): boolean {
  return [...t.position, ...t.rotation, ...t.scale].every(Number.isFinite);
}
