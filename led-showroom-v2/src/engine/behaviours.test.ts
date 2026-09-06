import { describe, it, expect } from 'vitest';
import {
  AUTO_ROTATE_SPEED, applyBehaviours, autoRotateAngle, carryTransform, matrixOf, normaliseDimensions, parentMatrix, rideTransform, spanSource, stageTopY,
  syncRiders, transformOf, worldMatrix,
} from './behaviours';
import { createDimension, createDocument, createEquipment, createGroup, createLedWall, createStage } from './document/defaults';
import { removeEntities, withEntity } from './document/Document';
import type { Document, Entity, LedWallEntity, StageEntity, Transform } from './document/types';
import type { Vec3 } from './math';

const tf = (position: Vec3, rotation: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): Transform => ({ position, rotation, scale });

function scene(groundLock = true): { doc: Document; stage: StageEntity; wall: LedWallEntity } {
  const stage = createStage(24, [10, 0, 5]);
  const wall = createLedWall({ position: [10, 24, -15] });
  wall.attachedTo = stage.id;
  const doc: Document = { ...createDocument(), entities: [stage, wall] };
  doc.settings.snap.groundLock = groundLock;
  return { doc, stage, wall };
}

const move = (doc: Document, id: string, t: Transform): Document => withEntity(doc, id, { transform: t } as Partial<Entity>);
const pos = (doc: Document, id: string): Vec3 => doc.entities.find(e => e.id === id)!.transform.position;
const rot = (doc: Document, id: string): Vec3 => doc.entities.find(e => e.id === id)!.transform.rotation;

describe('stageTopY', () => {
  it('is position.y + heightIn × scale.y', () => {
    const s = createStage(16, [0, 4, 0]);
    s.transform.scale = [1, 2, 1];
    expect(stageTopY(s)).toBe(36);
  });
});

describe('rideTransform', () => {
  it('translates the rider by the stage delta and pins y to the deck top', () => {
    const p = createStage(24, [0, 0, 0]);
    const n = { ...p, transform: tf([30, 0, -10]) };
    const r = rideTransform(tf([0, 24, -20]), p, n, true);
    expect(r.position).toEqual([30, 24, -30]);
  });
  it('yaws the rider about the stage centre and adds the yaw delta', () => {
    const p = createStage(24, [0, 0, 0]);
    const n = { ...p, transform: tf([0, 0, 0], [0, 90, 0]) };
    const r = rideTransform(tf([0, 24, -20], [0, 10, 0]), p, n, true);
    // three.js +90° about Y maps (0,0,-20) to (-20,0,0)
    expect(r.position[0]).toBeCloseTo(-20, 9);
    expect(r.position[2]).toBeCloseTo(0, 9);
    expect(r.rotation[1]).toBe(100);
  });
  it('without ground-lock follows the vertical delta instead of snapping to the top', () => {
    const p = createStage(24, [0, 0, 0]);
    const n = { ...p, transform: tf([0, 6, 0]) };
    expect(rideTransform(tf([0, 30, 0]), p, n, false).position[1]).toBe(36);
    expect(rideTransform(tf([0, 30, 0]), p, n, true).position[1]).toBe(30);
  });
  it('scales the horizontal offset with the deck', () => {
    const p = createStage(24, [0, 0, 0]);
    const n = { ...p, transform: tf([0, 0, 0], [0, 0, 0], [2, 1, 2]) };
    expect(rideTransform(tf([0, 24, -20]), p, n, true).position).toEqual([0, 24, -40]);
  });
});

