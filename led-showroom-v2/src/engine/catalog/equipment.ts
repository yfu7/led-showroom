/**
 * Equipment catalog: to-scale event equipment that can be dropped into a scene alongside LED walls.
 * Dimensions are width × height × depth in inches.
 *
 * The Veloxity rental fleet is modelled from the product cutouts published on veloxity.us, with the
 * dimensions, weights and power figures taken from each product's own spec table. Those items render
 * as photo cutouts (`photo: true`); a product we hold the manufacturer's CAD for renders as that
 * mesh (`geometry: 'cad'` + `model`); everything else is parametric geometry. LED walls and posters
 * are not in this catalog at all — they are `led-wall` entities built from the CAD panel spec.
 */
import type { Vec3 } from '../math';
import type { EquipmentGeometry } from '../document/types';

export type CatalogCategory = 'charging' | 'display' | 'staging' | 'structure' | 'furniture' | 'reference';

export interface EquipmentDef {
  id: string;
  name: string;
  category: CatalogCategory;
  geometry: EquipmentGeometry;
  /** Width, height, depth in inches. */
  dims: Vec3;
  color: string;
  accent?: string;
  description: string;
  /**
   * Cutout photo used as the model and the catalog thumbnail. Served from /products; the plane is
   * scaled to `dims[1]` (the real height) and the image's own aspect, so the product is never
   * stretched. Present only on real products we have photography for.
   */
  image?: string;
  /** Render the photo cutout instead of parametric geometry. */
  photo?: boolean;
  /**
   * Shipped CAD mesh for a `geometry: 'cad'` product: a GLB under /models converted from the
   * manufacturer's STEP by `scripts/step-to-glb.cjs`. `dims` must be the mesh's own bounds, since
   * the renderer scales the mesh to `dims` (they are 1:1 as published).
   */
  model?: string;
  /** Spec rows shown in the inspector, straight from the product's published sheet. */
  specs?: { label: string; value: string }[];
  /** Optional dimension presets (e.g. truss lengths). */
  variants?: { name: string; dims: Vec3 }[];
}

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  charging: 'Charging',
  display: 'Interactive displays',
  staging: 'Staging',
  structure: 'Structure',
  furniture: 'Furniture',
  reference: 'Reference',
};

/** The Veloxity rental fleet — real products, real dimensions, photographed. */
export const VELOXITY_PRODUCTS: EquipmentDef[] = [
  {
    id: 'portable-charger-kiosk',
    name: 'Portable charger kiosk',
    category: 'charging',
    geometry: 'photo', dims: [17.5, 65, 10], color: '#1f2226', accent: '#28ace3',
    image: '/products/power-pod-36.webp', photo: true,
    description: 'Attendees borrow a fully charged power bank from the kiosk and charge on the go.',
    specs: [
      { label: 'Display', value: '24" touchscreen' },
      { label: 'Portable chargers', value: '36' },
      { label: 'Charger capacity', value: '5000 & 8000 mAh' },
      { label: 'Power', value: '120V, 5A' },
      { label: 'Weight', value: '110 lb (54 kg)' },
    ],
  },
  {
    id: 'charging-lockers',
    name: 'Phone charging lockers',
    category: 'charging',
    geometry: 'photo', dims: [17.5, 65, 12], color: '#1f2226', accent: '#28ace3',
    image: '/products/charging-lockers.webp', photo: true,
    description: 'Eight lockers with built-in cables; attendees secure a device with a personal PIN.',
    specs: [
      { label: 'Display', value: '19" touchscreen' },
      { label: 'Lockers', value: '8' },
      { label: 'Power', value: '120V, 5A' },
      { label: 'Weight', value: '130 lb (59 kg)' },
    ],
  },
  {
    id: 'charging-table',
    name: 'Phone charging table',
    category: 'charging',
    geometry: 'photo', dims: [23, 45, 23], color: '#e9ecef', accent: '#28ace3',
    image: '/products/charging-table.webp', photo: true,
    description: 'Hightop table with retractable cables, MagSafe pads and AC outlets for laptops.',
    specs: [
      { label: 'Cables', value: '4 Lightning, 4 Type-C' },
      { label: 'Wireless', value: '2 MagSafe pads' },
      { label: 'Outlets', value: '2 AC for laptops' },
      { label: 'Power', value: '120V, 5A' },
      { label: 'Weight', value: '80 lb (36 kg)' },
    ],
  },
  {
    id: 'tabletop-chargers',
    name: 'Tabletop portable chargers',
    category: 'charging',
    geometry: 'photo', dims: [11, 9, 4], color: '#2a2d32', accent: '#28ace3',
    image: '/products/powerpax.webp', photo: true,
    description: 'A tabletop bay of eight power banks — the space-efficient charge-on-the-go option.',
    specs: [
      { label: 'Portable chargers', value: '8' },
      { label: 'Charger capacity', value: '5,000 mAh' },
      { label: 'Power', value: '120V, 5A' },
      { label: 'Weight', value: '8 lb (3.6 kg)' },
    ],
  },
  {
    id: 'touch-50-vertical',
    name: '50" vertical touch screen',
    category: 'display',
    geometry: 'photo', dims: [27, 72, 1], color: '#141518', accent: '#0e0e10',
    image: '/products/touch-50-vertical.webp', photo: true,
    description: 'Thin plug-and-play interactive screen with a built-in Windows computer and Wi-Fi.',
    specs: [
      { label: 'Screen size', value: '50" touchscreen' },
      { label: 'Resolution', value: '1080 × 1920' },
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Power', value: '120V, 5A' },
      { label: 'Weight', value: '95 lb (43 kg)' },
    ],
  },
  {
    id: 'touch-43-horizontal',
    name: '43" horizontal touch screen',
    category: 'display',
    geometry: 'photo', dims: [44, 43, 31], color: '#141518', accent: '#0e0e10',
    image: '/products/touch-43-horizontal.webp', photo: true,
    description: 'Tilting table-height touch screen, 30–45°, with a built-in computer and Wi-Fi.',
    specs: [
      { label: 'Screen size', value: '43" touchscreen' },
      { label: 'Resolution', value: '1920 × 1080' },
      { label: 'Aspect ratio', value: '16:9' },
      { label: 'Power', value: '120V, 5A' },
      { label: 'Weight', value: '90 lb (43 kg)' },
    ],
  },
];

