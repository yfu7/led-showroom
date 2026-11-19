/**
 * The spec derivation is the "each item's specs" leg of the inspector architecture, so the tests
 * that matter are the architectural ones: it is pure, it is idempotent, and one item's rows never
 * depend on what else is standing on the canvas.
 */
import { describe, expect, it } from 'vitest';
import { entitySpecs, sceneSpecs } from './specs';
import { createDocument, createDimension, createGroup, createLedWall, createRoom, createStage } from './defaults';
import { cellKey } from '../ledwall/layout';
import type { Document, Entity, LedWallEntity } from './types';

const docWith = (...entities: Entity[]): Document => ({ ...createDocument(), entities });
const value = (rows: { label: string; value: string }[], label: string): string | undefined =>
  rows.find(r => r.label === label)?.value;

describe('entitySpecs — purity and isolation', () => {
  it('is idempotent: the same item read twice gives the same rows', () => {
    const wall = createLedWall({ cols: 3, rows: 2 });
    const doc = docWith(wall);
    expect(entitySpecs(wall, doc, 'in')).toEqual(entitySpecs(wall, doc, 'in'));
  });

  it('mutates nothing it is given', () => {
    const wall = createLedWall({ cols: 3, rows: 2 });
    const doc = docWith(wall);
    const before = JSON.stringify([wall, doc]);
    entitySpecs(wall, doc, 'ft');
    expect(JSON.stringify([wall, doc])).toBe(before);
  });

  it('reads one item only — a second, larger wall in the doc changes nothing', () => {
    const small = createLedWall({ cols: 2, rows: 2 });
    const big = createLedWall({ cols: 9, rows: 4 });
    const alone = entitySpecs(small, docWith(small), 'in');
    const crowded = entitySpecs(small, docWith(small, big), 'in');
    expect(crowded).toEqual(alone);
    // ...and the big wall reports its own numbers, not the small one's.
    expect(value(entitySpecs(big, docWith(small, big), 'in'), 'Grid')).toBe('9 × 4');
  });
});

describe('entitySpecs — LED wall', () => {
  it('reports the grid, the panel count and a resolution', () => {
    const rows = entitySpecs(createLedWall({ cols: 6, rows: 5 }), createDocument(), 'in');
    expect(value(rows, 'Grid')).toBe('6 × 5');
    expect(value(rows, 'Panels')).toBe('30');
    expect(value(rows, 'Resolution')).toBe(`${344 * 6} × ${258 * 5} px`);
  });

  it('separates the filled count from the bounding box on a custom shape', () => {
    // An L: a 3x3 box with the top-right 2x2 carved out, so 5 of 9 cells are filled.
    const cells = ['0,0', '0,1', '0,2', '1,2', '2,2'].map(k => cellKey(...(k.split(',').map(Number) as [number, number])));
    const wall: LedWallEntity = { ...createLedWall({ cols: 3, rows: 3 }), shape: { mode: 'custom', cells } };
    const rows = entitySpecs(wall, createDocument(), 'in');
    expect(value(rows, 'Panels')).toBe('5');
    expect(value(rows, 'Grid')).toBe('3 × 3');
  });

  it('always offers feet, and does not repeat itself when feet is the working unit', () => {
    expect(value(entitySpecs(createLedWall(), createDocument(), 'mm'), 'Size (ft)')).toBeDefined();
    expect(value(entitySpecs(createLedWall(), createDocument(), 'ft'), 'Size (ft)')).toBeUndefined();
  });

  it('mentions folds only once the wall has them', () => {
    const flat = createLedWall({ cols: 3, rows: 1 });
    expect(value(entitySpecs(flat, createDocument(), 'in'), 'Folds')).toBeUndefined();
    const folded: LedWallEntity = { ...flat, corners: [{ afterCol: 0, angle: 90 }] };
    expect(value(entitySpecs(folded, createDocument(), 'in'), 'Folds')).toBe('1 corner');
  });
});

describe('entitySpecs — other types', () => {
  it('puts a stage deck top at position + deck height', () => {
    const stage = { ...createStage(24), transform: { ...createStage(24).transform, position: [0, 12, 0] as [number, number, number] } };
    expect(value(entitySpecs(stage, createDocument(), 'in'), 'Top at')).toBe('36"');
  });

  it('describes a room by its footprint and how its walls are drawn', () => {
    const room = createRoom(20, 8, 10);
    const rows = entitySpecs(room, createDocument(), 'ft');
    expect(value(rows, 'Footprint')).toBe(`20' 0" × 10' 0"`); // formatLength always names both parts in feet
    expect(value(rows, 'Walls')).toBe('Solid surfaces');
    expect(value(entitySpecs({ ...room, outlineWalls: true }, createDocument(), 'ft'), 'Walls')).toBe('Outlined (footprint + guides)');
  });

  it('prints measurement endpoints in the working unit, naming it once', () => {
    const dim = createDimension([0, 0, 0], [120, 0, 0]);
    expect(value(entitySpecs(dim, createDocument(), 'ft'), 'Length')).toBe(`10' 0"`);
    // mm: bare numbers, unit named once at the end (as the measurement inspector always did)
    expect(value(entitySpecs(dim, createDocument(), 'mm'), 'Point B')).toBe('3048, 0, 0 mm');
    expect(value(entitySpecs(dim, createDocument(), 'in'), 'Point A')).toBe('0, 0, 0');
  });

  it('counts a group by its descendants', () => {
    const group = createGroup();
    const child = { ...createStage(24), parentId: group.id };
    expect(value(entitySpecs(group, docWith(group, child), 'in'), 'Members')).toBe('1 object');
    expect(value(entitySpecs(group, docWith(group), 'in'), 'Members')).toBe('0 objects');
  });
});

describe('sceneSpecs', () => {
  it('reports only the floor for an empty canvas', () => {
    const rows = sceneSpecs(createDocument(), 'ft');
    expect(rows.map(r => r.label)).toEqual(['Floor']);
  });

  it('tallies each type and sums the LED totals across walls', () => {
    const a = createLedWall({ cols: 2, rows: 2 });
    const b = createLedWall({ cols: 3, rows: 2 });
    const rows = sceneSpecs(docWith(a, b, createStage(24)), 'in');
    expect(value(rows, 'LED walls')).toBe('2');
    expect(value(rows, 'Stage deck')).toBe('1');
    expect(value(rows, 'LED panels')).toBe('10'); // 4 + 6
  });

  it('uses the singular label for a single item of a type', () => {
    expect(value(sceneSpecs(docWith(createLedWall()), 'in'), 'LED wall')).toBe('1');
  });
});
