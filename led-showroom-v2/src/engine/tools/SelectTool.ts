/**
 * Select tool: hover, click / Shift / Ctrl selection, double-click focus, drag-move on the ground
 * (or the stage the object rides), Shift-drag vertical, Alt-drag free (camera-facing plane),
 * marquee box selection and the editing hotkeys (Delete, Ctrl+D, arrows, F, Ctrl+A, Escape).
 * Middle-drag over a selected object tumbles the selection in place and Alt+wheel scales it
 * (v1 Move mode, F70).
 *
 * v1 reference: Move mode (index.html 7690-7952) dragged on a camera-facing plane; v2 defaults
 * to the floor plane so objects slide on the ground, with ground-lock keeping them resting on
 * stages / the floor (entity.attachedTo tracks the stage). When the pointer ray only grazes the
 * floor plane (eye-level views, grabbing above the horizon) the drag falls back to a vertical
 * camera-facing plane with the height locked, so objects never freeze or fly to the horizon.
 *
 * Moves are computed in WORLD space and written back through each entity's parent frame, so a
 * child of a group follows the pointer exactly and a group selected together with its children
 * moves the children once (see `topLevelIds`).
 *
 * All edits go through engine.run(...) with a per-drag mergeKey and engine.history.commit() on
 * pointer up, so one Ctrl+Z reverts a whole gesture; Escape mid-drag restores the start pose.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { PointerInfo, Tool, ToolId } from './Tool';
import { cameraFacingPlane, rayFromNdc, verticalPlane, type Hit } from '../scene/Picking';
import { cmdAddEntities, cmdUpdateEntities } from '../commands/entity';
import { isLedWall, type Document, type Entity, type Transform } from '../document/types';
import { parentMatrix, worldMatrix } from '../behaviours';
import { cloneEntities, collectEntities, PASTE_STEP_IN } from '../clipboard';
import { cloneJson, type Vec3 } from '../math';
import { BoxSelect, entitiesInRect, hiddenEntityIds } from './BoxSelect';
import {
  FLOOR_PLANE_MIN_SLOPE, FLOOR_PLANE_RESTORE_SLOPE, clampDelta, dragDeltaCap, floorPlaneUsable, isResting, mergeKeyFor, restOnSupport,
  roundTransform, snapDeltaAbsolute, stageSupports, topLevelIds, type Support,
} from './snapping';
import { scaleByFactor, tumbleRotation, wheelScaleFactor } from './tumble';

/** How the drag plane is chosen. */
export type DragMode = 'floor' | 'vertical' | 'free';
/** The plane actually in use: 'side' is the vertical camera-facing fallback of 'floor' (and the plane of 'vertical'). */
type PlaneKind = 'floor' | 'side' | 'facing';

export interface SelectToolOptions {
  /** Start a marquee when dragging from empty space even without Shift (default false: camera orbits). */
  boxSelectOnEmptyDrag: boolean;
  /** Pixels the pointer must travel before a press becomes a drag. */
  dragThresholdPx: number;
}

interface Press {
  pointerId: number;
  x: number;
  y: number;
  id: string | null;
  hit: Hit | null;
  wasSelected: boolean;
  locked: boolean;
  shift: boolean;
  ctrl: boolean;
  boxSelect: boolean;
}

interface DragItem {
  id: string;
  /** Document (local) transform at the current anchor. */
  base: Transform;
  /** World position of the entity origin at the anchor. */
  worldPos: THREE.Vector3;
  /** World → parent-local (identity for top-level entities). */
  parentInv: THREE.Matrix4;
  hasParent: boolean;
  /** World footprint bounds relative to `worldPos` (empty when unknown). */
  footRel: THREE.Box3;
}

