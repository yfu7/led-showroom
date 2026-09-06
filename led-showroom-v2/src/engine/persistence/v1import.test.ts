import { describe, it, expect } from 'vitest';
import {
  V1_PRESETS_KEY, V1_VIEW_KEY,
  V1_HIGH_PERF_GPU_KEY, V1_HIGH_RES_KEY, V1_LIVE_WEBSITE_KEY, V1_PIXEL_GRID_DIST_KEY, readV1Preferences,
  convertV1Preset, readV1PresetsFromStorage, readV1ViewFromStorage, summarizeV1Preset,
  parseV1Cells, cellsBBox, v1WallDims, v1ColumnLayout, v1WallBounds, rotateEulerXYZ, v1CentreToV2Origin,
  sanitizeV1ViewWall,
} from './v1import';
import type { V1Preset, V1View } from './v1import';
import { IPOSTER } from '../ledwall/specs';
import { isLedWall } from '../document/types';
import type { LedWallEntity } from '../document/types';

const W = IPOSTER.widthIn, H = IPOSTER.heightIn, D = IPOSTER.depthIn, G = IPOSTER.gapIn;

const globals = {
  cwUnit: 'px' as const, spanContent: false, showBezels: true, autoRotate: false,
  doubleSided: false, showAccessories: true, showDimensions: false, brightness: 80,
};

function walls(doc: ReturnType<typeof convertV1Preset>): LedWallEntity[] {
  return doc.entities.filter(isLedWall);
}

describe('constants', () => {
  it('uses the v1 storage keys', () => {
    expect(V1_PRESETS_KEY).toBe('led-showroom-presets');
    expect(V1_VIEW_KEY).toBe('led-showroom-view');
  });
});

describe('v1 geometry ports', () => {
  it('wallDims matches v1 (gap only with bezels)', () => {
    const d = v1WallDims(5, 5, true);
    expect(d.totalW).toBeCloseTo(5 * W + 4 * G, 9);
    expect(d.totalH).toBeCloseTo(5 * H + 4 * G, 9);
    expect(d.wallWPx).toBe(5 * 344);
    expect(d.wallHPx).toBe(5 * 258);
    expect(v1WallDims(5, 5, false).totalW).toBeCloseTo(5 * W, 9);
  });

  it('straight wall bounds equal the unfolded width and panel depth', () => {
    const b = v1WallBounds(5, 3, [], true);
    expect(b.w).toBeCloseTo(5 * W + 4 * G, 9);
    expect(b.h).toBeCloseTo(3 * H + 2 * G, 9);
    expect(b.depth).toBeCloseTo(D, 9);
    const layout = v1ColumnLayout(5, [], G);
    expect(layout).toHaveLength(5);
    expect(layout[2].x).toBeCloseTo(0, 9);            // centred on the mean
    expect(layout[4].x - layout[0].x).toBeCloseTo(4 * (W + G), 9);
  });

  it('a 90° corner folds the second column back (computeColumnLayout + wallBounds)', () => {
    const layout = v1ColumnLayout(2, [{ afterCol: 0, angle: 90 }], G);
    expect(layout[1].rotY).toBeCloseTo(Math.PI / 2, 9);
    expect(layout[0].x).toBeCloseTo(-W / 4, 9);
    expect(layout[1].z).toBeCloseTo(-W / 4, 9);
    const b = v1WallBounds(2, 1, [{ afterCol: 0, angle: 90 }], true);
    expect(b.w).toBeCloseTo(W + D / 2, 9);
    expect(b.depth).toBeCloseTo(W + D / 2, 9);
  });

  it('rotateEulerXYZ matches three.js order XYZ', () => {
    // pure yaw of 90° about Y: +X → -Z
    const v = rotateEulerXYZ([1, 0, 0], [0, Math.PI / 2, 0]);
    expect(v[0]).toBeCloseTo(0, 9); expect(v[2]).toBeCloseTo(-1, 9);
    // roll of 90° about Z: +Y → -X
    const u = rotateEulerXYZ([0, 1, 0], [0, 0, Math.PI / 2]);
    expect(u[0]).toBeCloseTo(-1, 9); expect(u[1]).toBeCloseTo(0, 9);
    // pitch of 90° about X: +Y → +Z
    const t = rotateEulerXYZ([0, 1, 0], [Math.PI / 2, 0, 0]);
    expect(t[1]).toBeCloseTo(0, 9); expect(t[2]).toBeCloseTo(1, 9);
  });

  it('v1CentreToV2Origin drops the origin to the bottom edge and lifts by the floor offset', () => {
    const totalH = 100;
    expect(v1CentreToV2Origin([0, 0, 0], [0, 0, 0], 1, totalH, -50)).toEqual([0, 0, 0]);
    expect(v1CentreToV2Origin([10, 20, 30], [0, 0, 0], 1, totalH, -50)[1]).toBeCloseTo(20, 9);
    // ×2 scale about the centre: bottom edge is 100 below the centre → 50 below the floor
    expect(v1CentreToV2Origin([0, 0, 0], [0, 0, 0], 2, totalH, -50)[1]).toBeCloseTo(-50, 9);
    // roll 90° about Z at the centre: the bottom-centre swings to +X by totalH/2
    const r = v1CentreToV2Origin([0, 0, 0], [0, 0, Math.PI / 2], 1, totalH, -50);
    expect(r[0]).toBeCloseTo(50, 9); expect(r[1]).toBeCloseTo(50, 9);
  });
});

