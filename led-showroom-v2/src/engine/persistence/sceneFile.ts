/**
 * Scene files (`*.showroom.json`): the document plus its local assets (images, videos, models,
 * photos, splats) inlined as data URLs, so a scene can travel between machines.
 *
 *  - `exportSceneFile(doc, assets)` embeds every referenced asset while the running total stays
 *    under `MAX_EMBED_BYTES`; the rest are listed by name in `missing`.
 *  - `importSceneFile(file, assets)` re-creates the embedded assets in the local store, rewrites
 *    the asset ids in the document (ids that were not embedded but already exist in the local
 *    store are kept) and reports the assets that could not be restored.
 *  - `migrateDocument(json)` brings any older / partial document up to the current schema.
 *
 * The pure parts (`migrateDocument`, `embedAssets`, `restoreAssets`, `rewriteAssetIds`,
 * `assetNames`, data-URL helpers) take an `AssetReader` / `AssetWriter` so they run in node.
 */
import type { Corner, Document, Entity, Environment, EquipmentGeometry, ModelFormat, Transform, ViewState } from '../document/types';
import { DOCUMENT_VERSION } from '../document/types';
import {
  createDimension, createEquipment, createGroup, createLedWall, createModel, createRoom, createSplat, createStage,
  defaultEnvironment, defaultSettings, defaultView, identityTransform,
} from '../document/defaults';
import type { Vec3 } from '../math';
import { newId } from '../ids';
import { cloneJson } from '../math';
import { pruneCorners } from '../ledwall/layout';
import { collectAssetIds, type AssetMeta } from './AssetStore';

export const SCENE_FILE_FORMAT = 'led-showroom-scene';
export const SCENE_FILE_VERSION = 1;
export const SCENE_FILE_EXTENSION = '.showroom.json';
export const MAX_EMBED_BYTES = 150 * 1024 * 1024;

export interface EmbeddedAsset {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
}

export interface SceneFile {
  format: typeof SCENE_FILE_FORMAT;
  fileVersion: number;
  exportedAt: number;
  document: Document;
  assets: EmbeddedAsset[];
  /** Names of referenced assets that were not embedded (too large / not found). */
  missing: string[];
}

export interface AssetReader {
  getBlob(id: string): Promise<Blob | null>;
  list?(): Promise<AssetMeta[]>;
}
export interface AssetWriter {
  put(file: Blob, name?: string): Promise<string>;
}

/* ───────────────────────────── data URLs ───────────────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (rem === 2 ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const lookup = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = lookup[clean.charCodeAt(i)], b = lookup[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3)] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < len && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/**
 * Encode a blob as a base64 data URL. In the browser the encoding runs off the main thread
 * through `FileReader.readAsDataURL`; the byte encoder above is the node fallback (and the
 * safety net when the reader fails).
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const type = blob.type || 'application/octet-stream';
  if (typeof FileReader !== 'undefined') {
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      });
      // the reader mints the mime type itself; normalise a typeless blob to the documented default
      const comma = url.indexOf(',');
      if (url.startsWith('data:') && comma > 0) return `data:${type};base64,${url.slice(comma + 1)}`;
    } catch { /* fall through to the byte encoder */ }
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${type};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const type = m[1] || 'application/octet-stream';
  if (m[2]) return new Blob([base64ToBytes(m[3]) as BlobPart], { type });
  return new Blob([decodeURIComponent(m[3])], { type });
}

/* ───────────────────────────── asset id walking ───────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Display names for every referenced asset, taken from the sibling `fileName` (models, splats) or
 * `name` (content sources, surfaces, backdrop photos) of the object that carries the `assetId`.
 */
export function assetNames(value: unknown, out = new Map<string, string>()): Map<string, string> {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const v of value) assetNames(v, out); return out; }
  const o = value as Record<string, unknown>;
  if (typeof o.assetId === 'string') {
    const name = typeof o.fileName === 'string' ? o.fileName : typeof o.name === 'string' ? o.name : null;
    if (name && !out.has(o.assetId)) out.set(o.assetId, name);
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') assetNames(v, out);
  return out;
}

/**
 * Deep-copy `value`, replacing every `assetId` through `map` (ids without a mapping are kept,
 * or dropped when `dropUnmapped`), and stripping session-only `blob:` URLs that sit next to an
 * `assetId` (they are minted at runtime from the asset store).
 */