interface DragState {
  pointerId: number;
  mode: DragMode;
  planeKind: PlaneKind;
  plane: THREE.Plane;
  /** Plane intersection at the anchor. */
  startHit: THREE.Vector3;
  /** World point under the pointer at the anchor (moves with the objects). */
  grab: THREE.Vector3;
  /** Delta applied since the anchor. */
  lastDelta: THREE.Vector3;
  items: DragItem[];
  /** The pressed entity: its absolute position is what snaps to the grid. */
  primaryId: string;
  stages: Support[];
  label: string;
  /** Document state when the gesture started (restored by Escape). */
  origin: { id: string; transform: Transform; attachedTo: string | null }[];
  /** True once a command has been run for this gesture. */
  ran: boolean;
}

/** Middle-drag tumble (v1 F70): every target turns about its own origin, positions untouched. */
interface TumbleState {
  pointerId: number;
  /** Pointer position at the anchor (CSS px). */
  x: number;
  y: number;
  items: { id: string; base: Transform }[];
  label: string;
  ran: boolean;
}

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/**
 * Deep-clone `ids` (plus the descendants of any group among them) with fresh ids, unique names
 * and an offset. Parent / attachedTo links between cloned entities are remapped to the clones.
 * Pure: returns the clones without touching `doc`.
 *
 * The cloning itself lives in `engine/clipboard.ts` so duplicate and paste behave identically.
 */
export function duplicateEntities(doc: Document, ids: Iterable<string>, offset: Vec3 = [PASTE_STEP_IN, 0, 0]): { clones: Entity[]; idMap: Map<string, string> } {
  return cloneEntities(doc, collectEntities(doc, ids), offset);
}

export class SelectTool implements Tool {
  readonly id: ToolId = 'select';
  readonly hint = 'Click: select · Shift: add · Ctrl: toggle · Drag: move on floor (Shift: vertical, Alt: free) · Middle-drag a selected object: tumble · Alt+wheel: scale · Shift+drag empty: box select · Double-click: focus · Del · Ctrl+D · Arrows: nudge';
  cursor = '';
  options: SelectToolOptions;

  private engine: Engine;
  private press: Press | null = null;
  private lastPress: Press | null = null;
  private drag: DragState | null = null;
  private tumble: TumbleState | null = null;
  /** Last time the wheel-scale warning was shown (ms), so a scroll burst warns once. */
  private lastScaleWarn = 0;
  private marquee: BoxSelect | null = null;
  private marqueeShift = false;
  private hoverNdc = new THREE.Vector2();
  private hoverDirty = false;
  private active = false;
  /** Pointer id of the press this tool claimed (camera pan + rotate are held off until it ends). */
  private claimedPointer: number | null = null;

  constructor(engine: Engine, options: Partial<SelectToolOptions> = {}) {
    this.engine = engine;
    this.options = { boxSelectOnEmptyDrag: false, dragThresholdPx: 4, ...options };
  }

  /* ───────────── lifecycle ───────────── */

  onActivate(): void {
    this.active = true;
    this.press = this.lastPress = null;
    this.hoverDirty = false;
    window.addEventListener('blur', this.onBlur);
  }

  onDeactivate(): void {
    this.active = false;
    window.removeEventListener('blur', this.onBlur);
    this.cancelGesture();
    this.engine.setHover(null);
    this.engine.tools.setCursor(null);
  }

  dispose(): void {
    this.onDeactivate();
    this.marquee?.dispose();
    this.marquee = null;
  }

  /** True while a drag-move, tumble or marquee is in progress. */
  get busy(): boolean { return this.drag !== null || this.tumble !== null || (this.marquee?.active ?? false); }

  private onBlur = (): void => { this.cancelGesture(); };

  /**
   * Finish any gesture without waiting for pointer up (blur, tool switch). With `revert` (Escape)
   * a drag-move puts the objects back where the gesture started instead of keeping the move.
   */
  cancelGesture(revert = false): void {
    if (this.drag) {
      if (revert) this.revertDrag();
      this.endDrag();
    }
    if (this.tumble) {
      if (revert) this.revertTumble();
      this.endTumble();
    }
    if (this.marquee?.active) this.marquee.end();
    this.press = this.lastPress = null;
    this.releaseClaim();
    this.updateCursor(null);
  }

  /* ───────────── camera claim ───────────── */

