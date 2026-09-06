import { describe, it, expect } from 'vitest';
import { hiddenEntityIds, normalizeRect, rectContains } from './BoxSelect';

describe('normalizeRect / rectContains', () => {
  it('normalises corners given in any order', () => {
    expect(normalizeRect(10, 20, 5, 2)).toEqual({ x: 5, y: 2, w: 5, h: 18 });
    expect(normalizeRect(0, 0, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  it('treats the rect edges as inside', () => {
    const r = normalizeRect(0, 0, 10, 10);
    expect(rectContains(r, 0, 10)).toBe(true);
    expect(rectContains(r, 10.1, 5)).toBe(false);
  });
});

describe('hiddenEntityIds', () => {
  const ents = [
    { id: 'g', visible: false },
    { id: 'a', visible: true, parentId: 'g' },
    { id: 'b', visible: true, parentId: 'a' },
    { id: 'c', visible: true },
    { id: 'd', visible: false, parentId: 'c' },
    { id: 'loop1', visible: true, parentId: 'loop2' },
    { id: 'loop2', visible: true, parentId: 'loop1' },
    { id: 'orphan', visible: true, parentId: 'missing' },
  ];
  it('includes hidden entities and everything under a hidden group', () => {
    expect(Array.from(hiddenEntityIds(ents)).sort()).toEqual(['a', 'b', 'd', 'g']);
  });
  it('survives cycles and dangling parents', () => {
    const h = hiddenEntityIds(ents);
    expect(h.has('loop1')).toBe(false);
    expect(h.has('orphan')).toBe(false);
    expect(h.has('c')).toBe(false);
  });
  it('is empty when everything is visible', () => {
    expect(hiddenEntityIds([{ id: 'x', visible: true }]).size).toBe(0);
  });
});