describe('syncRiders', () => {
  it('returns the same document when nothing relevant changed', () => {
    const { doc } = scene();
    expect(syncRiders(doc, doc)).toBe(doc);
  });
  it('carries the rider when the stage moves', () => {
    const { doc, stage, wall } = scene();
    const next = move(doc, stage.id, tf([40, 0, 5]));
    const out = syncRiders(next, doc);
    expect(pos(out, wall.id)).toEqual([40, 24, -15]);
    expect(out).not.toBe(next);
  });
  it('does not double-move a rider that moved together with its stage', () => {
    const { doc, stage, wall } = scene();
    const next = move(move(doc, stage.id, tf([40, 0, 5])), wall.id, tf([40, 24, -15]));
    expect(pos(syncRiders(next, doc), wall.id)).toEqual([40, 24, -15]);
  });
  it('re-lifts riders when the deck height changes (ground-lock)', () => {
    const { doc, stage, wall } = scene();
    const next = withEntity(doc, stage.id, { heightIn: 40 } as Partial<Entity>);
    expect(pos(syncRiders(next, doc), wall.id)[1]).toBe(40);
  });
  it('lifts a freshly attached entity onto the deck', () => {
    const { doc, stage } = scene();
    const eq = createEquipment({ id: 'x', name: 'Box', geometry: 'box', dims: [10, 10, 10], color: '#fff' }, [12, 0, 6]);
    const next: Document = { ...doc, entities: [...doc.entities, { ...eq, attachedTo: stage.id }] };
    expect(pos(syncRiders(next, doc), eq.id)).toEqual([12, 24, 6]);
  });
  it('leaves y alone without ground-lock unless the stage moved', () => {
    const { doc, stage, wall } = scene(false);
    const lifted = move(doc, wall.id, tf([10, 30, -15]));
    expect(syncRiders(lifted, doc)).toBe(lifted);
    const next = move(lifted, stage.id, tf([10, 2, 5]));
    expect(pos(syncRiders(next, lifted), wall.id)).toEqual([10, 32, -15]);
  });
  it('drops riders to the floor when their stage is deleted', () => {
    const { doc, stage, wall } = scene();
    const next = removeEntities(doc, [stage.id]);
    const out = syncRiders(next, doc);
    expect(out.entities.find(e => e.id === wall.id)!.attachedTo).toBeNull();
    expect(pos(out, wall.id)).toEqual([10, 0, -15]);
  });
  it('rides back on undo of a stage move', () => {
    const { doc, stage, wall } = scene();
    const moved = syncRiders(move(doc, stage.id, tf([40, 0, 5], [0, 45, 0])), doc);
    const undone = syncRiders(move(moved, stage.id, doc.entities[0].transform), moved);
    expect(pos(undone, wall.id)[0]).toBeCloseTo(10, 9);
    expect(pos(undone, wall.id)[2]).toBeCloseTo(-15, 9);
    expect(rot(undone, wall.id)[1]).toBeCloseTo(0, 9);
  });
  it('lifts a rider back onto the deck when its deleted stage is restored (undo), even without ground-lock', () => {
    const { doc, stage, wall } = scene(false);
    // delete → the post-change drop puts the wall on the floor
    const deleted = syncRiders(removeEntities(doc, [stage.id]), doc);
    expect(pos(deleted, wall.id)[1]).toBe(0);
    // undo (cmdRemoveEntities.undo): re-add the stage and re-set attachedTo, nothing else
    const undone: Document = { ...deleted, entities: [stage, ...deleted.entities.map(e => (e.id === wall.id ? { ...e, attachedTo: stage.id } : e))] };
    const out = syncRiders(undone, deleted);
    expect(pos(out, wall.id)).toEqual([10, 24, -15]);
    // a rider that is attached without ground-lock and did not lose its stage keeps its own y
    const floating = move(doc, wall.id, tf([10, 30, -15]));
    expect(syncRiders(floating, doc)).toBe(floating);
  });
});

describe('carryTransform', () => {
  it('translates the deck by the rider delta and keeps the deck y', () => {
    const out = carryTransform(tf([10, 0, 5]), tf([10, 24, -15]), tf([40, 30, -15]));
    expect(out.position).toEqual([40, 0, 5]);
  });
  it('yaws the deck about the rider and adds the yaw delta', () => {
    const out = carryTransform(tf([10, 0, 5]), tf([10, 24, -15]), tf([10, 24, -15], [0, 90, 0]));
    expect(out.position[0]).toBeCloseTo(30, 9);
    expect(out.position[2]).toBeCloseTo(-15, 9);
    expect(out.rotation[1]).toBe(90);
  });
  it('ignores a purely vertical move and the rider scale', () => {
    const stage = tf([10, 0, 5]);
    expect(carryTransform(stage, tf([10, 24, -15]), tf([10, 60, -15]))).toEqual(stage);
    expect(carryTransform(stage, tf([10, 24, -15]), tf([10, 24, -15], [0, 0, 0], [3, 3, 3]))).toEqual(stage);
  });
});