  /**
   * ToolManager only suppresses camera *rotate* for a claimed press; OrbitControls' own listener
   * runs first and may already be panning (Shift / Ctrl in the orbit scheme, every left press in
   * the pan scheme), so pan is switched off here too and restored when the press ends.
   */
  private claim(pointerId: number): void {
    this.claimedPointer = pointerId;
    this.engine.camera.setPanEnabled(false);
  }

  private releaseClaim(): void {
    if (this.claimedPointer === null) return;
    this.claimedPointer = null;
    this.engine.camera.setPanEnabled(true);
  }

  /* ───────────── picking ───────────── */

  /** Entity under `ndc`, ignoring hidden entities (three's raycaster does not honour `visible`). */
  private pick(ndc: THREE.Vector2): Hit | null {
    return this.engine.pickAt(ndc);
  }

  /* ───────────── pointer ───────────── */

  onPointerDown(p: PointerInfo): boolean {
    const e = this.engine;
    if (this.tumble) this.endTumble(); // a left press during a middle-drag closes the tumble
    const hit = this.pick(p.ndc);
    if (hit) {
      const ent = e.entity(hit.entityId);
      if (!ent) return false;
      const wasSelected = e.isSelected(ent.id);
      if (!wasSelected) e.select([ent.id], p.shift || p.ctrl ? 'add' : 'replace');
      const press: Press = { pointerId: p.event.pointerId, x: p.x, y: p.y, id: ent.id, hit, wasSelected, locked: ent.locked, shift: p.shift, ctrl: p.ctrl, boxSelect: false };
      this.lastPress = press;
      // a locked entity can be (de)selected but not dragged: leave the drag to the camera
      if (ent.locked) { this.press = null; return false; }
      this.press = press;
      this.claim(p.event.pointerId);
      return true;
    }
    const boxSelect = p.shift || this.options.boxSelectOnEmptyDrag;
    this.press = this.lastPress = { pointerId: p.event.pointerId, x: p.x, y: p.y, id: null, hit: null, wasSelected: false, locked: false, shift: p.shift, ctrl: p.ctrl, boxSelect };
    if (boxSelect) this.claim(p.event.pointerId);
    return boxSelect;
  }

  onPointerMove(p: PointerInfo): void {
    if (this.tumble) { this.updateTumble(p); return; }
    if (this.drag) { this.updateDrag(p); return; }
    if (this.marquee?.active) { this.marquee.update(p.x, p.y); return; }
    if (this.press && p.dragDistance >= this.options.dragThresholdPx) {
      const pr = this.press;
      this.press = null;
      if (pr.hit && pr.id) {
        this.lastPress = null;
        if (!pr.locked) this.beginDrag(pr, p);
      } else if (pr.boxSelect) {
        this.lastPress = null;
        this.beginMarquee(pr, p);
      }
      return;
    }
    if (this.press) return;
    this.hoverNdc.copy(p.ndc);
    this.hoverDirty = true;
  }

  onPointerUp(p: PointerInfo): void {
    if (this.tumble && this.tumble.pointerId === p.event.pointerId) this.endTumble();
    if (this.drag && this.drag.pointerId === p.event.pointerId) this.endDrag();
    if (this.marquee?.active) this.finishMarquee(p);
    if (this.claimedPointer === p.event.pointerId) this.releaseClaim();
    this.press = null;
    this.hoverNdc.copy(p.ndc);
    this.hoverDirty = true;
  }

  onClick(p: PointerInfo): void {
    const pr = this.lastPress;
    this.lastPress = null;
    if (!pr) return;
    const e = this.engine;
    if (pr.id) {
      if (!pr.wasSelected) return; // selected on pointer down
      if (p.ctrl) e.select([pr.id], 'toggle');
      else if (!p.shift) e.select([pr.id], 'replace');
    } else if (!p.shift && !p.ctrl) {
      e.select([]);
    }
  }

  onDoubleClick(p: PointerInfo): void {
    const e = this.engine;
    const hit = this.pick(p.ndc);
    if (hit) {
      const b = e.boundsOf([hit.entityId]);
      if (!b.isEmpty()) e.camera.focus(b);
    } else {
      e.frameAll();
    }
  }

