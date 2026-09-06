/**
 * Group renderer: an empty Object3D the SceneManager parents child entity roots under
 * (`entity.parentId`). The group draws nothing itself; its bounds are the union of its
 * children's visible, pickable meshes. Selecting a group outlines its children — that is the
 * engine's job, so `selectionMeshes()` is empty.
 */
import * as THREE from 'three';
import type { GroupEntity } from '../document/types';
import type { EntityRenderer, RenderContext, RendererFactory } from './EntityRenderer';
import { tagRoot } from './EntityRenderer';

/**
 * World bounds of every visible, pickable mesh under `obj`. Unlike `Picking.objectBounds` this
 * skips whole hidden subtrees (`traverseVisible`), so a hidden child entity does not count.
 */
export function visibleMeshBounds(obj: THREE.Object3D, out = new THREE.Box3()): THREE.Box3 {
  out.makeEmpty();
  obj.updateWorldMatrix(true, true);
  const b = new THREE.Box3();
  obj.traverseVisible(o => {
    if (o.userData.helper || o.userData.unpickable) return;
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    out.union(b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld));
  });
  return out;
}

export class GroupRenderer implements EntityRenderer<GroupEntity> {
  entity: GroupEntity;
  readonly root = new THREE.Group();

  constructor(entity: GroupEntity, _ctx: RenderContext) {
    this.entity = entity;
    tagRoot(this.root, entity);
  }

  update(entity: GroupEntity, _ctx: RenderContext): void {
    this.entity = entity;
    tagRoot(this.root, entity);
  }

  /** Union of every visible child root's meshes (nested groups included). */
  bounds(out = new THREE.Box3()): THREE.Box3 {
    return visibleMeshBounds(this.root, out);
  }

  selectionMeshes(): THREE.Mesh[] { return []; }

  dispose(): void {
    // Children are other entities' roots; the SceneManager re-parents or disposes them itself.
    this.root.removeFromParent();
  }
}

export const createGroupRenderer: RendererFactory = (entity, ctx) => new GroupRenderer(entity as GroupEntity, ctx);