export function rewriteAssetIds<T>(value: T, map: Map<string, string>, dropUnmapped = false): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'assetId' && typeof x === 'string') {
        const to = map.get(x);
        if (to) out[k] = to;
        else if (!dropUnmapped) out[k] = x;
      } else if (k === 'url' && typeof x === 'string' && typeof v.assetId === 'string' && x.startsWith('blob:')) {
        // runtime object URL — meaningless in another session
      } else out[k] = walk(x);
    }
    return out;
  };
  return walk(value) as T;
}

/* ───────────────────────────── migration ───────────────────────────── */

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const vec3 = (v: unknown, d: [number, number, number]): [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : [...d];

/**
 * True when `v` names a file the app ships under `dir` (e.g. '/models/'). Restored scenes are
 * untrusted input and both `EquipmentEntity.model` and `.image` are loaded by URL, so only a plain
 * absolute path inside the expected public folder is accepted — no other origin, no '..' segment.
 */
const shippedAsset = (v: unknown, dir: string): v is string =>
  typeof v === 'string' && v.startsWith(dir) && !v.includes('..') && !v.includes('//');

/**
 * Sanity envelope of a restored transform (v1 P26 / Alg A33, index.html 9163-9199): v1 dropped a
 * stored wall placement whose coordinates left ±3000 in or whose scale left 0.1..10, so a runaway
 * drag could never persist. v2 clamps instead of dropping (the entity keeps a usable placement)
 * and widens the scale window: the v2 scale field itself goes down to 0.01 (TransformSection) and
 * a model authored in metres legitimately sits near 40×, so only garbage is cut.
 */
export const MAX_POSITION_IN = 3000;
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 1000;

const clampAxis = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clampPos = (v: Vec3): Vec3 => [
  clampAxis(v[0], -MAX_POSITION_IN, MAX_POSITION_IN),
  clampAxis(v[1], -MAX_POSITION_IN, MAX_POSITION_IN),
  clampAxis(v[2], -MAX_POSITION_IN, MAX_POSITION_IN),
];
/** Non-positive scale is not reachable through the UI (the gizmo takes absolute ratios): reset it. */
const scaleAxis = (v: number): number => (v > 0 ? clampAxis(v, MIN_SCALE, MAX_SCALE) : 1);

function migrateTransform(t: unknown): Transform {
  const d = identityTransform();
  if (!isObj(t)) return d;
  const s = vec3(t.scale, d.scale);
  return {
    position: clampPos(vec3(t.position, d.position)),
    // rotation stays as authored: v2 stores degrees, where a wrapped value would silently rewrite
    // what the inspector shows (270 → -90); non-finite components already fall back to 0.
    rotation: vec3(t.rotation, d.rotation),
    scale: [scaleAxis(s[0]), scaleAxis(s[1]), scaleAxis(s[2])],
  };
}

const ENTITY_TYPES = new Set(['led-wall', 'stage', 'equipment', 'model', 'splat', 'room', 'dimension', 'group']);

/** Runtime mirror of the `EquipmentGeometry` union (the record keeps it exhaustive at compile time). */
const EQUIPMENT_GEOMETRY: Record<EquipmentGeometry, true> = {
  box: true, cylinder: true, kiosk: true, totem: true, truss: true, 'truss-upright': true, figure: true, 'table-round': true,
  'table-rect': true, chair: true, sofa: true, screen: true, drape: true, podium: true, speaker: true, counter: true, plant: true, locker: true, photo: true,
  cad: true,
};
const isEquipmentGeometry = (v: unknown): v is EquipmentGeometry => typeof v === 'string' && Object.prototype.hasOwnProperty.call(EQUIPMENT_GEOMETRY, v);

const MODEL_FORMATS: readonly ModelFormat[] = ['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply'];
const SPLAT_FORMATS = ['ply', 'splat', 'ksplat'] as const;
const UNIT_IDS = ['in', 'ft', 'mm', 'cm', 'm'] as const;
const oneOf = <T extends string>(v: unknown, options: readonly T[], d: T): T => ((options as readonly string[]).includes(v as string) ? (v as T) : d);
const finiteVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const positive = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Per-type defaulting. Every entity type gets the fields its `defaults.ts` factory produces when
 * the raw object lacks them (or carries junk), on top of the base fields. Returns `null` for
 * entities that cannot be repaired: equipment without a known geometry / finite dims.
 */
function migrateTyped(raw: Record<string, unknown>, e: Record<string, unknown>): Record<string, unknown> | null {
  switch (raw.type) {
    case 'led-wall': {
      const d = createLedWall();
      const cols = Math.max(1, Math.round(num(raw.cols, d.cols)));
      e.cols = cols;
      e.rows = Math.max(1, Math.round(num(raw.rows, d.rows)));
      e.product = str(raw.product, d.product);
      e.shape = isObj(raw.shape) && raw.shape.mode === 'custom' && Array.isArray(raw.shape.cells) ? { mode: 'custom', cells: raw.shape.cells.filter(c => typeof c === 'string') } : { mode: 'rect' };
      // Corners only exist on a real joint (0 <= afterCol < cols - 1); a stored scene can carry stale ones.
      e.corners = pruneCorners(cols, Array.isArray(raw.corners)
        ? raw.corners.filter((c): c is Corner => isObj(c) && typeof c.afterCol === 'number' && typeof c.angle === 'number')
        : []);
      e.contentWindows = Array.isArray(raw.contentWindows) ? raw.contentWindows.filter(w => isObj(w) && typeof w.id === 'string' && isObj(w.rect)) : [];
      e.bezels = bool(raw.bezels, d.bezels);
      e.doubleSided = bool(raw.doubleSided, d.doubleSided);
      e.brightness = num(raw.brightness, d.brightness);
      e.accessories = bool(raw.accessories, d.accessories);
      e.pixelGrid = bool(raw.pixelGrid, d.pixelGrid);
      e.showDimensions = bool(raw.showDimensions, d.showDimensions);
      return e;
    }
    case 'stage': {
      const d = createStage();
      e.widthIn = positive(raw.widthIn, d.widthIn);
      e.depthIn = positive(raw.depthIn, d.depthIn);
      e.heightIn = positive(raw.heightIn, d.heightIn);
      e.color = str(raw.color, d.color as string);
      return e;
    }
    case 'equipment': {
      if (!isEquipmentGeometry(raw.geometry) || !finiteVec3(raw.dims)) return null;
      const d = createEquipment({ id: str(raw.catalogId, 'custom'), name: e.name as string, geometry: raw.geometry, dims: raw.dims, color: '#4a4a52' });
      e.catalogId = d.catalogId;
      e.geometry = d.geometry;
      e.dims = d.dims;
      e.color = str(raw.color, d.color);
      if (typeof raw.accent === 'string') e.accent = raw.accent; else delete e.accent;
      e.screen = isObj(raw.screen) ? raw.screen : null;
      // `model` and `image` name files the renderer FETCHES (loadCadGeometry / loadProductTexture),
      // so a scene file may only point them at the app's own shipped assets: an absolute path under
      // the right public folder, no scheme, no traversal. Anything else is dropped and the item
      // falls back to parametric geometry rather than reaching out to whatever the file names.
      if (shippedAsset(raw.model, '/models/')) e.model = raw.model; else delete e.model;
      if (shippedAsset(raw.image, '/products/')) e.image = raw.image; else delete e.image;
      if (typeof raw.billboard === 'boolean') e.billboard = raw.billboard; else delete e.billboard;
      return e;
    }
    case 'model': {
      const fileName = str(raw.fileName, 'model.glb');
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      const d = createModel(fileName, oneOf(raw.format, MODEL_FORMATS, oneOf(ext, MODEL_FORMATS, 'glb')), {});
      e.fileName = d.fileName;
      e.format = d.format;
      e.sourceUnit = oneOf(raw.sourceUnit, UNIT_IDS, d.sourceUnit);
      if (finiteVec3(raw.dims)) e.dims = [...raw.dims]; else delete e.dims;
      return e;
    }
    case 'splat': {
      const d = createSplat(str(raw.fileName, 'splat.ply'), {});
      e.fileName = d.fileName;
      e.format = oneOf(raw.format, SPLAT_FORMATS, d.format);
      return e;
    }
    case 'room': {
      const d = createRoom();
      e.widthIn = positive(raw.widthIn, d.widthIn);
      e.heightIn = positive(raw.heightIn, d.heightIn);
      e.depthIn = positive(raw.depthIn, d.depthIn);
      const show = isObj(raw.show) ? raw.show : {};
      e.show = { back: bool(show.back, d.show.back), floor: bool(show.floor, d.show.floor), ceiling: bool(show.ceiling, d.show.ceiling), left: bool(show.left, d.show.left), right: bool(show.right, d.show.right) };
      const surfaces: Record<string, unknown> = {};
      if (isObj(raw.surfaces)) {
        for (const k of ['back', 'floor', 'ceiling', 'left', 'right']) {
          const v = raw.surfaces[k];
          if (isObj(v) && (v.kind === 'image' || v.kind === 'video')) surfaces[k] = v;
        }
      }
      e.surfaces = surfaces;
      e.color = str(raw.color, d.color);
      e.opacity = Math.min(1, Math.max(0, num(raw.opacity, d.opacity)));
      return e;
    }
    case 'dimension': {
      const d = createDimension([0, 0, 0], [0, 0, 0]);
      e.a = finiteVec3(raw.a) ? [...raw.a] : d.a;
      e.b = finiteVec3(raw.b) ? [...raw.b] : d.b;
      const label = optStr(raw.label);
      if (label !== undefined) e.label = label; else delete e.label;
      return e;
    }
    case 'group':
      return e; // createGroup(): no typed fields beyond the base
    default:
      return null;
  }
}

function migrateEntity(raw: unknown, used: Set<string>): Entity | null {
  if (!isObj(raw) || typeof raw.type !== 'string' || !ENTITY_TYPES.has(raw.type)) return null;
  let id = typeof raw.id === 'string' && raw.id ? raw.id : newId('ent');
  while (used.has(id)) id = newId('ent');
  const e: Record<string, unknown> = {
    ...raw,
    id,
    name: str(raw.name, raw.type as string),
    transform: migrateTransform(raw.transform),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
  };
  if (raw.parentId !== undefined) e.parentId = optStr(raw.parentId) ?? null;
  if (raw.attachedTo !== undefined) e.attachedTo = optStr(raw.attachedTo) ?? null;
  const typed = migrateTyped(raw, e);
  if (!typed) return null;
  used.add(id);
  return typed as unknown as Entity;
}

function migrateEnvironment(raw: unknown): Environment {
  const d = defaultEnvironment();
  if (!isObj(raw)) return d;
  const backdrop = isObj(raw.backdrop) ? raw.backdrop : {};
  const grid = isObj(raw.grid) ? raw.grid : {};
  const floor = isObj(raw.floor) ? raw.floor : {};
  const lighting = isObj(raw.lighting) ? raw.lighting : {};
  return {
    backdrop: {
      ...d.backdrop,
      ...backdrop,
      color: str(backdrop.color, d.backdrop.color),
      photo: isObj(backdrop.photo) ? { ...backdrop.photo, name: str(backdrop.photo.name, 'Photo') } : null,
      calibration: isObj(backdrop.calibration) ? (backdrop.calibration as unknown as Environment['backdrop']['calibration']) : null,
    },
    grid: { visible: bool(grid.visible, d.grid.visible), minorIn: num(grid.minorIn, d.grid.minorIn), majorIn: num(grid.majorIn, d.grid.majorIn) },
    floor: { visible: bool(floor.visible, d.floor.visible), sizeIn: num(floor.sizeIn, d.floor.sizeIn), reflective: bool(floor.reflective, d.floor.reflective) },
    lighting: {
      preset: (['showroom', 'studio', 'dark', 'venue'] as const).find(p => p === lighting.preset) ?? d.lighting.preset,
      intensity: num(lighting.intensity, d.lighting.intensity),
      shadows: bool(lighting.shadows, d.lighting.shadows),
    },
  };
}

function migrateView(raw: unknown): ViewState {
  const d = defaultView();
  if (!isObj(raw)) return d;
  return {
    projection: raw.projection === 'orthographic' ? 'orthographic' : 'perspective',
    position: vec3(raw.position, d.position),
    target: vec3(raw.target, d.target),
    fov: num(raw.fov, d.fov),
    locked: bool(raw.locked, d.locked),
    savedViews: Array.isArray(raw.savedViews) ? (raw.savedViews.filter(v => isObj(v) && typeof v.id === 'string') as ViewState['savedViews']) : [],
  };
}

function migrateSettings(raw: unknown): Document['settings'] {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const snap = isObj(raw.snap) ? raw.snap : {};
  return {
    units: (['in', 'ft', 'mm', 'cm', 'm'] as const).find(u => u === raw.units) ?? d.units,
    autoRotate: bool(raw.autoRotate, d.autoRotate),
    pixelGridDistIn: num(raw.pixelGridDistIn, d.pixelGridDistIn),
    spanContent: bool(raw.spanContent, d.spanContent),
    snap: {
      enabled: bool(snap.enabled, d.snap.enabled),
      translateIn: num(snap.translateIn, d.snap.translateIn),
      rotateDeg: num(snap.rotateDeg, d.snap.rotateDeg),
      scale: num(snap.scale, d.snap.scale),
      groundLock: bool(snap.groundLock, d.snap.groundLock),
      deckFollowsRider: bool(snap.deckFollowsRider, d.snap.deckFollowsRider),
    },
    showHud: bool(raw.showHud, d.showHud),
  };
}

/**
 * Bring a (possibly older or partial) document JSON up to the current schema: missing
 * settings / environment / view fields get their defaults, entities get identity transforms and
 * unique ids, unknown entity types are dropped. Throws on values that are not documents at all.
 */
export function migrateDocument(input: unknown): Document {
  if (!isObj(input)) throw new Error('Not a showroom document');
  const version = num(input.version, 0);
  if (version > DOCUMENT_VERSION) throw new Error(`Document version ${version} is newer than this app supports (${DOCUMENT_VERSION})`);
  const now = Date.now();
  const used = new Set<string>();
  const entities = (Array.isArray(input.entities) ? input.entities : []).map(e => migrateEntity(e, used)).filter((e): e is Entity => !!e);
  // drop dangling parent / attachment links
  const ids = new Set(entities.map(e => e.id));
  for (const e of entities) {
    if (e.parentId && !ids.has(e.parentId)) e.parentId = null;
    if (e.attachedTo && !ids.has(e.attachedTo)) e.attachedTo = null;
  }
  return {
    version: DOCUMENT_VERSION,
    id: str(input.id, '') || newId('doc'),
    name: str(input.name, 'Untitled showroom'),
    createdAt: num(input.createdAt, now),
    updatedAt: num(input.updatedAt, now),
    entities,
    environment: migrateEnvironment(input.environment),
    view: migrateView(input.view),
    settings: migrateSettings(input.settings),
  };
}

/* ───────────────────────────── embed / restore ───────────────────────────── */

/**
 * Inline every asset the document references. Assets are embedded in reference order while the
 * running total stays under `limit`; the others (and assets the store no longer has) are
 * reported by name in `missing`.
 */
export async function embedAssets(doc: Document, assets: AssetReader, limit = MAX_EMBED_BYTES): Promise<{ assets: EmbeddedAsset[]; missing: string[] }> {
  const ids = Array.from(collectAssetIds(doc));
  const names = assetNames(doc);
  let metaNames: Map<string, string> | null = null;
  const nameOf = async (id: string): Promise<string> => {
    const n = names.get(id);
    if (n) return n;
    if (!metaNames && assets.list) {
      metaNames = new Map();
      try { for (const m of await assets.list()) metaNames.set(m.id, m.name); } catch { /* ignore */ }
    }
    return metaNames?.get(id) ?? id;
  };
  const out: EmbeddedAsset[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const id of ids) {
    let blob: Blob | null = null;
    try { blob = await assets.getBlob(id); } catch { blob = null; }
    const name = await nameOf(id);
    if (!blob || total + blob.size > limit) { missing.push(name); continue; }
    total += blob.size;
    out.push({ id, name, type: blob.type, dataUrl: await blobToDataUrl(blob) });
  }
  return { assets: out, missing };
}

/**
 * Store every embedded asset and return the id map (file id → local id). Assets whose data URL
 * cannot be decoded are skipped.
 */
export async function restoreAssets(embedded: EmbeddedAsset[], assets: AssetWriter): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const a of embedded) {
    if (!a || typeof a.id !== 'string' || typeof a.dataUrl !== 'string') continue;
    const blob = dataUrlToBlob(a.dataUrl);
    if (!blob) continue;
    const typed = a.type && blob.type !== a.type ? new Blob([blob], { type: a.type }) : blob;
    try { map.set(a.id, await assets.put(typed, a.name || a.id)); } catch (err) { console.warn('[scene-file] could not store asset', a.name, err); }
  }
  return map;
}