/** Generic props with no product photography — parametric geometry, for dressing a room to scale. */
export const PROPS: EquipmentDef[] = [
  { id: 'truss-12-8ft', name: 'Box truss 12" × 8 ft', category: 'structure', geometry: 'truss', dims: [96, 12, 12], color: '#b9bcc2', description: 'Aluminium box truss, 12" square section.', variants: [{ name: '4 ft', dims: [48, 12, 12] }, { name: '8 ft', dims: [96, 12, 12] }, { name: '10 ft', dims: [120, 12, 12] }] },
  { id: 'truss-upright-10ft', name: 'Truss upright 10 ft', category: 'structure', geometry: 'truss-upright', dims: [12, 120, 12], color: '#b9bcc2', description: 'Vertical truss leg with a base plate.', variants: [{ name: '8 ft', dims: [12, 96, 12] }, { name: '10 ft', dims: [12, 120, 12] }, { name: '12 ft', dims: [12, 144, 12] }] },
  { id: 'pipe-drape', name: 'Pipe & drape 10 × 8 ft', category: 'structure', geometry: 'drape', dims: [120, 96, 6], color: '#101012', description: 'One bay of pipe-and-drape in velour.', variants: [{ name: '8 ft tall', dims: [120, 96, 6] }, { name: '12 ft tall', dims: [120, 144, 6] }, { name: '16 ft tall', dims: [120, 192, 6] }] },
  { id: 'counter', name: 'Trade-show counter', category: 'structure', geometry: 'counter', dims: [40, 40, 20], color: '#f2efe9', accent: '#28ace3', description: 'Branded reception counter.' },
  { id: 'podium', name: 'Podium', category: 'structure', geometry: 'podium', dims: [24, 47, 18], color: '#1c1c1e', description: 'Presenter lectern.' },
  { id: 'speaker', name: 'Speaker on stand', category: 'structure', geometry: 'speaker', dims: [17, 72, 15], color: '#121214', description: '15" cabinet on a tripod stand.' },

  { id: 'table-6ft', name: 'Banquet table 6 ft', category: 'furniture', geometry: 'table-rect', dims: [72, 30, 30], color: '#e9e6df', description: '6 ft rectangular table.' },
  { id: 'table-round-60', name: 'Round table 60"', category: 'furniture', geometry: 'table-round', dims: [60, 30, 60], color: '#e9e6df', description: '60" round banquet table.' },
  { id: 'cocktail-table', name: 'Cocktail table', category: 'furniture', geometry: 'table-round', dims: [30, 42, 30], color: '#e9e6df', description: '30" high-top.' },
  { id: 'chair', name: 'Chair', category: 'furniture', geometry: 'chair', dims: [18, 34, 20], color: '#2b2b2f', description: 'Banquet chair.' },
  { id: 'sofa', name: 'Lounge sofa', category: 'furniture', geometry: 'sofa', dims: [72, 30, 32], color: '#d8d2c6', description: 'Three-seat lounge sofa.' },
  { id: 'armchair', name: 'Armchair', category: 'furniture', geometry: 'sofa', dims: [32, 30, 32], color: '#d8d2c6', description: 'Lounge armchair.' },
  { id: 'plant', name: 'Plant', category: 'furniture', geometry: 'plant', dims: [30, 66, 30], color: '#3f6b3a', accent: '#5d5348', description: 'Potted plant.' },

  { id: 'figure', name: 'Person (5\'9")', category: 'reference', geometry: 'figure', dims: [20, 69, 12], color: '#8a8f99', description: 'Human figure for scale.' },
  { id: 'box', name: 'Custom box', category: 'reference', geometry: 'box', dims: [24, 24, 24], color: '#6b6f78', description: 'A plain box with editable dimensions.' },
  { id: 'cylinder', name: 'Custom cylinder', category: 'reference', geometry: 'cylinder', dims: [24, 36, 24], color: '#6b6f78', description: 'A plain cylinder with editable dimensions.' },
];

export const EQUIPMENT: EquipmentDef[] = [...VELOXITY_PRODUCTS, ...PROPS];

export const EQUIPMENT_BY_ID: Record<string, EquipmentDef> = Object.fromEntries(EQUIPMENT.map(e => [e.id, e]));

export function equipmentDef(id: string): EquipmentDef | undefined {
  return EQUIPMENT_BY_ID[id];
}

/** Order the catalog groups appear in. */
export const CATEGORY_ORDER: CatalogCategory[] = ['charging', 'display', 'structure', 'furniture', 'reference', 'staging'];
