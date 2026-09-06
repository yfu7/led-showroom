import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { Engine } from '../Engine';
import {
  autoCropRect, coverFitRect, cropPadding, evenRect, projectBoxCorners, RASTER_TTL_MS, rasterIsFresh,
  rasterizeIframes, rectsEqual, sliceCrop, unionRects,
} from './composite';

const html2canvasMock = vi.hoisted(() => vi.fn());
vi.mock('html2canvas', () => ({ default: html2canvasMock }));

/** Minimal stand-ins for the DOM objects sliceCrop reads (node test environment). */
function el(style: Record<string, string>, client = { w: 0, h: 0 }) {
  return { style: style as unknown as CSSStyleDeclaration, clientWidth: client.w, clientHeight: client.h };
}

describe('sliceCrop', () => {
  const container = el({ width: '400px', height: '300px' });
  const iframe = el({ width: '1200px', height: '900px', left: '-400px', top: '-300px' });

  it('maps the visible slice of an offset iframe into raster pixels at 1:1', () => {
    expect(sliceCrop(container, iframe, { width: 1200, height: 900 })).toEqual({ visW: 400, visH: 300, sx: 400, sy: 300, sw: 400, sh: 300 });
  });
  it('re-derives the source rect from the raster size, so a reflowed raster samples the same region', () => {
    // Same page rasterised at twice the size (e.g. page grew and html2canvas returned a bigger canvas).
    const c = sliceCrop(container, iframe, { width: 2400, height: 1800 })!;
    expect(c).toEqual({ visW: 400, visH: 300, sx: 800, sy: 600, sw: 800, sh: 600 });
    // A raster shorter than the iframe box scales the slice down proportionally and never samples past its edge.
    const short = sliceCrop(container, iframe, { width: 1200, height: 450 })!;
    expect(short.sy).toBe(150);
    expect(short.sh).toBe(150);
    expect(short.sy + short.sh).toBeLessThanOrEqual(450);
  });
  it('clamps the source rect to the raster bounds when the slice would overrun it', () => {
    // Iframe styled taller than the raster actually is (page shrank): the slice is cut at the raster edge.
    const c = sliceCrop(container, el({ width: '1200px', height: '900px', left: '-400px', top: '-700px' }), { width: 1200, height: 900 })!;
    expect(c.sy).toBe(700);
    expect(c.sh).toBe(200);
  });
  it('falls back to clientWidth/Height and the container size when styles are missing', () => {
    const c = sliceCrop(el({}, { w: 320, h: 200 }), el({}), { width: 320, height: 200 });
    expect(c).toEqual({ visW: 320, visH: 200, sx: 0, sy: 0, sw: 320, sh: 200 });
  });
  it('returns null for a degenerate element or a raster that leaves nothing visible', () => {
    expect(sliceCrop(el({ width: '0px', height: '0px' }), iframe, { width: 1200, height: 900 })).toBeNull();
    expect(sliceCrop(container, iframe, { width: 2, height: 2 })).toBeNull(); // sub-pixel slice
  });
});