describe('syncRiders deck-follows-rider', () => {
  it('carries the stage when its rider moves alone', () => {
    const { doc, stage, wall } = scene();
    const out = syncRiders(move(doc, wall.id, tf([40, 24, -15])), doc);
    expect(pos(out, stage.id)).toEqual([40, 0, 5]);
    expect(pos(out, wall.id)).toEqual([40, 24, -15]); // the rider itself is not moved again
  });
  it('yaws the stage with its rider', () => {
    const { doc, stage, wall } = scene();
    const out = syncRiders(move(doc, wall.id, tf([10, 24, -15], [0, 90, 0])), doc);
    expect(pos(out, stage.id)[0]).toBeCloseTo(30, 9);
    expect(pos(out, stage.id)[2]).toBeCloseTo(-15, 9);
    expect(rot(out, stage.id)[1]).toBeCloseTo(90, 9);
  });
  it('takes the deck’s other riders along', () => {
    const { doc, stage, wall } = scene();
    const eq = { ...createEquipment({ id: 'x', name: 'Box', geometry: 'box', dims: [10, 10, 10], color: '#fff' }, [10, 24, 15]), attachedTo: stage.id };
    const withEq: Document = { ...doc, entities: [...doc.entities, eq] };
    const out = syncRiders(move(withEq, wall.id, tf([40, 24, -15])), withEq);
    expect(pos(out, stage.id)).toEqual([40, 0, 5]);
    expect(pos(out, eq.id)).toEqual([40, 24, 15]);
  });
  it('puts the deck back on undo of the rider move', () => {
    const { doc, stage, wall } = scene();
    const moved = syncRiders(move(doc, wall.id, tf([40, 24, -15], [0, 45, 0])), doc);
    const undone = syncRiders(move(moved, wall.id, doc.entities[1].transform), moved);
    expect(pos(undone, stage.id)[0]).toBeCloseTo(10, 6);
    expect(pos(undone, stage.id)[2]).toBeCloseTo(5, 6);
    expect(rot(undone, stage.id)[1]).toBeCloseTo(0, 6);
  });
  it('leaves the deck alone when both moved, when the rider just landed, and when the setting is off', () => {
    const { doc, stage, wall } = scene();
    // multi-selection drag: stage and rider both moved — riding and carrying must both stay out of it
    const both = move(move(doc, stage.id, tf([40, 0, 5])), wall.id, tf([40, 24, -15]));
    expect(syncRiders(both, doc)).toBe(both);
    // freshly attached (dropped onto the deck): the deck stays put and the rider is lifted onto it
    const eq = createEquipment({ id: 'x', name: 'Box', geometry: 'box', dims: [10, 10, 10], color: '#fff' }, [12, 0, 6]);
    const landed: Document = { ...doc, entities: [...doc.entities, { ...eq, attachedTo: stage.id }] };
    const out = syncRiders(landed, { ...doc, entities: [...doc.entities, eq] });
    expect(pos(out, stage.id)).toEqual([10, 0, 5]);
    expect(pos(out, eq.id)).toEqual([12, 24, 6]);
    // setting off → the rider slides across the deck as before
    const off: Document = { ...doc, settings: { ...doc.settings, snap: { ...doc.settings.snap, deckFollowsRider: false } } };
    expect(pos(syncRiders(move(off, wall.id, tf([40, 24, -15])), off), stage.id)).toEqual([10, 0, 5]);
    // a locked deck stays put too
    const lockedDeck = withEntity(doc, stage.id, { locked: true } as Partial<Entity>);
    expect(pos(syncRiders(move(lockedDeck, wall.id, tf([40, 24, -15])), lockedDeck), stage.id)).toEqual([10, 0, 5]);
  });
  it('carries a top-level stage by the world delta of a grouped rider', () => {
    const g = { ...createGroup('G'), id: 'G', transform: tf([0, 0, 0], [0, 90, 0]) };
    const stage = createStage(24, [0, 0, 0]);
    const wall = createLedWall({ position: [0, 24, -20] });
    wall.parentId = g.id; wall.attachedTo = stage.id;
    const doc: Document = { ...createDocument(), entities: [g, stage, wall] };
    // local (0,24,-20) → world (-20,24,0); local (0,24,-30) → world (-30,24,0): a world delta of −10 x
    const out = syncRiders(move(doc, wall.id, tf([0, 24, -30])), doc);
    expect(pos(out, stage.id)[0]).toBeCloseTo(-10, 6);
    expect(pos(out, stage.id)[1]).toBeCloseTo(0, 6);
    expect(pos(out, stage.id)[2]).toBeCloseTo(0, 6);
  });
});

