/**
 * The document schema. Everything the user builds is one plain JSON `Document`.
 * Lengths are inches, angles are degrees, pixel coordinates are wall pixels (origin top-left, y down).
 */
import type { Unit } from '../units';
import type { Vec3 } from '../math';

export const DOCUMENT_VERSION = 2;

/* ───────────────────────────── Transform ───────────────────────────── */

export interface Transform {
  position: Vec3;
  /** Euler XYZ in degrees. */
  rotation: Vec3;
  scale: Vec3;
}

/* ───────────────────────────── Entities ───────────────────────────── */

export type EntityType = 'led-wall' | 'stage' | 'equipment' | 'model' | 'splat' | 'room' | 'dimension' | 'group';

export interface EntityBase {
  id: string;
  type: EntityType;
  name: string;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  /** Parent group id (hierarchy). */
  parentId?: string | null;
  /** Entity this one stands on (e.g. an LED wall riding a stage deck). Kept in sync by the engine. */
  attachedTo?: string | null;
}

/** A fold between column `afterCol` and `afterCol + 1`. Positive = convex (front faces meet). */
export interface Corner {
  afterCol: number;
  /** -270 … 90 degrees. */
  angle: number;
}

export interface WallShape {
  mode: 'rect' | 'custom';
  /** Filled cells as "col,row" strings, normalised to origin. Only for `custom`. */
  cells?: string[];
}

export type ContentSourceType = 'image' | 'video' | 'website' | 'color' | 'test-pattern';

export interface ContentSource {
  type: ContentSourceType;
  /** http(s) URL (website / remote media) or a blob: URL resolved at runtime from `assetId`. */
  url?: string;
  /** Persistent local-asset id (IndexedDB) so scenes survive reloads. */
  assetId?: string;
  name?: string;
  /** For `color`. */
  color?: string;
  /** Detected video codec, drives the decode path. */
  codec?: 'hevc' | 'avc' | 'vp9' | 'av1' | 'other';
  mimeType?: string;
  loop?: boolean;
  muted?: boolean;
}

/** fill = stretch to the rect, scaled = aspect-fit (contain) inside the rect, custom = free rect. */
export type ContentFitMode = 'fill' | 'scaled' | 'custom';

export interface PxRect { x: number; y: number; w: number; h: number }

export interface ContentWindow {
  id: string;
  name: string;
  mode: ContentFitMode;
  /** Rect in wall pixels. For fill/scaled it is always the full wall. */
  rect: PxRect;
  source: ContentSource | null;
  aspectLock: boolean;
  visible: boolean;
  opacity: number;
}

export interface LedWallEntity extends EntityBase {
  type: 'led-wall';
  /** Panel spec id (see ledwall/specs.ts). */
  product: string;
  cols: number;
  rows: number;
  shape: WallShape;
  corners: Corner[];
  contentWindows: ContentWindow[];
  /** Show the 0.06" seam between panels. */
  bezels: boolean;
  doubleSided: boolean;
  /** 0–100 %. */
  brightness: number;
  /** Floor base plates + back supports (one set per column). */
  accessories: boolean;
  /** LED pixel-structure overlay (auto-appears within the configured distance). */
  pixelGrid: boolean;
  /** Engineering-style dimension annotations. */
  showDimensions: boolean;
}

export interface StageEntity extends EntityBase {
  type: 'stage';
  widthIn: number;
  depthIn: number;
  heightIn: number;
  color?: string;
}

export type EquipmentGeometry =
  | 'box' | 'cylinder' | 'kiosk' | 'totem' | 'truss' | 'truss-upright' | 'figure' | 'table-round'
  | 'table-rect' | 'chair' | 'sofa' | 'screen' | 'drape' | 'podium' | 'speaker' | 'counter' | 'plant' | 'locker'
  /** A photographed product: a cutout image stood up on the floor, scaled to the real height. */
  | 'photo'
  /**
   * A product we have the manufacturer's CAD for: a mesh shipped with the app (`model`), converted
   * from STEP to GLB by `scripts/step-to-glb.cjs`. Not the same thing as a `model` entity, which is
   * a file the user imported.
   */
  | 'cad';

export interface EquipmentEntity extends EntityBase {
  type: 'equipment';
  /** Catalog id this was created from (for the label/icon); dims are editable afterwards. */
  catalogId: string;
  geometry: EquipmentGeometry;
  /** width, height, depth in inches. */
  dims: Vec3;
  color: string;
  /** Optional secondary colour (screen, accent). */
  accent?: string;
  /** Optional media shown on a screen-bearing item (kiosk/totem/screen). */
  screen?: ContentSource | null;
  /** Cutout photo URL for `geometry: 'photo'` products (served from /products). */
  image?: string;
  /** Shipped CAD mesh URL for `geometry: 'cad'` products (a GLB served from /models). */
  model?: string;
  /** Keep a photo cutout turned towards the camera about Y. Default true for photo products. */
  billboard?: boolean;
}

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'fbx' | 'ply';

export interface ModelEntity extends EntityBase {
  type: 'model';
  assetId?: string;
  url?: string;
  fileName: string;
  format: ModelFormat;
  /** Unit the file was authored in; the engine converts to inches. */
  sourceUnit: Unit;
  /** Measured bounding size (inches) after load, for the inspector. */
  dims?: Vec3;
}