/** Build the file contents (pure apart from reading the blobs). */
export async function buildSceneFile(doc: Document, assets: AssetReader, limit = MAX_EMBED_BYTES): Promise<SceneFile> {
  const clean = rewriteAssetIds(cloneJson(doc), new Map());
  const { assets: embedded, missing } = await embedAssets(clean, assets, limit);
  return { format: SCENE_FILE_FORMAT, fileVersion: SCENE_FILE_VERSION, exportedAt: Date.now(), document: clean, assets: embedded, missing };
}

/**
 * Parse file contents: migrate the document, restore the embedded assets, rewrite ids, report
 * what is missing. Asset ids that were not embedded are kept when the local store (`getBlob`)
 * already holds them - a scene exported and re-imported on the same machine loses nothing -
 * and dropped (and reported by name) only when they are neither restored nor present.
 */
export async function parseSceneFile(json: unknown, assets: AssetWriter & Partial<AssetReader>): Promise<{ doc: Document; missing: string[] }> {
  if (!isObj(json)) throw new Error('Not a showroom scene file');
  // a bare document is accepted too
  const isWrapped = json.format === SCENE_FILE_FORMAT || isObj(json.document);
  const rawDoc = isWrapped ? json.document : json;
  if (isWrapped && num(json.fileVersion, 1) > SCENE_FILE_VERSION) throw new Error('Scene file was written by a newer version of the app');
  const migrated = migrateDocument(rawDoc);
  const embedded = isWrapped && Array.isArray(json.assets) ? (json.assets as EmbeddedAsset[]) : [];
  const map = await restoreAssets(embedded, assets);
  const names = assetNames(migrated);
  const missing = new Set<string>();
  const foundLocally = new Set<string>();
  for (const id of collectAssetIds(migrated)) {
    if (map.has(id)) continue;
    let local: Blob | null = null;
    if (assets.getBlob) { try { local = await assets.getBlob(id); } catch { local = null; } }
    if (local) { map.set(id, id); foundLocally.add(names.get(id) ?? id); } else missing.add(names.get(id) ?? id);
  }
  // names the exporter could not embed, unless the local store turned out to have them
  if (isWrapped && Array.isArray(json.missing)) for (const m of json.missing) if (typeof m === 'string' && !foundLocally.has(m)) missing.add(m);
  const doc = rewriteAssetIds(migrated, map, true);
  return { doc, missing: Array.from(missing) };
}

