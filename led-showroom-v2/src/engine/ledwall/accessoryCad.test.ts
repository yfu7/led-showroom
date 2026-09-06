/**
 * Swapping the manufacturer's CAD in behind the extruded accessory placeholders.
 *
 * A wall is built synchronously, so `basePlateGeometry` / `supportBracketGeometry` always return
 * something immediately and the CAD replaces the contents of that very geometry object when it
 * arrives — meshes are never rebuilt, the renderer only re-renders. These tests drive that with an
 * injected loader; the real GLBs (and the frames they land in) are checked in
 * `content/cadModels.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { setCadLoader } from '../content/cadModels';
import { IPOSTER } from './specs';
import {
  ACCESSORY_CAD, CAD_BASE_SPEC, CAD_SUPPORT_SPEC, basePlateGeometry, basePlateMatchesCad, disposeGeometryCache,
  onAccessoryGeometry, preloadAccessoryGeometry, supportBracketGeometry, supportBracketMatchesCad,
} from './geometry';

const base = IPOSTER.accessories!.base;
const support = IPOSTER.accessories!.support;

/** Vertex count of the extruded placeholders, so a swap is unmistakable. */
const EXTRUDED_BASE_VERTS = 132;

const box = (g: THREE.BufferGeometry): THREE.Box3 => {
  g.computeBoundingBox();
  return g.boundingBox!;
};

/**
 * Stand-in CAD: a box of the part's real size, deliberately parked away from the origin so the
 * loader's framing has to move it, and tagged per part so we can tell the three apart.
 */
function fakeCad(url: string): THREE.BufferGeometry {
  const size = url.includes('base') ? [25.08, 0.25, 18.78] : [2, 21.14, 6.7];
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  g.translate(37, 91, -13);
  g.userData.part = url;
  return g;
}

afterEach(() => {
  setCadLoader(null); // also empties the CAD cache
  disposeGeometryCache();
});

describe('CAD / spec matching', () => {
  it('the shipped CAD is the iPoster spec, so real walls get it', () => {
    expect(basePlateMatchesCad(base)).toBe(true);
    expect(supportBracketMatchesCad(support)).toBe(true);
    expect(base.backW).toBeCloseTo(CAD_BASE_SPEC.backW, 6);
    expect(support.totalH).toBeCloseTo(CAD_SUPPORT_SPEC.totalH, 6);
  });

  it('a hand-edited spec keeps the parametric extrusion, which is the only thing that can follow it', () => {
    expect(basePlateMatchesCad({ ...base, thick: 0.5 })).toBe(false);
    expect(basePlateMatchesCad({ ...base, depth: 20 })).toBe(false);
    expect(basePlateMatchesCad({ ...base, notch: 4 })).toBe(false);
    expect(supportBracketMatchesCad({ ...support, totalH: 30 })).toBe(false);
    expect(supportBracketMatchesCad({ ...support, footD: 8 })).toBe(false);
  });

  it('ignores fields that do not shape the model, and tolerates rounding', () => {
    expect(supportBracketMatchesCad({ ...support, thick: 2, inset: 9 })).toBe(true);
    expect(basePlateMatchesCad({ ...base, backW: base.backW + 0.004 })).toBe(true);
    expect(basePlateMatchesCad({ ...base, backW: base.backW + 0.05 })).toBe(false);
  });

  it('names one CAD file per part', () => {
    expect(Object.keys(ACCESSORY_CAD).sort()).toEqual(['base', 'support-lh', 'support-rh']);
    expect(new Set(Object.values(ACCESSORY_CAD).map(p => p.url)).size).toBe(3);
  });
});

