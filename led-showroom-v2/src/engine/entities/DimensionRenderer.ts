/**
 * Measurement renderer (v1 measure tool, index.html 9340-9452): a tape line between two world
 * points with sphere end markers and a distance label at the midpoint, plus a faint dashed
 * axis-aligned dx/dy/dz breakdown.
 *
 * `a` and `b` are WORLD points. The entity transform is ignored: the root has
 * `matrixAutoUpdate = false` AND `matrixWorldAutoUpdate = false` with identity local/world
 * matrices, so neither the SceneManager's `applyTransform` nor a parent group's transform moves
 * it, and every child is placed in world coordinates.
 *
 * Picking convention: nothing a dimension draws is a pick target (`userData.unpickable` on the
 * markers, the tape line, the breakdown and the label). v1 `measureRaycastPoint` restricted the
 * measure tool to panels / stages / venue planes so a chained measurement lands on the real surface
 * beneath an existing endpoint rather than on the 1.4 in marker sphere or the fat tape line; with
 * `pickSurface` raycasting the whole scene, the same is achieved by opting the dimension out.
 * Dimensions are therefore selected via box-select or the outliner, not by clicking; the markers
 * are still `selectionMeshes()` so the selection outline draws around them.
 */
import * as THREE from 'three';
import type { DimensionEntity } from '../document/types';
import type { Vec3 } from '../math';
import { v3dist } from '../math';
import { formatLength, type Unit } from '../units';
import type { EntityRenderer, RenderContext, RendererFactory } from './EntityRenderer';
import { tagRoot } from './EntityRenderer';
import { createLabelSprite, updateLabelSpriteScale } from '../ledwall/dimensions';

/* ───────────────────────────── Constants (v1 values) ───────────────────────────── */

export const MEASURE_COLOR = 0xeab308;
/** v1 `_measMarkerGeom`: SphereGeometry(1.4, 12, 12). */
export const MEASURE_MARKER_RADIUS_IN = 1.4;
/** v1 renderOrder: line 1001, markers 1002. */
export const MEASURE_LINE_RENDER_ORDER = 1001;
export const MEASURE_MARKER_RENDER_ORDER = 1002;
/** Label sprite base height (inches) and lift above the midpoint (v1 `label.position.y += 4`). */
export const MEASURE_LABEL_HEIGHT_IN = 6;
export const MEASURE_LABEL_LIFT_IN = 4;

/* ───────────────────────────── Pure helpers ───────────────────────────── */

/** Straight-line distance in inches. */
export function dimensionDistance(a: Vec3, b: Vec3): number { return v3dist(a, b); }

/** Label text: the explicit label when set, else the distance in the display unit (no px readout). */
export function dimensionLabelText(a: Vec3, b: Vec3, unit: Unit, label?: string): string {
  const custom = label?.trim();
  if (custom) return custom;
  return formatLength(dimensionDistance(a, b), unit);
}

/** Label anchor: the midpoint lifted `MEASURE_LABEL_LIFT_IN` up. */
export function dimensionLabelPosition(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + MEASURE_LABEL_LIFT_IN, (a[2] + b[2]) / 2];
}

/**
 * Axis-aligned breakdown polyline a → (b.x, a.y, a.z) → (b.x, b.y, a.z) → b, i.e. dx, then dy,
 * then dz. Degenerate legs (zero length) are dropped so the polyline never doubles back on a point.
 */
export function axisBreakdownPoints(a: Vec3, b: Vec3): Vec3[] {
  const pts: Vec3[] = [a];
  const push = (p: Vec3) => { const last = pts[pts.length - 1]; if (v3dist(last, p) > 1e-6) pts.push(p); };
  push([b[0], a[1], a[2]]);
  push([b[0], b[1], a[2]]);
  push(b);
  return pts;
}

/* ───────────────────────────── Label sprite reuse ───────────────────────────── */

