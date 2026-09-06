import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { EquipmentEntity, EquipmentGeometry } from '../document/types';
import { EQUIPMENT } from '../catalog/equipment';
import {
  EQUIPMENT_GEOMETRIES, SCREEN_GEOMETRIES, buildEquipment, colorOf, disposeEquipmentBuild, equipmentBounds, equipmentBuildKey, podiumProfile,
  safeDims,
} from './equipmentGeometry';

/** Local-space bounding box of one mesh of a build (mesh transform applied). */
function meshBox(m: THREE.Mesh): THREE.Box3 {
  m.geometry.computeBoundingBox();
  m.updateMatrix();
  return m.geometry.boundingBox!.clone().applyMatrix4(m.matrix);
}

/** Y range of the vertices of `m` whose local z is within `tol` of `z`. */
function yRangeAtZ(m: THREE.Mesh, z: number, tol = 0.05): { min: number; max: number } {
  const pos = m.geometry.getAttribute('position');
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i) - z) > tol) continue;
    min = Math.min(min, pos.getY(i));
    max = Math.max(max, pos.getY(i));
  }
  return { min, max };
}

function entity(geometry: EquipmentGeometry, dims: [number, number, number], extra: Partial<EquipmentEntity> = {}): EquipmentEntity {
  return {
    id: 'eq_test', type: 'equipment', name: geometry, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true, locked: false, catalogId: geometry, geometry, dims, color: '#6b6f78', screen: null, ...extra,
  };
}

/** Every parametric kind. 'photo' and 'cad' are deliberately excluded — a photographed product and a
 *  CAD-modelled one are built by EquipmentRenderer from their cutout / mesh, and only fall back to a
 *  plain box here. */
const ALL_KINDS: EquipmentGeometry[] = [
  'box', 'cylinder', 'kiosk', 'totem', 'truss', 'truss-upright', 'figure', 'table-round', 'table-rect', 'chair', 'sofa', 'screen',
  'drape', 'podium', 'speaker', 'counter', 'plant', 'locker',
];

