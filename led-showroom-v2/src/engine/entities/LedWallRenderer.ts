/**
 * LED wall renderer: panels (with corner mitres and custom shapes), bezels, base plates and back
 * supports, the pixel-structure grid, engineering dimensions and the content windows (textures for
 * images/videos/patterns, CSS3D iframes for websites), all in the wall-local frame
 * (origin on the floor at the wall's horizontal centre, screen facing +Z).
 */
import * as THREE from 'three';
import { CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import type { ContentSource, ContentWindow, Corner, LedWallEntity, PxRect } from '../document/types';
import type { EntityRenderer, RenderContext, RendererFactory } from './EntityRenderer';
import { disposeObject, tagRoot } from './EntityRenderer';
import {
  accessoryPlacements, cellKey, computeColumnLayout, computeSegments, filledCells, isRectWall, miterCutsForColumn,
  panelLocalPosition, wallDims, wallLocalBounds, localPointToWallPixel, wallPixelToLocal,
  type ColumnPlacement, type Segment, type WallDims,
} from '../ledwall/layout';
import {
  BEZEL_LINE_OFFSET_IN, basePlateGeometry, bezelLineGeometry, createWallMaterials, miteredPanelGeometry, onAccessoryGeometry,
  panelGeometry, panelMaterialArray, setFrontBrightness, supportBracketGeometry, type WallMaterials,
} from '../ledwall/geometry';
import {
  PIXEL_GRID_LAYER, PIXEL_GRID_RENDER_ORDER, brightnessCompensation, buildCellMaskTexture, disposePixelGrid,
  gridOpacityForDistance, gridPlaneForSegment, makePixelGridMaterial, perpendicularDistanceToFace, segmentHasFilledCells,
  segmentMiterExtensions,
} from '../ledwall/pixelGrid';
import { buildWallDimensions, disposeDimensionGroup, updateLabelSpriteScale } from '../ledwall/dimensions';
import { clampWindowRect, spanInfo, windowAtPixel } from '../ledwall/contentWindows';
import { acquireMedia, proxyUrl, releaseMedia, sourceKey, type ContentMedia } from '../content/ContentLayer';
import { formatLength } from '../units';
import type { Vec3 } from '../math';

const CONTENT_STANDOFF_IN = 0.02;
const CONTENT_Z_STEP = 0.004;

let sharedMats: WallMaterials | null = null;
function mats(): WallMaterials { return (sharedMats ??= createWallMaterials()); }

export interface Slice {
  /** Column whose frame anchors the slice (leftmost column). */
  anchorCol: number;
  /** Row of the slice (custom walls) or null (segment slice spanning all rows). */
  row: number | null;
  /** Visible pixel rect of the slice (wall px). */
  rect: PxRect;
  /** Signed mitre extension of the slice's left edge, inches (positive = extended outward). */
  extLeftIn: number;
  /** Signed mitre extension of the slice's right edge, inches (positive = extended outward). */
  extRightIn: number;
}

/**
 * Signed front-face mitre extension to apply to a content slice's left/right edge (v1 Alg A8).
 *
 * At a corner the panel's FRONT face is extended by `cornerExtension` so the two mitre faces meet,
 * so the content plane must reach the same extent or a bare unlit strip of panel shows at the fold.
 * Only a slice that actually touches a segment end picks the extension up; interior slices get 0.
 * The slice's UVs are left alone, so the outermost pixel column stretches over the extension and the
 * image stays contiguous in pixel space across the fold (exactly what v1's `segIppx` stretch did).
 */
export function sliceMiterExtensions(dims: WallDims, seg: Segment, corners: Corner[], rect: PxRect): { left: number; right: number } {
  const ext = segmentMiterExtensions(dims, seg, corners);
  const segX0 = seg.startCol * dims.spec.pxW;
  const segX1 = (seg.endCol + 1) * dims.spec.pxW;
  return {
    left: rect.x <= segX0 ? ext.left : 0,
    right: rect.x + rect.w >= segX1 ? ext.right : 0,
  };
}

interface WindowState {
  key: string;
  mediaKey: string;
  media: ContentMedia | null;
  material: THREE.MeshBasicMaterial | null;
  backdrop: THREE.MeshBasicMaterial | null;
  objects: THREE.Object3D[];
  css: CSS3DObject[];
  loading: boolean;
}

export class LedWallRenderer implements EntityRenderer<LedWallEntity> {
  entity: LedWallEntity;
  readonly root = new THREE.Group();
  /** Everything lives under `inner` so accessories can lift the wall by the base-plate thickness. */
  private inner = new THREE.Group();
  private panelsGroup = new THREE.Group();
  private bezelsGroup = new THREE.Group();
  private accGroup = new THREE.Group();
  private gridGroup = new THREE.Group();
  private dimGroup: THREE.Group | null = null;
  private contentGroup = new THREE.Group();

  dims!: WallDims;
  layout!: ColumnPlacement[];
  segments!: Segment[];
  cells!: Set<string>;
  private frontMat: THREE.MeshStandardMaterial;
  private panelMeshes: THREE.Mesh[] = [];
  private gridPlanes: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; mask: THREE.DataTexture | null }[] = [];
  private gridOpacity = -1;
  private windows = new Map<string, WindowState>();
  private structureKey = '';
  private gridKey = '';
  private dimKey = '';
  private contentKey = '';
  private spanKey = '';
  needsCss3d = false;
  needsPixelGrid = false;
  private ctx!: RenderContext;
  /**
   * Accessory CAD arrives after the wall is built and is swapped into the geometry objects the
   * accessory meshes already hold, so the only thing left to do is ask for a re-render.
   */
  private unsubAccessoryCad: () => void;

  constructor(entity: LedWallEntity, ctx: RenderContext) {
    this.entity = entity;
    this.ctx = ctx;
    this.unsubAccessoryCad = onAccessoryGeometry(() => this.ctx.invalidate());
    tagRoot(this.root, entity);
    this.frontMat = mats().front.clone();
    this.frontMat.userData.perWall = true;
    for (const g of [this.panelsGroup, this.bezelsGroup, this.accGroup, this.gridGroup, this.contentGroup]) this.inner.add(g);
    this.root.add(this.inner);
    this.bezelsGroup.userData.unpickable = true;
    this.gridGroup.userData.unpickable = true;
    this.update(entity, ctx);
  }

  /* ───────────────────────── update ───────────────────────── */

  update(entity: LedWallEntity, ctx: RenderContext): void {
    this.entity = entity;
    this.ctx = ctx;
    const sKey = JSON.stringify([entity.product, entity.cols, entity.rows, entity.shape, entity.corners, entity.bezels, entity.accessories]);
    if (sKey !== this.structureKey) { this.structureKey = sKey; this.rebuildStructure(); }

    const gKey = sKey + '|' + entity.pixelGrid;
    if (gKey !== this.gridKey) { this.gridKey = gKey; this.rebuildGrid(); }

    const dKey = sKey + '|' + entity.showDimensions + '|' + ctx.unit;
    if (dKey !== this.dimKey) { this.dimKey = dKey; this.rebuildDimensions(); }

    this.rebuildContent();
    this.applyBrightness();
  }

  private rebuildStructure(): void {
    const e = this.entity;
    this.dims = wallDims(e);
    this.layout = computeColumnLayout(this.dims, e.corners);
    this.segments = computeSegments(e.cols, e.corners);
    this.cells = filledCells(e);
    const spec = this.dims.spec;
    const m = mats();

    // panels
    for (const mesh of this.panelMeshes) { if (!mesh.userData.sharedGeometry) mesh.geometry.dispose(); mesh.removeFromParent(); }
    this.panelMeshes = [];
    const cuts = new Map<number, ReturnType<typeof miterCutsForColumn>>();
    for (let c = 0; c < e.cols; c++) cuts.set(c, miterCutsForColumn(c, this.dims, e.corners));
    const materials = panelMaterialArray(m, this.frontMat);
    for (const key of this.cells) {
      const [c, r] = key.split(',').map(Number);
      const cut = cuts.get(c)!;
      const mitered = !!(cut.left || cut.right);
      const geom = mitered ? miteredPanelGeometry(spec, cut.left, cut.right) : panelGeometry(spec);
      const mesh = new THREE.Mesh(geom, materials);
      mesh.userData.sharedGeometry = !mitered;
      mesh.userData.sharedMaterial = true;
      mesh.userData.part = 'panel';
      mesh.userData.col = c; mesh.userData.row = r;
      const p = panelLocalPosition(this.dims, this.layout, c, r);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.rotation.y = this.layout[c]?.rotY ?? 0;
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.panelsGroup.add(mesh);
      this.panelMeshes.push(mesh);
    }

    // bezel lines
    this.bezelsGroup.clear();
    if (e.bezels) {
      for (const mesh of this.panelMeshes) {
        const c = mesh.userData.col as number;
        const cut = cuts.get(c)!;
        // Signed cuts pass straight through (v1 4108-4110 used lfCut/rfCut unclamped): at a convex
        // corner the front cut is NEGATIVE, so the outline follows the extended mitre face instead
        // of stopping ~1 in inside the panel edge. bezelLineGeometry handles negative trims.
        const g = bezelLineGeometry(spec.widthIn, spec.heightIn, cut.left ? cut.left.front : 0, cut.right ? cut.right.front : 0);
        const line = new THREE.LineSegments(g, m.bezel);
        line.userData.sharedMaterial = true;
        line.userData.unpickable = true;
        const rotY = mesh.rotation.y;
        line.position.copy(mesh.position).add(new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)).multiplyScalar(spec.depthIn / 2 + BEZEL_LINE_OFFSET_IN));
        line.rotation.y = rotY;
        this.bezelsGroup.add(line);
      }
    }

    // accessories
    for (const ch of Array.from(this.accGroup.children)) disposeObject(ch);
    this.accGroup.clear();
    const acc = spec.accessories;
    if (e.accessories && acc && isRectWall(e)) {
      const baseGeom = basePlateGeometry(acc.base);
      // Two real parts, not one part flipped: mirroring with scale.x = -1 would invert the CAD
      // bracket's winding and show its inside faces.
      const supGeom = [supportBracketGeometry(acc.support, false), supportBracketGeometry(acc.support, true)];
      for (const pl of accessoryPlacements(this.dims, this.layout, spec)) {
        const base = new THREE.Mesh(baseGeom, m.accessory);
        base.userData.sharedGeometry = true; base.userData.sharedMaterial = true; base.userData.part = 'base';
        base.position.set(pl.base.position[0], pl.base.position[1], pl.base.position[2]);
        base.rotation.y = pl.base.rotY;
        base.castShadow = true; base.receiveShadow = true;
        this.accGroup.add(base);
        for (const s of pl.supports) {
          const sup = new THREE.Mesh(supGeom[s.mirrored ? 1 : 0], m.accessory);
          sup.userData.sharedGeometry = true; sup.userData.sharedMaterial = true; sup.userData.part = 'support';
          sup.position.set(s.position[0], s.position[1], s.position[2]);
          sup.rotation.y = s.rotY;
          sup.castShadow = true;
          this.accGroup.add(sup);
        }
      }
      this.inner.position.y = acc.base.thick;
    } else {
      this.inner.position.y = 0;
    }
    // content planes depend on the structure
    this.contentKey = '';
  }

  private rebuildGrid(): void {
    for (const g of this.gridPlanes) { disposePixelGrid(g.mat, g.mask); g.mesh.geometry.dispose(); g.mesh.removeFromParent(); }
    this.gridPlanes = [];
    this.gridOpacity = -1;
    const e = this.entity;
    this.needsPixelGrid = e.pixelGrid;
    if (!e.pixelGrid) return;
    const rect = isRectWall(e);
    for (const seg of this.segments) {
      if (!rect && !segmentHasFilledCells(this.cells, seg.startCol, seg.endCol, e.rows)) continue;
      const pl = gridPlaneForSegment(this.dims, this.layout, seg, e.corners);
      const mask = rect ? null : buildCellMaskTexture(this.cells, seg.startCol, seg.endCol, e.rows);
      const mat = makePixelGridMaterial({ cols: seg.endCol - seg.startCol + 1, rows: e.rows, gapIn: this.dims.gap, spec: this.dims.spec, maskTex: mask, extendLeftIn: pl.extendLeftIn, extendRightIn: pl.extendRightIn });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(pl.width, pl.height), mat);
      mesh.position.set(pl.center[0], pl.center[1], pl.center[2]);
      mesh.rotation.y = pl.rotY;
      mesh.layers.set(PIXEL_GRID_LAYER);
      mesh.renderOrder = PIXEL_GRID_RENDER_ORDER;
      mesh.userData.unpickable = true;
      mesh.userData.helper = true;
      this.gridGroup.add(mesh);
      this.gridPlanes.push({ mesh, mat, mask });
    }
  }

  private rebuildDimensions(): void {
    if (this.dimGroup) { disposeDimensionGroup(this.dimGroup); this.dimGroup.removeFromParent(); this.dimGroup = null; }
    if (!this.entity.showDimensions) return;
    this.dimGroup = buildWallDimensions({ wall: this.entity, dims: this.dims, layout: this.layout, segments: this.segments, unit: this.ctx.unit });
    this.dimGroup.traverse(o => { o.userData.unpickable = true; o.userData.helper = true; });
    this.inner.add(this.dimGroup);
  }

  /* ───────────────────────── content ───────────────────────── */

  /** Windows to render: the entity's own, or one synthetic spanning window in span mode. */
  private effectiveWindows(): { win: ContentWindow; texRect: PxRect; visRect: PxRect }[] {
    const e = this.entity, d = this.dims, doc = this.ctx.doc;
    const wallRect = { x: 0, y: 0, w: d.wallWPx, h: d.wallHPx };
    const walls = doc.entities.filter(x => x.type === 'led-wall') as LedWallEntity[];
    if (doc.settings.spanContent && walls.length > 1) {
      const first = walls[0];
      const srcWin = first.contentWindows.find(w => w.source) ?? first.contentWindows[0];
      if (!srcWin?.source) return [];
      const info = spanInfo(walls.map(w => ({ id: w.id, dims: wallDims(w) })));
      const mine = info.walls.find(w => w.id === e.id);
      if (!mine) return [];
      const win: ContentWindow = { ...srcWin, id: 'span', mode: 'fill', rect: wallRect };
      return [{ win, texRect: { x: -mine.xOffsetPx, y: -mine.yOffsetPx, w: info.totalWPx, h: info.maxHPx }, visRect: wallRect }];
    }
    return e.contentWindows.filter(w => w.visible !== false && w.source).map(win => {
      const rect = clampWindowRect(win.rect, win.mode, d);
      return { win, texRect: rect, visRect: rect };
    });
  }

  private rebuildContent(): void {
    const e = this.entity;
    const items = this.effectiveWindows();
    const key = JSON.stringify([items.map(i => [i.win.id, sourceKey(i.win.source), i.win.mode, i.texRect, i.visRect, i.win.opacity]), e.doubleSided, this.structureKey]);
    if (key === this.contentKey) return;
    this.contentKey = key;

    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.win.id);
      let st = this.windows.get(it.win.id);
      const mediaKey = sourceKey(it.win.source) + '|' + (it.win.source?.type === 'test-pattern' || it.win.source?.type === 'color' ? `${this.dims.wallWPx}x${this.dims.wallHPx}` : '');
      if (st && st.mediaKey !== mediaKey) { this.disposeWindow(st); st = undefined; }
      if (!st) {
        st = { key: it.win.id, mediaKey, media: null, material: null, backdrop: null, objects: [], css: [], loading: false };
        this.windows.set(it.win.id, st);
        this.loadMedia(st, it.win.source!);
      } else {
        for (const o of st.objects) { (o as THREE.Mesh).geometry?.dispose?.(); o.removeFromParent(); }
        for (const c of st.css) { c.element.remove(); c.removeFromParent(); }
        st.objects = []; st.css = [];
      }
      this.buildWindowObjects(st, it);
    }
    for (const [id, st] of Array.from(this.windows.entries())) if (!seen.has(id)) { this.disposeWindow(st); this.windows.delete(id); }
    this.needsCss3d = Array.from(this.windows.values()).some(w => w.css.length > 0);
    this.applyBrightness();
  }

  private loadMedia(st: WindowState, src: ContentSource): void {
    if (src.type === 'website') return; // per-slice iframes
    const d = this.dims;
    // Shared, refcounted: walls showing the same source (every wall in span mode, or the same
    // file dropped on several walls) get one decoder and one texture, so a spanned video stays
    // frame-identical across the seam — v1's getSharedSpanVideo (index.html:4969).
    const media = acquireMedia(src, this.ctx.assets, {
      maxTextureSize: this.ctx.maxTextureSize,
      gen: { wPx: d.wallWPx, hPx: d.wallHPx, panelPxW: d.spec.pxW, panelPxH: d.spec.pxH, cols: d.cols, rows: d.rows, physicalW: formatLength(d.totalW, this.ctx.unit), physicalH: formatLength(d.totalH, this.ctx.unit) },
      onError: msg => { this.ctx.setLoading(this.entity.id, st.key, false); console.warn('[wall content]', msg); },
    });
    st.media = media;
    st.material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.FrontSide });
    st.material.map = media.texture;
    st.backdrop = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    st.loading = true;
    this.ctx.setLoading(this.entity.id, st.key, true);
    media.ready.then(() => {
      st.loading = false;
      this.ctx.setLoading(this.entity.id, st.key, false);
      if (st.material) { st.material.map = media.texture; st.material.needsUpdate = true; }
      // scaled mode needs the media aspect → rebuild slices
      this.contentKey = '';
      this.rebuildContent();
      this.ctx.invalidate();
    }).catch(() => { st.loading = false; });
  }

  private disposeWindow(st: WindowState): void {
    for (const o of st.objects) { (o as THREE.Mesh).geometry?.dispose?.(); o.removeFromParent(); }
    for (const c of st.css) { c.element.remove(); c.removeFromParent(); }
    releaseMedia(st.media);
    st.media = null;
    st.material?.dispose();
    st.backdrop?.dispose();
    if (st.loading) this.ctx.setLoading(this.entity.id, st.key, false);
  }

  /** Split a visible rect into per-segment (rect walls) or per-cell (custom walls) slices. */
  private slices(vis: PxRect): Slice[] {
    const d = this.dims, e = this.entity;
    const out: Slice[] = [];
    const ix = (a: PxRect, b: PxRect): PxRect | null => {
      const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    const push = (seg: Segment, anchorCol: number, row: number | null, rect: PxRect): void => {
      const ext = sliceMiterExtensions(d, seg, e.corners, rect);
      out.push({ anchorCol, row, rect, extLeftIn: ext.left, extRightIn: ext.right });
    };
    if (isRectWall(e)) {
      for (const seg of this.segments) {
        const r = ix(vis, { x: seg.startCol * d.spec.pxW, y: 0, w: (seg.endCol - seg.startCol + 1) * d.spec.pxW, h: d.wallHPx });
        if (r) push(seg, seg.startCol, null, r);
      }
    } else {
      for (const key of this.cells) {
        const [c, r] = key.split(',').map(Number);
        const cr = ix(vis, { x: c * d.spec.pxW, y: r * d.spec.pxH, w: d.spec.pxW, h: d.spec.pxH });
        if (cr) push(this.segments.find(s => c >= s.startCol && c <= s.endCol) ?? { startCol: c, endCol: c }, c, r, cr);
      }
    }
    return out;
  }

  /** Inches from the anchor column's left edge to wall pixel x (gaps included). */
  private pxToInX(px: number, anchorCol: number): number {
    const d = this.dims;
    const col = Math.floor(px / d.spec.pxW);
    const within = px - col * d.spec.pxW;
    return (col - anchorCol) * (d.panelW + d.gap) + within * d.inPerPxX;
  }
  /** Inches from the wall top to wall pixel y (gaps included). */
  private pxToInY(py: number): number {
    const d = this.dims;
    const row = Math.floor(py / d.spec.pxH);
    const within = py - row * d.spec.pxH;
    return row * (d.panelH + d.gap) + within * d.inPerPxY;
  }

  private placeSlice(obj: THREE.Object3D, sl: Slice, back: boolean, zIndex: number): { w: number; h: number } {
    const d = this.dims;
    const col = this.layout[sl.anchorCol] ?? { x: 0, z: 0, rotY: 0 };
    const rotY = col.rotY;
    const dir = new THREE.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
    const normal = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
    // Stretch the slice over the segment's mitre extensions so the lit area matches the extended
    // panel face at a fold (v1 Alg A8); UVs are untouched, so the edge pixel column stretches.
    const x0 = this.pxToInX(sl.rect.x, sl.anchorCol) - sl.extLeftIn;
    const x1 = this.pxToInX(sl.rect.x + sl.rect.w, sl.anchorCol) + sl.extRightIn;
    const yTop = this.pxToInY(sl.rect.y), yBot = this.pxToInY(sl.rect.y + sl.rect.h);
    const w = x1 - x0, h = yBot - yTop;
    const leftEdge = new THREE.Vector3(col.x, 0, col.z).addScaledVector(dir, -d.panelW / 2);
    const centre = leftEdge.addScaledVector(dir, (x0 + x1) / 2);
    centre.y = d.totalH - (yTop + yBot) / 2;
    const off = d.panelD / 2 + CONTENT_STANDOFF_IN + zIndex * CONTENT_Z_STEP;
    centre.addScaledVector(normal, back ? -off : off);
    obj.position.copy(centre);
    obj.rotation.set(0, back ? rotY + Math.PI : rotY, 0);
    return { w, h };
  }

  private sliceGeometry(w: number, h: number, sl: Slice, tex: PxRect): THREE.PlaneGeometry {
    const g = new THREE.PlaneGeometry(w, h);
    const u0 = (sl.rect.x - tex.x) / tex.w, u1 = (sl.rect.x + sl.rect.w - tex.x) / tex.w;
    const v1 = 1 - (sl.rect.y - tex.y) / tex.h, v0 = 1 - (sl.rect.y + sl.rect.h - tex.y) / tex.h;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // PlaneGeometry uv order: (0,1) (1,1) (0,0) (1,0)
    uv.setXY(0, u0, v1); uv.setXY(1, u1, v1); uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
    uv.needsUpdate = true;
    return g;
  }

  private buildWindowObjects(st: WindowState, it: { win: ContentWindow; texRect: PxRect; visRect: PxRect }): void {
    const e = this.entity, d = this.dims;
    const zIndex = Math.max(0, e.contentWindows.findIndex(w => w.id === it.win.id));
    const sides: boolean[] = e.doubleSided ? [false, true] : [false];
    const src = it.win.source!;

    if (src.type === 'website') {
      for (const sl of this.slices(it.visRect)) {
        for (const back of sides) {
          const el = document.createElement('div');
          el.className = 'sr-web';
          Object.assign(el.style, { width: `${sl.rect.w}px`, height: `${sl.rect.h}px`, overflow: 'hidden', background: '#000', pointerEvents: 'auto', position: 'relative' });
          const ifr = document.createElement('iframe');
          Object.assign(ifr.style, { position: 'absolute', left: `${it.texRect.x - sl.rect.x}px`, top: `${it.texRect.y - sl.rect.y}px`, width: `${it.texRect.w}px`, height: `${it.texRect.h}px`, border: '0', background: '#000' });
          ifr.src = proxyUrl(src.url ?? '');
          el.appendChild(ifr);
          const obj = new CSS3DObject(el);
          const { w, h } = this.placeSlice(obj, sl, back, zIndex);
          obj.scale.set(w / sl.rect.w, h / sl.rect.h, 1);
          obj.userData.unpickable = true;
          this.contentGroup.add(obj);
          st.css.push(obj);
        }
      }
      return;
    }

    // texture-backed windows
    let texRect = it.texRect;
    const media = st.media;
    if (it.win.mode === 'scaled' && media && media.width && media.height) {
      // aspect-fit inside the visible rect; black letterbox behind
      const ar = media.width / media.height, vr = it.visRect.w / it.visRect.h;
      let w = it.visRect.w, h = it.visRect.h;
      if (ar > vr) h = w / ar; else w = h * ar;
      texRect = { x: it.visRect.x + (it.visRect.w - w) / 2, y: it.visRect.y + (it.visRect.h - h) / 2, w, h };
      for (const sl of this.slices(it.visRect)) {
        for (const back of sides) {
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), st.backdrop!);
          const { w: sw, h: sh } = this.placeSlice(mesh, sl, back, zIndex);
          mesh.geometry.dispose(); mesh.geometry = new THREE.PlaneGeometry(sw, sh);
          mesh.userData.sharedMaterial = true; mesh.userData.unpickable = true;
          this.contentGroup.add(mesh); st.objects.push(mesh);
        }
      }
    }
    const visible = it.win.mode === 'scaled' ? intersect(texRect, it.visRect) : it.visRect;
    if (!visible) return;
    for (const sl of this.slices(visible)) {
      for (const back of sides) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), st.material!);
        const { w, h } = this.placeSlice(mesh, sl, back, zIndex + (it.win.mode === 'scaled' ? 1 : 0));
        mesh.geometry.dispose();
        mesh.geometry = this.sliceGeometry(w, h, sl, texRect);
        mesh.userData.sharedMaterial = true;
        mesh.userData.part = 'content';
        mesh.userData.windowId = it.win.id;
        mesh.userData.unpickable = true; // panels are the pick targets; content is looked up by pixel
        this.contentGroup.add(mesh);
        st.objects.push(mesh);
      }
    }
  }

  private applyBrightness(): void {
    const comp = brightnessCompensation(Math.max(0, this.gridOpacity));
    const v = Math.min(1.6, (this.entity.brightness / 100) * comp);
    setFrontBrightness(this.frontMat, this.entity.brightness, comp);
    for (const st of this.windows.values()) {
      if (st.material) {
        st.material.color.setScalar(v);
        st.material.opacity = 1;
      }
      // Websites are CSS3D, so they take the same factor as a CSS filter (v1 applied
      // `filter: brightness(adj)` to every content element). The factor is also stamped on the
      // object so the export's website overlay tints its raster identically.
      for (const c of st.css) {
        (c.element as HTMLElement).style.filter = Math.abs(v - 1) < 0.005 ? '' : `brightness(${v})`;
        c.userData.contentBrightness = v;
      }
    }
  }

  /* ───────────────────────── frame ───────────────────────── */

  frame(dt: number, ctx: RenderContext): boolean {
    let dirty = false;
    for (const st of this.windows.values()) if (st.media?.update()) dirty = true;

    if (this.gridPlanes.length) {
      const camLocal = this.inner.worldToLocal(ctx.camera.position.clone());
      const scale = this.root.getWorldScale(new THREE.Vector3()).z || 1;
      const dist = perpendicularDistanceToFace(camLocal.z, this.dims.panelD, scale);
      const op = gridOpacityForDistance(dist, ctx.doc.settings.pixelGridDistIn);
      if (Math.abs(op - this.gridOpacity) > 0.002) {
        this.gridOpacity = op;
        for (const g of this.gridPlanes) { (g.mat.uniforms.uOpacity as THREE.IUniform).value = op; g.mesh.visible = op > 0.001; }
        this.applyBrightness();
        dirty = true;
      }
      this.needsPixelGrid = this.entity.pixelGrid && this.gridOpacity > 0.001;
    }
    if (this.dimGroup) {
      for (const ch of this.dimGroup.children) if ((ch as THREE.Sprite).isSprite) updateLabelSpriteScale(ch as THREE.Sprite, ctx.camera, (ch.userData.baseHeightIn as number) || 6);
    }
    void dt;
    return dirty;
  }

  /* ───────────────────────── queries ───────────────────────── */

  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    this.root.updateWorldMatrix(true, true);
    const b = new THREE.Box3();
    for (const m of this.panelMeshes) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld); out.union(b); }
    for (const ch of this.accGroup.children) { const m = ch as THREE.Mesh; if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld); out.union(b); }
    return out;
  }

  selectionMeshes(): THREE.Mesh[] { return this.panelMeshes; }

  /** Local-space bounds (for the inspector). */
  localBounds() { return wallLocalBounds(this.dims, this.layout); }

  /** Wall pixel under a world point on the screen surface (or null). */
  pixelAtWorld(p: THREE.Vector3): { px: number; py: number } | null {
    const local = this.inner.worldToLocal(p.clone());
    const r = localPointToWallPixel(this.dims, this.layout, this.segments, [local.x, local.y, local.z]);
    if (!r) return null;
    return { px: Math.floor(r.px), py: Math.floor(r.py) };
  }

  /** World point on the screen surface for a wall pixel. */
  pixelToWorld(px: number, py: number): THREE.Vector3 {
    const l: Vec3 = wallPixelToLocal(this.dims, this.layout, px, py);
    return this.inner.localToWorld(new THREE.Vector3(l[0], l[1], l[2]));
  }

  windowAt(px: number, py: number): ContentWindow | null {
    return windowAtPixel(this.entity.contentWindows, px, py);
  }

  dispose(): void {
    this.unsubAccessoryCad();
    for (const st of this.windows.values()) this.disposeWindow(st);
    this.windows.clear();
    for (const g of this.gridPlanes) { disposePixelGrid(g.mat, g.mask); g.mesh.geometry.dispose(); }
    this.gridPlanes = [];
    if (this.dimGroup) disposeDimensionGroup(this.dimGroup);
    for (const m of this.panelMeshes) if (!m.userData.sharedGeometry) m.geometry.dispose();
    this.frontMat.dispose();
    for (const ch of Array.from(this.accGroup.children)) disposeObject(ch);
    this.root.removeFromParent();
  }
}

function intersect(a: PxRect, b: PxRect): PxRect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export const createLedWallRenderer: RendererFactory = (entity, ctx) => new LedWallRenderer(entity as LedWallEntity, ctx);

export { cellKey };
