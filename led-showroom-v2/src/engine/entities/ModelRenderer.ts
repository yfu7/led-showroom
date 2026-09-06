/**
 * Imported model renderer (glTF/GLB, OBJ, STL, FBX, PLY). The file is resolved through the asset
 * store (Blob) or a URL, loaded lazily, scaled from its source unit to inches and re-centred so
 * it stands on the floor at its footprint centre. While loading / on failure a 24" wireframe box
 * marks the entity's position so it stays visible and pickable.
 *
 * Measured dims (inches) are exposed through `onMeasured` and `root.userData.measuredDims` so
 * the UI can write them back into the entity (`dims`) through a command.
 */
import * as THREE from 'three';
import type { ModelEntity } from '../document/types';
import type { EntityRenderer, RenderContext } from './EntityRenderer';
import { disposeObject, tagRoot } from './EntityRenderer';
import { fitOnFloor, loadModel, unitScaleToInches } from '../content/modelLoaders';
import type { Vec3 } from '../math';

const PLACEHOLDER_SIZE_IN = 24;
const LOADING_KEY = 'model';

export class ModelRenderer implements EntityRenderer<ModelEntity> {
  entity: ModelEntity;
  readonly root = new THREE.Group();
  /** Called after each successful load with the measured size in inches. */
  onMeasured?: (dims: Vec3) => void;

  private ctx: RenderContext;
  /** The scaled + floor-fitted group holding the loaded object. */
  private fit: THREE.Group | null = null;
  /** The raw loaded object (unscaled), kept so a unit change only needs a re-fit. */
  private loaded: THREE.Object3D | null = null;
  private meshes: THREE.Mesh[] = [];
  private placeholder: THREE.Mesh;
  private placeholderMat: THREE.MeshBasicMaterial;
  private sourceKey = '';
  private unitKey = '';
  private loadToken = 0;
  private disposed = false;
  private _dims: Vec3 | null = null;
  private static readonly _box = new THREE.Box3();

  constructor(entity: ModelEntity, ctx: RenderContext) {
    this.entity = entity;
    this.ctx = ctx;
    tagRoot(this.root, entity);
    this.placeholderMat = new THREE.MeshBasicMaterial({ color: 0x8a94a6, wireframe: true, transparent: true, opacity: 0.8 });
    this.placeholder = new THREE.Mesh(new THREE.BoxGeometry(PLACEHOLDER_SIZE_IN, PLACEHOLDER_SIZE_IN, PLACEHOLDER_SIZE_IN), this.placeholderMat);
    this.placeholder.position.y = PLACEHOLDER_SIZE_IN / 2;
    this.placeholder.name = 'placeholder';
    this.placeholder.userData.placeholder = true;
    this.root.add(this.placeholder);
    this.update(entity, ctx);
  }

  /** Measured size in inches, or null before the first successful load. */
  get measuredDims(): Vec3 | null { return this._dims; }

  update(entity: ModelEntity, ctx: RenderContext): void {
    this.entity = entity;
    this.ctx = ctx;
    const sKey = JSON.stringify([entity.url ?? null, entity.assetId ?? null, entity.format]);
    if (sKey !== this.sourceKey) {
      this.sourceKey = sKey;
      this.unitKey = entity.sourceUnit;
      void this.load();
      return;
    }
    if (entity.sourceUnit !== this.unitKey) {
      this.unitKey = entity.sourceUnit;
      if (this.loaded) this.refit();
    }
  }

  /* ───────────────────────── loading ───────────────────────── */

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const e = this.entity;
    const ctx = this.ctx;
    this.clearModel();
    this.showPlaceholder(0x8a94a6);
    ctx.setLoading(e.id, LOADING_KEY, true);
    try {
      let source: Blob | string | null = null;
      if (e.assetId) source = await ctx.assets.getBlob(e.assetId);
      if (!source && e.url) source = e.url;
      if (token !== this.loadToken || this.disposed) return;
      if (!source) throw new Error(`Model "${e.fileName}" has no readable source`);
      const obj = await loadModel(source, e.format, e.fileName);
      if (token !== this.loadToken || this.disposed) { disposeObject(obj); return; }
      this.loaded = obj;
      this.refit();
      this.placeholder.visible = false;
    } catch (err) {
      if (token !== this.loadToken || this.disposed) return;
      console.warn(`[model] failed to load ${e.fileName}:`, err);
      this.showPlaceholder(0xe05555);
    } finally {
      if (token === this.loadToken && !this.disposed) ctx.setLoading(e.id, LOADING_KEY, false);
      ctx.invalidate();
    }
  }

  /** (Re)build the scaled, floor-fitted group around the loaded object and measure it. */
  private refit(): void {
    if (!this.loaded) return;
    if (this.fit) { this.fit.removeFromParent(); this.loaded.removeFromParent(); this.fit = null; }
    const scale = unitScaleToInches(this.entity.sourceUnit);
    const { group, dims } = fitOnFloor(this.loaded, scale);
    this.fit = group;
    this.root.add(group);
    this.meshes = [];
    group.traverse(o => { if ((o as THREE.Mesh).isMesh) this.meshes.push(o as THREE.Mesh); });
    this._dims = dims;
    this.root.userData.measuredDims = dims;
    this.onMeasured?.(dims);
    this.ctx.invalidate();
  }

  private clearModel(): void {
    if (this.fit) { disposeObject(this.fit); this.fit = null; }
    this.loaded = null;
    this.meshes = [];
  }

  private showPlaceholder(color: number): void {
    this.placeholderMat.color.setHex(color);
    this.placeholder.visible = true;
  }

  /* ───────────────────────── contract ───────────────────────── */

  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    this.root.updateMatrixWorld(true);
    if (this.fit) {
      const b = ModelRenderer._box;
      for (const m of this.meshes) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
        out.union(b);
      }
      // point clouds (PLY) have no meshes; fall back to the whole group
      if (out.isEmpty()) out.setFromObject(this.fit, false);
    }
    if (out.isEmpty()) out.setFromObject(this.placeholder, false);
    return out;
  }

  selectionMeshes(): THREE.Mesh[] {
    return this.fit ? this.meshes : [this.placeholder];
  }

  dispose(): void {
    this.disposed = true;
    this.loadToken++;
    this.ctx.setLoading(this.entity.id, LOADING_KEY, false);
    this.clearModel();
    disposeObject(this.root);
  }
}

export const createModelRenderer = (entity: ModelEntity, ctx: RenderContext): ModelRenderer => new ModelRenderer(entity, ctx);
