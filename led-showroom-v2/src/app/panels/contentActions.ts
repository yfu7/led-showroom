/**
 * Content-window actions: every edit the Content panel makes to a wall's `contentWindows`
 * array, expressed as immutable updates through `engine.update`. Ported from v1
 * (setWindowContent 5518-5548, clearWindowContent 5550-5563, addContentWindow 5566-5586,
 * removeContentWindow 5588-5598, upload/URL handlers 6035-6135, mode tabs 6237-6264,
 * rect edits 6310-6378).
 */
import type { Engine } from '@/engine/Engine';
import type { ContentFitMode, ContentSource, ContentWindow, LedWallEntity, PxRect } from '@/engine/document/types';
import { createContentWindow } from '@/engine/document/defaults';
import { LIMITS } from '@/engine/ledwall/specs';
import { wallDims, type WallDims } from '@/engine/ledwall/layout';
import {
  alignRect, canReorderWindow, clampWindowRect, defaultWindowRect, lockedAspectRatio, reorderWindows, setRectField, type AlignKey,
} from '@/engine/ledwall/contentWindows';
import { pickDecodePath, sniffVideoCodecs } from '@/engine/content/video';
import { DEFAULT_SOLID_COLOR, type PatternKind } from '@/engine/content/generators';

const EDIT_LABEL = 'Edit content window';

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov)$/i;

export const isVideoFile = (file: File): boolean => file.type.startsWith('video/') || VIDEO_EXT.test(file.name);

/** Re-clamp every window to a (possibly new) wall size (v1 applyAllWindowRects). */
export function reclampWindows(windows: ContentWindow[], dims: WallDims): ContentWindow[] {
  return windows.map(w => {
    const rect = clampWindowRect(w.rect, w.mode, dims);
    return rect.x === w.rect.x && rect.y === w.rect.y && rect.w === w.rect.w && rect.h === w.rect.h ? w : { ...w, rect };
  });
}

/** Patch one window inside a wall's `contentWindows` array. */
export function updateWindow(
  engine: Engine,
  wallId: string,
  windowId: string,
  patch: Partial<ContentWindow> | ((w: ContentWindow, wall: LedWallEntity) => ContentWindow),
  opts: { label?: string; mergeKey?: string } = {},
): void {
  engine.update<LedWallEntity>(wallId, wall => ({
    ...wall,
    contentWindows: wall.contentWindows.map(w => {
      if (w.id !== windowId) return w;
      return typeof patch === 'function' ? patch(w, wall) : { ...w, ...patch };
    }),
  }), { label: opts.label ?? EDIT_LABEL, mergeKey: opts.mergeKey });
}

/** Append a window (first one fills the wall, later ones are 50 % centred). Returns it, or null at the limit. */
export function addWindow(engine: Engine, wall: LedWallEntity): ContentWindow | null {
  if (wall.contentWindows.length >= LIMITS.maxContentWindows) {
    engine.toast('info', `Up to ${LIMITS.maxContentWindows} content windows per wall`);
    return null;
  }
  const index = wall.contentWindows.length;
  const { mode, rect } = defaultWindowRect(index, wallDims(wall));
  const win = createContentWindow({ mode, rect }, index);
  engine.update<LedWallEntity>(wall.id, w => ({ ...w, contentWindows: [...w.contentWindows, win] }), { label: 'Add content window' });
  return win;
}

export function removeWindow(engine: Engine, wallId: string, windowId: string): void {
  engine.update<LedWallEntity>(wallId, w => ({ ...w, contentWindows: w.contentWindows.filter(x => x.id !== windowId) }), { label: 'Remove content window' });
}

/**
 * Copy a window (source, rect, opacity and all) as a new one on top of the list, nudged down and
 * right by a twentieth of the wall so it is visible on the panels rather than hidden underneath.
 * Returns the new window, or null at the per-wall limit.
 */
