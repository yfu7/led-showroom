/**
 * What has to be true of the drawing sheet for it to be measurable: the orthographic cameras put
 * the model on the page at exactly the printed scale, the third-angle views face each other the way
 * the convention requires, and the title block reports the scene it was generated from.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { titleFields, viewCamera } from './drawing';
import { sheetLayout, viewOf, type ViewKey } from './sheet';
import { createDocument, createLedWall } from '../document/defaults';
import type { Document, LedWallEntity } from '../document/types';
import { wallDims } from '../ledwall/layout';

const WALL = { w: 240, h: 120, d: 20 };
/** Bounds for WALL, centred on the origin. */
const bounds = (e = WALL): THREE.Box3 =>
  new THREE.Box3(new THREE.Vector3(-e.w / 2, -e.h / 2, -e.d / 2), new THREE.Vector3(e.w / 2, e.h / 2, e.d / 2));

/** Where a world point lands in NDC through a camera. */
const ndc = (cam: THREE.Camera, x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z).project(cam);

const docWith = (walls: LedWallEntity[], name = 'Main Atrium'): Document =>
  ({ ...createDocument(), name, entities: walls });

describe('viewCamera', () => {
  const layout = sheetLayout(WALL);

  it('draws a to-scale view at exactly the sheet scale', () => {
    const v = viewOf(layout, 'front')!;
    const cam = viewCamera(v, bounds(), layout.pxPerIn);
    // The right edge of the model in NDC, converted back to sheet pixels, must be half the drawn
    // width the layout promised — that equality is what makes the printed "1 : N" true.
    const edge = ndc(cam, WALL.w / 2, 0, 0).x * (v.fit.w / 2);
    expect(edge).toBeCloseTo(v.drawnW / 2, 4);
    const topEdge = ndc(cam, 0, WALL.h / 2, 0).y * (v.fit.h / 2);
    expect(topEdge).toBeCloseTo(v.drawnH / 2, 4);
  });

  it('keeps every to-scale view on the same scale', () => {
    const perInch = (key: ViewKey, axis: 'x' | 'y', model: number): number => {
      const v = viewOf(layout, key)!;
      const cam = viewCamera(v, bounds(), layout.pxPerIn);
      const p = ndc(cam, axis === 'x' ? model : 0, axis === 'y' ? model : 0, 0);
      return Math.abs((axis === 'x' ? p.x * v.fit.w / 2 : p.y * v.fit.h / 2) / model);
    };
    expect(perInch('front', 'x', 60)).toBeCloseTo(layout.pxPerIn, 6);
    expect(perInch('top', 'x', 60)).toBeCloseTo(layout.pxPerIn, 6);
    expect(perInch('right', 'y', 40)).toBeCloseTo(layout.pxPerIn, 6);
  });

  it('orients the views in third angle, so shared edges face each other', () => {
    const front = viewCamera(viewOf(layout, 'front')!, bounds(), layout.pxPerIn);
    const top = viewCamera(viewOf(layout, 'top')!, bounds(), layout.pxPerIn);
    const right = viewCamera(viewOf(layout, 'right')!, bounds(), layout.pxPerIn);

    // Front: +X right, +Y up — the ordinary elevation.
    expect(ndc(front, 10, 0, 0).x).toBeGreaterThan(0);
    expect(ndc(front, 0, 10, 0).y).toBeGreaterThan(0);
    // Top sits above Front, so the model's front face (+Z) has to point DOWN the page, toward it.
    expect(ndc(top, 10, 0, 0).x).toBeGreaterThan(0);
    expect(ndc(top, 0, 0, 10).y).toBeLessThan(0);
    // Right sits beside Front, so the front face points LEFT, back toward it.
    expect(ndc(right, 0, 0, 10).x).toBeLessThan(0);
    expect(ndc(right, 0, 10, 0).y).toBeGreaterThan(0);
  });

  it('fits the iso in its cell instead of claiming the sheet scale', () => {
    const v = viewOf(layout, 'iso')!;
    const cam = viewCamera(v, bounds(), layout.pxPerIn);
    for (let i = 0; i < 8; i++) {
      const p = ndc(cam, i & 1 ? WALL.w / 2 : -WALL.w / 2, i & 2 ? WALL.h / 2 : -WALL.h / 2, i & 4 ? WALL.d / 2 : -WALL.d / 2);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
    }
    // ...and it fills the cell on one axis rather than sitting tiny in the middle.
    const reach = Array.from({ length: 8 }, (_, i) => {
      const p = ndc(cam, i & 1 ? WALL.w / 2 : -WALL.w / 2, i & 2 ? WALL.h / 2 : -WALL.h / 2, i & 4 ? WALL.d / 2 : -WALL.d / 2);
      return Math.max(Math.abs(p.x), Math.abs(p.y));
    }).reduce((a, b) => Math.max(a, b));
    expect(reach).toBeGreaterThan(0.85);
  });

  it('centres the iso on its projected silhouette, not on the model axis', () => {
    const v = viewOf(layout, 'iso')!;
    const cam = viewCamera(v, bounds(), layout.pxPerIn);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = ndc(cam, i & 1 ? WALL.w / 2 : -WALL.w / 2, i & 2 ? WALL.h / 2 : -WALL.h / 2, i & 4 ? WALL.d / 2 : -WALL.d / 2);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // A box seen from a corner leans, so its silhouette centre is not the bounds centre; fitting
    // on max|x| alone used to park the drawing high and to one side of the cell.
    expect((minX + maxX) / 2).toBeCloseTo(0, 6);
    expect((minY + maxY) / 2).toBeCloseTo(0, 6);
  });

  it('puts the whole model inside the depth range of every view', () => {
    for (const v of layout.views) {
      const cam = viewCamera(v, bounds(), layout.pxPerIn);
      for (let i = 0; i < 8; i++) {
        const p = ndc(cam, i & 1 ? WALL.w / 2 : -WALL.w / 2, i & 2 ? WALL.h / 2 : -WALL.h / 2, i & 4 ? WALL.d / 2 : -WALL.d / 2);
        expect(p.z).toBeGreaterThan(-1);   // not behind the near plane
        expect(p.z).toBeLessThan(1);       // not past the far plane
      }
    }
  });

  it('survives a degenerate (flat, zero-size) bound without producing NaNs', () => {
    const flat = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    for (const v of sheetLayout({ w: 0, h: 0, d: 0 }).views) {
      const cam = viewCamera(v, flat, 1);
      expect(Number.isFinite(cam.left + cam.right + cam.top + cam.bottom + cam.near + cam.far)).toBe(true);
    }
  });
});