/** Canvas styling mirrored from `createLabelSprite` (ledwall/dimensions.ts, v1 4202-4236). */
const LABEL_FONT_PX = 56;
const LABEL_PAD_PX = 20;
const LABEL_CORNER_RADIUS_PX = 10;
const LABEL_FONT_FAMILY = '"Courier New", monospace';
const LABEL_FONT = `bold ${LABEL_FONT_PX}px ${LABEL_FONT_FAMILY}`;
const LABEL_TEXT_COLOR = '#00ccff';
const LABEL_BACKGROUND = 'rgba(0, 0, 0, 0.8)';

/**
 * Redraw `text` into an existing label sprite's canvas without reallocating the texture.
 * The canvas keeps its size (a resized canvas would need a new GPU texture anyway); the dark
 * rounded box is drawn only as wide as the new text needs, centred, with transparent margins, so
 * the sprite's aspect/scale stay valid. Returns false when the sprite has no canvas or the text
 * would not fit — the caller then rebuilds the sprite.
 */
export function redrawLabelSprite(sprite: THREE.Sprite, text: string): boolean {
  const map = sprite.material.map;
  const canvas = map?.image as HTMLCanvasElement | undefined;
  if (!map || !canvas || typeof canvas.getContext !== 'function') return false;
  const c = canvas.getContext('2d');
  if (!c) return false;
  const w = canvas.width, h = canvas.height;
  c.font = LABEL_FONT;
  const boxW = Math.ceil(c.measureText(text).width + LABEL_PAD_PX * 2);
  if (boxW > w) return false;
  const x0 = Math.floor((w - boxW) / 2);
  c.clearRect(0, 0, w, h);
  c.fillStyle = LABEL_BACKGROUND;
  if (typeof c.roundRect === 'function') {
    c.beginPath();
    c.roundRect(x0, 0, boxW, h, LABEL_CORNER_RADIUS_PX);
    c.fill();
  } else {
    c.fillRect(x0, 0, boxW, h);
  }
  c.font = LABEL_FONT;
  c.fillStyle = LABEL_TEXT_COLOR;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, w / 2, h / 2);
  map.needsUpdate = true;
  sprite.userData.label = text;
  return true;
}

/* ───────────────────────────── Shared GPU resources ───────────────────────────── */

let markerGeom: THREE.SphereGeometry | null = null;
let markerMat: THREE.MeshBasicMaterial | null = null;
let lineMat: THREE.LineBasicMaterial | null = null;
let breakdownMat: THREE.LineDashedMaterial | null = null;

function shared() {
  markerGeom ??= new THREE.SphereGeometry(MEASURE_MARKER_RADIUS_IN, 12, 12);
  markerMat ??= new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false, toneMapped: false });
  lineMat ??= new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
  breakdownMat ??= new THREE.LineDashedMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true, opacity: 0.3, dashSize: 2, gapSize: 2, toneMapped: false });
  return { markerGeom, markerMat, lineMat, breakdownMat };
}

/* ───────────────────────────── Renderer ───────────────────────────── */

export class DimensionRenderer implements EntityRenderer<DimensionEntity> {
  entity: DimensionEntity;
  readonly root = new THREE.Group();
  readonly markerA: THREE.Mesh;
  readonly markerB: THREE.Mesh;
  readonly line: THREE.Line;
  readonly breakdown: THREE.Line;
  label: THREE.Sprite | null = null;
  private geomKey = '';
  private labelKey = '';

