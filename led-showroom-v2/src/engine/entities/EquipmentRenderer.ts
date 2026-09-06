/**
 * Equipment renderer: parametric catalog items (kiosks, totems, truss, furniture, figures …)
 * built by `equipmentGeometry.ts`, plus optional image/video content on screen-bearing items
 * (kiosk / totem / screen) mapped onto an unlit plane.
 *
 * Two catalog items are not parametric: a `photo` product is its own cutout photograph on a
 * billboarded plane, and a `cad` product is the manufacturer's mesh shipped under /models. Both
 * load asynchronously behind a placeholder and both take their bounds from the declared dims.
 *
 * Local frame: origin at the bottom centre (stands on y = 0), front faces +Z, size = dims.
 */
import * as THREE from 'three';
import type { ContentSource, EquipmentEntity } from '../document/types';
import type { EntityRenderer, RenderContext, RendererFactory } from './EntityRenderer';
import { tagRoot } from './EntityRenderer';
import { createContentMedia, sourceKey, type ContentMedia } from '../content/ContentLayer';
import { geometrySize, loadCadGeometry, type CadAnchors } from '../content/cadModels';
import { buildEquipment, colorOf, disposeEquipmentBuild, equipmentBounds, equipmentBuildKey, safeDims, SCREEN_GEOMETRIES, type EquipmentBuild } from './equipmentGeometry';
import { faceCameraY, loadProductTexture, makeContactShadow, PHOTO_ALPHA_TEST, photoPlaneSize } from './photoModel';

const SCREEN_LOADING_KEY = 'screen';
const PHOTO_LOADING_KEY = 'photo';
const CAD_LOADING_KEY = 'cad';

/** Equipment CAD stands on the floor at its footprint centre, like every other equipment model. */
export const CAD_EQUIPMENT_ANCHORS: CadAnchors = { x: 'center', y: 'min', z: 'center' };

/** A photographed product: one alpha-tested plane plus a contact shadow, both owned by the renderer. */
interface PhotoBuild {
  group: THREE.Group;
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadow: THREE.Mesh;
  url: string;
}

/**
 * A CAD product: the shipped mesh (geometry shared out of the CAD cache, material owned here) with
 * a wireframe box standing in until it arrives.
 */
interface CadBuild {
  group: THREE.Group;
  url: string;
  placeholder: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  mesh: THREE.Mesh | null;
  material: THREE.MeshStandardMaterial | null;
}

/**
 * Scale that makes a CAD mesh of `size` fill the declared `dims`. The catalog publishes the mesh's
 * own bounds, so this is 1 until the user edits the dimensions; an axis the mesh is flat on (or a
 * degenerate mesh) is left at 1 rather than blowing up.
 */
export function cadFitScale(size: readonly [number, number, number], dims: readonly [number, number, number]): [number, number, number] {
  const axis = (s: number, d: number): number => (s > 1e-6 && d > 0 ? d / s : 1);
  return [axis(size[0], dims[0]), axis(size[1], dims[1]), axis(size[2], dims[2])];
}

/** Cover-fit a texture on a plane: crop the media so it fills the plane without distortion. */
export function coverFit(texture: THREE.Texture, mediaW: number, mediaH: number, planeW: number, planeH: number): void {
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
  if (!(mediaW > 0 && mediaH > 0 && planeW > 0 && planeH > 0)) return;
  const ma = mediaW / mediaH, pa = planeW / planeH;
  if (ma > pa) { const rx = pa / ma; texture.repeat.x = rx; texture.offset.x = (1 - rx) / 2; }
  else if (ma < pa) { const ry = ma / pa; texture.repeat.y = ry; texture.offset.y = (1 - ry) / 2; }
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.matrixAutoUpdate = true;
}

export class EquipmentRenderer implements EntityRenderer<EquipmentEntity> {
  entity: EquipmentEntity;
  readonly root = new THREE.Group();

  private build: EquipmentBuild | null = null;
  private buildKey = '';
  private ctx: RenderContext;

  private media: ContentMedia | null = null;
  private mediaKey = '';
  private mediaLoading = false;