describe('cells', () => {
  it('parses, dedupes and normalises to the origin', () => {
    expect(parseV1Cells(['1,1', '2,1', '2,1', 'x', 3, '2,2'])).toEqual(['0,0', '1,0', '1,1']);
    expect(parseV1Cells([])).toBeNull();
    expect(parseV1Cells('0,0')).toBeNull();
    expect(cellsBBox(['0,0', '1,0', '2,0', '1,1'])).toEqual({ cols: 3, rows: 2 });
  });
});

describe('convertV1Preset — gen 1 single wall', () => {
  it('converts cols/rows/corners/windows and stands the wall on the floor', () => {
    const preset: V1Preset = {
      name: 'Old one', ts: 1700000000000,
      cols: 5, rows: 5,
      corners: [{ afterCol: 2, angle: 90 }, { afterCol: 9, angle: 45 }],
      contentWindows: [{ rect: { x: 0, y: 0, w: 1720, h: 1290 }, mode: 'fill' }, { rect: { x: 10, y: 20, w: 300, h: 200 }, mode: 'custom' }],
      ...globals,
    };
    const doc = convertV1Preset(preset);
    expect(doc.version).toBe(2);
    expect(doc.name).toBe('Old one');
    expect(doc.createdAt).toBe(1700000000000);
    const ws = walls(doc);
    expect(ws).toHaveLength(1);
    const w = ws[0];
    expect(w.name).toBe('Wall 1');
    expect(w.cols).toBe(5); expect(w.rows).toBe(5);
    expect(w.shape).toEqual({ mode: 'rect' });
    expect(w.corners).toEqual([{ afterCol: 2, angle: 90 }]);        // afterCol 9 pruned (≥ cols-1)
    expect(w.contentWindows).toHaveLength(2);
    expect(w.contentWindows[0].mode).toBe('fill');
    expect(w.contentWindows[0].rect).toEqual({ x: 0, y: 0, w: 1720, h: 1290 });
    expect(w.contentWindows[1].mode).toBe('custom');
    expect(w.contentWindows[1].rect).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(w.contentWindows[1].source).toBeNull();
    expect(w.transform.position).toEqual([0, 0, 0]);
    expect(w.transform.rotation).toEqual([0, 0, 0]);
    expect(w.transform.scale).toEqual([1, 1, 1]);
    expect(w.bezels).toBe(true);
    expect(w.accessories).toBe(true);
    expect(w.brightness).toBe(80);
    expect(w.doubleSided).toBe(false);
    expect(w.pixelGrid).toBe(false);
    expect(doc.settings.autoRotate).toBe(false);
    expect(doc.settings.spanContent).toBe(false);
  });

  it('honours the oldest cwRect/cwMode form and defaults a window when nothing is stored', () => {
    const a = walls(convertV1Preset({ cols: 3, rows: 2, cwRect: { x: 5, y: 5, w: 100, h: 50 }, cwMode: 'scaled', ...globals }))[0];
    expect(a.contentWindows).toHaveLength(1);
    expect(a.contentWindows[0].mode).toBe('scaled');
    expect(a.contentWindows[0].rect).toEqual({ x: 5, y: 5, w: 100, h: 50 });

    const b = walls(convertV1Preset({ cols: 3, rows: 2, ...globals }))[0];
    expect(b.contentWindows).toHaveLength(1);
    expect(b.contentWindows[0].mode).toBe('fill');
    expect(b.contentWindows[0].rect).toEqual({ x: 0, y: 0, w: 3 * 344, h: 2 * 258 });
  });

  it('falls back to v1 initial-state defaults for missing globals and clamps brightness', () => {
    const doc = convertV1Preset({ cols: 2, rows: 2, brightness: 250 });
    const w = walls(doc)[0];
    expect(w.bezels).toBe(true);
    expect(w.accessories).toBe(false);
    expect(w.brightness).toBe(100);
    expect(doc.name).toBe('Imported v1 preset');
    expect(walls(convertV1Preset({}))[0].cols).toBe(5);
  });
});