  /**
   * Alt + wheel scales the selection about each object's own origin — v1 Move-mode wheel scale
   * (F70), used to eyeball a wall against a backdrop photo. Gated behind Alt so a plain wheel
   * still zooms the camera and the gesture can never fire by accident, and free of scale snapping
   * for the same reason v1 was: the whole point is a continuous match. Scaling an LED wall breaks
   * its physical size (panel counts and pitch stay as specified), so the first tick of a burst
   * says so.
   */
  onWheel(ev: WheelEvent): boolean {
    if (!ev.altKey || this.busy) return false;
    const eng = this.engine;
    const targets = this.movableSelection();
    if (!targets.length) return false;
    const factor = wheelScaleFactor(ev.deltaY);
    if (!(factor > 0) || factor === 1) return true;
    const patches = targets.map(t => ({
      id: t.id,
      patch: { transform: roundTransform({ ...cloneJson(t.transform), scale: scaleByFactor(t.transform.scale, factor) }) } as Partial<Entity>,
    }));
    const label = targets.length === 1 ? `Scale ${targets[0].name}` : `Scale ${targets.length} objects`;
    eng.run(cmdUpdateEntities(eng, patches, { label, mergeKey: mergeKeyFor('wheel-scale', targets.map(t => t.id)) }));
    const now = Date.now();
    if (now - this.lastScaleWarn > 4000 && targets.some(isLedWall)) {
      this.lastScaleWarn = now;
      eng.toast('info', 'Scaling changes the real size of a wall; its panel count and pitch stay as specified');
    }
    return true;
  }

  /* ───────────── tumble (middle-drag) ───────────── */

  /**
   * Middle-drag over a selected object tumbles the whole selection in place — v1 Move mode
   * (index.html 7838-7882, F70): horizontal travel yaws, vertical travel pitches, 0.005 rad/px,
   * pitch clamped short of the vertical flip. Each object turns about its own origin, so positions
   * (and anything resting on a stage) stay put.
   *
   * The gesture only fires when the pointer is actually over the selection; middle-drag anywhere
   * else stays with the camera rig, which needs it for pan (orbit scheme) or orbit (pan scheme).
   */
  onMiddlePointerDown(p: PointerInfo): boolean {
    if (this.busy) return false;
    const targets = this.movableSelection();
    if (!targets.length || !this.overSelection(p.ndc)) return false;
    this.tumble = {
      pointerId: p.event.pointerId,
      x: p.x,
      y: p.y,
      items: targets.map(t => ({ id: t.id, base: cloneJson(t.transform) })),
      label: targets.length === 1 ? `Rotate ${targets[0].name}` : `Rotate ${targets.length} objects`,
      ran: false,
    };
    this.engine.setHover(null);
    this.claim(p.event.pointerId);
    this.updateCursor('grabbing');
    return true;
  }

  /** True when the entity under `ndc` is selected, or lives inside a selected group. */
  private overSelection(ndc: THREE.Vector2): boolean {
    const eng = this.engine;
    const hit = this.pick(ndc);
    let cur = hit ? eng.entity(hit.entityId) : undefined;
    for (let guard = 0; cur && guard < 64; guard++) {
      if (eng.isSelected(cur.id)) return true;
      cur = cur.parentId ? eng.entity(cur.parentId) : undefined;
    }
    return false;
  }

  private updateTumble(p: PointerInfo): void {
    const t = this.tumble;
    if (!t) return;
    // the middle-button pointerup can be swallowed (autoscroll, focus loss); v1 watched `buttons` too
    if (p.event.pointerType === 'mouse' && (p.event.buttons & 4) === 0) { this.endTumble(); return; }
    const eng = this.engine;
    const snapCfg = eng.doc.settings.snap;
    const step = snapCfg.enabled !== p.ctrl ? snapCfg.rotateDeg : 0; // Ctrl inverts snapping, as on the gizmo
    const dx = p.x - t.x, dy = p.y - t.y;
    const patches = t.items
      .filter(it => eng.entity(it.id))
      .map(it => ({
        id: it.id,
        patch: { transform: roundTransform({ ...cloneJson(it.base), rotation: tumbleRotation(it.base.rotation, dx, dy, step) }) } as Partial<Entity>,
      }));
    if (!patches.length) return;
    t.ran = true;
    eng.run(cmdUpdateEntities(eng, patches, { label: t.label, mergeKey: `tumble:${t.pointerId}` }));
  }

