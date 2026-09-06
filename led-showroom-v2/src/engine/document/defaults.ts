/** Factories for documents and entities. */
import { newId } from '../ids';
import type { Vec3 } from '../math';
import { IPOSTER, STAGE_SIZE_IN } from '../ledwall/specs';
import { computeColumnLayout, wallDims, wallLocalBounds } from '../ledwall/layout';
import { DEG } from '../units';
import type {
  ContentWindow, DimensionEntity, Document, DocumentSettings, Entity, Environment, EquipmentEntity, EquipmentGeometry,
  GroupEntity, LedWallEntity, ModelEntity, ModelFormat, RoomEntity, SplatEntity, StageEntity, Transform, ViewState,
} from './types';
import { DOCUMENT_VERSION } from './types';

export const identityTransform = (position: Vec3 = [0, 0, 0]): Transform => ({
  position: [...position] as Vec3,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

export function defaultEnvironment(): Environment {
  return {
    backdrop: { color: '#05070a', photo: null, calibration: null },
    grid: { visible: true, minorIn: 12, majorIn: 48 },
    floor: { visible: true, sizeIn: 1440, reflective: true },
    lighting: { preset: 'showroom', intensity: 1, shadows: true },
  };
}

export function defaultView(): ViewState {
  return {
    projection: 'perspective',
    position: [140, 90, 320],
    target: [0, 45, 0],
    fov: 40,
    locked: false,
    savedViews: [],
  };
}

export function defaultSettings(): DocumentSettings {
  return {
    units: 'in',
    autoRotate: false,
    pixelGridDistIn: 72,
    spanContent: false,
    snap: { enabled: true, translateIn: 1, rotateDeg: 5, scale: 0.05, groundLock: true, deckFollowsRider: true },
    showHud: true,
  };
}

export function createDocument(name = 'Untitled showroom'): Document {
  const now = Date.now();
  return {
    version: DOCUMENT_VERSION,
    id: newId('doc'),
    name,
    createdAt: now,
    updatedAt: now,
    entities: [],
    environment: defaultEnvironment(),
    view: defaultView(),
    settings: defaultSettings(),
  };
}

export function createContentWindow(partial: Partial<ContentWindow> & { rect: ContentWindow['rect'] }, index = 0): ContentWindow {
  return {
    id: newId('cw'),
    name: partial.name ?? `Window ${index + 1}`,
    mode: partial.mode ?? 'fill',
    rect: partial.rect,
    source: partial.source ?? null,
    aspectLock: partial.aspectLock ?? false,
    visible: partial.visible ?? true,
    opacity: partial.opacity ?? 1,
  };
}

export interface LedWallOptions {
  name?: string;
  cols?: number;
  rows?: number;
  product?: string;
  position?: Vec3;
  accessories?: boolean;
  bezels?: boolean;
}

/** A wall standing on the floor (y = 0 is the bottom edge of the lowest panel). */
export function createLedWall(opts: LedWallOptions = {}): LedWallEntity {
  const cols = opts.cols ?? 5;
  const rows = opts.rows ?? 5;
  const spec = IPOSTER;
  const wallWPx = cols * spec.pxW;
  const wallHPx = rows * spec.pxH;
  return {
    id: newId('wall'),
    type: 'led-wall',
    name: opts.name ?? 'LED Wall',
    transform: identityTransform(opts.position ?? [0, 0, 0]),
    visible: true,
    locked: false,
    product: opts.product ?? spec.id,
    cols,
    rows,
    shape: { mode: 'rect' },
    corners: [],
    contentWindows: [createContentWindow({ mode: 'fill', rect: { x: 0, y: 0, w: wallWPx, h: wallHPx } }, 0)],
    bezels: opts.bezels ?? true,
    doubleSided: false,
    brightness: 100,
    accessories: opts.accessories ?? false,
    pixelGrid: false,
    showDimensions: false,
  };
}

export function createStage(heightIn = 24, position: Vec3 = [0, 0, 0], name = 'Stage deck'): StageEntity {
  return {
    id: newId('stage'),
    type: 'stage',
    name,
    transform: identityTransform(position),
    visible: true,
    locked: false,
    widthIn: STAGE_SIZE_IN,
    depthIn: STAGE_SIZE_IN,
    heightIn,
    color: '#1a1a1c',
  };
}

export function createEquipment(def: { id: string; name: string; geometry: EquipmentGeometry; dims: Vec3; color: string; accent?: string; image?: string; model?: string }, position: Vec3 = [0, 0, 0]): EquipmentEntity {
  return {
    id: newId('eq'),
    type: 'equipment',
    name: def.name,
    transform: identityTransform(position),
    visible: true,
    locked: false,
    catalogId: def.id,
    geometry: def.geometry,
    dims: [...def.dims] as Vec3,
    color: def.color,
    accent: def.accent,
    screen: null,
    ...(def.image ? { image: def.image } : {}),
    ...(def.model ? { model: def.model } : {}),
  };
}

export function createModel(fileName: string, format: ModelFormat, ref: { assetId?: string; url?: string }, position: Vec3 = [0, 0, 0]): ModelEntity {
  return {
    id: newId('model'),
    type: 'model',
    name: fileName.replace(/\.[^.]+$/, ''),
    transform: identityTransform(position),
    visible: true,
    locked: false,
    fileName,
    format,
    sourceUnit: 'm',
    ...ref,
  };
}

export function createSplat(fileName: string, ref: { assetId?: string; url?: string }): SplatEntity {
  const ext = (fileName.split('.').pop() || 'ply').toLowerCase();
  return {
    id: newId('splat'),
    type: 'splat',
    name: fileName.replace(/\.[^.]+$/, ''),
    transform: identityTransform(),
    visible: true,
    locked: false,
    fileName,
    format: ext === 'ksplat' ? 'ksplat' : ext === 'splat' ? 'splat' : 'ply',
    ...ref,
  };
}

/**
 * Clearance between the rear face of the LED walls and the room's back wall (v1 `#vsWallFromBack`,
 * default 2 ft — index.html 1878, 6786). The room's local origin is the floor centre of the back
 * wall, so this is simply how far the back wall sits behind the wall datum.
 */
export const DEFAULT_WALL_FROM_BACK_IN = 24;

/** World-space X extent and rear-most Z of one LED wall's panels (yaw only; parent groups ignored). */
function ledWallXZ(w: LedWallEntity): { minX: number; maxX: number; minZ: number } {
  const dims = wallDims(w);
  const b = wallLocalBounds(dims, computeColumnLayout(dims, w.corners));
  const [px, , pz] = w.transform.position;
  const [sx, , sz] = w.transform.scale;
  const yaw = w.transform.rotation[1] * DEG;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity;
  for (const lx of [b.minX * sx, b.maxX * sx]) {
    for (const lz of [b.minZ * sz, b.maxZ * sz]) {
      const x = px + lx * cos + lz * sin;
      const z = pz - lx * sin + lz * cos;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
    }
  }
  return { minX, maxX, minZ };
}

/**
 * The datum a venue room is placed against: the horizontal centre and the rear-most face of the
 * LED walls in the scene. With no walls it falls back to the rear face of a wall standing at the
 * origin, so a fresh room lands exactly where v1 put it (`backZ = -(panelD / 2) - wallFromBack`,
 * A19 / index.html 6824).
 */
export function ledWallDatum(entities: readonly Entity[]): { centreX: number; rearZ: number } {
  let minX = Infinity, maxX = -Infinity, rearZ = Infinity;
  for (const e of entities) {
    if (e.type !== 'led-wall') continue;
    const b = ledWallXZ(e);
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minZ < rearZ) rearZ = b.minZ;
  }
  if (!Number.isFinite(rearZ)) return { centreX: 0, rearZ: -IPOSTER.depthIn / 2 };
  return { centreX: (minX + maxX) / 2, rearZ };
}

/** Room origin (floor centre of the back wall) that leaves `wallFromBackIn` in front of the walls. */
export function roomPosition(entities: readonly Entity[], wallFromBackIn = DEFAULT_WALL_FROM_BACK_IN): Vec3 {
  const d = ledWallDatum(entities);
  return [d.centreX, 0, d.rearZ - wallFromBackIn];
}

/** v1 defaults: 40 ft wide, 13 ft high, 30 ft deep; the LED wall sits 2 ft in front of the back wall. */
export function createRoom(widthFt = 40, heightFt = 13, depthFt = 30, wallFromBackIn = DEFAULT_WALL_FROM_BACK_IN): RoomEntity {
  return {
    id: newId('room'),
    type: 'room',
    name: 'Venue space',
    transform: identityTransform(roomPosition([], wallFromBackIn)),
    visible: true,
    locked: false,
    widthIn: widthFt * 12,
    heightIn: heightFt * 12,
    depthIn: depthFt * 12,
    surfaces: {},
    show: { back: true, floor: true, ceiling: false, left: true, right: true },
    color: '#2a2a2e',
    opacity: 1,
  };
}

/**
 * A venue room fitted to the scene: same proportions as {@link createRoom}, but centred on the
 * existing LED walls and pushed back so the back wall clears their rear face (v1 always centred the
 * room on x = 0 and assumed a wall at the origin).
 */
export function createRoomForScene(
  entities: readonly Entity[], widthFt?: number, heightFt?: number, depthFt?: number, wallFromBackIn = DEFAULT_WALL_FROM_BACK_IN,
): RoomEntity {
  const room = createRoom(widthFt, heightFt, depthFt, wallFromBackIn);
  room.transform.position = roomPosition(entities, wallFromBackIn);
  return room;
}

/* ───────────────────────── trade-show booth presets ───────────────────────── */

/** A standard trade-show booth footprint, expressed the way the show floor sells it: feet. */
export interface BoothPreset {
  /** Stable id, also used as the catalog card id. */
  id: string;
  /** Display name, e.g. "10 × 10 booth". */
  label: string;
  /** Across the aisle frontage. */
  widthFt: number;
  /** Back to front, away from the back wall. */
  depthFt: number;
  /** Wall height — see {@link BOOTH_HEIGHT_FT}. */
  heightFt: number;
}

/**
 * Wall height for every booth preset: 8 ft.
 *
 * A booth is not a venue hall, so the 13 ft of {@link createRoom} would be arbitrary here — hall
 * ceilings run anywhere from 16 to 30+ ft and differ per venue, so modelling one is a guess that
 * says nothing useful. 8 ft is the number an exhibitor actually designs against: the standard US
 * inline back drape is 8 ft high (with 3 ft side rails over the front 5 ft), and it is the display
 * height limit for a linear booth. Putting the room's walls on that line turns them into the drape
 * datum — if an LED wall pokes above them, it is over height for an inline booth. Islands carry no
 * drape at all, but one height across the three presets keeps the reference readable, and the room
 * ceiling stays off by default so 8 ft never boxes in a taller build.
 */
export const BOOTH_HEIGHT_FT = 8;

/** The three standard US booth footprints, smallest first. Width is frontage, depth runs back. */
export const BOOTH_PRESETS: readonly BoothPreset[] = [
  { id: 'booth-10x10', label: '10 × 10 booth', widthFt: 10, depthFt: 10, heightFt: BOOTH_HEIGHT_FT },
  { id: 'booth-20x10', label: '20 × 10 booth', widthFt: 20, depthFt: 10, heightFt: BOOTH_HEIGHT_FT },
  { id: 'booth-20x20', label: '20 × 20 booth', widthFt: 20, depthFt: 20, heightFt: BOOTH_HEIGHT_FT },
];

export function findBoothPreset(id: string): BoothPreset | undefined {
  return BOOTH_PRESETS.find(p => p.id === id);
}

/**
 * A booth-sized venue room, placed against the scene exactly like {@link createRoomForScene}:
 * centred on the existing LED walls with the back wall clearing their rear face.
 */
export function createBoothForScene(
  preset: BoothPreset, entities: readonly Entity[] = [], wallFromBackIn = DEFAULT_WALL_FROM_BACK_IN,
): RoomEntity {
  const room = createRoomForScene(entities, preset.widthFt, preset.heightFt, preset.depthFt, wallFromBackIn);
  room.name = preset.label;
  return room;
}

export function createDimension(a: Vec3, b: Vec3): DimensionEntity {
  return {
    id: newId('dim'),
    type: 'dimension',
    name: 'Measurement',
    transform: identityTransform(),
    visible: true,
    locked: false,
    a: [...a] as Vec3,
    b: [...b] as Vec3,
  };
}

export function createGroup(name = 'Group'): GroupEntity {
  return {
    id: newId('grp'),
    type: 'group',
    name,
    transform: identityTransform(),
    visible: true,
    locked: false,
  };
}
