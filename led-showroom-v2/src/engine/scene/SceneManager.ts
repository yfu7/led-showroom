/**
 * Keeps the three.js scene in sync with the document. One EntityRenderer per entity; diffing is
 * structural (JSON equality on the entity plus a "global version" that bumps when settings that
 * affect every renderer change).
 */
import * as THREE from 'three';
import type { Document, Entity, EntityType } from '../document/types';
import { jsonEq } from '../math';
import type { EntityRenderer, RenderContext, RendererFactory } from '../entities/EntityRenderer';
import { applyTransform } from '../entities/EntityRenderer';

export class SceneManager {
  readonly scene = new THREE.Scene();
  /** Parent of all entity roots. */
  readonly world = new THREE.Group();
  private factories = new Map<EntityType, RendererFactory>();
  private renderers = new Map<string, EntityRenderer>();
  private lastEntity = new Map<string, Entity>();
  private lastGlobalKey = '';

  constructor() {
    this.world.name = 'world';
    this.scene.add(this.world);
  }

  register(type: EntityType, factory: RendererFactory): void { this.factories.set(type, factory); }

  get(id: string): EntityRenderer | undefined { return this.renderers.get(id); }
  all(): EntityRenderer[] { return Array.from(this.renderers.values()); }
  rootOf(id: string): THREE.Object3D | undefined { return this.renderers.get(id)?.root; }

  /** Fields outside the entity that change how entities render. */
  private globalKey(doc: Document): string {
    const s = doc.settings;
    return JSON.stringify([s.units, s.spanContent, s.pixelGridDistIn, s.autoRotate, doc.environment.lighting, doc.environment.backdrop.photo?.url ?? null]);
  }

  /** Reconcile the scene with `doc`. Returns ids that were created/updated/removed. */
  sync(doc: Document, ctx: RenderContext, force = false): { created: string[]; updated: string[]; removed: string[] } {
    const created: string[] = [], updated: string[] = [], removed: string[] = [];
    const gk = this.globalKey(doc);
    const globalChanged = force || gk !== this.lastGlobalKey;
    this.lastGlobalKey = gk;

    const seen = new Set<string>();
    doc.entities.forEach((entity, index) => {
      seen.add(entity.id);
      let r = this.renderers.get(entity.id);
      if (!r) {
        const f = this.factories.get(entity.type);
        if (!f) { console.warn('[scene] no renderer for', entity.type); return; }
        r = f(entity, ctx);
        r.root.userData.entityId = entity.id;
        r.root.userData.entityType = entity.type;
        this.renderers.set(entity.id, r);
        this.lastEntity.set(entity.id, entity);
        created.push(entity.id);
      } else {
        const prev = this.lastEntity.get(entity.id);
        if (globalChanged || prev !== entity && !jsonEq(prev, entity)) {
          r.update(entity, ctx);
          this.lastEntity.set(entity.id, entity);
          updated.push(entity.id);
        }
      }
      // hierarchy + transform are cheap to re-apply every sync
      const parent = entity.parentId ? this.renderers.get(entity.parentId)?.root ?? this.world : this.world;
      if (r.root.parent !== parent) parent.add(r.root);
      applyTransform(r.root, entity.transform);
      r.root.visible = entity.visible;
      r.root.renderOrder = index;
    });

    for (const [id, r] of Array.from(this.renderers.entries())) {
      if (!seen.has(id)) {
        r.dispose();
        this.renderers.delete(id);
        this.lastEntity.delete(id);
        removed.push(id);
      }
    }
    return { created, updated, removed };
  }

  /** Per-frame hook for renderers. Returns true if a render is needed. */
  frame(dt: number, ctx: RenderContext): boolean {
    let dirty = false;
    for (const r of this.renderers.values()) if (r.frame && r.frame(dt, ctx)) dirty = true;
    return dirty;
  }

  /** World bounds of a set of entities (or all). */
  bounds(ids?: Iterable<string>, out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    const list = ids ? Array.from(ids).map(id => this.renderers.get(id)).filter(Boolean) as EntityRenderer[] : this.all();
    const b = new THREE.Box3();
    for (const r of list) { if (r.root.visible) { r.bounds(b); if (!b.isEmpty()) out.union(b); } }
    return out;
  }

  dispose(): void {
    for (const r of this.renderers.values()) r.dispose();
    this.renderers.clear();
    this.lastEntity.clear();
  }
}
