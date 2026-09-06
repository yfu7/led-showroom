/**
 * Stage deck renderer (v1 index.html 7186-7276): a solid box with a dark top and a darker skirt,
 * outlined with edge lines. The entity origin is the bottom centre of the deck, so the box is
 * centred at `y = heightIn / 2` and the deck spans `y ∈ [0, heightIn]` in local space. Footprint
 * and height scale with the entity transform (v1 `stageTotalScale`).
 */
import * as THREE from 'three';
import type { StageEntity } from '../document/types';
import type { EntityRenderer, RenderContext, RendererFactory } from './EntityRenderer';
import { tagRoot } from './EntityRenderer';
import { createWallMaterials, type WallMaterials } from '../ledwall/geometry';

/** Dimensions a stage deck is drawn from. */
export interface StageDims {
  widthIn: number;
  depthIn: number;
  heightIn: number;
}

/** One shared material table for every stage (v1 `_stageTopMat` / `_stageSkirtMat` / `_stageEdgeMat`). */
let sharedMats: WallMaterials | null = null;
function mats(): WallMaterials { return (sharedMats ??= createWallMaterials()); }

/* ───────────────────────────── Pure placement maths ───────────────────────────── */

/** Local centre of the deck box: bottom-centre origin → the box is lifted by half its height. */
export function stageDeckCenter(d: StageDims): [number, number, number] {
  return [0, d.heightIn / 2, 0];
}

/** Local y of the walking surface (the caller multiplies by the entity's y scale). */
export function stageTopY(d: StageDims): number {
  return d.heightIn;
}

/** Local-space bounds of the deck: x/z centred, y from the floor to the top surface. */
export function stageLocalBounds(d: StageDims): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [-d.widthIn / 2, 0, -d.depthIn / 2],
    max: [d.widthIn / 2, d.heightIn, d.depthIn / 2],
  };
}

/**
 * BoxGeometry material order is +x, -x, +y (top), -y, +z, -z (v1 7237-7238): the top face gets
 * the deck material, every other face the skirt.
 */
export function stageMaterialArray(top: THREE.Material, side: THREE.Material): THREE.Material[] {
  return [side, side, top, side, side, side];
}

/** Skirt colour derived from a custom deck colour: the same hue, a touch lighter (v1 skirt 0x242428 vs top 0x1a1a1a). */
export function stageSkirtColor(color: THREE.Color, out = new THREE.Color()): THREE.Color {
  return out.copy(color).offsetHSL(0, 0, 0.04);
}

/* ───────────────────────────── Renderer ───────────────────────────── */

export class StageRenderer implements EntityRenderer<StageEntity> {
  entity: StageEntity;
  readonly root = new THREE.Group();
  readonly box: THREE.Mesh;
  readonly edges: THREE.LineSegments;
  /** Cloned materials when `entity.color` overrides the shared table. */
  private customTop: THREE.MeshStandardMaterial | null = null;
  private customSide: THREE.MeshStandardMaterial | null = null;
  private dimsKey = '';
  private colorKey: string | undefined = undefined;

  constructor(entity: StageEntity, ctx: RenderContext) {
    this.entity = entity;
    tagRoot(this.root, entity);

    const m = mats();
    this.box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), stageMaterialArray(m.stageTop, m.stageSide));
    this.box.name = 'stage-deck';
    this.box.userData.part = 'stage';
    this.box.userData.sharedMaterial = true;
    this.box.castShadow = true;
    this.box.receiveShadow = true;
    this.root.add(this.box);

    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.box.geometry), m.stageEdge);
    this.edges.name = 'stage-edges';
    this.edges.userData.sharedMaterial = true;
    this.edges.userData.helper = true;
    this.edges.userData.unpickable = true;
    this.root.add(this.edges);

    this.update(entity, ctx);
  }

  update(entity: StageEntity, _ctx: RenderContext): void {
    this.entity = entity;
    const dKey = `${entity.widthIn}|${entity.heightIn}|${entity.depthIn}`;
    if (dKey !== this.dimsKey) { this.dimsKey = dKey; this.rebuildGeometry(); }
    if (entity.color !== this.colorKey) { this.colorKey = entity.color; this.applyColor(); }
  }

  private rebuildGeometry(): void {
    const e = this.entity;
    const w = Math.max(0.01, e.widthIn), h = Math.max(0.01, e.heightIn), d = Math.max(0.01, e.depthIn);
    this.box.geometry.dispose();
    this.edges.geometry.dispose();
    this.box.geometry = new THREE.BoxGeometry(w, h, d);
    this.edges.geometry = new THREE.EdgesGeometry(this.box.geometry);
    const [cx, cy, cz] = stageDeckCenter(e);
    this.box.position.set(cx, cy, cz);
    this.edges.position.set(cx, cy, cz);
  }

  private applyColor(): void {
    const m = mats();
    const color = this.entity.color;
    if (color) {
      if (!this.customTop) { this.customTop = m.stageTop.clone(); this.customSide = m.stageSide.clone(); }
      this.customTop.color.set(color);
      stageSkirtColor(this.customTop.color, this.customSide!.color);
      this.box.material = stageMaterialArray(this.customTop, this.customSide!);
      this.box.userData.sharedMaterial = false;
    } else {
      this.box.material = stageMaterialArray(m.stageTop, m.stageSide);
      this.box.userData.sharedMaterial = true;
      this.customTop?.dispose(); this.customSide?.dispose();
      this.customTop = null; this.customSide = null;
    }
  }

  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    this.root.updateWorldMatrix(true, true);
    const g = this.box.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return out.copy(g.boundingBox!).applyMatrix4(this.box.matrixWorld);
  }

  selectionMeshes(): THREE.Mesh[] { return [this.box]; }

  topSurfaceY(): number { return stageTopY(this.entity); }

  dispose(): void {
    this.box.geometry.dispose();
    this.edges.geometry.dispose();
    this.customTop?.dispose();
    this.customSide?.dispose();
    this.customTop = null; this.customSide = null;
    this.root.removeFromParent();
  }
}

export const createStageRenderer: RendererFactory = (entity, ctx) => new StageRenderer(entity as StageEntity, ctx);
