/**
 * Catalog data: everything the user can add to a scene, grouped in display order. Items are pure
 * descriptions plus a `make` factory that returns a fresh document entity (or a promise for the
 * file-backed ones — imported models and Gaussian splats — which open a file picker first).
 *
 * The LED sub-lines depend on the document unit, so the list is built per unit via `buildCatalog`.
 */
import type { Engine } from '@/engine/Engine';
import type { Entity, EquipmentGeometry, ModelFormat } from '@/engine/document/types';
import { createEquipment, createLedWall, createModel, createRoomForScene, createSplat, createStage } from '@/engine/document/defaults';
import { CATEGORY_LABELS, EQUIPMENT, type CatalogCategory, type EquipmentDef } from '@/engine/catalog/equipment';
import { STAGE_HEIGHTS_IN } from '@/engine/ledwall/specs';
import { wallDims } from '@/engine/ledwall/layout';
import { formatDims, formatLength, type Unit } from '@/engine/units';
import type { CatalogIconKind } from '@/app/components/Icons';

export interface MakeArgs {
  engine: Engine;
  /** Custom wall parameters (only read by the "Custom wall…" item). */
  cols?: number;
  rows?: number;
}

export interface CatalogItem {
  id: string;
  group: string;
  name: string;
  sub: string;
  icon: CatalogIconKind;
  /** Product cutout shown on the card in place of the line icon (photographed products only). */
  image?: string;
  /** The item needs a small inline form (columns × rows) before it can be made. */
  custom?: boolean;
  /** Longer description for the tooltip / title attribute. */
  description?: string;
  make(args: MakeArgs): Entity | Promise<Entity | null>;
}

export const GROUP_LED = 'LED displays';
export const GROUP_STAGING = 'Staging';
export const GROUP_VENUE = 'Venue';

/** Equipment categories that get their own catalog group, in display order. */
const EQUIPMENT_CATEGORIES: CatalogCategory[] = ['charging', 'display', 'structure', 'furniture', 'reference'];

/* ───────────────────────────── helpers ───────────────────────────── */

const WALL_PRESETS: { cols: number; rows: number; poster?: boolean }[] = [
  { cols: 1, rows: 1, poster: true },
  { cols: 1, rows: 2, poster: true },
  { cols: 1, rows: 3, poster: true },
  { cols: 2, rows: 2 },
  { cols: 3, rows: 2 },
  { cols: 4, rows: 3 },
  { cols: 5, rows: 5 },
  { cols: 6, rows: 3 },
  { cols: 8, rows: 4 },
];

/** "1720 × 1290 px · 10' 6.2" × 7' 10.7"" — resolution and physical size of a cols × rows wall. */
export function wallSubLine(cols: number, rows: number, unit: Unit): string {
  const d = wallDims({ cols, rows, bezels: true, product: 'iposter' });
  return `${d.wallWPx} × ${d.wallHPx} px · ${formatDims([d.totalW, d.totalH], unit)}`;
}

const EQUIPMENT_ICON: Record<EquipmentGeometry, CatalogIconKind> = {
  box: 'box',
  cylinder: 'cylinder',
  kiosk: 'kiosk',
  totem: 'totem',
  truss: 'truss',
  'truss-upright': 'truss',
  figure: 'figure',
  'table-round': 'table',
  'table-rect': 'table',
  chair: 'chair',
  sofa: 'sofa',
  screen: 'screen',
  drape: 'drape',
  podium: 'podium',
  speaker: 'speaker',
  counter: 'counter',
  plant: 'plant',
  locker: 'locker',
  photo: 'box',
  // The one CAD product is an LED display; a future one would want its own icon kind.
  cad: 'screen',
};

export const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply'] as const;
export const SPLAT_EXTENSIONS = ['ply', 'splat', 'ksplat'] as const;