describe('buildEquipment', () => {
  it('has a builder for every EquipmentGeometry', () => {
    expect(new Set(EQUIPMENT_GEOMETRIES)).toEqual(new Set([...ALL_KINDS, 'photo', 'cad']));
  });

  const cases: { geometry: EquipmentGeometry; dims: [number, number, number]; label: string }[] = [];
  for (const def of EQUIPMENT) {
    cases.push({ geometry: def.geometry, dims: def.dims, label: def.id });
    for (const v of def.variants ?? []) cases.push({ geometry: def.geometry, dims: v.dims, label: `${def.id} ${v.name}` });
  }
  for (const g of ALL_KINDS) {
    cases.push({ geometry: g, dims: [24, 40, 20], label: `${g} generic` });
    cases.push({ geometry: g, dims: [90, 12, 9], label: `${g} squat` });
    cases.push({ geometry: g, dims: [8, 120, 8], label: `${g} tall` });
  }

  for (const c of cases) {
    it(`${c.label}: builds, stands on y=0 and is ${c.dims[1]}" tall`, () => {
      const build = buildEquipment(entity(c.geometry, c.dims));
      expect(build.meshes.length).toBeGreaterThan(0);
      const b = equipmentBounds(build);
      const h = b.max.y - b.min.y;
      expect(Math.abs(h - c.dims[1]) / c.dims[1]).toBeLessThanOrEqual(0.05);
      expect(Math.abs(b.min.y)).toBeLessThanOrEqual(0.25);
      // sanity: the footprint never explodes beyond the declared size
      expect(b.max.x - b.min.x).toBeLessThanOrEqual(Math.max(c.dims[0], c.dims[2]) * 2.5 + 1);
      expect(b.max.z - b.min.z).toBeLessThanOrEqual(Math.max(c.dims[0], c.dims[2]) * 2.5 + 1);
      disposeEquipmentBuild(build);
    });
  }

  it('flags every mesh for shadows and shared materials, and puts all meshes under the group', () => {
    for (const g of ALL_KINDS) {
      const build = buildEquipment(entity(g, [24, 40, 20]));
      for (const m of build.meshes) {
        expect(m.receiveShadow).toBe(true);
        if (m !== build.screen) { expect(m.castShadow).toBe(true); expect(m.userData.sharedMaterial).toBe(true); }
        let p: THREE.Object3D | null = m;
        while (p && p !== build.group) p = p.parent;
        expect(p).toBe(build.group);
      }
      disposeEquipmentBuild(build);
    }
  });

  it('returns a hidden unlit screen plane only for screen-bearing kinds', () => {
    for (const g of ALL_KINDS) {
      const build = buildEquipment(entity(g, [30, 70, 20]));
      if (SCREEN_GEOMETRIES.has(g)) {
        expect(build.screen).toBeDefined();
        const mat = build.screen!.material as THREE.MeshBasicMaterial;
        expect(mat.isMeshBasicMaterial).toBe(true);
        expect(mat.toneMapped).toBe(false);
        expect(build.screen!.visible).toBe(false);
        expect(build.materials).toContain(mat);
      } else {
        expect(build.screen).toBeUndefined();
      }
      disposeEquipmentBuild(build);
    }
  });

  it('uses the entity colours', () => {
    const build = buildEquipment(entity('kiosk', [18, 62, 18], { color: '#ff0000', accent: '#00ff00' }));
    const colors = new Set(build.meshes.map(m => '#' + (m.material as THREE.MeshStandardMaterial).color.getHexString()));
    expect(colors.has('#ff0000')).toBe(true);
    expect(colors.has('#00ff00')).toBe(true);
    disposeEquipmentBuild(build);
  });

  it('falls back to the default colour for an invalid colour string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(colorOf('not-a-colour', '#6b6f78').getHexString()).toBe('6b6f78');
      expect(colorOf('', '#6b6f78').getHexString()).toBe('6b6f78');
      expect(colorOf(undefined, '#6b6f78').getHexString()).toBe('6b6f78');
      expect(colorOf('#ff0000', '#6b6f78').getHexString()).toBe('ff0000');
      const build = buildEquipment(entity('box', [10, 10, 10], { color: 'not-a-colour' }));
      expect((build.meshes[0].material as THREE.MeshStandardMaterial).color.getHexString()).toBe('6b6f78');
      disposeEquipmentBuild(build);
    } finally {
      warn.mockRestore();
    }
  });

  it('builds each truss as a single merged mesh (plus the base plate for uprights)', () => {
    for (const dims of [[48, 12, 12], [96, 12, 12], [120, 12, 12]] as [number, number, number][]) {
      const build = buildEquipment(entity('truss', dims));
      expect(build.meshes).toHaveLength(1);
      const truss = build.meshes[0];
      expect(truss.geometry.getAttribute('position').count).toBeGreaterThan(200);
      const b = meshBox(truss);
      expect(b.max.x - b.min.x).toBeCloseTo(dims[0], 1);
      expect(b.max.y - b.min.y).toBeCloseTo(dims[1], 1);
      expect(b.max.z - b.min.z).toBeCloseTo(dims[2], 1);
      disposeEquipmentBuild(build);
    }
    for (const dims of [[12, 96, 12], [12, 120, 12], [12, 144, 12]] as [number, number, number][]) {
      const build = buildEquipment(entity('truss-upright', dims));
      expect(build.meshes).toHaveLength(2);
      const truss = build.meshes.find(m => m.name === 'truss')!;
      const b = meshBox(truss);
      expect(b.max.x - b.min.x).toBeCloseTo(dims[0], 1);
      expect(b.max.z - b.min.z).toBeCloseTo(dims[2], 1);
      expect(b.max.y).toBeCloseTo(dims[1], 1);
      disposeEquipmentBuild(build);
    }
  });

  it('podium: the reading top is a solid wedge resting on the body, high at +Z, with the book stop on the low edge', () => {
    for (const dims of [[24, 47, 18], [24, 40, 20], [90, 12, 9], [8, 120, 8]] as [number, number, number][]) {
      const [, h, d] = dims;
      const { topT, bodyTop } = podiumProfile(h);
      const build = buildEquipment(entity('podium', dims));
      const top = build.meshes.find(m => m.name === 'reading-top')!;
      expect(top).toBeDefined();
      // underside touches the body top along both Z edges (no air wedge)
      const lowEdge = yRangeAtZ(top, -d / 2), highEdge = yRangeAtZ(top, d / 2);
      expect(lowEdge.min).toBeCloseTo(bodyTop, 3);
      expect(highEdge.min).toBeCloseTo(bodyTop, 3);
      // presenter side (-Z) is the low edge, audience side (+Z) reaches the full height
      expect(lowEdge.max).toBeCloseTo(bodyTop + topT, 3);
      expect(highEdge.max).toBeCloseTo(h, 3);
      // book stop sits on the slab surface at the low edge
      const stop = meshBox(build.meshes.find(m => m.name === 'book-stop')!);
      expect(stop.min.y).toBeCloseTo(bodyTop + topT, 3);
      expect(stop.min.z).toBeCloseTo(-d / 2, 3);
      disposeEquipmentBuild(build);
    }
  });

  it('drape: base plates stay inside the bay so the X footprint equals the bay width', () => {
    for (const dims of [[120, 96, 6], [120, 192, 6], [8, 120, 8], [90, 12, 9]] as [number, number, number][]) {
      const build = buildEquipment(entity('drape', dims));
      const b = equipmentBounds(build);
      expect(b.min.x).toBeCloseTo(-dims[0] / 2, 3);
      expect(b.max.x).toBeCloseTo(dims[0] / 2, 3);
      disposeEquipmentBuild(build);
    }
  });

  it('speaker: tripod feet stay inside the declared footprint', () => {
    for (const dims of [[17, 72, 15], [24, 40, 20], [8, 120, 8]] as [number, number, number][]) {
      const [w, , d] = dims;
      const build = buildEquipment(entity('speaker', dims));
      const b = equipmentBounds(build);
      expect(b.min.x).toBeGreaterThanOrEqual(-w / 2 - 0.01);
      expect(b.max.x).toBeLessThanOrEqual(w / 2 + 0.01);
      expect(b.min.z).toBeGreaterThanOrEqual(-d / 2 - 0.01);
      expect(b.max.z).toBeLessThanOrEqual(d / 2 + 0.6);   // the woofer ring is proud of the cabinet face
      expect(build.meshes.find(m => m.name === 'tripod')).toBeDefined();
      disposeEquipmentBuild(build);
    }
  });

  it('falls back to a box for an unknown geometry and to sane dims for bad input', () => {
    const build = buildEquipment(entity('unknown' as EquipmentGeometry, [NaN, -1, 0] as unknown as [number, number, number]));
    const b = equipmentBounds(build);
    expect(b.max.y - b.min.y).toBeCloseTo(24, 5);
    expect(safeDims([NaN, -1, 0])).toEqual([24, 24, 24]);
    expect(safeDims(undefined)).toEqual([24, 24, 24]);
    disposeEquipmentBuild(build);
  });

  it('build key changes with geometry, dims, colour and accent only', () => {
    const base = entity('chair', [18, 34, 20]);
    const k = equipmentBuildKey(base);
    expect(equipmentBuildKey({ ...base, name: 'other', screen: { type: 'image', url: 'x' } })).toBe(k);
    expect(equipmentBuildKey({ ...base, dims: [18, 35, 20] })).not.toBe(k);
    expect(equipmentBuildKey({ ...base, color: '#ffffff' })).not.toBe(k);
    expect(equipmentBuildKey({ ...base, accent: '#ffffff' })).not.toBe(k);
    expect(equipmentBuildKey({ ...base, geometry: 'sofa' })).not.toBe(k);
  });

  it('disposes and detaches', () => {
    const parent = new THREE.Group();
    const build = buildEquipment(entity('locker', [24, 66, 18]));
    parent.add(build.group);
    disposeEquipmentBuild(build);
    expect(build.group.parent).toBeNull();
  });
});