  private photo: PhotoBuild | null = null;
  private photoLoading = false;

  private cad: CadBuild | null = null;
  private cadLoading = false;

  constructor(entity: EquipmentEntity, ctx: RenderContext) {
    this.entity = entity;
    this.ctx = ctx;
    tagRoot(this.root, entity);
    this.update(entity, ctx);
  }

  /* ───────────────────────── update ───────────────────────── */

  /** True when this item is modelled by its product photograph rather than parametric geometry. */
  private get isPhoto(): boolean { return this.entity.geometry === 'photo' && !!this.entity.image; }

  /** True when this item is modelled by a CAD mesh shipped with the app. */
  private get isCad(): boolean { return this.entity.geometry === 'cad' && !!this.entity.model; }

  update(entity: EquipmentEntity, ctx: RenderContext): void {
    this.entity = entity;
    this.ctx = ctx;
    const dims = safeDims(entity.dims).join(',');
    const key = this.isPhoto ? `photo|${entity.image}|${dims}`
      : this.isCad ? `cad|${entity.model}|${dims}|${entity.color}`
      : equipmentBuildKey(entity);
    if (key !== this.buildKey) { this.buildKey = key; this.rebuild(); }
    if (!this.isPhoto && !this.isCad) this.syncScreen();
  }

  private rebuild(): void {
    this.disposeBuilds();
    if (this.isPhoto) { this.buildPhoto(); return; }
    if (this.isCad) { this.buildCad(); return; }
    this.build = buildEquipment(this.entity);
    this.root.add(this.build.group);
    this.applyScreen();
  }

  /* ───────────────────────── CAD model ───────────────────────── */

  /**
   * Stand a wireframe box of the declared size in place, then swap the shipped CAD mesh in when it
   * loads. The geometry comes from the shared CAD cache (never disposed here); the material is the
   * renderer's own so the item follows the entity's colour.
   */
  private buildCad(): void {
    const e = this.entity;
    const url = e.model!;
    const dims = safeDims(e.dims);
    const group = new THREE.Group();
    group.name = 'cad';

    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(dims[0], dims[1], dims[2]),
      new THREE.MeshBasicMaterial({ color: 0x8a94a6, wireframe: true, transparent: true, opacity: 0.8 }),
    );
    placeholder.position.y = dims[1] / 2;
    placeholder.userData.part = 'placeholder';
    group.add(placeholder);

    this.root.add(group);
    // The guard on the async completion is this build OBJECT, never its url: `rebuild()` fires on any
    // buildKey change (a colour or dims edit keeps the same model url), `loadCadGeometry` hands both
    // builds the same cached promise, and a url test would let the dead build's callback add a second
    // mesh to the live group and orphan its material.
    const build: CadBuild = { group, url, placeholder, mesh: null, material: null };
    this.cad = build;