describe('convertV1Preset — gen 2 multi wall with corners and windows', () => {
  const preset: V1Preset = {
    name: 'Booth', ts: 1,
    walls: [
      {
        id: 1, name: 'Main', cols: 5, rows: 5,
        corners: [{ afterCol: 2, angle: 90 }],
        contentWindows: [{ rect: { x: 0, y: 0, w: 1720, h: 1290 }, mode: 'fill' }, { rect: { x: 100, y: 100, w: 400, h: 300 }, mode: 'custom' }],
      },
      { id: 2, name: 'Side', cols: 4, rows: 4, corners: [], contentWindows: [{ rect: { x: 0, y: 0, w: 1376, h: 1032 }, mode: 'fill' }] },
      { id: 3, cols: 2, rows: 1 },
    ],
    // gen-1 mirror of the active wall — must be ignored when walls[] is present
    cols: 1, rows: 1, corners: [], contentWindows: [],
    ...globals, spanContent: true, autoRotate: true, doubleSided: true,
  };

  it('creates one entity per wall with corners and windows intact', () => {
    const doc = convertV1Preset(preset);
    const ws = walls(doc);
    expect(ws).toHaveLength(3);
    expect(ws.map(w => w.name)).toEqual(['Main', 'Side', 'Wall 3']);
    expect(ws[0].corners).toEqual([{ afterCol: 2, angle: 90 }]);
    expect(ws[0].contentWindows).toHaveLength(2);
    expect(ws[0].contentWindows[1].rect).toEqual({ x: 100, y: 100, w: 400, h: 300 });
    expect(ws[1].contentWindows).toHaveLength(1);
    expect(ws[2].contentWindows).toHaveLength(0);          // v1 emptied windows for walls without data
    expect(ws.every(w => w.doubleSided)).toBe(true);
    expect(doc.settings.spanContent).toBe(true);
    expect(doc.settings.autoRotate).toBe(true);
  });

  it('places walls like v1 arrangeWalls: 40 in right of the rightmost, all on the floor, z = 0', () => {
    const ws = walls(convertV1Preset(preset));
    const b0 = v1WallBounds(5, 5, [{ afterCol: 2, angle: 90 }], true);
    const b1 = v1WallBounds(4, 4, [], true);
    const b2 = v1WallBounds(2, 1, [], true);
    expect(ws[0].transform.position).toEqual([0, 0, 0]);
    const x1 = b0.w / 2 + 40 + b1.w / 2;
    expect(ws[1].transform.position[0]).toBeCloseTo(x1, 9);
    expect(ws[1].transform.position[1]).toBeCloseTo(0, 9);
    expect(ws[1].transform.position[2]).toBeCloseTo(0, 9);
    const x2 = x1 + b1.w / 2 + 40 + b2.w / 2;
    expect(ws[2].transform.position[0]).toBeCloseTo(x2, 9);
    expect(ws[2].transform.position[1]).toBeCloseTo(0, 9);
  });

  it('caps at 10 walls and 8 windows', () => {
    const many: V1Preset = {
      walls: Array.from({ length: 12 }, () => ({
        cols: 1, rows: 1,
        contentWindows: Array.from({ length: 10 }, () => ({ rect: { x: 0, y: 0, w: 344, h: 258 }, mode: 'custom' as const })),
      })),
    };
    const ws = walls(convertV1Preset(many));
    expect(ws).toHaveLength(10);
    expect(ws[0].contentWindows).toHaveLength(8);
  });
});

