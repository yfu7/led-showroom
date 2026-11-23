import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EquipmentEntity } from '../document/types';
import { buildEquipment, GHOST_OPACITY } from '../entities/equipmentGeometry';
import { ghostsHeldReal, realGhosts, setGhostLook } from './realGhosts';

const entity = (id: string, ghost: boolean): EquipmentEntity => ({
  id, type: 'equipment', name: 'truss', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  visible: true, locked: false, catalogId: 'truss-base', geometry: 'truss-base', dims: [36, 36.5, 36], color: '#6b6f78',
  screen: null, ...(ghost ? { ghost: true } : {}),
});

const look = (b: ReturnType<typeof buildEquipment>) => b.meshes.map(m => {
  const mat = m.material as THREE.Material;
  return [mat.transparent, mat.opacity, mat.depthWrite, m.castShadow];
});

describe('realGhosts', () => {
  it('draws a ghost as the real part for one export, then puts the ghost back', () => {
    const ghostE = entity('g', true), solidE = entity('s', false);
    const ghost = buildEquipment(ghostE), solid = buildEquipment(solidE);
    const roots: Record<string, THREE.Object3D> = { g: ghost.group, s: solid.group };
    let redraws = 0;
    const host = {
      doc: { entities: [ghostE, solidE] }, invalidate: () => { redraws++; },
      scene: { rootOf: (id: string) => roots[id] },
    } as unknown as Parameters<typeof realGhosts>[0];

    const ghostLook = look(ghost), solidLook = look(solid);
    expect(ghostLook.every(l => l[1] === GHOST_OPACITY)).toBe(true);

    const back = realGhosts(host);
    expect(look(ghost)).toEqual(solidLook);
    expect(look(solid)).toEqual(solidLook);
    back();
    back(); // once only
    expect(look(ghost)).toEqual(ghostLook);
    expect(redraws).toBe(2);
  });
});

describe('overlapping holds', () => {
  const setup = () => {
    const ghostE = entity('g', true), solidE = entity('s', false);
    const roots: Record<string, THREE.Object3D> = { g: buildEquipment(ghostE).group };
    const host = {
      doc: { entities: [ghostE, solidE] }, invalidate: () => {},
      scene: { rootOf: (id: string) => roots[id] },
    } as unknown as Parameters<typeof realGhosts>[0];
    const opacities = () => {
      const s = new Set<number>();
      roots.g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) s.add((m.material as THREE.Material).opacity); });
      return [...s];
    };
    return { ghostE, roots, host, opacities };
  };

  it('keeps ghosts real until the last of two overlapping holds lets go, in either order', () => {
    const { host, opacities } = setup();
    const take = realGhosts(host);      // a video take starts
    const glb = realGhosts(host);       // a GLB export starts during it
    take();                             // the take ends first
    expect(opacities()).toEqual([1]);
    expect(ghostsHeldReal()).toBe(true);
    glb();
    expect(opacities()).toEqual([GHOST_OPACITY]);
    expect(ghostsHeldReal()).toBe(false);
  });

  it('sets a part rebuilt mid-hold real again, and back to a ghost on release', () => {
    const { ghostE, roots, host, opacities } = setup();
    const back = realGhosts(host);
    roots.g = buildEquipment(ghostE).group; // rebuilt: a fresh see-through ghost
    expect(opacities()).toEqual([GHOST_OPACITY]);
    expect(setGhostLook(host, true)).toBe(true);
    expect(opacities()).toEqual([1]);
    expect(setGhostLook(host, true)).toBe(false);
    back();
    expect(opacities()).toEqual([GHOST_OPACITY]);
  });
});