describe('syncRiders with groups (world-space riding)', () => {
  const group = (id: string, t: Transform): Entity => ({ ...createGroup(id), id, transform: t });

  it('carries a grouped rider by the world delta of a top-level stage', () => {
    // group G rotated 90° about Y; wall local (0,24,-20) → world (-20,24,0); stage at the origin
    const g = group('G', tf([0, 0, 0], [0, 90, 0]));
    const stage = createStage(24, [0, 0, 0]);
    const wall = createLedWall({ position: [0, 24, -20] });
    wall.parentId = g.id; wall.attachedTo = stage.id;
    const doc: Document = { ...createDocument(), entities: [g, stage, wall] };
    const next = move(doc, stage.id, tf([30, 0, 0]));
    const out = syncRiders(next, doc);
    // world (10,24,0) expressed in G's frame is (0,24,10) — NOT a +30 bump of the local x
    const p = pos(out, wall.id);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(24, 6);
    expect(p[2]).toBeCloseTo(10, 6);
    expect(g.transform).toEqual(tf([0, 0, 0], [0, 90, 0])); // input untouched
  });
  it('carries a top-level rider when the group holding its stage moves', () => {
    const g = group('G', tf([0, 0, 0]));
    const stage = createStage(24, [10, 0, 5]);
    stage.parentId = g.id;
    const wall = createLedWall({ position: [10, 24, -15] });
    wall.attachedTo = stage.id;
    const doc: Document = { ...createDocument(), entities: [g, stage, wall] };
    const out = syncRiders(move(doc, g.id, tf([30, 0, 0])), doc);
    const p = pos(out, wall.id);
    expect(p[0]).toBeCloseTo(40, 6);
    expect(p[1]).toBeCloseTo(24, 6);
    expect(p[2]).toBeCloseTo(-15, 6);
  });
  it('leaves riders alone when they move with their stage inside the same group', () => {
    const g = group('G', tf([0, 0, 0]));
    const stage = createStage(24, [10, 0, 5]);
    const wall = createLedWall({ position: [10, 24, -15] });
    stage.parentId = g.id; wall.parentId = g.id; wall.attachedTo = stage.id;
    const doc: Document = { ...createDocument(), entities: [g, stage, wall] };
    const next = move(doc, g.id, tf([30, 5, 0], [0, 45, 0]));
    expect(syncRiders(next, doc)).toBe(next);
  });
  it('does not ride when a stage is re-parented without moving in world space', () => {
    const g = group('G', tf([100, 0, 0]));
    const stage = createStage(24, [110, 0, 5]);
    const wall = createLedWall({ position: [110, 24, -15] });
    wall.attachedTo = stage.id;
    const doc: Document = { ...createDocument(), entities: [g, stage, wall] };
    const next = withEntity(doc, stage.id, { parentId: g.id, transform: tf([10, 0, 5]) } as Partial<Entity>);
    expect(syncRiders(next, doc)).toBe(next);
  });
  it('pins a grouped rider to the deck top and drops it to world y = 0 when the stage is deleted', () => {
    const g = group('G', tf([0, 10, 0]));
    const stage = createStage(24, [0, 0, 0]);
    const wall = createLedWall({ position: [0, 0, -20] });
    wall.parentId = g.id; wall.attachedTo = stage.id;
    const doc: Document = { ...createDocument(), entities: [g, stage, wall] };
    const pinned = syncRiders(doc, { ...doc, entities: [g, stage] });
    expect(pos(pinned, wall.id)[1]).toBeCloseTo(14, 6); // world 24 inside a group lifted by 10
    const dropped = syncRiders(removeEntities(pinned, [stage.id]), pinned);
    expect(pos(dropped, wall.id)[1]).toBeCloseTo(-10, 6); // world 0
  });
});