  /** Put the tumbled objects back at their start orientation (merged into the gesture's entry). */
  private revertTumble(): void {
    const t = this.tumble;
    if (!t || !t.ran) return;
    const eng = this.engine;
    const patches = t.items.filter(it => eng.entity(it.id)).map(it => ({ id: it.id, patch: { transform: cloneJson(it.base) } as Partial<Entity> }));
    if (patches.length) eng.run(cmdUpdateEntities(eng, patches, { label: t.label, mergeKey: `tumble:${t.pointerId}` }));
  }

  private endTumble(): void {
    if (!this.tumble) return;
    this.tumble = null;
    this.engine.history.commit();
    this.updateCursor(null);
    this.hoverDirty = true;
  }

  /** Per-frame: resolve the hover raycast (at most once per frame, never during a gesture). */
  frame(): boolean {
    if (!this.active || !this.hoverDirty) return false;
    this.hoverDirty = false;
    if (this.drag || this.tumble || this.press || this.marquee?.active) return false;
    const e = this.engine;
    const hit = this.pick(this.hoverNdc);
    const id = hit?.entityId ?? null;
    e.setHover(id);
    const ent = e.entity(id);
    this.updateCursor(ent && !ent.locked ? 'grab' : null);
    return false;
  }

  /** Recompute hover on the next frame (call after the scene changes under a still pointer). */
  refreshHover(): void { this.hoverDirty = true; }

  private updateCursor(c: string | null): void {
    if (this.active) this.engine.tools.setCursor(c);
  }

  /* ───────────── drag move ───────────── */

  /** Unlocked, visible selected entities that have no selected ancestor (a group moves its children itself). */
  private movableSelection(): Entity[] {
    const e = this.engine;
    const hidden = hiddenEntityIds(e.doc.entities);
    const movable = e.selectedEntities().filter(x => !x.locked && !hidden.has(x.id));
    const top = new Set(topLevelIds(e.doc.entities, movable.map(x => x.id)));
    return movable.filter(x => top.has(x.id));
  }

  private dragMode(p: PointerInfo): DragMode {
    if (p.alt) return 'free';
    if (p.shift) return 'vertical';
    return this.engine.doc.settings.snap.groundLock ? 'floor' : 'free';
  }