describe('preloadAccessoryGeometry', () => {
  it('does nothing (and never rejects) when no CAD can be loaded', async () => {
    await expect(preloadAccessoryGeometry()).resolves.toBeUndefined();
    expect(basePlateGeometry(base).attributes.position.count).toBe(EXTRUDED_BASE_VERTS);
  });

  it('swaps the CAD into the placeholder already handed out, keeping its identity', async () => {
    setCadLoader(async url => fakeCad(url));
    const changed = vi.fn();
    const off = onAccessoryGeometry(changed);

    const plate = basePlateGeometry(base);
    expect(plate.attributes.position.count).toBe(EXTRUDED_BASE_VERTS);

    await preloadAccessoryGeometry();

    expect(basePlateGeometry(base)).toBe(plate); // same object: no mesh had to be rebuilt
    expect(plate.attributes.position.count).toBe(24); // the CAD box, not the extrusion
    expect(changed).toHaveBeenCalledTimes(1);
    off();

    // …and it landed in the frame accessoryPlacements places it in: top face on the panel bottom.
    const b = box(plate);
    expect(b.max.y).toBeCloseTo(0, 6);
    expect(b.min.y).toBeCloseTo(-0.25, 4);
    expect(b.min.x).toBeCloseTo(-12.54, 4);
    expect(b.max.z).toBeCloseTo(9.39, 4);
  });

  it('frames the brackets on the ground with the bar on the panel back', async () => {
    setCadLoader(async url => fakeCad(url));
    const lh = supportBracketGeometry(support);
    await preloadAccessoryGeometry();
    const b = box(lh);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.max.y).toBeCloseTo(21.14, 4);
    expect(b.max.z).toBeCloseTo(0, 6);
    expect(b.min.z).toBeCloseTo(-6.7, 4);
    expect(b.min.x).toBeCloseTo(-1, 4);
  });

  it('gives the left and right brackets their own geometry, from their own file', async () => {
    const urls: string[] = [];
    setCadLoader(async url => { urls.push(url); return fakeCad(url); });
    const lh = supportBracketGeometry(support, false);
    const rh = supportBracketGeometry(support, true);
    expect(rh).not.toBe(lh);
    await preloadAccessoryGeometry();
    expect(urls).toContain(ACCESSORY_CAD['support-lh'].url);
    expect(urls).toContain(ACCESSORY_CAD['support-rh'].url);
    expect(lh.attributes.position.count).toBe(24);
    expect(rh.attributes.position.count).toBe(24);
    expect(rh).not.toBe(lh);
  });

  it('hands the CAD straight out once it is warm, with no placeholder step', async () => {
    setCadLoader(async url => fakeCad(url));
    await preloadAccessoryGeometry(); // warmed before any wall exists
    expect(basePlateGeometry(base).attributes.position.count).toBe(24);
    expect(supportBracketGeometry(support).attributes.position.count).toBe(24);
  });

  it('loads once however many times it is called', async () => {
    let calls = 0;
    setCadLoader(async url => { calls++; return fakeCad(url); });
    await Promise.all([preloadAccessoryGeometry(), preloadAccessoryGeometry()]);
    await preloadAccessoryGeometry();
    expect(calls).toBe(3); // one per part, not per call
  });

  it('leaves a spec the CAD does not fit on the extrusion', async () => {
    setCadLoader(async url => fakeCad(url));
    await preloadAccessoryGeometry();
    const custom = basePlateGeometry({ ...base, thick: 0.5 });
    expect(custom.attributes.position.count).toBe(EXTRUDED_BASE_VERTS);
    expect(box(custom).min.y).toBeCloseTo(-0.5, 6);
  });

  it('keeps the placeholder when the CAD cannot be loaded, and does not notify', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCadLoader(async () => { throw new Error('offline'); });
    const changed = vi.fn();
    const off = onAccessoryGeometry(changed);
    const plate = basePlateGeometry(base);
    await preloadAccessoryGeometry();
    expect(plate.attributes.position.count).toBe(EXTRUDED_BASE_VERTS);
    expect(changed).not.toHaveBeenCalled();
    off();
    warn.mockRestore();
  });

  it('stops notifying an unsubscribed listener', async () => {
    setCadLoader(async url => fakeCad(url));
    const changed = vi.fn();
    onAccessoryGeometry(changed)();
    basePlateGeometry(base);
    await preloadAccessoryGeometry();
    expect(changed).not.toHaveBeenCalled();
  });
});
