import { describe, expect, it } from 'vitest';
import { fitPose, viewerPresets, VIEWER_EYE_HEIGHT_M, VIEWER_FIT_PADDING, type ViewerPreset, type WallView } from './presets';

const close = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe('viewer presets', () => {
  const scene: WallView['box'] = { min: [-3, 0, -1], max: [3, 2.5, 1] };

  it('gives an overview, front and top, then one stand square on to each wall', () => {
    const walls: WallView[] = [
      { id: 'a', name: 'North', box: { min: [-2, 0, -0.1], max: [2, 2, 0.1] }, normal: [0, 0, 1] },
      // Turned to face +x: 3 m across along z, 0.2 m deep along x.
      { id: 'b', name: 'Side', box: { min: [2.9, 0, -1.5], max: [3.1, 2.4, 1.5] }, normal: [1, 0, 0] },
    ];
    const p = viewerPresets(scene, walls);
    expect(p.map(x => x.id)).toEqual(['overview', 'front', 'top', 'wall:a', 'wall:b']);
    expect(p.map(x => x.label)).toEqual(['Overview', 'Front', 'Top', 'North', 'Side']);
    const side = p[4];
    close(side.center, [3, 1.2, 0]);
    close(side.dir, [1, 0, 0]);
    expect(side.w).toBeCloseTo(3, 9);
    expect(side.h).toBeCloseTo(2.4, 9);
    expect(side.depth).toBeCloseTo(0.2, 9);
  });

  it('numbers walls that share a name', () => {
    const w = (id: string, name: string): WallView => ({ id, name, box: scene, normal: [0, 0, 1] });
    const p = viewerPresets(scene, [w('a', 'LED Wall'), w('b', 'Tower'), w('c', 'LED Wall'), w('d', ' ')]);
    expect(p.slice(3).map(x => x.label)).toEqual(['LED Wall 1', 'Tower', 'LED Wall 2', 'Wall']);
  });

  it('keeps a wall stand level, whatever tilt its facing has', () => {
    const [, , , w] = viewerPresets(scene, [{ id: 'w', name: '', box: scene, normal: [0, 0.5, 1] }]);
    expect(w.dir[1]).toBe(0);
    expect(w.label).toBe('Wall');
  });

  it('stands far enough off to fit the height, or the width on a narrow window', () => {
    const p: ViewerPreset = { id: 'x', label: 'x', center: [0, 1, 0], w: 4, h: 2, depth: 0.4, dir: [0, 0, 1] };
    const t = Math.tan((40 * Math.PI) / 360);
    const wide = fitPose(p, 40, 4); // wide window: the height sets it
    close(wide.position, [0, 1, (1 / t) * VIEWER_FIT_PADDING + 0.2]);
    close(wide.target, [0, 1, 0]);
    const narrow = fitPose(p, 40, 0.5); // phone upright: the width sets it
    close(narrow.position, [0, 1, (2 / t / 0.5) * VIEWER_FIT_PADDING + 0.2]);
  });

  it('walks at the app eye level, 66 in', () => {
    expect(VIEWER_EYE_HEIGHT_M).toBeCloseTo(1.6764, 9);
  });
});
