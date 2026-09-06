import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MIN_SCALE,
  clampDelta,
  dragDeltaCap,
  floorPlaneUsable,
  footprintAt,
  groundLockY,
  isResting,
  localDelta,
  mergeKeyFor,
  preferBaseRotation,
  restOnSupport,
  roundTransform,
  snapAngleDeg,
  snapDeltaAbsolute,
  snapScale,
  snapTranslation,
  stageSupports,
  stageWorldBounds,
  supportHeightUnder,
  supportUnder,
  topLevelIds,
  transformEquals,
} from './snapping';
import type { Transform } from '../document/types';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));

const tf = (position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): Transform => ({ position, rotation, scale });

describe('snapTranslation', () => {
  it('snaps every component to the step', () => {
    expect(snapTranslation([1.4, 2.6, -0.4], 1, true)).toEqual([1, 3, 0]);
    expect(snapTranslation([7, 0, 13], 12, true)).toEqual([12, 0, 12]);
  });
  it('is a no-op when disabled or the step is invalid', () => {
    expect(snapTranslation([1.4, 2.6, -0.4], 1, false)).toEqual([1.4, 2.6, -0.4]);
    expect(snapTranslation([1.4, 2.6, -0.4], 0, true)).toEqual([1.4, 2.6, -0.4]);
    expect(snapTranslation([1.4, 2.6, -0.4], NaN, true)).toEqual([1.4, 2.6, -0.4]);
  });
  it('returns a new array', () => {
    const v: [number, number, number] = [1, 2, 3];
    expect(snapTranslation(v, 1, false)).not.toBe(v);
  });
});

describe('snapAngleDeg / snapScale', () => {
  it('snaps angles', () => {
    expect(snapAngleDeg(47, 5, true)).toBe(45);
    expect(snapAngleDeg(47, 5, false)).toBe(47);
    expect(snapAngleDeg(-92.6, 15, true)).toBe(-90);
  });
  it('snaps scale and never collapses below MIN_SCALE', () => {
    expect(snapScale(1.03, 0.05, true)).toBeCloseTo(1.05);
    expect(snapScale(1.03, 0.05, false)).toBe(1.03);
    expect(snapScale(0.001, 0.05, true)).toBe(MIN_SCALE);
    expect(snapScale(NaN, 0.05, true)).toBe(1);
  });
});

describe('groundLockY', () => {
  it('returns the offset that puts the footprint bottom on the support', () => {
    expect(groundLockY(0)).toBe(0);
    expect(groundLockY(-3)).toBe(3);
    expect(groundLockY(2, 24)).toBe(22);
  });
});

describe('stageWorldBounds', () => {
  it('spans y in [0, height] around the bottom-centre origin', () => {
    const b = stageWorldBounds({ widthIn: 48, depthIn: 48, heightIn: 24, transform: tf([10, 0, -5]) });
    expect(b.min.x).toBeCloseTo(-14); expect(b.max.x).toBeCloseTo(34);
    expect(b.min.y).toBeCloseTo(0); expect(b.max.y).toBeCloseTo(24);
    expect(b.min.z).toBeCloseTo(-29); expect(b.max.z).toBeCloseTo(19);
  });
  it('honours yaw and scale', () => {
    const b = stageWorldBounds({ widthIn: 96, depthIn: 48, heightIn: 12, transform: tf([0, 0, 0], [0, 90, 0], [1, 2, 1]) });
    expect(b.min.x).toBeCloseTo(-24); expect(b.max.x).toBeCloseTo(24);
    expect(b.min.z).toBeCloseTo(-48); expect(b.max.z).toBeCloseTo(48);
    expect(b.max.y).toBeCloseTo(24);
  });
});

describe('supportUnder / supportHeightUnder', () => {
  const low = { id: 'low', bounds: box(-24, 0, -24, 24, 12, 24) };
  const high = { id: 'high', bounds: box(-10, 0, -10, 10, 36, 10) };
  const far = { id: 'far', bounds: box(100, 0, 100, 148, 24, 148) };

  it('is the floor when nothing is under the footprint centre', () => {
    expect(supportUnder([low, high, far], box(60, 0, 60, 70, 10, 70))).toEqual({ y: 0, stageId: null });
    expect(supportHeightUnder([], box(0, 0, 0, 1, 1, 1))).toBe(0);
  });
  it('uses the footprint centre, not its extent', () => {
    // footprint extends over the low stage but its centre is outside
    expect(supportUnder([low], box(20, 0, 0, 40, 10, 10)).stageId).toBeNull();
    expect(supportUnder([low], box(-30, 0, -30, 30, 10, 30)).stageId).toBe('low');
  });
  it('picks the highest stage whose footprint contains the centre', () => {
    expect(supportUnder([low, high], box(-2, 0, -2, 2, 10, 2))).toEqual({ y: 36, stageId: 'high' });
    expect(supportHeightUnder([low, high], box(15, 0, 15, 20, 10, 20))).toBe(12);
  });
  it('ignores empty boxes', () => {
    expect(supportUnder([{ id: 'x', bounds: new THREE.Box3() }], box(0, 0, 0, 1, 1, 1)).stageId).toBeNull();
    expect(supportUnder([low], new THREE.Box3()).y).toBe(0);
  });
});

