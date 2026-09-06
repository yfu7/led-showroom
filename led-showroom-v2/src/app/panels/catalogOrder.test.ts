/**
 * Catalog ordering: the saved order survives a catalog that grows, shrinks or is searched, and every
 * photographed product actually has its cutout on disk.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOrder, clearOrder, isCustomised, loadOrder, reorder, saveOrder, type StorageLike } from './catalogOrder';
import { buildCatalog, catalogGroups } from './catalogItems';
import { EQUIPMENT } from '@/engine/catalog/equipment';

const item = (id: string) => ({ id });
const ids = <T extends { id: string }>(list: readonly T[]) => list.map(i => i.id);

/** An in-memory localStorage stand-in, so the tests never depend on a DOM. */
function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: k => { map.delete(k); },
  };
}

describe('applyOrder', () => {
  const list = [item('a'), item('b'), item('c')];

  it('leaves the catalog order alone when nothing is saved', () => {
    expect(ids(applyOrder(list, undefined))).toEqual(['a', 'b', 'c']);
    expect(ids(applyOrder(list, []))).toEqual(['a', 'b', 'c']);
  });

  it('applies a saved order', () => {
    expect(ids(applyOrder(list, ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('sorts a newly added product after the hand-ordered ones, never dropping it', () => {
    const grown = [...list, item('d')];
    expect(ids(applyOrder(grown, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores ids that are no longer in the catalog', () => {
    expect(ids(applyOrder(list, ['gone', 'c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input', () => {
    const src = [...list];
    applyOrder(src, ['c', 'b', 'a']);
    expect(ids(src)).toEqual(['a', 'b', 'c']);
  });
});

describe('reorder', () => {
  const list = [item('a'), item('b'), item('c'), item('d')];

  it('moves a card ahead of another', () => {
    expect(reorder(list, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves a card to the end when there is nothing to sit before', () => {
    expect(reorder(list, 'a', null)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moving a card onto itself is a no-op', () => {
    expect(reorder(list, 'b', 'b')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves the list alone when the dragged card is unknown', () => {
    expect(reorder(list, 'zz', 'b')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the dragged card in place when the target is unknown', () => {
    expect(reorder(list, 'c', 'zz')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('round-trips through applyOrder', () => {
    const next = reorder(list, 'd', 'a');
    expect(ids(applyOrder(list, next))).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('persistence', () => {
  it('saves and loads', () => {
    const s = memory();
    saveOrder({ Displays: ['b', 'a'] }, s);
    expect(loadOrder(s)).toEqual({ Displays: ['b', 'a'] });
  });

  it('survives corrupt or foreign storage without throwing', () => {
    const s = memory();
    for (const bad of ['not json', '[]', 'null', '{"g":"nope"}', '{"g":[1,2]}']) {
      s.setItem('showroom-v2:catalog-order', bad);
      expect(() => loadOrder(s)).not.toThrow();
    }
    s.setItem('showroom-v2:catalog-order', '{"g":["a",7,"b"]}');
    expect(loadOrder(s)).toEqual({ g: ['a', 'b'] });
  });

  it('clears', () => {
    const s = memory();
    saveOrder({ Displays: ['b'] }, s);
    clearOrder(s);
    expect(loadOrder(s)).toEqual({});
  });

  it('reports which groups are hand-ordered', () => {
    const order = { Displays: ['b', 'a'], Power: [] };
    expect(isCustomised(order, 'Displays')).toBe(true);
    expect(isCustomised(order, 'Power')).toBe(false);
    expect(isCustomised(order, 'Nothing')).toBe(false);
  });
});

describe('the catalog it orders', () => {
  const items = buildCatalog('in');

  it('has unique ids, so an order can address every card', () => {
    expect(new Set(items.map(i => i.id)).size).toBe(items.length);
  });

  it('reorders one group without disturbing another', () => {
    const groups = catalogGroups(items);
    expect(groups.length).toBeGreaterThan(1);
    const [g1, g2] = groups;
    const a = items.filter(i => i.group === g1);
    const b = items.filter(i => i.group === g2);
    const order = { [g1]: reorder(a, a[a.length - 1].id, a[0].id) };
    expect(ids(applyOrder(b, order[g2]))).toEqual(ids(b));
    expect(ids(applyOrder(a, order[g1]))[0]).toBe(a[a.length - 1].id);
  });

  it('gives every photographed product a cutout that exists on disk', () => {
    const photo = EQUIPMENT.filter(e => e.geometry === 'photo');
    expect(photo.length).toBeGreaterThan(0);
    for (const def of photo) {
      expect(def.image, `${def.id} has no image`).toBeTruthy();
      expect(def.image!.startsWith('/'), `${def.id} image should be an absolute path`).toBe(true);
      expect(existsSync(join(process.cwd(), 'public', def.image!)), `missing ${def.image}`).toBe(true);
    }
  });

  it('carries the product cutout onto the catalog card', () => {
    for (const def of EQUIPMENT.filter(e => e.geometry === 'photo')) {
      const card = items.find(i => i.id.includes(def.id));
      expect(card, `no catalog card for ${def.id}`).toBeTruthy();
      expect(card!.image).toBe(def.image);
    }
  });
});