describe('convertV1Preset — gen 3 custom shape', () => {
  it('restores sparse cells and derives cols/rows from their bbox', () => {
    const preset: V1Preset = {
      walls: [
        { cols: 3, rows: 2, shape: { mode: 'custom', cells: ['0,0', '1,0', '2,0', '1,1'] }, contentWindows: [{ rect: { x: 0, y: 0, w: 1032, h: 516 }, mode: 'fill' }] },
        { cols: 4, rows: 4, shape: { mode: 'rect' } },
        { cols: 9, rows: 9, shape: { mode: 'custom', cells: ['1,1', '2,1'] } },   // un-normalised, stale cols/rows
        { cols: 2, rows: 2, shape: { mode: 'custom', cells: [] } },               // empty → rect
      ],
      ...globals,
    };
    const ws = walls(convertV1Preset(preset));
    expect(ws[0].shape).toEqual({ mode: 'custom', cells: ['0,0', '1,0', '2,0', '1,1'] });
    expect(ws[0].cols).toBe(3); expect(ws[0].rows).toBe(2);
    expect(ws[1].shape).toEqual({ mode: 'rect' });
    expect(ws[2].shape).toEqual({ mode: 'custom', cells: ['0,0', '1,0'] });
    expect(ws[2].cols).toBe(2); expect(ws[2].rows).toBe(1);
    expect(ws[3].shape).toEqual({ mode: 'rect' });
    expect(ws[3].cols).toBe(2);
    // bottom-aligned: every wall on the floor regardless of height
    ws.forEach(w => expect(w.transform.position[1]).toBeCloseTo(0, 9));
  });
});