describe('stageSupports', () => {
  it('collects visible stages excluding the moving ids', () => {
    const entities = [
      { id: 'a', type: 'stage', visible: true, widthIn: 48, depthIn: 48, heightIn: 24, transform: tf() },
      { id: 'b', type: 'stage', visible: false, widthIn: 48, depthIn: 48, heightIn: 24, transform: tf() },
      { id: 'c', type: 'stage', visible: true, widthIn: 48, depthIn: 48, heightIn: 24, transform: tf([100, 0, 0]) },
      { id: 'w', type: 'led-wall', visible: true, transform: tf() },
    ];
    const s = stageSupports(entities, ['c']);
    expect(s.map(x => x.id)).toEqual(['a']);
    expect(s[0].bounds.max.y).toBe(24);
  });
});

describe('restOnSupport / isResting', () => {
  it('lifts an object onto the stage it is over', () => {
    const stage = { id: 's', bounds: box(-24, 0, -24, 24, 24, 24) };
    const r = restOnSupport([stage], box(-5, 0, -5, 5, 80, 5), 0);
    expect(r).toEqual({ y: 24, stageId: 's' });
    expect(isResting(24, r.y)).toBe(true);
    expect(isResting(30, r.y)).toBe(false);
  });
  it('drops an object back to the floor and respects a non-zero footprint bottom', () => {
    // entity origin at y = 24, footprint bottom at 21 → the origin must go to 3 to rest on the floor
    const r = restOnSupport([], box(-5, 21, -5, 5, 80, 5), 24);
    expect(r).toEqual({ y: 3, stageId: null });
  });
  it('treats the origin as the footprint bottom when the footprint is empty', () => {
    expect(restOnSupport([], new THREE.Box3(), 7)).toEqual({ y: 0, stageId: null });
    const stage = { id: 's', bounds: box(-24, 0, -24, 24, 24, 24) };
    expect(restOnSupport([stage], footprintAt([0, 0, 0]), 0)).toEqual({ y: 24, stageId: 's' });
  });
});

describe('footprintAt / clampDelta / roundTransform', () => {
  it('builds a degenerate footprint at the point', () => {
    const b = footprintAt([1, 2, 3]);
    expect(b.isEmpty()).toBe(false);
    expect(b.min.toArray()).toEqual([1, 2, 3]);
    expect(b.max.toArray()).toEqual([1, 2, 3]);
  });
  it('clamps long or NaN deltas', () => {
    expect(clampDelta(new THREE.Vector3(9000, 0, 0), 5000).length()).toBeCloseTo(5000);
    expect(clampDelta(new THREE.Vector3(NaN, 1, 1)).toArray()).toEqual([0, 0, 0]);
    expect(clampDelta(new THREE.Vector3(3, 4, 0)).length()).toBeCloseTo(5);
  });
  it('rounds float noise and normalises negative zero', () => {
    const t = roundTransform({ position: [1e-12, -0, 3.00004], rotation: [89.99996, 1e-9, 0], scale: [1.0000001, 1, 1] });
    expect(t.position).toEqual([0, 0, 3]);
    expect(t.rotation).toEqual([90, 0, 0]);
    expect(t.scale).toEqual([1, 1, 1]);
    expect(Object.is(t.position[1], -0)).toBe(false);
  });
});

describe('topLevelIds / mergeKeyFor', () => {
  const ents = [
    { id: 'g' },
    { id: 'a', parentId: 'g' },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: null },
    { id: 'loop1', parentId: 'loop2' },
    { id: 'loop2', parentId: 'loop1' },
    { id: 'orphan', parentId: 'missing' },
  ];
  it('drops members that have a selected ancestor', () => {
    expect(topLevelIds(ents, ['g', 'a', 'b', 'c'])).toEqual(['g', 'c']);
    expect(topLevelIds(ents, ['a', 'b'])).toEqual(['a']);
    expect(topLevelIds(ents, ['b', 'c'])).toEqual(['b', 'c']);
  });
  it('keeps the input order and survives cycles / dangling parents', () => {
    expect(topLevelIds(ents, ['c', 'loop1', 'orphan'])).toEqual(['c', 'loop1', 'orphan']);
    expect(topLevelIds(ents, ['loop1', 'loop2'])).toEqual([]);
  });
  it('builds a selection-dependent merge key', () => {
    expect(mergeKeyFor('nudge', ['b', 'a'])).toBe('nudge:a,b');
    expect(mergeKeyFor('nudge', ['a'])).not.toBe(mergeKeyFor('nudge', ['b']));
  });
});

