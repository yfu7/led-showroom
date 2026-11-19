/**
 * Measure tool (id `measure`) — point-to-point tape measure with snapping.
 *
 * Rebuilt from the v1 measure tool (index.html 9340-9452): click two points on anything in the
 * scene (walls, decks, equipment, rooms or the floor) to create a `DimensionEntity`. v2 adds:
 *  - snapping to an ELEMENT's own box — its corners, edge midpoints, face centres and centre —
 *    as well as to mesh geometry, so the features a build is dimensioned from have a target even
 *    where no vertex sits. Selecting items first makes those items snap from anywhere on screen,
 *    whether or not the pointer is over them: that is how you take a custom distance between two
 *    particular panels or cases in a dense scene.
 *  - a hover snap marker (sphere on LAYER_GIZMO, coloured by snap kind — see `pointSnap.ts`),
 *  - a live preview line + distance label while placing the second point,
 *  - X / Y / Z axis lock while placing the second point (B projected onto the axis through A),
 *  - Shift on the second click keeps the tool active (continuous measuring); otherwise the
 *    previous tool is restored,
 *  - Escape cancels the pending first point, a second Escape leaves the tool.
 *
 * Picking: `pickSurface` over the whole scene (entities + the environment floor), falling back
 * to the y = 0 ground plane when the pointer misses everything. Left-drag is NOT claimed, so the
 * camera still orbits; only a click (< 4 px) places a point.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { PointerInfo, Tool, ToolId } from './Tool';
import { pickGround, pickSurface, rayFromNdc } from '../scene/Picking';
import { LAYER_GIZMO } from '../scene/Renderer';
import { createDimension } from '../document/defaults';
import { DIMENSION_LABEL_BACKGROUND, DIMENSION_TEXT_COLOR, createLabelSprite, updateLabelSpriteScale } from '../ledwall/dimensions';
import { formatLength } from '../units';
import type { Vec3 } from '../math';
import {
  DEFAULT_SNAP_RADIUS_PX, elementBoxFromLocal, projectOntoAxis, resolveHitFace, snapPoint,
  type ElementBox, type SnapKind, type SnapResult,
} from './pointSnap';
import { localMeshBounds } from '../entities/GroupRenderer';
import type { Entity } from '../document/types';

export const MEASURE_HINT_FIRST = 'Click the first point';
export const MEASURE_HINT_SECOND = 'Click the second point · Shift keeps measuring · X/Y/Z lock axis';
/** Appended while something is selected, because those items then snap from anywhere on screen. */
export const MEASURE_HINT_SELECTION = ' · selected items snap from anywhere';

/** Marker colour per snap kind. */
export const SNAP_COLORS: Record<SnapKind, number> = {
  element: 0xf472b6,  // pink
  vertex: 0xf97316,   // orange
  midpoint: 0x22d3ee, // cyan
  grid: 0xa78bfa,     // violet
  floor: 0x34d399,    // green
  surface: 0xeab308,  // v1 yellow
};

const MARKER_RADIUS_IN = 1.4;      // v1 `_measMarkerGeom`
const MARKER_RENDER_ORDER = 1002;  // v1
const LINE_RENDER_ORDER = 1001;    // v1
const LABEL_BASE_HEIGHT_IN = 6;
const LABEL_LIFT_IN = 4;           // v1 lifted the label 4" above the midpoint
const MARKER_REF_DIST_IN = 200;    // same distance compensation as the labels
const MARKER_MIN_SCALE = 0.4;

/**
 * Label canvas styling for in-place redraws. Mirrors the private constants of
 * `createLabelSprite` (ledwall/dimensions.ts: 56 px bold Courier, 20 px padding, 10 px radius)
 * so a redrawn label is pixel-identical to a freshly created one.
 */
const LABEL_FONT = 'bold 56px "Courier New", monospace';
const LABEL_FONT_PX = 56;
const LABEL_PAD_PX = 20;
const LABEL_CORNER_RADIUS_PX = 10;

type Axis = 'x' | 'y' | 'z';