describe('convertV1Preset — view record', () => {
  const preset: V1Preset = { walls: [{ cols: 5, rows: 5 }, { cols: 3, rows: 2 }, { cols: 4, rows: 4 }], ...globals };
  const totalH0 = 5 * H + 4 * G;
  const totalH1 = 2 * H + 1 * G;

  it('converts positions to the floor frame and radians to degrees', () => {
    const view: V1View = {
      cam: { px: 100, py: 60, pz: 300, tx: 0, ty: 10, tz: 0 }, fov: 55.4, lock: true, userView: true,
      walls: [
        { x: 0, y: 10, z: 0, r: Math.PI / 4, rx: 0, rz: 0, s: 1 },
        { x: 200, y: 0, z: -30, r: 0, rx: 0, rz: 0, s: 2 },
        null,
      ],
    };
    const doc = convertV1Preset(preset, view);
    const ws = walls(doc);
    // wall 1 lifted 10 in above the floor, yawed 45°
    expect(ws[0].transform.position[0]).toBeCloseTo(0, 9);
    expect(ws[0].transform.position[1]).toBeCloseTo(10, 9);
    expect(ws[0].transform.rotation[1]).toBeCloseTo(45, 9);
    // wall 2 scaled ×2 about its v1 centre (which sat at wall 1's centre height): its bottom edge
    // lands at totalH0/2 - totalH1 above the floor
    expect(ws[1].transform.position[0]).toBeCloseTo(200, 9);
    expect(ws[1].transform.position[1]).toBeCloseTo(totalH0 / 2 - totalH1, 9);
    expect(ws[1].transform.position[2]).toBeCloseTo(-30, 9);
    expect(ws[1].transform.scale).toEqual([2, 2, 2]);
    // wall 3 had no position: default slot right of the rightmost (wall 2, unscaled bounds), bottom-aligned to wall 1
    const b1 = v1WallBounds(3, 2, [], true), b2 = v1WallBounds(4, 4, [], true);
    expect(ws[2].transform.position[0]).toBeCloseTo(200 + b1.w / 2 + 40 + b2.w / 2, 9);
    expect(ws[2].transform.position[1]).toBeCloseTo(10, 9);
    // camera: shifted by the same floor offset; fov rounded; lock carried
    expect(doc.view.position).toEqual([100, 60 + totalH0 / 2, 300]);
    expect(doc.view.target).toEqual([0, 10 + totalH0 / 2, 0]);
    expect(doc.view.fov).toBe(55);
    expect(doc.view.locked).toBe(true);
  });

  it('applies the v1 sanity bounds', () => {
    const view: V1View = {
      cam: { px: 100, py: 60, pz: 300, tx: 0, ty: 10, tz: 0 }, fov: 200, userView: false,
      walls: [
        { x: 5000, y: 0, z: 0, r: 1 },                                 // out of range → ignored entirely
        { x: 50, y: 0, z: 0, r: 150, rx: 3, rz: 8, s: 20 },              // pos ok, every other field rejected
      ],
    };
    const doc = convertV1Preset(preset, view);
    const ws = walls(doc);
    // wall 1's record was rejected, so (as in v1 arrangeWalls) it takes the free slot right of the
    // only positioned wall — wall 2 — and sits on the floor.
    const b0 = v1WallBounds(5, 5, [], true), b1 = v1WallBounds(3, 2, [], true);
    expect(ws[0].transform.position[0]).toBeCloseTo(50 + b1.w / 2 + 40 + b0.w / 2, 9);
    expect(ws[0].transform.position[1]).toBeCloseTo(0, 9);
    expect(ws[0].transform.rotation).toEqual([0, 0, 0]);
    expect(ws[1].transform.position[0]).toBeCloseTo(50, 9);
    expect(ws[1].transform.position[1]).toBeCloseTo(totalH0 / 2 - totalH1 / 2, 9);
    expect(ws[1].transform.rotation).toEqual([0, 0, 0]);
    expect(ws[1].transform.scale).toEqual([1, 1, 1]);
    expect(doc.view.position).toEqual([140, 90, 320]);      // userView false → default camera kept
    expect(doc.view.fov).toBe(40);
    expect(doc.view.locked).toBe(false);
  });

  it('sanitizeV1ViewWall', () => {
    expect(sanitizeV1ViewWall(null)).toBeNull();
    expect(sanitizeV1ViewWall({ x: 1, y: NaN, z: 0 })).toBeNull();
    expect(sanitizeV1ViewWall({ x: 1, y: 2, z: 3 })).toEqual({ pos: [1, 2, 3], eulerRad: [0, 0, 0], scale: 1 });
    expect(sanitizeV1ViewWall({ x: 1, y: 2, z: 3, r: 0.5, rx: -1, rz: 6, s: 0.1 })).toEqual({ pos: [1, 2, 3], eulerRad: [-1, 0.5, 6], scale: 0.1 });
  });

  it('sanitizeV1ViewWall mirrors v1 isFinite/+ coercion (numeric strings and null accepted)', () => {
    // v1: `isFinite('10') && Math.abs('10') <= SANE` → true, then `+'10'` → 10
    expect(sanitizeV1ViewWall({ x: '10', y: 0, z: 0 })).toEqual({ pos: [10, 0, 0], eulerRad: [0, 0, 0], scale: 1 });
    // v1: isFinite(null) === true, +null === 0
    expect(sanitizeV1ViewWall({ x: 10, y: null, z: 0 })).toEqual({ pos: [10, 0, 0], eulerRad: [0, 0, 0], scale: 1 });
    // rotation / scale coerced the same way (r/rx/rz/s)
    expect(sanitizeV1ViewWall({ x: 0, y: 0, z: 0, r: '0.5', rx: '-1', rz: '6', s: '2' })).toEqual({ pos: [0, 0, 0], eulerRad: [-1, 0.5, 6], scale: 2 });
    expect(sanitizeV1ViewWall({ x: 0, y: 0, z: 0, r: null, s: null })).toEqual({ pos: [0, 0, 0], eulerRad: [0, 0, 0], scale: 1 });   // +null = 0; s=0 < 0.1 → 1
    // v1 rejected: isFinite(undefined) / isFinite('abc') / isFinite({}) are all false
    expect(sanitizeV1ViewWall({ x: 'abc', y: 0, z: 0 })).toBeNull();
    expect(sanitizeV1ViewWall({ x: {}, y: 0, z: 0 })).toBeNull();
    expect(sanitizeV1ViewWall({ y: 0, z: 0 })).toBeNull();
    expect(sanitizeV1ViewWall({ x: 0, y: 0, z: 0, r: 'abc', s: 'x' })).toEqual({ pos: [0, 0, 0], eulerRad: [0, 0, 0], scale: 1 });
    // the ±3000 bound still applies after coercion
    expect(sanitizeV1ViewWall({ x: '5000', y: 0, z: 0 })).toBeNull();
  });

  it('camera / fov / lock follow the same v1 coercion and truthiness rules', () => {
    const view = {
      cam: { px: '100', py: null, pz: 300, tx: 0, ty: '10', tz: 0 }, fov: '55.4', lock: 1, userView: 1,
      walls: [],
    } as unknown as V1View;
    const doc = convertV1Preset(preset, view);
    expect(doc.view.position).toEqual([100, 0 + totalH0 / 2, 300]);
    expect(doc.view.target).toEqual([0, 10 + totalH0 / 2, 0]);
    expect(doc.view.fov).toBe(55);
    expect(doc.view.locked).toBe(true);

    // one non-finite camera component rejects the whole camera (v1 `.every(sane)`); fov stays default
    const bad = { cam: { px: 'abc', py: 0, pz: 0, tx: 0, ty: 0, tz: 0 }, fov: 'wide', userView: true } as unknown as V1View;
    const d2 = convertV1Preset(preset, bad);
    expect(d2.view.position).toEqual([140, 90, 320]);
    expect(d2.view.fov).toBe(40);
    expect(d2.view.locked).toBe(false);
  });
});

