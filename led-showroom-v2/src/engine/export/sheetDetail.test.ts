/**
 * The sheet's detail prints what the document holds and nothing it does not: the walls in document
 * order under the tags the drawing carries, the equipment by part with what is to buy, and the
 * notes that hold for this scene.
 */
import { describe, expect, it } from 'vitest';
import { chainEdges, levels, pitchMmOf, sheetSchedule, wallTags, zoneCounts } from './sheetDetail';
import { createDocument, createLedWall } from '../document/defaults';
import type { Document, Entity, EquipmentEntity } from '../document/types';
import { filledCount, wallDims } from '../ledwall/layout';

const docWith = (entities: Entity[]): Document => ({ ...createDocument(), entities });
let seq = 0;
const piece = (catalogId: string, ghost = false): EquipmentEntity => ({
  id: `${catalogId}-${++seq}`, type: 'equipment', name: catalogId, catalogId, geometry: 'box',
  dims: [1, 1, 1], color: '#000', visible: true, locked: false, ghost,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
} as EquipmentEntity);
const section = (doc: Document, title: string) => sheetSchedule(doc, 'ft').find(s => s.title === title);

describe('sheetSchedule', () => {
  it('lists each visible wall under its tag, in document order, with its panel, array, size and pixels', () => {
    const a = { ...createLedWall({ cols: 4, rows: 3 }), name: 'Main' };
    const b = { ...createLedWall({ cols: 2, rows: 2 }), name: 'Side' };
    const hidden = { ...createLedWall({ cols: 9, rows: 9 }), name: 'Off', visible: false };
    const doc = docWith([a, hidden, b]);
    expect(wallTags(doc).map(t => [t.tag, t.wall.name])).toEqual([['W1', 'Main'], ['W2', 'Side']]);
    const rows = section(doc, 'LED WALL SCHEDULE')!.rows.map(r => r.text);
    const d = wallDims(a);
    expect(rows[0]).toBe('W1  Main');
    expect(rows).toContain(`${d.spec.name} · ${pitchMmOf(d.spec).toFixed(2)} mm`);
    expect(rows).toContain(`4 × 3 array · ${filledCount(a)} panels`);
    expect(rows.some(r => r.includes(`${d.wallWPx} × ${d.wallHPx} px`))).toBe(true);
    expect(rows.some(r => r.startsWith('W') && r.includes('Off'))).toBe(false);
    expect(rows[rows.length - 1]).toMatch(new RegExp(`^TOTAL  ${filledCount(a) + filledCount(b)} panels`));
  });

  it('weighs the walls from the panel spec, and totals it', () => {
    const a = createLedWall({ cols: 4, rows: 3 });
    const spec = wallDims(a).spec;
    const rows = section(docWith([a]), 'LED WALL SCHEDULE')!.rows.map(r => r.text);
    if (spec.weightLb) {
      const lb = Math.round(filledCount(a) * spec.weightLb);
      expect(rows.some(r => r.replace(/,/g, '') === `${lb} lb`)).toBe(true);
      expect(rows[rows.length - 1].replace(/,/g, '')).toContain(`${lb} lb`);
    } else {
      expect(rows.some(r => r.endsWith(' lb'))).toBe(false);
    }
  });

  it('counts equipment by catalog part, with the ghosts as to buy', () => {
    const doc = docWith([piece('gp-truss-8ft'), piece('gp-truss-8ft'), piece('gp-truss-8ft', true), piece('gp-truss-4ft')]);
    const rows = section(doc, 'EQUIPMENT')!.rows.map(r => r.text);
    expect(rows[0]).toBe('3 × DT-GP8 box truss 8 ft (1 to buy)');
    expect(rows[1]).toBe('1 × DT-GP4 box truss 4 ft');
    expect(section(doc, 'NOTES')!.rows.some(r => r.text.includes('to buy'))).toBe(true);
  });

  it('notes only what holds: units always, mounts from the spec, no wall notes on an empty scene', () => {
    const empty = section(docWith([]), 'NOTES')!.rows.map(r => r.text);
    expect(empty).toEqual(['1. Dimensions in feet & inches.']);
    expect(section(docWith([]), 'LED WALL SCHEDULE')).toBeUndefined();
    expect(section(docWith([]), 'EQUIPMENT')).toBeUndefined();
    const wall = createLedWall({ cols: 2, rows: 2 });
    const notes = section(docWith([wall]), 'NOTES')!.rows.map(r => r.text);
    const mount = wallDims(wall).spec.mount;
    expect(notes.some(n => n.includes('hang from'))).toBe(!!mount);
    if (mount) expect(notes.some(n => n.includes(mount.bolt))).toBe(true);
  });

  it('notes that the two truss systems do not connect only when both are on the sheet', () => {
    const notes = (d: Document) => section(d, 'NOTES')!.rows.map(r => r.text).join(' ');
    expect(notes(docWith([piece('gp-truss-8ft')]))).not.toContain('F34');
    expect(notes(docWith([piece('gp-truss-8ft'), piece('f34-straight-1500')]))).toContain('DT-GP and F34 truss do not connect');
  });
});

describe('chainEdges', () => {
  it('sorts the ends and merges ends that meet', () => {
    expect(chainEdges([[0, 120], [120.2, 240], [300, 260]])).toEqual([0, 120, 240, 260, 300]);
    expect(levels([96, 0, 96.3, 120])).toEqual([0, 96, 120]);
  });
});

describe('zoneCounts', () => {
  it('marks about one zone every two inches', () => {
    expect(zoneCounts(16.2, 10.2)).toEqual({ cols: 8, rows: 5 });
    expect(zoneCounts(1, 1)).toEqual({ cols: 2, rows: 2 });
  });
});