describe('floorPlaneUsable / dragDeltaCap', () => {
  const ray = (oy: number, dy: number, dz = -1) => new THREE.Ray(new THREE.Vector3(0, oy, 100), new THREE.Vector3(0, dy, dz).normalize());
  it('accepts a ray heading down onto a plane below the eye', () => {
    expect(floorPlaneUsable(ray(66, -1), 0)).toBe(true);
  });
  it('rejects a ray that grazes the plane', () => {
    expect(floorPlaneUsable(ray(66, -0.05), 0)).toBe(false);
    expect(floorPlaneUsable(ray(66, -0.05), 0, 0.01)).toBe(true);
  });
  it('rejects a ray heading away from the plane (grab above eye level, pointer below the horizon)', () => {
    expect(floorPlaneUsable(ray(66, -0.5), 80)).toBe(false);
    expect(floorPlaneUsable(ray(66, 0.5), 80)).toBe(true);
  });
  it('accepts a ray that starts on the plane and rejects non-finite directions', () => {
    expect(floorPlaneUsable(ray(0, -1), 0)).toBe(true);
    expect(floorPlaneUsable(new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, NaN, 0)), 0)).toBe(false);
  });
  it('caps drag deltas relative to the camera distance', () => {
    expect(dragDeltaCap(300)).toBe(600);
    expect(dragDeltaCap(10)).toBe(120);
    expect(dragDeltaCap(NaN)).toBe(120);
  });
});

describe('snapDeltaAbsolute', () => {
  it('snaps the absolute position, not the delta', () => {
    expect(snapDeltaAbsolute([0.3, 0, 0], [5, 0, 0], 1, true)).toEqual([4.7, 0, 0]);
    expect(snapTranslation([5, 0, 0], 1, true)).toEqual([5, 0, 0]);
  });
  it('leaves disabled axes and disabled snapping alone', () => {
    expect(snapDeltaAbsolute([0.3, 24, 0.3], [5, 2.2, 5], 1, true, [true, false, true])).toEqual([4.7, 2.2, 4.7]);
    expect(snapDeltaAbsolute([0.3, 0, 0], [5, 0, 0], 1, false)).toEqual([5, 0, 0]);
    expect(snapDeltaAbsolute([0.3, 0, 0], [5, 0, 0], 0, true)).toEqual([5, 0, 0]);
  });
  it('normalises tiny results to zero', () => {
    expect(Object.is(snapDeltaAbsolute([12, 0, 0], [0, 0, 0], 12, true)[0], -0)).toBe(false);
    expect(snapDeltaAbsolute([12, 0, 0], [1e-12, 0, 0], 12, true)).toEqual([0, 0, 0]);
  });
});

describe('localDelta', () => {
  it('rotates a world delta into the parent frame and undoes the parent scale', () => {
    const parent = new THREE.Matrix4().compose(new THREE.Vector3(100, 0, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), new THREE.Vector3(2, 2, 2));
    const d = localDelta(new THREE.Vector3(10, 0, 0), parent.clone().invert());
    // a +90 deg yaw maps local +Z onto world +X, so world +X is local +Z; the parent scale 2 halves it; translation is ignored
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(0, 6);
    expect(d.z).toBeCloseTo(5, 6);
  });
  it('is the identity for top-level entities', () => {
    expect(localDelta(new THREE.Vector3(1, 2, 3), new THREE.Matrix4()).toArray()).toEqual([1, 2, 3]);
  });
});

describe('preferBaseRotation / transformEquals', () => {
  it('keeps the base numbers when the orientation is the same', () => {
    expect(preferBaseRotation([0, -90, 0], [0, 270, 0])).toEqual([0, 270, 0]);
    expect(preferBaseRotation([180, 0, 180], [0, 180, 0])).toEqual([0, 180, 0]);
    expect(preferBaseRotation([0, 45, 0], [0, 45.0000001, 0])).toEqual([0, 45.0000001, 0]);
  });
  it('returns the new rotation when it actually differs', () => {
    expect(preferBaseRotation([0, 45, 0], [0, 270, 0])).toEqual([0, 45, 0]);
  });
  it('compares transforms component-wise', () => {
    expect(transformEquals(tf([1, 2, 3]), tf([1, 2, 3]))).toBe(true);
    expect(transformEquals(tf([1, 2, 3]), tf([1, 2, 3.001]))).toBe(false);
    expect(transformEquals(tf([1, 2, 3]), tf([1, 2, 3.001]), 0.01)).toBe(true);
    expect(transformEquals(tf(), tf([0, 0, 0], [0, 0, 1]))).toBe(false);
    expect(transformEquals(tf(), tf([0, 0, 0], [0, 0, 0], [1, 1, 2]))).toBe(false);
  });
});