describe('storage readers', () => {
  const store = (map: Record<string, string>, throws = false): Pick<Storage, 'getItem'> => ({
    getItem: (k: string) => { if (throws) throw new Error('blocked'); return map[k] ?? null; },
  });

  it('readV1PresetsFromStorage is safe', () => {
    expect(readV1PresetsFromStorage(store({}))).toEqual([]);
    expect(readV1PresetsFromStorage(store({ [V1_PRESETS_KEY]: '{bad' }))).toEqual([]);
    expect(readV1PresetsFromStorage(store({ [V1_PRESETS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readV1PresetsFromStorage(store({}, true))).toEqual([]);
    const list = readV1PresetsFromStorage(store({ [V1_PRESETS_KEY]: JSON.stringify([{ name: 'a', cols: 2, rows: 2 }, 7, null, { walls: [] }]) }));
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('a');
  });

  it('readV1ViewFromStorage is safe', () => {
    expect(readV1ViewFromStorage(store({}))).toBeNull();
    expect(readV1ViewFromStorage(store({ [V1_VIEW_KEY]: '[1]' }))).toBeNull();
    expect(readV1ViewFromStorage(store({}, true))).toBeNull();
    expect(readV1ViewFromStorage(store({ [V1_VIEW_KEY]: '{"fov":50}' }))).toEqual({ fov: 50 });
  });

  it('readV1Preferences translates the four legacy preference keys', () => {
    expect(readV1Preferences(store({}))).toEqual({});
    expect(readV1Preferences(store({}, true))).toEqual({});
    expect(readV1Preferences(store({
      [V1_HIGH_PERF_GPU_KEY]: 'true',
      [V1_HIGH_RES_KEY]: 'true',
      [V1_LIVE_WEBSITE_KEY]: 'true',
      [V1_PIXEL_GRID_DIST_KEY]: '120',
    }))).toEqual({ gpu: 'high-performance', qualityScale: 1.5, liveWebsiteInRecordings: true, pixelGridDistIn: 120 });
    // an explicit opt-out is a choice too; the "off" options simply stay at the v2 default
    expect(readV1Preferences(store({
      [V1_HIGH_PERF_GPU_KEY]: 'false', [V1_HIGH_RES_KEY]: 'false', [V1_LIVE_WEBSITE_KEY]: 'false',
    }))).toEqual({ gpu: 'low-power' });
  });

  it('readV1Preferences ignores unrecognised values', () => {
    expect(readV1Preferences(store({ [V1_HIGH_PERF_GPU_KEY]: 'yes', [V1_PIXEL_GRID_DIST_KEY]: '100' }))).toEqual({});
    expect(readV1Preferences(store({ [V1_PIXEL_GRID_DIST_KEY]: 'nope' }))).toEqual({});
    expect(readV1Preferences(store({ [V1_PIXEL_GRID_DIST_KEY]: '144' }))).toEqual({ pixelGridDistIn: 144 });
  });
});

describe('summarizeV1Preset', () => {
  it('describes each wall, marking custom shapes', () => {
    expect(summarizeV1Preset({ cols: 5, rows: 5 })).toBe('1 wall · 5×5');
    expect(summarizeV1Preset({
      walls: [
        { cols: 5, rows: 5 },
        { cols: 3, rows: 2, shape: { mode: 'custom', cells: ['0,0', '1,0', '2,0', '1,1'] } },
        { cols: 4, rows: 4 },
      ],
    })).toBe('3 walls · 5×5, 3×2 (custom), 4×4');
  });
});