    this.cadLoading = true;
    this.ctx.setLoading(e.id, CAD_LOADING_KEY, true);
    loadCadGeometry(url, CAD_EQUIPMENT_ANCHORS).then(geom => {
      if (this.cad !== build) return;
      const d = safeDims(this.entity.dims);
      const mat = new THREE.MeshStandardMaterial({ color: colorOf(this.entity.color, '#6b6f78'), roughness: 0.5, metalness: 0.25 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.sharedGeometry = true; // owned by the CAD cache
      mesh.userData.part = 'cad';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const s = cadFitScale(geometrySize(geom), d);
      mesh.scale.set(s[0], s[1], s[2]);
      build.group.add(mesh);
      build.mesh = mesh;
      build.material = mat;
      build.placeholder.visible = false;
      this.cadLoading = false;
      this.ctx.setLoading(this.entity.id, CAD_LOADING_KEY, false);
      this.ctx.invalidate();
    }).catch(err => {
      if (this.cad !== build) return;
      this.cadLoading = false;
      this.ctx.setLoading(this.entity.id, CAD_LOADING_KEY, false);
      console.warn('[equipment cad]', (err as Error).message);
    });
  }

  /* ───────────────────────── photo model ───────────────────────── */

  private buildPhoto(): void {
    const e = this.entity;
    const url = e.image!;
    const dims = safeDims(e.dims);
    const group = new THREE.Group();
    group.name = 'photo';

    const size = photoPlaneSize(dims, null); // resized once the texture reports its aspect
    const mat = new THREE.MeshBasicMaterial({
      transparent: false, alphaTest: PHOTO_ALPHA_TEST, side: THREE.DoubleSide, toneMapped: false,
      color: 0xffffff, opacity: 1,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size.w, size.h), mat);
    plane.position.y = size.h / 2;
    plane.castShadow = true;
    plane.receiveShadow = false;
    plane.userData.part = 'photo';
    plane.visible = false; // nothing to show until the cutout has loaded
    group.add(plane);

    const shadow = makeContactShadow(dims[0], dims[2]);
    group.add(shadow);

    this.root.add(group);
    // Guarded on the build object, not the url, for the reason spelled out in `buildCad`: a dims edit
    // rebuilds without changing `image`, and a stale callback would resize and reallocate the geometry
    // of a plane that has already been disposed and detached.
    const build: PhotoBuild = { group, plane, shadow, url };
    this.photo = build;

    this.photoLoading = true;
    this.ctx.setLoading(e.id, PHOTO_LOADING_KEY, true);
    loadProductTexture(url).then(tex => {
      if (this.photo !== build) return;
      const img = tex.image as { width: number; height: number } | undefined;
      const s = photoPlaneSize(safeDims(this.entity.dims), img ?? null);
      build.plane.geometry.dispose();
      build.plane.geometry = new THREE.PlaneGeometry(s.w, s.h);
      build.plane.position.y = s.h / 2;
      const bm = build.plane.material;
      bm.map = tex;
      bm.needsUpdate = true;
      build.plane.visible = this.entity.visible !== false;
      this.photoLoading = false;
      this.ctx.setLoading(this.entity.id, PHOTO_LOADING_KEY, false);
      this.ctx.invalidate();
    }).catch(err => {
      if (this.photo !== build) return;
      this.photoLoading = false;
      this.ctx.setLoading(this.entity.id, PHOTO_LOADING_KEY, false);
      console.warn('[equipment photo]', (err as Error).message);
    });
  }

  private disposeBuilds(): void {
    if (this.build) { disposeEquipmentBuild(this.build); this.build = null; }
    if (this.photo) {
      if (this.photoLoading) { this.photoLoading = false; this.ctx.setLoading(this.entity.id, PHOTO_LOADING_KEY, false); }
      this.photo.plane.geometry.dispose();
      this.photo.plane.material.dispose(); // the texture itself is shared and stays cached
      this.photo.shadow.geometry.dispose();
      const sm = this.photo.shadow.material as THREE.MeshBasicMaterial;
      sm.map?.dispose();
      sm.dispose();
      this.photo.group.removeFromParent();
      this.photo = null;
    }
    if (this.cad) {
      if (this.cadLoading) { this.cadLoading = false; this.ctx.setLoading(this.entity.id, CAD_LOADING_KEY, false); }
      this.cad.placeholder.geometry.dispose();
      this.cad.placeholder.material.dispose();
      this.cad.material?.dispose(); // the mesh geometry is shared and stays in the CAD cache
      this.cad.group.removeFromParent();
      this.cad = null;
    }
  }

  /** Which content source (if any) should be on the screen right now. */
  private screenSource(): ContentSource | null {
    const e = this.entity;
    if (!SCREEN_GEOMETRIES.has(e.geometry) || !this.build?.screen || !e.screen) return null;
    if (e.screen.type === 'website') return null; // CSS3D websites are not supported on equipment screens
    return e.screen;
  }

  private syncScreen(): void {
    const src = this.screenSource();
    const key = sourceKey(src);
    if (key === this.mediaKey) { this.applyScreen(); return; }
    this.mediaKey = key;
    this.disposeMedia();
    if (src) this.loadMedia(src);
    this.applyScreen();
  }

  private screenSize(): { w: number; h: number } {
    const s = this.build?.screen;
    if (!s) return { w: 1, h: 1 };
    const g = s.geometry as THREE.PlaneGeometry;
    return { w: g.parameters.width, h: g.parameters.height };
  }

  private loadMedia(src: ContentSource): void {
    const { w, h } = this.screenSize();
    const px = Math.min(1920, this.ctx.maxTextureSize);
    const wPx = w >= h ? px : Math.round(px * w / h), hPx = w >= h ? Math.round(px * h / w) : px;
    const id = this.entity.id;
    const media = createContentMedia(src, this.ctx.assets, {
      maxTextureSize: this.ctx.maxTextureSize,
      gen: { wPx, hPx, panelPxW: wPx, panelPxH: hPx, cols: 1, rows: 1 },
      onError: msg => console.warn('[equipment screen]', msg),
    });
    this.media = media;
    this.mediaLoading = true;
    this.ctx.setLoading(id, SCREEN_LOADING_KEY, true);
    media.ready.then(() => {
      if (this.media !== media) return;
      this.mediaLoading = false;
      this.ctx.setLoading(id, SCREEN_LOADING_KEY, false);
      this.applyScreen();
      this.ctx.invalidate();
    }).catch(() => {
      if (this.media !== media) return;
      this.mediaLoading = false;
      this.ctx.setLoading(id, SCREEN_LOADING_KEY, false);
    });
  }

  private disposeMedia(): void {
    if (this.mediaLoading) { this.mediaLoading = false; this.ctx.setLoading(this.entity.id, SCREEN_LOADING_KEY, false); }
    this.media?.dispose();
    this.media = null;
  }

  /** Put the current media texture (if ready) on the screen plane; hide the plane otherwise. */
  private applyScreen(): void {
    const screen = this.build?.screen;
    if (!screen) return;
    const mat = screen.material as THREE.MeshBasicMaterial;
    const tex = this.media?.texture ?? null;
    if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
    if (tex && this.media) {
      const { w, h } = this.screenSize();
      coverFit(tex, this.media.width, this.media.height, w, h);
    }
    screen.visible = !!tex;
  }

  /* ───────────────────────── frame / queries ───────────────────────── */

  frame(_dt: number, ctx: RenderContext): boolean {
    if (this.photo) {
      // Keep the cutout turned towards the camera about Y, cancelling the entity's own yaw so the
      // billboard is absolute. Reports a change only when it actually turned, so a still camera
      // does not keep the render loop awake.
      if (this.entity.billboard === false) return false;
      const yaw = THREE.MathUtils.degToRad(this.entity.transform.rotation[1]);
      return faceCameraY(this.photo.group, ctx.camera, yaw);
    }
    return this.media ? this.media.update() : false;
  }

  /**
   * Bounds come from the declared width/height/depth, never the billboard plane: the plane spins
   * with the camera and is as thin as paper, so using it would make selection boxes, framing,
   * snapping and measurements wobble as you orbit.
   */
  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    this.root.updateWorldMatrix(true, false);
    // A CAD product is measured the same way: the declared dims are the published ones and the mesh
    // is scaled to them, so the box is right from the first frame, before the mesh has loaded.
    if (this.photo || this.cad) {
      const [w, h, d] = safeDims(this.entity.dims);
      out.set(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, h, d / 2));
      return out.applyMatrix4(this.root.matrixWorld);
    }
    if (!this.build) return out;
    return equipmentBounds(this.build, out);
  }

  selectionMeshes(): THREE.Mesh[] {
    if (this.photo) return [this.photo.plane];
    if (this.cad) return [this.cad.mesh ?? this.cad.placeholder];
    return this.build ? this.build.meshes : [];
  }

  /**
   * Top of the item in local space (for stacking small items on it), or null when no build exists.
   * Uses the same clamped dims the model was built from.
   */
  topSurfaceY(): number | null {
    return this.build || this.photo || this.cad ? safeDims(this.entity.dims)[1] : null;
  }

  dispose(): void {
    this.disposeMedia();
    this.disposeBuilds();
    this.root.removeFromParent();
  }
}

export const createEquipmentRenderer: RendererFactory = (entity, ctx) => new EquipmentRenderer(entity as EquipmentEntity, ctx);