export interface SplatEntity extends EntityBase {
  type: 'splat';
  assetId?: string;
  url?: string;
  fileName: string;
  format: 'ply' | 'splat' | 'ksplat';
}

export interface SurfaceMedia {
  assetId?: string;
  url?: string;
  name?: string;
  kind: 'image' | 'video';
}

/** A proportional room (v1 "Venue Space"): back wall, floor, ceiling, left and right walls. */
export interface RoomEntity extends EntityBase {
  type: 'room';
  widthIn: number;
  heightIn: number;
  depthIn: number;
  surfaces: { back?: SurfaceMedia | null; floor?: SurfaceMedia | null; ceiling?: SurfaceMedia | null; left?: SurfaceMedia | null; right?: SurfaceMedia | null };
  show: { back: boolean; floor: boolean; ceiling: boolean; left: boolean; right: boolean };
  /**
   * Draw the volume as an outline rather than as solid surfaces: the floor face renders as usual
   * (photo and all) and the back, left, right and ceiling planes are replaced by faded dashed
   * vertical guides at the four footprint corners, from the floor up to `heightIn`.
   *
   * This is what a trade-show booth wants — a footprint on the show floor plus a height reference,
   * not a room you stand inside — but it is not booth-specific: a venue space reads the same way
   * when you want to see past its walls. Off by default, so every existing room is unchanged.
   */
  outlineWalls: boolean;
  color: string;
  opacity: number;
}

export interface DimensionEntity extends EntityBase {
  type: 'dimension';
  a: Vec3;
  b: Vec3;
  /** Optional label override. */
  label?: string;
}

export interface GroupEntity extends EntityBase {
  type: 'group';
}

export type Entity = LedWallEntity | StageEntity | EquipmentEntity | ModelEntity | SplatEntity | RoomEntity | DimensionEntity | GroupEntity;

/* ───────────────────────────── Environment ───────────────────────────── */

export interface Seg2 { x1: number; y1: number; x2: number; y2: number }

/**
 * Two-vanishing-point calibration of a venue photo. Lines are in normalised photo
 * coordinates (0..1 of the cover-fitted photo).
 */
export interface PerspectiveCalibration {
  widthLines: [Seg2, Seg2];
  depthLines: [Seg2, Seg2];
  solved?: {
    quaternion: [number, number, number, number];
    fovDeg: number;
  } | null;
  /** Optional absolute-scale reinforcement. */
  cameraHeightIn?: number;
  cameraDistanceIn?: number;
  locked: boolean;
  showGrid: boolean;
}

export interface Backdrop {
  color: string;
  photo?: { assetId?: string; url?: string; name: string; fovDeg?: number } | null;
  calibration?: PerspectiveCalibration | null;
}

export type LightingPreset = 'showroom' | 'studio' | 'dark' | 'venue';

export interface Environment {
  backdrop: Backdrop;
  grid: { visible: boolean; minorIn: number; majorIn: number };
  floor: { visible: boolean; sizeIn: number; reflective: boolean };
  lighting: { preset: LightingPreset; intensity: number; shadows: boolean };
}

/* ───────────────────────────── View ───────────────────────────── */

export interface SavedView {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
  projection: 'perspective' | 'orthographic';
}

export interface ViewState {
  projection: 'perspective' | 'orthographic';
  position: Vec3;
  target: Vec3;
  fov: number;
  locked: boolean;
  savedViews: SavedView[];
}

/* ───────────────────────────── Settings ───────────────────────────── */

export interface SnapSettings {
  enabled: boolean;
  translateIn: number;
  rotateDeg: number;
  scale: number;
  /** Keep objects resting on the floor / their support while moving. */
  groundLock: boolean;
  /** Moving or rotating an object that rides a stage carries the stage with it (v1 wall/deck sync). */
  deckFollowsRider: boolean;
}

export interface DocumentSettings {
  units: Unit;
  autoRotate: boolean;
  /** Camera distance (inches) inside which the pixel grid appears. */
  pixelGridDistIn: number;
  /** Treat all LED walls as one contiguous canvas. */
  spanContent: boolean;
  snap: SnapSettings;
  showHud: boolean;
}

/* ───────────────────────────── Document ───────────────────────────── */

export interface Document {
  version: typeof DOCUMENT_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  entities: Entity[];
  environment: Environment;
  view: ViewState;
  settings: DocumentSettings;
}

/* ───────────────────────────── Type guards ───────────────────────────── */

export const isLedWall = (e: Entity | null | undefined): e is LedWallEntity => !!e && e.type === 'led-wall';
export const isStage = (e: Entity | null | undefined): e is StageEntity => !!e && e.type === 'stage';
export const isEquipment = (e: Entity | null | undefined): e is EquipmentEntity => !!e && e.type === 'equipment';
export const isModel = (e: Entity | null | undefined): e is ModelEntity => !!e && e.type === 'model';
export const isSplat = (e: Entity | null | undefined): e is SplatEntity => !!e && e.type === 'splat';
export const isRoom = (e: Entity | null | undefined): e is RoomEntity => !!e && e.type === 'room';
export const isDimension = (e: Entity | null | undefined): e is DimensionEntity => !!e && e.type === 'dimension';
export const isGroup = (e: Entity | null | undefined): e is GroupEntity => !!e && e.type === 'group';
