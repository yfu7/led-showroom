import { describe, expect, it } from 'vitest';
import { TRUSS_INVENTORY, equipmentDef, ownedCount, type TrussSystem } from './equipment';

/**
 * What we hold, read off the five Stage Lighting Store sales orders (#733795, #734958, #735958,
 * #736526, #736643) and our own count of the 3 ft sticks, not off this catalog. The F34 block and
 * 12 x 12 in plate were quoted and never ordered.
 */
const HELD: [id: string, system: TrussSystem, owned: number][] = [
  ['gp-truss-8ft', 'DT-GP', 3],
  ['gp-truss-5ft', 'DT-GP', 6],
  ['gp-truss-4ft', 'DT-GP', 12],
  ['gp-truss-3ft', 'DT-GP', 6],
  ['gp-corner-6way', 'DT-GP', 6],
  ['gp-base-36', 'DT-GP', 6],
  ['f34-straight-1500', 'F34', 2],
  ['f34-straight-1250', 'F34', 6],
  ['f34-corner-2way', 'F34', 4],
  ['f34-tee-3way', 'F34', 2],
  ['f34-block-6way', 'F34', 0],
  ['f34-base-1x4', 'F34', 2],
  ['f34-base-30', 'F34', 2],
  ['f34-base-12', 'F34', 0],
];

describe('the truss inventory', () => {
  it.each(HELD)('%s is %s, %i held', (id, system, owned) => {
    expect(equipmentDef(id)?.trussSystem).toBe(system);
    expect(ownedCount(equipmentDef(id))).toBe(owned);
  });

  it('is every truss part on the paperwork, and the coupler', () => {
    expect(TRUSS_INVENTORY.map(d => d.id).sort()).toEqual([...HELD.map(([id]) => id), 'clamp-8002'].sort());
  });

  it('puts the coupler in neither system', () => {
    expect(equipmentDef('clamp-8002')?.trussSystem).toBeUndefined();
  });

  it('gives the two systems different sections, which is why they do not connect', () => {
    const sections = (s: TrussSystem): number[] =>
      [...new Set(TRUSS_INVENTORY.filter(d => d.trussSystem === s && d.geometry === 'truss').map(d => d.dims[1]))];
    expect(sections('DT-GP')).toEqual([11.16]);
    expect(sections('F34')).toEqual([11.42]);
  });
});
