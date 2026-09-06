import { describe, it, expect, vi } from 'vitest';

// The splat library touches browser globals at import time; stub the enum surface we use.
vi.mock('@mkkellogg/gaussian-splats-3d', () => ({
  SceneFormat: { Splat: 0, KSplat: 1, Ply: 2, Spz: 3 },
  LoaderStatus: { Downloading: 0, Processing: 1, Done: 2 },
  DropInViewer: class {},
}));

import {
  splatFormatFromFileName,
  toSceneFormat,
  splatNeedsRender,
  shouldRemeasure,
  SPLAT_FALLBACK_SIZE_IN,
  LOADER_STATUS_DONE,
  REMEASURE_INTERVAL_SECONDS,
  type SplatFrameState,
} from './SplatRenderer';

describe('splatFormatFromFileName', () => {
  it('detects ksplat / splat / ply (default) ignoring case and query strings', () => {
    expect(splatFormatFromFileName('room.ksplat')).toBe('ksplat');
    expect(splatFormatFromFileName('ROOM.SPLAT')).toBe('splat');
    expect(splatFormatFromFileName('scan.ply')).toBe('ply');
    expect(splatFormatFromFileName('https://x.test/a/b.ksplat?x=1')).toBe('ksplat');
    expect(splatFormatFromFileName('unknown.bin')).toBe('ply');
  });
});

describe('toSceneFormat', () => {
  it('maps document formats onto the library enum', () => {
    expect(toSceneFormat('ply')).toBe(2);
    expect(toSceneFormat('splat')).toBe(0);
    expect(toSceneFormat('ksplat')).toBe(1);
  });
});

describe('constants', () => {
  it('uses a 120 in fallback box', () => {
    expect(SPLAT_FALLBACK_SIZE_IN).toBe(120);
  });
  it('matches the library LoaderStatus.Done value and throttles re-measurement', () => {
    expect(LOADER_STATUS_DONE).toBe(2);
    expect(REMEASURE_INTERVAL_SECONDS).toBeGreaterThan(0);
  });
});

const idle: SplatFrameState = {
  loading: false, sorting: false, wasSorting: false, fading: false, renderReady: true, grew: false, settle: 0,
};

describe('splatNeedsRender', () => {
  it('is idle once loaded, sorted, settled and not growing', () => {
    expect(splatNeedsRender(idle)).toBe(false);
  });
  it('renders while the first section loads', () => {
    expect(splatNeedsRender({ ...idle, loading: true })).toBe(true);
  });
  it('renders while sorting and on the frame a sort finishes', () => {
    expect(splatNeedsRender({ ...idle, sorting: true })).toBe(true);
    expect(splatNeedsRender({ ...idle, wasSorting: true, sorting: false })).toBe(true);
  });
  it('renders during the reveal fade, before the first sort and while settling', () => {
    expect(splatNeedsRender({ ...idle, fading: true })).toBe(true);
    expect(splatNeedsRender({ ...idle, renderReady: false })).toBe(true);
    expect(splatNeedsRender({ ...idle, settle: 0.1 })).toBe(true);
  });
  it('renders on the frame a later progressive section lands', () => {
    expect(splatNeedsRender({ ...idle, grew: true })).toBe(true);
  });
});

describe('shouldRemeasure', () => {
  it('re-measures only when the count changed, no sort is running and the throttle elapsed', () => {
    expect(shouldRemeasure(5000, 1000, false, 0)).toBe(true);
    expect(shouldRemeasure(5000, 5000, false, 0)).toBe(false);
    expect(shouldRemeasure(5000, 1000, true, 0)).toBe(false);
    expect(shouldRemeasure(5000, 1000, false, 0.1)).toBe(false);
  });
  it('never measures an empty mesh', () => {
    expect(shouldRemeasure(0, 1000, false, 0)).toBe(false);
  });
});