/* ───────────────────────────── browser entry points ───────────────────────────── */

/**
 * JSON text of a scene file as a list of parts (one per embedded asset), so the output blob can
 * be assembled without concatenating every data URL into one giant string first.
 * `parts.join('')` is exactly `JSON.stringify(file)`.
 */
export function sceneFileParts(file: SceneFile): string[] {
  const parts: string[] = [];
  let first = true;
  for (const [k, v] of Object.entries(file)) {
    if (v === undefined) continue;
    parts.push((first ? '{' : ',') + JSON.stringify(k) + ':');
    first = false;
    if (k === 'assets') {
      parts.push('[');
      (v as EmbeddedAsset[]).forEach((a, i) => parts.push((i ? ',' : '') + JSON.stringify(a)));
      parts.push(']');
    } else parts.push(JSON.stringify(v));
  }
  parts.push(first ? '{}' : '}');
  return parts;
}

export async function exportSceneFile(doc: Document, assets: AssetReader): Promise<Blob> {
  const file = await buildSceneFile(doc, assets);
  return new Blob(sceneFileParts(file), { type: 'application/json' });
}

export async function importSceneFile(file: Blob, assets: AssetWriter & Partial<AssetReader>): Promise<{ doc: Document; missing: string[] }> {
  const text = await file.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error('The file is not valid JSON'); }
  return parseSceneFile(json, assets);
}

/** Filename for a document: "my-showroom.showroom.json". */
export function sceneFileName(doc: Document): string {
  const slug = (doc.name || 'showroom').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'showroom';
  return slug + SCENE_FILE_EXTENSION;
}

/** Trigger a browser download of `blob` as `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
