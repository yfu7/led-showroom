import { describe, expect, it } from 'vitest';
import { TRUSS_INVENTORY, equipmentDef, ownedCount, type TrussSystem } from './equipment';

/**
 * What we hold, read off the five Stage Lighting Store sales orders (#733795, #734958, #735958,
 * #736526, #736643), not off this catalog. The orders are the whole of our stock: no 3 ft stick is
 * on them, so we hold none; the catalog lists one as a stick to buy. The F34 block and 12 x 12 in
 * plate were quoted and never ordered.
 */
const HELD: [id: string, system: TrussSystem, owned: number][] = [
  ['gp-truss-8ft', 'DT-GP', 3],
  ['gp-truss-5ft', 'DT-GP', 6],
  ['gp-truss-4ft', 'DT-GP', 12],
  ['gp-truss-3ft', 'DT-GP', 0],
  ['gp-truss-2ft', 'DT-GP', 0],
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

  it('is every truss part on the paperwork, the coupler, and the 3 ft and 2 ft sticks to buy', () => {
    expect(TRUSS_INVENTORY.map(d => d.id).sort()).toEqual([...HELD.map(([id]) => id), 'clamp-8002'].sort());
  });

  it('lists the 3 ft stick, which is on none of the orders, as one to buy', () => {
    const def = equipmentDef('gp-truss-3ft');
    expect(def?.dims).toEqual([36, 11.16, 11.16]);
    expect(ownedCount(def)).toBe(0);
    expect(def?.specs?.find(s => s.label === 'Owned')?.value).toMatch(/^0 /);
  });

  it('lists the 2 ft DT-GP2, which is on none of the orders, as one to buy at a retailer price', () => {
    const def = equipmentDef('gp-truss-2ft');
    expect(def?.dims).toEqual([24, 11.16, 11.16]);
    expect(ownedCount(def)).toBe(0);
    expect(def?.specs?.find(s => s.label === 'Part no.')?.value).toMatch(/^GP0222 - DT-GP2 /);
    expect(def?.specs?.find(s => s.label === 'Unit price')?.value).toMatch(/^\$407\.00 \(estimate/);
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