export function duplicateWindow(engine: Engine, wall: LedWallEntity, windowId: string): ContentWindow | null {
  const src = wall.contentWindows.find(w => w.id === windowId);
  if (!src) return null;
  if (wall.contentWindows.length >= LIMITS.maxContentWindows) {
    engine.toast('info', `Up to ${LIMITS.maxContentWindows} content windows per wall`);
    return null;
  }
  const dims = wallDims(wall);
  const step = Math.round(Math.min(dims.wallWPx, dims.wallHPx) / 20);
  const base = src.mode === 'custom' ? src.rect : { x: 0, y: 0, w: dims.wallWPx, h: dims.wallHPx };
  const copy: ContentWindow = {
    ...createContentWindow({ mode: 'custom', rect: base }, wall.contentWindows.length),
    name: `${src.name} copy`.slice(0, 30),
    source: src.source ? { ...src.source } : null,
    aspectLock: src.aspectLock,
    visible: src.visible,
    opacity: src.opacity,
    rect: clampWindowRect({ ...base, x: base.x + step, y: base.y + step }, 'custom', dims),
  };
  engine.update<LedWallEntity>(wall.id, w => ({ ...w, contentWindows: [...w.contentWindows, copy] }), { label: 'Duplicate content window' });
  return copy;
}

/** Move a window one place in the draw order (+1 = forward / on top, -1 = backward). */
export function moveWindow(engine: Engine, wall: LedWallEntity, windowId: string, dir: 1 | -1): void {
  if (!canReorderWindow(wall.contentWindows, windowId, dir)) return;
  engine.update<LedWallEntity>(wall.id, w => ({ ...w, contentWindows: reorderWindows(w.contentWindows, windowId, dir) }), {
    label: dir === 1 ? 'Bring window forward' : 'Send window backward',
  });
}

export function renameWindow(engine: Engine, wallId: string, windowId: string, name: string): void {
  const n = name.trim().slice(0, 30);
  if (!n) return;
  updateWindow(engine, wallId, windowId, { name: n }, { label: 'Rename content window' });
}

/**
 * Store the file as an asset and point the window at it (image or video). Resolves `true` when
 * the window was updated; every failure (undecodable codec, a rejected asset-store write) is
 * toasted here so callers may fire and forget. The wall's loading flag covers the store write.
 */
export async function setWindowSource(engine: Engine, wallId: string, windowId: string, file: File): Promise<boolean> {
  const video = isVideoFile(file);
  const loadKey = `upload:${windowId}`;
  engine.setLoading(wallId, loadKey, true);
  try {
    let codec: ContentSource['codec'];
    if (video) {
      const info = await sniffVideoCodecs(file);
      if (pickDecodePath(info) === 'unsupported') {
        engine.toast('error', 'This video is encoded with a codec your browser cannot decode (likely HEVC) and WebCodecs is unavailable. Re-encode to H.264 and try again.');
        return false;
      }
      codec = info.hasHevc ? 'hevc'
        : info.hasAvc ? 'avc'
          : info.codecs.some(c => c.startsWith('vp09') || c === 'vp9') ? 'vp9'
            : info.codecs.some(c => c.startsWith('av01')) ? 'av1'
              : 'other';
    }
    const assetId = await engine.assets.put(file, file.name);
    const wall = engine.entity<LedWallEntity>(wallId);
    if (!wall || !wall.contentWindows.some(w => w.id === windowId)) return false;
    const source: ContentSource = {
      type: video ? 'video' : 'image',
      assetId,
      name: file.name,
      mimeType: file.type || undefined,
      codec,
      loop: video ? true : undefined,
      muted: video ? true : undefined,
    };
    updateWindow(engine, wallId, windowId, { source, name: file.name.replace(/\.[^.]+$/, '') }, { label: video ? 'Load video' : 'Load image' });
    return true;
  } catch (e) {
    const reason = e instanceof Error && e.message ? e.message : 'storage error';
    engine.toast('error', `Could not load ${file.name}: ${reason}`);
    return false;
  } finally {
    engine.setLoading(wallId, loadKey, false);
  }
}