describe('titleFields', () => {
  const field = (doc: Document, label: string, opts?: Partial<Parameters<typeof titleFields>[3]>) =>
    titleFields(doc, WALL, 'ft', { date: '18/11/2026', scaleDenom: 48, toScale: true, ...opts })
      .find(f => f.label === label)?.value;

  it('reports the project, the date and the scale as printed', () => {
    const doc = docWith([]);
    expect(field(doc, 'PROJECT')).toBe('Main Atrium');
    expect(field(doc, 'DATE')).toBe('18/11/2026');
    expect(field(doc, 'SCALE')).toBe('1 : 48');
  });

  it('prints NTS rather than a ratio when the view is not to scale', () => {
    expect(field(docWith([]), 'SCALE', { toScale: false })).toBe('NTS');
  });

  it('prefers an explicit project name, and names an unnamed scene', () => {
    expect(field(docWith([]), 'PROJECT', { project: 'Booth 4201' })).toBe('Booth 4201');
    expect(field(docWith([], '   '), 'PROJECT')).toBe('Untitled show');
  });

  it('counts the panels and the LED area across every wall', () => {
    const a = createLedWall({ cols: 4, rows: 3 }), b = createLedWall({ cols: 2, rows: 2 });
    expect(field(docWith([a, b]), 'LED')).toMatch(/^16 panels/);
    expect(field(docWith([]), 'LED')).toBe('—');
  });

  it('lists wall resolutions, and stops listing once there are too many', () => {
    const w = (cols: number, rows: number) => createLedWall({ cols, rows });
    const one = w(4, 3);
    const d = wallDims(one);
    expect(field(docWith([one]), 'RESOLUTION')).toBe(`${d.wallWPx} × ${d.wallHPx}`);
    // Two distinct sizes are both worth printing...
    expect(field(docWith([w(4, 3), w(2, 2)]), 'RESOLUTION')).toContain('·');
    // ...three would not fit the cell, so the rest are counted instead.
    expect(field(docWith([w(4, 3), w(2, 2), w(5, 5)]), 'RESOLUTION')).toMatch(/\+2 more$/);
    // Identical walls are one resolution, not three.
    expect(field(docWith([w(4, 3), w(4, 3), w(4, 3)]), 'RESOLUTION')).toBe(`${d.wallWPx} × ${d.wallHPx}`);
  });

  it('states the overall size in the document units', () => {
    expect(field(docWith([]), 'OVERALL  W × H × D')).toBe(`20' 0" × 10' 0" × 1' 8"`);
  });

  it('measures nothing on an empty scene', () => {
    // `generateDrawing` passes a unit cube for an empty scene so the layout maths stays finite.
    // Printed as-is it would read as a measured 1 in object at 1 : 1.
    const empty = (label: string) =>
      titleFields(docWith([]), { w: 1, h: 1, d: 1 }, 'ft', { date: '18/11/2026', scaleDenom: 1, toScale: true, empty: true })
        .find(f => f.label === label)?.value;
    expect(empty('OVERALL  W × H × D')).toBe('—');
    expect(empty('SCALE')).toBe('—');
    // The rest of the strip still identifies the sheet.
    expect(empty('PROJECT')).toBe('Main Atrium');
    expect(empty('DATE')).toBe('18/11/2026');
  });
});
