/**
 * Contract for entity renderers: document entity → three.js objects.
 *
 * Every renderer owns exactly one root Object3D per entity (tagged with userData.entityId and
 * userData.entityType). The SceneManager calls `update` whenever the entity's JSON changes
 * (compared structurally), and `frame` every rendered frame for time-based work (video textures,
 * pixel-grid fade, label scaling).
 */
import * as THREE from 'three';
import type { Document, Entity } from '../document/types';
import type { AssetStore } from '../persistence/AssetStore';

export interface RenderContext {
  /** Read-only access to the whole document (walls need global settings, stages, span mode). */
  doc: Document;
  assets: AssetStore;
  camera: THREE.Camera;
  /** Ask for a re-render (render-on-demand loop). */
  invalidate(): void;
  /** Report async loading state for the HUD. */
  setLoading(entityId: string, key: string, loading: boolean): void;
  /** Display unit for labels. */
  unit: Document['settings']['units'];
  /** Whether the CSS3D layer / pixel-grid overlay are currently needed (renderers set flags). */
  needs: { css3d: boolean; pixelGrid: boolean };
  /** Max WebGL texture size. */
  maxTextureSize: number;
}

export interface EntityRenderer<E extends Entity = Entity> {
  readonly entity: E;
  readonly root: THREE.Object3D;
  /** Apply a new version of the entity (and possibly changed global context). */
  update(entity: E, ctx: RenderContext): void;
  /** Per-frame hook. Return true if something changed and a render is needed. */
  frame?(dt: number, ctx: RenderContext): boolean;
  /** World-space bounds of the visible geometry. */
  bounds(out?: THREE.Box3): THREE.Box3;
  /** Objects used for selection outlines (meshes). */
  selectionMeshes(): THREE.Mesh[];
  /** Height of the top surface at local (x, z) for stacking (stages), or null. */
  topSurfaceY?(): number | null;
  /** Set by renderers that mount CSS3D objects (websites) so the DOM pass runs. */
  needsCss3d?: boolean;
  /** Set by renderers while a pixel-grid overlay is visible so the overlay pass runs. */
  needsPixelGrid?: boolean;
  dispose(): void;
}

export type RendererFactory = (entity: Entity, ctx: RenderContext) => EntityRenderer;

/** Copy a document transform onto an Object3D (degrees → radians). */
export function applyTransform(obj: THREE.Object3D, t: Entity['transform']): void {
  obj.position.set(t.position[0], t.position[1], t.position[2]);
  obj.rotation.set(THREE.MathUtils.degToRad(t.rotation[0]), THREE.MathUtils.degToRad(t.rotation[1]), THREE.MathUtils.degToRad(t.rotation[2]), 'YXZ');
  obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
}

/** Read an Object3D's transform back into document form (radians → degrees). */
export function readTransform(obj: THREE.Object3D): Entity['transform'] {
  const e = obj.rotation.clone().reorder('YXZ');
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotation: [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  };
}

export function tagRoot(root: THREE.Object3D, entity: Entity): void {
  root.name = `${entity.type}:${entity.id}`;
  root.userData.entityId = entity.id;
  root.userData.entityType = entity.type;
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry && !m.userData.sharedGeometry) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (mat && !m.userData.sharedMaterial) {
      for (const mm of Array.isArray(mat) ? mat : [mat]) {
        for (const v of Object.values(mm as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
        mm.dispose();
      }
    }
  });
  obj.removeFromParent();
}
