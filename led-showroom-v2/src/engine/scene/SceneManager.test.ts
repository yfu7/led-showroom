/**
 * Integration: a document with every entity type syncs through the real renderers in node
 * (no WebGL). Guards the renderer registry, entity tagging, bounds and disposal.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SceneManager } from './SceneManager';
import type { RenderContext } from '../entities/EntityRenderer';
import { createDocument, createEquipment, createLedWall, createRoom, createStage, createDimension, createGroup } from '../document/defaults';
import { addEntity } from '../document/Document';
import { createLedWallRenderer } from '../entities/LedWallRenderer';
import { createStageRenderer } from '../entities/StageRenderer';
import { createEquipmentRenderer } from '../entities/EquipmentRenderer';
import { createRoomRenderer } from '../entities/RoomRenderer';
import { createDimensionRenderer } from '../entities/DimensionRenderer';
import { createGroupRenderer } from '../entities/GroupRenderer';
import { EQUIPMENT } from '../catalog/equipment';
import { AssetStore } from '../persistence/AssetStore';
import type { Document } from '../document/types';

function ctxFor(doc: Document): RenderContext {
  return {
    doc,
    assets: new AssetStore(),
    camera: new THREE.PerspectiveCamera(40, 1.6, 1, 60000),
    invalidate() {},
    setLoading() {},
    unit: doc.settings.units,
    needs: { css3d: false, pixelGrid: false },
    maxTextureSize: 4096,
  };
}

function manager(): SceneManager {
  const s = new SceneManager();
  s.register('led-wall', createLedWallRenderer);
  s.register('stage', createStageRenderer);
  s.register('equipment', createEquipmentRenderer);
  s.register('room', createRoomRenderer);
  s.register('dimension', createDimensionRenderer);
  s.register('group', createGroupRenderer);
  return s;
}

describe('SceneManager + renderers', () => {
  it('creates one tagged root per entity and sane bounds', () => {
    let doc = createDocument('t');
    const wall = createLedWall({ cols: 4, rows: 3 });
    wall.corners = [{ afterCol: 1, angle: 90 }];
    wall.accessories = true;
    wall.showDimensions = true;
    wall.pixelGrid = true;
    const stage = createStage(24, [0, 0, 80]);
    const eq = createEquipment(EQUIPMENT[0], [60, 0, 40]);
    const room = createRoom();
    const dim = createDimension([0, 0, 0], [48, 0, 0]);
    const grp = createGroup('G');
    for (const e of [wall, stage, eq, room, dim, grp]) doc = addEntity(doc, e);

    const s = manager();
    const ctx = ctxFor(doc);
    const res = s.sync(doc, ctx);
    expect(res.created.length).toBe(6);
    for (const e of doc.entities) {
      const r = s.get(e.id)!;
      expect(r).toBeTruthy();
      expect(r.root.userData.entityId).toBe(e.id);
      expect(r.root.userData.entityType).toBe(e.type);
      expect(r.root.parent).toBe(s.world);
    }
    const wb = s.get(wall.id)!.bounds();
    expect(wb.isEmpty()).toBe(false);
    // wall stands on the floor (lifted by the base plate thickness when accessories are on)
    expect(wb.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(wb.max.y).toBeGreaterThan(50);
    const sb = s.get(stage.id)!.bounds();
    expect(sb.max.y).toBeCloseTo(24, 1);
    expect(sb.getCenter(new THREE.Vector3()).z).toBeCloseTo(80, 1);
    const eb = s.get(eq.id)!.bounds();
    expect(eb.min.y).toBeGreaterThan(-1);
    expect(eb.max.y).toBeGreaterThan(20);
    expect(s.get(wall.id)!.selectionMeshes().length).toBe(12);
    expect(s.get(wall.id)!.needsPixelGrid).toBe(true);
  });

  it('updates on entity change and removes deleted entities', () => {
    let doc = createDocument('t');
    const wall = createLedWall({ cols: 2, rows: 2 });
    doc = addEntity(doc, wall);
    const s = manager();
    const ctx = ctxFor(doc);
    s.sync(doc, ctx);
    const before = s.get(wall.id)!.selectionMeshes().length;
    expect(before).toBe(4);
    const doc2: Document = { ...doc, entities: doc.entities.map(e => (e.id === wall.id ? { ...e, cols: 3 } : e)) as Document['entities'] };
    const res = s.sync(doc2, { ...ctx, doc: doc2 });
    expect(res.updated).toEqual([wall.id]);
    expect(s.get(wall.id)!.selectionMeshes().length).toBe(6);
    const doc3: Document = { ...doc2, entities: [] };
    const res2 = s.sync(doc3, { ...ctx, doc: doc3 });
    expect(res2.removed).toEqual([wall.id]);
    expect(s.get(wall.id)).toBeUndefined();
    expect(s.world.children.length).toBe(0);
  });

  it('parents children under groups and applies transforms in degrees', () => {
    let doc = createDocument('t');
    const grp = createGroup('G');
    const stage = createStage(16, [10, 0, 0]);
    stage.parentId = grp.id;
    stage.transform.rotation = [0, 90, 0];
    doc = addEntity(addEntity(doc, grp), stage);
    const s = manager();
    s.sync(doc, ctxFor(doc));
    const r = s.get(stage.id)!;
    expect(r.root.parent).toBe(s.get(grp.id)!.root);
    expect(r.root.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });
});