export class MeasureTool implements Tool {
  readonly id: ToolId = 'measure';
  cursor = 'crosshair';
  hint: string = MEASURE_HINT_FIRST;

  private engine: Engine;
  /** First point (world) once placed. */
  private a: THREE.Vector3 | null = null;
  /** Current hover snap (world), or null when the pointer is off-scene. */
  private hover: SnapResult | null = null;
  private axisKeys = new Set<Axis>();
  /**
   * Local-space bounds per entity, keyed by id and held against the entity object the renderer
   * carries — the document is replaced on every edit, so a changed entity is a cache miss. Walking
   * a model's meshes is the only part of gathering snap boxes that is not already cheap, and it
   * would otherwise run on every pointer move. Cleared on activate, which is also the way out if
   * an async load changes geometry under an entity that did not itself change.
   */
  private localBoxes = new Map<string, { entity: Entity; box: THREE.Box3 }>();

  // helpers
  private readonly group = new THREE.Group();
  private readonly markerGeom = new THREE.SphereGeometry(MARKER_RADIUS_IN, 16, 12);
  private readonly hoverMat = new THREE.MeshBasicMaterial({ color: SNAP_COLORS.surface, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  private readonly fixedMat = new THREE.MeshBasicMaterial({ color: SNAP_COLORS.surface, depthTest: false, depthWrite: false });
  private readonly hoverMarker: THREE.Mesh;
  private readonly aMarker: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly lineGeom = new THREE.BufferGeometry();
  private readonly lineMat = new THREE.LineBasicMaterial({ color: SNAP_COLORS.surface, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  private readonly line: THREE.Line;
  private label: THREE.Sprite | null = null;
  private labelText = '';

  constructor(engine: Engine) {
    this.engine = engine;
    this.group.name = 'measure-tool';
    this.group.userData.helper = true;
    this.group.userData.unpickable = true;
    this.group.visible = false;

    this.hoverMarker = this.makeMarker(this.hoverMat, 'measure-hover');
    this.aMarker = this.makeMarker(this.fixedMat, 'measure-a');
    // A thin ring around the hover marker (camera-facing) to make the snap kind readable.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(MARKER_RADIUS_IN * 1.8, MARKER_RADIUS_IN * 2.2, 32),
      new THREE.MeshBasicMaterial({ color: SNAP_COLORS.surface, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    this.tagHelper(this.ring, 'measure-ring');
    this.ring.renderOrder = MARKER_RENDER_ORDER;

    this.lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    this.line = new THREE.Line(this.lineGeom, this.lineMat);
    this.tagHelper(this.line, 'measure-preview');
    this.line.renderOrder = LINE_RENDER_ORDER;
    this.line.frustumCulled = false;

    this.group.add(this.hoverMarker, this.ring, this.aMarker, this.line);
    this.hoverMarker.visible = this.ring.visible = this.aMarker.visible = this.line.visible = false;
  }

  private makeMarker(mat: THREE.Material, name: string): THREE.Mesh {
    const m = new THREE.Mesh(this.markerGeom, mat);
    m.userData.sharedGeometry = true;
    this.tagHelper(m, name);
    m.renderOrder = MARKER_RENDER_ORDER;
    return m;
  }

  private tagHelper(o: THREE.Object3D, name: string): void {
    o.name = name;
    o.userData.helper = true;
    o.userData.unpickable = true;
    o.layers.set(LAYER_GIZMO);
  }

  /* ───────────── lifecycle ───────────── */

  onActivate(): void {
    if (!this.group.parent) this.engine.scene.scene.add(this.group);
    this.group.visible = true;
    this.a = null;
    this.hover = null;
    this.axisKeys.clear();
    // keyup is only delivered to the focused viewport: drop stale locks when focus leaves the window.
    if (typeof window !== 'undefined') window.addEventListener('blur', this.clearAxisKeys);
    this.localBoxes.clear();
    this.setHint(MEASURE_HINT_FIRST);
    this.refreshHelpers();
    this.engine.invalidate();
  }

  onDeactivate(): void {
    this.a = null;
    this.hover = null;
    this.axisKeys.clear();
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.clearAxisKeys);
    this.group.visible = false;
    this.refreshHelpers();
    this.engine.invalidate();
  }

  /** Drop every axis lock (window blur, commit, cancel) and refresh the preview if one was active. */
  private readonly clearAxisKeys = (): void => {
    if (!this.axisKeys.size) return;
    this.axisKeys.clear();
    this.refreshHelpers();
    this.engine.invalidate();
  };

  /** Release GPU resources (the integrator calls this on engine dispose if it keeps the tool). */
  dispose(): void {
    this.group.removeFromParent();
    this.markerGeom.dispose();
    this.hoverMat.dispose();
    this.fixedMat.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.lineGeom.dispose();
    this.lineMat.dispose();
    this.disposeLabel();
  }

  /* ───────────── pointer ───────────── */

  onPointerDown(): boolean { return false; }   // let the camera orbit on drag; clicks place points

  onPointerMove(p: PointerInfo): void {
    this.hover = this.snapAt(p);
    this.refreshHelpers();
    this.engine.invalidate();
  }

  onClick(p: PointerInfo): void {
    if (p.button !== 0) return;
    const snap = this.snapAt(p);
    if (!snap) return;
    this.hover = snap;
    if (!this.a) {
      this.a = snap.point.clone();
      this.setHint(MEASURE_HINT_SECOND);
      this.refreshHelpers();
      this.engine.invalidate();
      return;
    }
    const a = this.a;
    const b = this.secondPoint(snap.point);
    if (a.distanceTo(b) < 1e-3) { this.engine.toast('info', 'Pick two different points'); return; }
    this.a = null;
    const av: Vec3 = [a.x, a.y, a.z];
    const bv: Vec3 = [b.x, b.y, b.z];
    this.engine.add(createDimension(av, bv));
    this.engine.history.commit();
    // A lock is per measurement: never carry it into the next one (continuous mode).
    this.axisKeys.clear();
    if (p.shift) {
      this.setHint(MEASURE_HINT_FIRST);
      this.refreshHelpers();
      this.engine.invalidate();
    } else {
      this.engine.tools.restorePrevious();
    }
  }

  /* ───────────── keys ───────────── */

  onKeyDown(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (this.a) {
        this.a = null;
        this.axisKeys.clear();
        this.setHint(MEASURE_HINT_FIRST);
        this.refreshHelpers();
        this.engine.invalidate();
      } else {
        this.engine.tools.restorePrevious();
      }
      return true;
    }
    if ((k === 'x' || k === 'y' || k === 'z') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Only consume (and remember) the key while the second point is pending; otherwise leave
      // it to the app, and do not record a lock whose keyup may never reach the viewport.
      if (!this.a) return false;
      if (!this.axisKeys.has(k)) { this.axisKeys.add(k); this.refreshHelpers(); this.engine.invalidate(); }
      return true;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if ((k === 'x' || k === 'y' || k === 'z') && this.axisKeys.delete(k)) {
      this.refreshHelpers();
      this.engine.invalidate();
    }
  }

  /** The axis currently locking the second point (last pressed wins), or null. */
  get axisLock(): Axis | null {
    let last: Axis | null = null;
    for (const k of this.axisKeys) last = k;
    return last;
  }

  /* ───────────── per frame ───────────── */

  frame(): boolean {
    if (!this.group.visible) return false;
    const cam = this.engine.camera.camera;
    const camPos = cam.position;
    const scaleFor = (o: THREE.Object3D) => Math.max(MARKER_MIN_SCALE, camPos.distanceTo(o.position) / MARKER_REF_DIST_IN);
    for (const m of [this.hoverMarker, this.aMarker]) if (m.visible) m.scale.setScalar(scaleFor(m));
    if (this.ring.visible) { this.ring.scale.setScalar(scaleFor(this.ring)); this.ring.quaternion.copy(cam.quaternion); }
    if (this.label?.visible) updateLabelSpriteScale(this.label, cam, LABEL_BASE_HEIGHT_IN);
    return false;
  }

  /* ───────────── internals ───────────── */

  private setHint(base: string): void {
    const text = this.engine.selection.length ? base + MEASURE_HINT_SELECTION : base;
    if (this.hint === text) return;
    this.hint = text;
    // No dedicated "hint changed" event: re-emit the tool id so the status bar re-reads `hint`.
    this.engine.emit('tool', this.id);
  }

  private viewport(): { width: number; height: number } {
    const r = this.engine.renderer;
    return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  /** Raycast + snap for a pointer position. */
  private snapAt(p: PointerInfo): SnapResult | null {
    const camera = this.engine.camera.camera;
    const viewport = this.viewport();
    const gridIn = this.engine.doc.environment.grid.minorIn;
    const caster = rayFromNdc(p.ndc, camera);
    // Gathered once and passed down every path: a point a few pixels outside a silhouette corner
    // misses the mesh entirely and lands on the floor, or on nothing at all, and that is precisely
    // where someone is trying to catch the corner.
    const { boxes: elements, points } = this.elementTargets(caster.ray, viewport);
    const hit = pickSurface(p.ndc, camera, this.engine.scene.scene);
    if (hit) {
      const isFloor = hit.object.userData.pickable === 'ground';
      const { face, instanceId } = isFloor ? { face: null, instanceId: null } : resolveHitFace(hit.object, caster);
      return snapPoint({ point: hit.point, object: hit.object, face, instanceId, isFloor }, { camera, viewport, gridIn, elements, points });
    }
    const g = pickGround(p.ndc, camera, 0, new THREE.Vector3());
    if (!g) return null;
    return snapPoint({ point: g, object: null, isFloor: true }, { camera, viewport, gridIn, elements, points });
  }

  /**
   * Snap targets for the elements worth testing against this ray: boxes, and named points.
   *
   * Everything SELECTED is included wherever it is on screen — that is what lets you pick out the
   * two items you want a distance between and then measure them without the scene in front
   * catching the pointer. Everything else has to be near the ray: its world bounds, grown by what
   * the snap radius is worth in inches at that depth, must meet the ray at all.
   */
  private elementTargets(ray: THREE.Ray, viewport: { width: number; height: number }): { boxes: ElementBox[]; points: THREE.Vector3[] } {
    const selected = new Set(this.engine.selection);
    const boxes: ElementBox[] = [];
    const points: THREE.Vector3[] = [];
    const world = new THREE.Box3();
    const centre = new THREE.Vector3();
    for (const r of this.engine.scene.all()) {
      const e = r.entity;
      // A group has no geometry of its own (its children are listed separately), and a dimension is
      // a drawing of a measurement, not a thing in the build to measure to.
      if (e.type === 'group' || e.type === 'dimension' || !r.root.visible) continue;
      if (!selected.has(e.id)) {
        r.bounds(world);
        if (world.isEmpty()) continue;
        world.getCenter(centre);
        world.expandByScalar(this.inchesPerPixel(centre, viewport) * DEFAULT_SNAP_RADIUS_PX);
        if (!ray.intersectsBox(world)) continue;
      }
      // Before the snapBoxes early-out, so a renderer that supplies boxes still contributes points.
      const pts = r.snapPoints?.(this.engine.camera.camera);
      if (pts) points.push(...pts);
      const own = r.snapBoxes?.();
      if (own) { boxes.push(...own); continue; }
      let cached = this.localBoxes.get(e.id);
      if (!cached || cached.entity !== e) {
        cached = { entity: e, box: localMeshBounds(r.root) };
        this.localBoxes.set(e.id, cached);
      }
      const box = elementBoxFromLocal(cached.box, r.root.matrixWorld);
      if (box) boxes.push(box);
    }
    return { boxes, points };
  }

  /** World inches one screen pixel covers at `at`, so a pixel radius can grow a world box. */
  private inchesPerPixel(at: THREE.Vector3, viewport: { width: number; height: number }): number {
    const cam = this.engine.camera.camera;
    const persp = cam as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      const dist = cam.position.distanceTo(at);
      return (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * dist) / viewport.height;
    }
    const ortho = cam as unknown as THREE.OrthographicCamera;
    return (ortho.top - ortho.bottom) / Math.max(1e-6, ortho.zoom) / viewport.height;
  }

  /** Apply the axis lock (if any) to a candidate second point. */
  private secondPoint(raw: THREE.Vector3): THREE.Vector3 {
    const axis = this.axisLock;
    if (!this.a || !axis) return raw.clone();
    return projectOntoAxis(this.a, raw, axis);
  }

  private refreshHelpers(): void {
    const hover = this.hover;
    const showHover = this.group.visible && !!hover;
    this.hoverMarker.visible = this.ring.visible = showHover;
    if (hover) {
      const pt = this.a ? this.secondPoint(hover.point) : hover.point;
      this.hoverMarker.position.copy(pt);
      this.ring.position.copy(pt);
      const color = SNAP_COLORS[hover.kind];
      this.hoverMat.color.setHex(color);
      (this.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    }

    const a = this.a;
    this.aMarker.visible = this.group.visible && !!a;
    if (a) this.aMarker.position.copy(a);

    const showLine = this.group.visible && !!a && !!hover;
    this.line.visible = showLine;
    if (a && hover) {
      const b = this.secondPoint(hover.point);
      const pos = this.lineGeom.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
      this.lineGeom.computeBoundingSphere();
      const text = formatLength(a.distanceTo(b), this.engine.doc.settings.units);
      this.ensureLabel(text);
      this.label!.visible = true;
      this.label!.position.copy(a).add(b).multiplyScalar(0.5);
      this.label!.position.y += LABEL_LIFT_IN;
    } else if (this.label) {
      this.label.visible = false;
    }
  }

  /**
   * Keep ONE label sprite for the life of the tool. The first call creates it via
   * `createLabelSprite`; later calls with a different text redraw the existing canvas in place
   * and flag the texture for re-upload — no new canvas / CanvasTexture / SpriteMaterial per
   * pointer move. Nothing happens when the (rounded) text is unchanged.
   */
  private ensureLabel(text: string): void {
    if (this.label && this.labelText === text) return;
    if (!this.label) {
      const s = createLabelSprite(text, { heightIn: LABEL_BASE_HEIGHT_IN });
      this.tagHelper(s, 'measure-label');
      s.renderOrder = MARKER_RENDER_ORDER;
      this.group.add(s);
      this.label = s;
      this.labelText = text;
      return;
    }
    const sprite = this.label;
    const map = sprite.material.map;
    const canvas = (map?.image ?? null) as HTMLCanvasElement | null;
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (map && canvas && ctx) {
      ctx.font = LABEL_FONT;
      const width = Math.ceil(ctx.measureText(text).width + LABEL_PAD_PX * 2);
      const height = canvas.height;                       // fixed by the font size
      if (canvas.width !== width) canvas.width = width;   // resizing resets the context state
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = DIMENSION_LABEL_BACKGROUND;
      if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(0, 0, width, height, LABEL_CORNER_RADIUS_PX); ctx.fill(); }
      else ctx.fillRect(0, 0, width, height);
      ctx.font = LABEL_FONT;
      ctx.fillStyle = DIMENSION_TEXT_COLOR;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, width / 2, height / 2);
      map.needsUpdate = true;
      sprite.userData.dimAspect = width / Math.max(1, height);
    } else {
      // Map-less fallback (no DOM): keep the aspect proportional to the text like createLabelSprite.
      const w = text.length * LABEL_FONT_PX * 0.6 + LABEL_PAD_PX * 2;
      const h = LABEL_FONT_PX * 1.4 + LABEL_PAD_PX * 2;
      sprite.userData.dimAspect = w / h;
    }
    sprite.userData.label = text;
    updateLabelSpriteScale(sprite, this.engine.camera.camera, LABEL_BASE_HEIGHT_IN);
    this.labelText = text;
  }

  private disposeLabel(): void {
    if (!this.label) return;
    this.label.removeFromParent();
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label = null;
    this.labelText = '';
  }
}