/** Website source; adds https:// when the scheme is missing (v1 6127-6133). */
export function setWebsiteSource(engine: Engine, wallId: string, windowId: string, raw: string): void {
  const t = raw.trim();
  if (!t) return;
  const url = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  updateWindow(engine, wallId, windowId, { source: { type: 'website', url, name: url }, name: url.replace(/^https?:\/\//, '').slice(0, 30) }, { label: 'Load website' });
}

/** Built-in generator source: 'solid' becomes a colour source, everything else a test pattern. */
export function setPatternSource(engine: Engine, wallId: string, windowId: string, kind: PatternKind, color = DEFAULT_SOLID_COLOR, mergeKey?: string): void {
  const source: ContentSource = kind === 'solid'
    ? { type: 'color', name: kind, color }
    : { type: 'test-pattern', name: kind, color };
  updateWindow(engine, wallId, windowId, { source }, { label: kind === 'solid' ? 'Set solid colour' : 'Set test pattern', mergeKey });
}

/** Remove the source but keep the window (v1 clearWindowContent). */
export function clearWindowSource(engine: Engine, wallId: string, windowId: string): void {
  updateWindow(engine, wallId, windowId, (w, _wall) => ({ ...w, source: null }), { label: 'Clear content' });
}

/**
 * Change the fit mode (v1 6237-6264): fill/scaled snap to the full wall; custom keeps the rect
 * unless it was full-wall, in which case a 50 % centred rect is seeded.
 */
export function setWindowMode(engine: Engine, wall: LedWallEntity, windowId: string, mode: ContentFitMode): void {
  const dims = wallDims(wall);
  updateWindow(engine, wall.id, windowId, w => {
    if (mode !== 'custom') return { ...w, mode, rect: { x: 0, y: 0, w: dims.wallWPx, h: dims.wallHPx } };
    const full = w.rect.w === dims.wallWPx && w.rect.h === dims.wallHPx;
    const rect = full ? defaultWindowRect(1, dims).rect : clampWindowRect(w.rect, 'custom', dims);
    return { ...w, mode, rect };
  }, { label: 'Change window layout' });
}

/** Edit one rect field in wall pixels, honouring the window's aspect lock. */
export function setWindowRectField(engine: Engine, wall: LedWallEntity, windowId: string, field: keyof PxRect, valuePx: number, lockedRatio?: number, mergeKey?: string): void {
  const dims = wallDims(wall);
  updateWindow(engine, wall.id, windowId, w => ({ ...w, rect: setRectField(w.rect, field, valuePx, dims, w.aspectLock, lockedRatio) }), { mergeKey });
}

export function alignWindow(engine: Engine, wall: LedWallEntity, windowId: string, key: AlignKey): void {
  const dims = wallDims(wall);
  updateWindow(engine, wall.id, windowId, w => ({ ...w, rect: alignRect(w.rect, dims, key) }), { label: 'Align content window' });
}

/** Toggle the aspect lock; returns the ratio to freeze while it is on (v1 6300-6308). */
export function setWindowAspectLock(engine: Engine, wallId: string, win: ContentWindow, on: boolean): number {
  updateWindow(engine, wallId, win.id, { aspectLock: on }, { label: on ? 'Lock aspect ratio' : 'Unlock aspect ratio' });
  return lockedAspectRatio(win.rect);
}

export function setWindowOpacity(engine: Engine, wallId: string, windowId: string, pct: number): void {
  updateWindow(engine, wallId, windowId, { opacity: Math.max(0, Math.min(1, pct / 100)) }, { label: 'Change window opacity', mergeKey: `cw:${windowId}:opacity` });
}

export function setWindowVisible(engine: Engine, wallId: string, windowId: string, visible: boolean): void {
  updateWindow(engine, wallId, windowId, { visible }, { label: visible ? 'Show content window' : 'Hide content window' });
}