describe('coverFitRect', () => {
  it('fills the height and centre-crops horizontally for a wider image', () => {
    const r = coverFitRect(2000, 1000, 800, 600); // 2:1 into 4:3
    expect(r.h).toBe(600);
    expect(r.w).toBe(1200);
    expect(r.x).toBe(-200);
    expect(r.y).toBe(0);
  });
  it('fills the width and centre-crops vertically for a taller image', () => {
    const r = coverFitRect(1000, 2000, 800, 600);
    expect(r.w).toBe(800);
    expect(r.h).toBe(1600);
    expect(r.x).toBe(0);
    expect(r.y).toBe(-500);
  });
  it('is exact when aspect ratios match', () => {
    expect(coverFitRect(400, 300, 800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe('cropPadding / autoCropRect', () => {
  it('uses the 40px floor for small boxes and 20 % of the shorter side for large ones', () => {
    expect(cropPadding({ x: 0, y: 0, w: 100, h: 100 })).toBe(40);
    expect(cropPadding({ x: 0, y: 0, w: 1000, h: 500 })).toBe(100);
    expect(cropPadding({ x: 0, y: 0, w: 100, h: 100 }, 80)).toBe(80);
  });
  it('grows the bbox by the padding', () => {
    const r = autoCropRect({ x: 300, y: 200, w: 100, h: 100 }, 1600, 900);
    expect(r).toEqual({ x: 260, y: 160, w: 180, h: 180 });
  });
  it('clamps to the canvas', () => {
    const r = autoCropRect({ x: 10, y: 5, w: 1500, h: 880 }, 1600, 900);
    expect(r).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });
  it('floors / ceils fractional bbox edges outward', () => {
    const r = autoCropRect({ x: 100.4, y: 100.6, w: 200.2, h: 200.2 }, 1000, 1000);
    expect(r.x).toBe(60);
    expect(r.y).toBe(60);
    expect(r.x + r.w).toBe(341); // ceil(300.6 + 40)
    expect(r.y + r.h).toBe(341); // ceil(300.8 + 40)
  });
  it('returns the full canvas for a missing or degenerate bbox', () => {
    expect(autoCropRect(null, 640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    expect(autoCropRect({ x: 10, y: 10, w: 1, h: 50 }, 640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    expect(autoCropRect({ x: 10, y: 10, w: 0, h: 0 }, 640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
  });
  it('returns the full canvas when the bbox lies entirely off-canvas', () => {
    expect(autoCropRect({ x: -500, y: -500, w: 100, h: 100 }, 640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
  });
});

describe('evenRect / rectsEqual / unionRects', () => {
  it('floors odd sizes to even and never below 2', () => {
    expect(evenRect({ x: 3, y: 5, w: 641, h: 481 })).toEqual({ x: 3, y: 5, w: 640, h: 480 });
    expect(evenRect({ x: 0, y: 0, w: 1, h: 0 })).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });
  it('compares rects by value', () => {
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
  });
  it('unions rects and ignores nulls', () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([null, null])).toBeNull();
    expect(unionRects([{ x: 0, y: 0, w: 10, h: 10 }, null, { x: 5, y: -5, w: 10, h: 10 }])).toEqual({ x: 0, y: -5, w: 15, h: 15 });
  });
});

describe('projectBoxCorners', () => {
  const W = 800, H = 600;
  const cam = new THREE.PerspectiveCamera(60, W / H, 1, 1000);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  it('projects a centred box symmetrically around the screen centre', () => {
    const box = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    const r = projectBoxCorners(box, new THREE.Matrix4(), cam, W, H)!;
    expect(r).not.toBeNull();
    expect(r.x + r.w / 2).toBeCloseTo(W / 2, 6);
    expect(r.y + r.h / 2).toBeCloseTo(H / 2, 6);
    // near face (z = +10, distance 90) is larger than the far face: half-height = 10 / (90 tan30°) × 300
    const halfH = (10 / (90 * Math.tan(Math.PI / 6))) * (H / 2);
    expect(r.h / 2).toBeCloseTo(halfH, 6);
    expect(r.w / 2).toBeCloseTo(halfH, 6); // square box → square screen box
  });

  it('applies matrixWorld (translation moves the box on screen, y is down)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const m = new THREE.Matrix4().makeTranslation(0, 20, 0);
    const r = projectBoxCorners(box, m, cam, W, H)!;
    expect(r.y + r.h / 2).toBeLessThan(H / 2);
    expect(r.x + r.w / 2).toBeCloseTo(W / 2, 6);
  });

  it('returns null for an empty box or a box entirely behind the camera', () => {
    expect(projectBoxCorners(new THREE.Box3(), new THREE.Matrix4(), cam, W, H)).toBeNull();
    const behind = new THREE.Matrix4().makeTranslation(0, 0, 150);
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    expect(projectBoxCorners(box, behind, cam, W, H)).toBeNull();
  });
});


describe('rasterIsFresh', () => {
  it('reuses a raster inside the window and drops it once the window has passed', () => {
    expect(rasterIsFresh(1000, 1000)).toBe(true);
    expect(rasterIsFresh(1000, 1000 + RASTER_TTL_MS - 1)).toBe(true);
    expect(rasterIsFresh(1000, 1000 + RASTER_TTL_MS)).toBe(false);
    expect(rasterIsFresh(1000, 1500, 400)).toBe(false);
  });
  it('never reuses with a zero window or a clock that went backwards', () => {
    expect(rasterIsFresh(1000, 1000, 0)).toBe(false);
    expect(rasterIsFresh(1000, 900)).toBe(false);
  });
});

describe('rasterizeIframes', () => {
  /** Fake same-origin iframe + engine: only `contentDocument` and the CSS3D query are read. */
  function fakeIframe() {
    return { contentDocument: { documentElement: {}, body: {} } } as unknown as HTMLIFrameElement;
  }
  function fakeEngine(iframes: HTMLIFrameElement[]) {
    return { renderer: { css3dEl: { querySelectorAll: () => iframes } } } as unknown as Engine;
  }

  beforeEach(() => {
    let n = 0;
    html2canvasMock.mockReset();
    html2canvasMock.mockImplementation(async () => ({ width: 8, height: 8, id: ++n }));
  });

  it('reuses a cached raster within the TTL', async () => {
    const engine = fakeEngine([fakeIframe()]);
    const first = await rasterizeIframes(engine);
    const second = await rasterizeIframes(engine);
    expect(html2canvasMock).toHaveBeenCalledTimes(1);
    expect([...second.values()][0]).toBe([...first.values()][0]);
  });

  it('re-rasterises once the cached raster has aged out, so a changed page is not stale', async () => {
    const engine = fakeEngine([fakeIframe()]);
    const first = await rasterizeIframes(engine);
    const second = await rasterizeIframes(engine, { ttlMs: 0 }); // cache older than the window
    expect(html2canvasMock).toHaveBeenCalledTimes(2);
    expect([...second.values()][0]).not.toBe([...first.values()][0]);
  });

  it('re-rasterises on force (Save Image, live websites while recording)', async () => {
    const engine = fakeEngine([fakeIframe()]);
    const first = await rasterizeIframes(engine);
    const second = await rasterizeIframes(engine, { force: true });
    expect(html2canvasMock).toHaveBeenCalledTimes(2);
    expect([...second.values()][0]).not.toBe([...first.values()][0]);
  });

  it('maps a cross-origin iframe to null without calling html2canvas', async () => {
    const blocked = { get contentDocument(): Document { throw new Error('cross-origin'); } } as unknown as HTMLIFrameElement;
    const rasters = await rasterizeIframes(fakeEngine([blocked]), { force: true });
    expect(rasters.get(blocked)).toBeNull();
    expect(html2canvasMock).not.toHaveBeenCalled();
  });

  it('keeps the last good raster when a forced re-rasterisation fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const iframe = fakeIframe();
    const engine = fakeEngine([iframe]);
    const first = await rasterizeIframes(engine);
    html2canvasMock.mockRejectedValueOnce(new Error('tainted'));
    const second = await rasterizeIframes(engine, { force: true });
    expect(second.get(iframe)).toBe(first.get(iframe));
    warn.mockRestore();
  });
});