describe('hierarchy matrices', () => {
  it('round-trips transforms through matrices and composes parent chains', () => {
    const t = tf([1, 2, 3], [10, 20, 30], [1, 2, 1]);
    expect(transformOf(matrixOf(t))).toEqual(t);
    const g1 = { ...createGroup('g1'), id: 'g1', transform: tf([100, 0, 0], [0, 90, 0]) };
    const g2 = { ...createGroup('g2'), id: 'g2', parentId: 'g1', transform: tf([0, 5, 0]) };
    const wall = { ...createLedWall({ position: [0, 0, -10] }), parentId: 'g2' };
    const byId = new Map<string, Entity>([[g1.id, g1], [g2.id, g2], [wall.id, wall]]);
    const w = transformOf(worldMatrix(wall, byId));
    expect(w.position[0]).toBeCloseTo(90, 6);
    expect(w.position[1]).toBeCloseTo(5, 6);
    expect(w.position[2]).toBeCloseTo(0, 6);
    expect(w.rotation[1]).toBeCloseTo(90, 6);
    // a cycle stops the chain instead of looping
    const a = { ...createGroup('a'), id: 'a', parentId: 'b', transform: tf([1, 0, 0]) };
    const b = { ...createGroup('b'), id: 'b', parentId: 'a', transform: tf([1, 0, 0]) };
    expect(transformOf(parentMatrix(a, new Map([[a.id, a], [b.id, b]]))).position).toEqual([1, 0, 0]);
  });
  it('autoRotateAngle matches OrbitControls (one turn per 60/speed seconds)', () => {
    expect(autoRotateAngle(60 / AUTO_ROTATE_SPEED)).toBeCloseTo(2 * Math.PI, 9);
    expect(autoRotateAngle(0)).toBe(0);
  });
});

describe('normaliseDimensions', () => {
  it('resets a dimension transform to identity and leaves others alone', () => {
    const dim = createDimension([0, 0, 0], [10, 0, 0]);
    const wall = createLedWall({ position: [5, 0, 0] });
    const doc: Document = { ...createDocument(), entities: [wall, { ...dim, transform: tf([1, 2, 3], [0, 10, 0], [2, 2, 2]) }] };
    const out = normaliseDimensions(doc);
    expect(out.entities[1].transform).toEqual(tf([0, 0, 0]));
    expect(out.entities[0]).toBe(wall);
    expect(normaliseDimensions(out)).toBe(out);
  });
});

describe('applyBehaviours', () => {
  it('composes both steps and is identity when idle', () => {
    const { doc } = scene();
    expect(applyBehaviours(doc, doc)).toBe(doc);
  });
});

describe('spanSource', () => {
  it('is the first source of the first wall, or null', () => {
    const doc = createDocument();
    expect(spanSource(doc)).toBeNull();
    const w1 = createLedWall(), w2 = createLedWall();
    w2.contentWindows[0].source = { type: 'color', color: '#f00' };
    expect(spanSource({ ...doc, entities: [w1, w2] })).toBeNull();
    w1.contentWindows.push({ ...w1.contentWindows[0], id: 'cw2', source: { type: 'test-pattern' } });
    expect(spanSource({ ...doc, entities: [w1, w2] })).toEqual({ type: 'test-pattern' });
  });
});