  /**
   * The plane for `mode` through `through`. In floor mode the horizontal plane is replaced by a
   * vertical camera-facing plane when `ray` would only graze it (delta.y is zeroed later, so the
   * object still moves horizontally — along the screen's horizontal direction).
   */
  private planeFor(mode: DragMode, through: THREE.Vector3, ray: THREE.Ray, minSlope = FLOOR_PLANE_MIN_SLOPE): { plane: THREE.Plane; kind: PlaneKind } {
    const cam = this.engine.camera.camera;
    if (mode === 'floor') {
      if (floorPlaneUsable(ray, through.y, minSlope)) return { plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -through.y), kind: 'floor' };
      return { plane: verticalPlane(cam, through, new THREE.Plane()), kind: 'side' };
    }
    if (mode === 'vertical') return { plane: verticalPlane(cam, through, new THREE.Plane()), kind: 'side' };
    return { plane: cameraFacingPlane(cam, through, new THREE.Plane()), kind: 'facing' };
  }

  private ray(ndc: THREE.Vector2): THREE.Ray {
    return rayFromNdc(ndc, this.engine.camera.camera).ray;
  }

  private intersect(ray: THREE.Ray, plane: THREE.Plane, out: THREE.Vector3): THREE.Vector3 | null {
    const r = ray.intersectPlane(plane, out);
    if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z)) return null;
    return r;
  }

  /** Snapshot the entities for a move: world position, parent frame and world footprint. */
  private makeItems(entities: Entity[]): DragItem[] {
    const e = this.engine;
    const byId = new Map(e.doc.entities.map(x => [x.id, x]));
    return entities.map(ent => {
      const worldPos = new THREE.Vector3().setFromMatrixPosition(worldMatrix(ent, byId));
      const hasParent = !!ent.parentId && byId.has(ent.parentId);
      const parentInv = hasParent ? parentMatrix(ent, byId).invert() : new THREE.Matrix4();
      const b = e.scene.bounds([ent.id], _box);
      const rel = new THREE.Box3();
      if (!b.isEmpty()) {
        rel.min.set(b.min.x - worldPos.x, b.min.y - worldPos.y, b.min.z - worldPos.z);
        rel.max.set(b.max.x - worldPos.x, b.max.y - worldPos.y, b.max.z - worldPos.z);
      }
      return { id: ent.id, base: cloneJson(ent.transform), worldPos, parentInv, hasParent, footRel: rel };
    });
  }

  /**
   * Patches that move `items` by a world `delta`. `lock` pins every object to its support (floor
   * / stage top); otherwise `groundLock` only stops it from sinking below the support.
   */
  private movePatches(items: DragItem[], stages: Support[], delta: THREE.Vector3, lock: boolean, groundLock: boolean): { id: string; patch: Partial<Entity> }[] {
    return items.map(it => {
      const wp = it.worldPos.clone().add(delta);
      const foot = it.footRel.isEmpty() ? new THREE.Box3().setFromPoints([wp]) : it.footRel.clone().translate(wp);
      const rest = restOnSupport(stages, foot, wp.y);
      let attachedTo: string | null;
      if (lock) { wp.y = rest.y; attachedTo = rest.stageId; }
      else {
        if (groundLock) wp.y = Math.max(wp.y, rest.y);
        attachedTo = isResting(wp.y, rest.y) ? rest.stageId : null;
      }
      // world → parent local; the matrix round trip leaves float noise, so a child's position is rounded (1e-4")
      const local = it.hasParent ? wp.clone().applyMatrix4(it.parentInv) : wp;
      const position: Vec3 = it.hasParent ? roundTransform({ position: [local.x, local.y, local.z], rotation: [0, 0, 0], scale: [1, 1, 1] }).position : [local.x, local.y, local.z];
      const transform: Transform = { position, rotation: [...it.base.rotation] as Vec3, scale: [...it.base.scale] as Vec3 };
      return { id: it.id, patch: { transform, attachedTo } as Partial<Entity> };
    });
  }

  private beginDrag(pr: Press, p: PointerInfo): void {
    const e = this.engine;
    const targets = this.movableSelection();
    if (!targets.length || !pr.hit) return;
    const mode = this.dragMode(p);
    const grab = pr.hit.point.clone();
    const ray = this.ray(p.ndc);
    const { plane, kind } = this.planeFor(mode, grab, ray);
    const startHit = new THREE.Vector3();
    if (!this.intersect(ray, plane, startHit)) return;
    const items = this.makeItems(targets);
    this.drag = {
      pointerId: pr.pointerId,
      mode,
      planeKind: kind,
      plane,
      startHit,
      grab,
      lastDelta: new THREE.Vector3(),
      items,
      primaryId: items.some(it => it.id === pr.id) ? pr.id! : items[0].id,
      stages: stageSupports(e.doc.entities, targets.map(t => t.id)),
      label: targets.length === 1 ? `Move ${targets[0].name}` : `Move ${targets.length} objects`,
      origin: targets.map(t => ({ id: t.id, transform: cloneJson(t.transform), attachedTo: t.attachedTo ?? null })),
      ran: false,
    };
    e.setHover(null);
    this.updateCursor('grabbing');
    this.updateDrag(p);
  }

  /** Switch plane mid-drag (Shift / Alt pressed or released, floor plane grazed) without a jump. */
  private reanchor(d: DragState, mode: DragMode, p: PointerInfo, minSlope = FLOOR_PLANE_MIN_SLOPE): void {
    const e = this.engine;
    const grab = d.grab.clone().add(d.lastDelta);
    const ray = this.ray(p.ndc);
    const { plane, kind } = this.planeFor(mode, grab, ray, minSlope);
    const startHit = new THREE.Vector3();
    if (!this.intersect(ray, plane, startHit)) return;
    const ents = d.items.map(it => e.entity(it.id)).filter(Boolean) as Entity[];
    d.items = this.makeItems(ents);
    d.mode = mode;
    d.planeKind = kind;
    d.plane = plane;
    d.startHit = startHit;
    d.grab = grab;
    d.lastDelta.set(0, 0, 0);
  }

  private updateDrag(p: PointerInfo): void {
    const d = this.drag;
    if (!d) return;
    const e = this.engine;
    const wanted = this.dragMode(p);
    let ray = this.ray(p.ndc);
    if (wanted !== d.mode) this.reanchor(d, wanted, p);
    else if (d.mode === 'floor') {
      // fall back to the side plane when the ray grazes the floor, return once it is steep again
      if (d.planeKind === 'floor' && !floorPlaneUsable(ray, d.grab.y)) this.reanchor(d, 'floor', p);
      else if (d.planeKind === 'side' && floorPlaneUsable(ray, d.grab.y, FLOOR_PLANE_RESTORE_SLOPE)) this.reanchor(d, 'floor', p, FLOOR_PLANE_RESTORE_SLOPE);
    }
    ray = this.ray(p.ndc);
    const hit = this.intersect(ray, d.plane, _v);
    if (!hit) return; // keep the last valid position
    const camDist = e.camera.camera.position.distanceTo(d.grab);
    const delta = clampDelta(hit.clone().sub(d.startHit), dragDeltaCap(camDist));
    if (d.mode === 'floor') delta.y = 0;
    else if (d.mode === 'vertical') { delta.x = 0; delta.z = 0; }
    const snap = e.doc.settings.snap;
    const primary = d.items.find(it => it.id === d.primaryId) ?? d.items[0];
    const axes: [boolean, boolean, boolean] = d.mode === 'floor' ? [true, false, true] : d.mode === 'vertical' ? [false, true, false] : [true, true, true];
    const snapped = snapDeltaAbsolute([primary.worldPos.x, primary.worldPos.y, primary.worldPos.z], [delta.x, delta.y, delta.z], snap.translateIn, snap.enabled !== p.ctrl, axes);
    delta.set(snapped[0], snapped[1], snapped[2]);
    d.lastDelta.copy(delta);

    const patches = this.movePatches(d.items, d.stages, delta, d.mode === 'floor', snap.groundLock);
    d.ran = true;
    e.run(cmdUpdateEntities(e, patches, { label: d.label, mergeKey: `drag:${d.pointerId}` }));
  }

  /** Put the dragged objects back where the gesture started (merged into the gesture's history entry). */
  private revertDrag(): void {
    const d = this.drag;
    if (!d || !d.ran) return;
    const e = this.engine;
    const patches = d.origin.filter(o => e.entity(o.id)).map(o => ({ id: o.id, patch: { transform: cloneJson(o.transform), attachedTo: o.attachedTo } as Partial<Entity> }));
    if (patches.length) e.run(cmdUpdateEntities(e, patches, { label: d.label, mergeKey: `drag:${d.pointerId}` }));
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.engine.history.commit();
    this.updateCursor(null);
    this.hoverDirty = true;
  }

  /* ───────────── marquee ───────────── */

  private beginMarquee(pr: Press, p: PointerInfo): void {
    if (!this.marquee) this.marquee = new BoxSelect(this.engine.renderer.inputEl);
    this.marqueeShift = pr.shift;
    this.marquee.begin(pr.x, pr.y);
    this.marquee.update(p.x, p.y);
    this.updateCursor('crosshair');
  }

  private finishMarquee(p: PointerInfo): void {
    const rect = this.marquee?.end();
    this.updateCursor(null);
    if (!rect) return;
    const e = this.engine;
    const ids = rect.w < 2 && rect.h < 2 ? [] : entitiesInRect(e, rect, id => !e.entity(id)?.locked);
    if (ids.length) e.select(ids, this.marqueeShift || p.shift ? 'add' : 'replace');
    else if (!this.marqueeShift && !p.shift && !p.ctrl) e.select([]);
  }

  /* ───────────── keys ───────────── */

  onKeyDown(e: KeyboardEvent): boolean {
    // the camera rig preventDefaults the keys it owns in walk mode (WASD / QE / arrows)
    if (e.defaultPrevented) return false;
    const eng = this.engine;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if ((k === 'delete' || k === 'backspace') && !ctrl) {
      if (e.repeat) return true;
      this.deleteSelection();
      return true;
    }
    if (k === 'd' && ctrl) {
      if (!e.repeat) this.duplicateSelection();
      return true;
    }
    if (k === 'a' && ctrl) {
      const hidden = hiddenEntityIds(eng.doc.entities);
      eng.select(eng.doc.entities.filter(x => !x.locked && !hidden.has(x.id)).map(x => x.id));
      return true;
    }
    if (k === 'escape') {
      if (this.busy) { this.cancelGesture(true); return true; }
      if (eng.selection.length) { eng.select([]); return true; }
      return false;
    }
    if (k === 'f' && !ctrl) { eng.frameSelection(); return true; }
    const step = eng.doc.settings.snap.translateIn * (e.shiftKey ? 12 : 1);
    switch (k) {
      case 'arrowleft': this.nudge(-step, 0, 0); return true;
      case 'arrowright': this.nudge(step, 0, 0); return true;
      case 'arrowup': this.nudge(0, 0, -step); return true;
      case 'arrowdown': this.nudge(0, 0, step); return true;
      case 'pageup': this.nudge(0, step, 0); return true;
      case 'pagedown': this.nudge(0, -step, 0); return true;
    }
    return false;
  }

  /** Delete every unlocked selected entity (hidden ones included). */
  deleteSelection(): void {
    const sel = this.engine.selectedEntities();
    const ids = sel.filter(x => !x.locked).map(x => x.id);
    if (!ids.length) { if (sel.length) this.engine.toast('info', 'Selection is locked'); return; }
    this.engine.remove(ids);
  }

  /** Ctrl+D: clone the selection with new ids, offset +12" in X, and select the clones. */
  duplicateSelection(): void {
    const eng = this.engine;
    if (!eng.selection.length) return;
    const { clones, idMap } = duplicateEntities(eng.doc, eng.selection);
    if (!clones.length) return;
    eng.run(cmdAddEntities(eng, clones, clones.length === 1 ? `Duplicate ${clones[0].name}` : `Duplicate ${clones.length} objects`));
    // select the clones of what was selected (children of duplicated groups follow their parent)
    eng.select(eng.selection.map(id => idMap.get(id)).filter(Boolean) as string[]);
    eng.history.commit();
  }

  /**
   * Move the selection by a world offset (arrow keys, inspector buttons). With ground-lock on,
   * X/Z nudges keep objects resting on stages / the floor; Y nudges may lift an object but never
   * push it below its support.
   */
  nudge(dx: number, dy: number, dz: number): void {
    const eng = this.engine;
    const targets = this.movableSelection();
    if (!targets.length) return;
    const groundLock = eng.doc.settings.snap.groundLock;
    const ids = targets.map(t => t.id);
    const stages = stageSupports(eng.doc.entities, ids);
    const patches = this.movePatches(this.makeItems(targets), stages, new THREE.Vector3(dx, dy, dz), groundLock && dy === 0, groundLock);
    const label = targets.length === 1 ? `Nudge ${targets[0].name}` : `Nudge ${targets.length} objects`;
    eng.run(cmdUpdateEntities(eng, patches, { label, mergeKey: mergeKeyFor('nudge', ids) }));
  }
}