function extensionOf(fileName: string): string {
  const clean = fileName.split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

/** Model format from a file name (same rule as content/modelLoaders.detectModelFormat). */
export function modelFormatOf(fileName: string): ModelFormat | null {
  const ext = extensionOf(fileName);
  return (MODEL_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ModelFormat) : null;
}

/** Open the native file picker; resolves null when the user cancels. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let done = false;
    let fallback = 0;
    const finish = (file: File | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(fallback);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    // Only browsers without the `cancel` event need the focus fallback; it waits long enough for a
    // late `change` (slow pickers fire focus first) and is cleared as soon as change/cancel arrives.
    const onFocus = () => { fallback = window.setTimeout(() => finish(input.files?.[0] ?? null), 1500); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    if (!('oncancel' in input)) window.addEventListener('focus', onFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function importModel({ engine }: MakeArgs): Promise<Entity | null> {
  const file = await pickFile(MODEL_EXTENSIONS.map(e => `.${e}`).join(','));
  if (!file) return null;
  const format = modelFormatOf(file.name);
  if (!format) { engine.toast('error', `Unsupported model format: .${extensionOf(file.name) || '?'}`); return null; }
  const assetId = await engine.assets.put(file, file.name);
  return createModel(file.name, format, { assetId });
}

async function importSplat({ engine }: MakeArgs): Promise<Entity | null> {
  const file = await pickFile(SPLAT_EXTENSIONS.map(e => `.${e}`).join(','));
  if (!file) return null;
  const ext = extensionOf(file.name);
  if (!(SPLAT_EXTENSIONS as readonly string[]).includes(ext)) { engine.toast('error', `Unsupported splat format: .${ext || '?'}`); return null; }
  const assetId = await engine.assets.put(file, file.name);
  return createSplat(file.name, { assetId });
}

/* ───────────────────────────── the list ───────────────────────────── */

const cache = new Map<Unit, CatalogItem[]>();

/** All catalog items for the given display unit, in group order. Memoised per unit. */
export function buildCatalog(unit: Unit): CatalogItem[] {
  const hit = cache.get(unit);
  if (hit) return hit;

  const items: CatalogItem[] = [];

  // LED displays
  for (const p of WALL_PRESETS) {
    const poster = !!p.poster;
    const name = poster ? (p.rows === 1 ? 'LED poster' : `LED poster stack 1×${p.rows}`) : `LED wall ${p.cols}×${p.rows}`;
    items.push({
      id: poster ? `led-poster-${p.cols}x${p.rows}` : `led-wall-${p.cols}x${p.rows}`,
      group: GROUP_LED,
      name,
      sub: wallSubLine(p.cols, p.rows, unit),
      icon: poster ? 'led-poster' : 'led-wall',
      description: poster ? 'Freestanding iPoster panels with base plates and back supports.' : `${p.cols} × ${p.rows} iPoster panels.`,
      make: () => createLedWall({ cols: p.cols, rows: p.rows, accessories: poster, name: poster ? 'LED Poster' : 'LED Wall' }),
    });
  }
  items.push({
    id: 'led-wall-custom',
    group: GROUP_LED,
    name: 'Custom wall…',
    sub: 'Choose columns and rows',
    icon: 'led-wall',
    custom: true,
    description: 'Any size up to 50 × 50 panels.',
    make: ({ cols = 5, rows = 5 }) => createLedWall({ cols, rows, name: 'LED Wall' }),
  });

  // Staging
  for (const h of STAGE_HEIGHTS_IN) {
    items.push({
      id: `stage-${h}`,
      group: GROUP_STAGING,
      name: `Stage deck ${formatLength(h, 'in')}`,
      sub: `4 × 4 ft · ${formatLength(h, unit)} high`,
      icon: 'stage',
      description: 'A 4 ft × 4 ft riser. LED walls placed on top ride with it.',
      make: () => createStage(h, [0, 0, 0], `Stage deck ${h}"`),
    });
  }

  // Equipment, grouped by category
  for (const cat of EQUIPMENT_CATEGORIES) {
    for (const def of EQUIPMENT.filter(d => d.category === cat)) items.push(equipmentItem(def, unit));
  }

  // Venue
  items.push({
    id: 'venue-room',
    group: GROUP_VENUE,
    name: 'Venue space',
    sub: formatDims([40 * 12, 13 * 12, 30 * 12], unit),
    icon: 'room',
    description: 'A proportional room: back wall, floor, ceiling and side walls with optional photos.',
    make: ({ engine }) => createRoomForScene(engine.doc.entities),
  });
  items.push({
    id: 'venue-model',
    group: GROUP_VENUE,
    name: 'Import 3D model…',
    sub: '.glb .gltf .obj .stl .fbx .ply',
    icon: 'model',
    description: 'Load a model file from disk. Files stay on this device.',
    make: importModel,
  });
  items.push({
    id: 'venue-splat',
    group: GROUP_VENUE,
    name: 'Load Gaussian splat…',
    sub: '.ply .splat .ksplat',
    icon: 'splat',
    description: 'Load a Gaussian-splat scan of a venue.',
    make: importSplat,
  });

  cache.set(unit, items);
  return items;
}

function equipmentItem(def: EquipmentDef, unit: Unit): CatalogItem {
  return {
    id: `eq-${def.id}`,
    group: CATEGORY_LABELS[def.category],
    name: def.name,
    sub: formatDims(def.dims, unit),
    icon: EQUIPMENT_ICON[def.geometry] ?? 'box',
    // A photographed product shows its own cutout on the card instead of a line icon.
    image: def.image,
    description: def.description,
    make: () => createEquipment(def),
  };
}

/** Group titles in display order for a built catalog. */
export function catalogGroups(items: CatalogItem[]): string[] {
  const out: string[] = [];
  for (const it of items) if (!out.includes(it.group)) out.push(it.group);
  return out;
}

export function findCatalogItem(id: string, unit: Unit = 'in'): CatalogItem | undefined {
  return buildCatalog(unit).find(i => i.id === id);
}