  constructor(entity: DimensionEntity, ctx: RenderContext) {
    this.entity = entity;
    tagRoot(this.root, entity);
    // World-space children: freeze the root at identity, local AND world, so a parent group's
    // transform is skipped too (see module doc).
    this.root.matrixAutoUpdate = false;
    this.root.matrixWorldAutoUpdate = false;
    this.root.matrix.identity();
    this.root.matrixWorld.identity();

    const s = shared();
    const marker = (which: 'a' | 'b') => {
      const m = new THREE.Mesh(s.markerGeom, s.markerMat);
      m.name = `measure-end-${which}`;
      m.renderOrder = MEASURE_MARKER_RENDER_ORDER;
      m.userData.part = 'end';
      m.userData.end = which;
      m.userData.sharedGeometry = true;
      m.userData.sharedMaterial = true;
      m.userData.unpickable = true; // see picking convention in the module doc
      return m;
    };
    this.markerA = marker('a');
    this.markerB = marker('b');

    this.line = new THREE.Line(new THREE.BufferGeometry(), s.lineMat);
    this.line.name = 'measure-line';
    this.line.renderOrder = MEASURE_LINE_RENDER_ORDER;
    this.line.userData.sharedMaterial = true;
    this.line.userData.part = 'line';
    this.line.userData.unpickable = true;

    this.breakdown = new THREE.Line(new THREE.BufferGeometry(), s.breakdownMat);
    this.breakdown.name = 'measure-breakdown';
    this.breakdown.renderOrder = MEASURE_LINE_RENDER_ORDER - 1;
    this.breakdown.userData.sharedMaterial = true;
    this.breakdown.userData.helper = true;
    this.breakdown.userData.unpickable = true;

    this.root.add(this.line, this.breakdown, this.markerA, this.markerB);
    this.update(entity, ctx);
  }

  update(entity: DimensionEntity, ctx: RenderContext): void {
    this.entity = entity;
    const a = entity.a, b = entity.b;
    const gKey = JSON.stringify([a, b]);
    if (gKey !== this.geomKey) {
      this.geomKey = gKey;
      this.markerA.position.set(a[0], a[1], a[2]);
      this.markerB.position.set(b[0], b[1], b[2]);
      this.line.geometry.dispose();
      this.line.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
      this.breakdown.geometry.dispose();
      const pts = axisBreakdownPoints(a, b);
      this.breakdown.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p)));
      this.breakdown.computeLineDistances();
      // Only the diagonal line has a breakdown worth showing.
      this.breakdown.visible = pts.length > 2;
    }
    const text = dimensionLabelText(a, b, ctx.unit, entity.label);
    if (text !== this.labelKey || !this.label) {
      this.labelKey = text;
      // During an endpoint drag the text changes every pointer move: redraw the existing canvas
      // in place and only rebuild the sprite when the text no longer fits (or there is no canvas).
      if (!this.label || !redrawLabelSprite(this.label, text)) {
        this.disposeLabel();
        const sprite = createLabelSprite(text, { heightIn: MEASURE_LABEL_HEIGHT_IN });
        sprite.name = 'measure-label';
        sprite.userData.baseHeightIn = MEASURE_LABEL_HEIGHT_IN;
        sprite.userData.helper = true;
        sprite.userData.unpickable = true;
        this.label = sprite;
        this.root.add(sprite);
      }
    }
    const lp = dimensionLabelPosition(a, b);
    this.label!.position.set(lp[0], lp[1], lp[2]);
  }

  frame(_dt: number, ctx: RenderContext): boolean {
    if (this.label) updateLabelSpriteScale(this.label, ctx.camera, MEASURE_LABEL_HEIGHT_IN);
    return false;
  }

  bounds(out = new THREE.Box3()): THREE.Box3 {
    const { a, b } = this.entity;
    out.makeEmpty();
    out.expandByPoint(new THREE.Vector3(a[0], a[1], a[2]));
    out.expandByPoint(new THREE.Vector3(b[0], b[1], b[2]));
    out.expandByScalar(MEASURE_MARKER_RADIUS_IN);
    return out;
  }

  selectionMeshes(): THREE.Mesh[] { return [this.markerA, this.markerB]; }

  private disposeLabel(): void {
    if (!this.label) return;
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label.removeFromParent();
    this.label = null;
  }

  dispose(): void {
    this.disposeLabel();
    this.line.geometry.dispose();
    this.breakdown.geometry.dispose();
    this.root.removeFromParent();
  }
}

export const createDimensionRenderer: RendererFactory = (entity, ctx) => new DimensionRenderer(entity as DimensionEntity, ctx);
