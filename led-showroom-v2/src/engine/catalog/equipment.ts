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
  /**
   * The truss system a truss part belongs to. Parts of two systems never connect: DT-GP bolts end
   * plate to end plate on an 11.156 in section, F34 pins conical couplers on an 11.42 in one, so a
   * structure is built from one system alone. The half coupler is in neither; it closes on the
   * 50 mm chord of both.
   */
  trussSystem?: TrussSystem;
}

/** The Global Truss systems we own. They do not connect to each other. */
export type TrussSystem = 'DT-GP' | 'F34';

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


/* --------------------------- truss inventory ---------------------------
 * Our Global Truss stock, from the five Stage Lighting Store sales orders. Two systems that do NOT
 * connect to each other, so nothing built from one may take a part of the other (`trussSystem`):
 *
 *   DT-GP  11.156" section, end plates bolted with (4) 5/8" Gr.8 bolts.
 *            #735958  5/20/2026  6 x 5 ft, 6 x 4 ft, 3 x 8 ft, 6 x 6-way corners, 6 base plates
 *            #736643   7/1/2026  6 x 4 ft
 *          No 3 ft stick is on any of the orders: the orders are the whole of our stock. The 3 ft
 *          is listed with none owned, as the stick to buy for the legs of a walk-through arch.
 *   F34    11.42" section, conical couplers.
 *            #733795   2/6/2026  2 x 1.5 m, 6 x 1.25 m, 2 x 2-way 90 deg corners, 2 x 3-way T junctions
 *            #734958  3/31/2026  2 x 1 x 4 ft steel base plates, 2 x 2-way 90 deg corners
 *            #736526  6/22/2026  2 x 30 x 30 in base plates
 *          The 6-way junction block and the 12 x 12 in plate were quoted (Estimates #162181 rev. and
 *          #162195) but are on none of the orders, so we hold none of them.
 *
 * The truss of both systems is 6082-T6 aluminium, ordered black. Stick lengths and sections are the
 * manufacturer's own designations and are exact; junction and base-plate sizes are nominal unless a
 * row says where they come from. Every entry says which it is.
 */

/** Shared DT-GP spec rows (one engineered system, one set of figures). */
const GP_SYSTEM = { label: 'System', value: 'DT-GP - does not connect to F34' };
const GP_SECTION = { label: 'Section', value: '11.156 in square' };
const GP_BUILD = { label: 'Construction', value: '50 x 3 mm chord, 25 x 2 mm diagonal, 6082-T6 aluminium' };
const GP_CONN = { label: 'Connection', value: '(4) 5/8 in Gr.8 bolts per joint' };
const GP_SPAN = { label: 'Rated span (UDL)', value: '888 plf @ 5 ft, 370 plf @ 10 ft, 161 plf @ 15 ft, 88 plf @ 20 ft' };
const GP_BASIS = { label: 'Load basis', value: 'Strength + L/180 deflection. Loads at panel points only; table values are not additive.' };
const GP_ENGR = { label: 'Engineering', value: 'Entertainment Engineering Consultants, 06/20/2024, proj. 24.149.02A' };

/** Shared F34 spec rows. */
const F34_SYSTEM = { label: 'System', value: 'F34 - does not connect to DT-GP' };
const F34_SECTION = { label: 'Section', value: '11.42 in square' };
const F34_CONN = { label: 'Connection', value: 'Conical couplers' };
const F34_QUOTED = { label: 'Status', value: 'Quoted, never ordered - on an estimate, on none of our sales orders' };
const NOMINAL = { label: 'Overall size', value: 'Nominal - the order gives no geometry' };

export const TRUSS_INVENTORY: EquipmentDef[] = [
  {
    id: 'gp-truss-8ft', name: 'DT-GP8 box truss 8 ft', category: 'structure', geometry: 'truss', trussSystem: 'DT-GP',
    dims: [96, 11.16, 11.16], color: '#17181b',
    description: '8 ft end-plated DT-GP box truss, black. The horizontal span of an arch.',
    specs: [
      { label: 'Part no.', value: 'GP0001 - DT-GP8-BLK' },
      { label: 'Owned', value: '3 (Sales Order #735958)' },
      { label: 'Unit price', value: '$948.68 (Sales Order #735958, 5/20/2026)' },
      GP_SYSTEM, GP_SECTION, GP_BUILD, GP_CONN, GP_SPAN, GP_BASIS, GP_ENGR,
    ],
  },
  {
    id: 'gp-truss-5ft', name: 'DT-GP5 box truss 5 ft', category: 'structure', geometry: 'truss', trussSystem: 'DT-GP',
    dims: [60, 11.16, 11.16], color: '#17181b',
    description: '5 ft end-plated DT-GP box truss, black. The lower half of an arch leg.',
    specs: [
      { label: 'Part no.', value: 'GP0053 - DT-GP5-BLK' },
      { label: 'Owned', value: '6 (Sales Order #735958)' },
      { label: 'Unit price', value: '$682.28 (Sales Order #735958, 5/20/2026)' },
      GP_SYSTEM, GP_SECTION, GP_BUILD, GP_CONN, GP_SPAN, GP_BASIS, GP_ENGR,
    ],
  },
  {
    id: 'gp-truss-4ft', name: 'DT-GP4 box truss 4 ft', category: 'structure', geometry: 'truss', trussSystem: 'DT-GP',
    dims: [48, 11.16, 11.16], color: '#17181b',
    description: '4 ft end-plated DT-GP box truss, black. The upper half of an arch leg.',
    specs: [
      { label: 'Part no.', value: 'GP0079 - DT-GP4-BLK' },
      { label: 'Owned', value: '12 (Sales Orders #735958 and #736643, 6 on each)' },
      { label: 'Unit price', value: '$599.40 (Sales Orders #735958 and #736643)' },
      GP_SYSTEM, GP_SECTION, GP_BUILD, GP_CONN, GP_SPAN, GP_BASIS, GP_ENGR,
    ],
  },
  {
    id: 'gp-truss-3ft', name: 'DT-GP3 box truss 3 ft', category: 'structure', geometry: 'truss', trussSystem: 'DT-GP',
    dims: [36, 11.16, 11.16], color: '#17181b',
    description: '3 ft end-plated DT-GP box truss, black. Not one of ours: the stick to buy so a leg lands the header on the lintel of a walk-through arch.',
    specs: [
      { label: 'Part no.', value: 'GP0118 - DT-GP3-BLK (from retailer listings; not on any order)' },
      { label: 'Owned', value: '0 (on none of our orders; a DT-GP2 2 ft stick beside a 5 ft does the same job in a leg)' },
      { label: 'Unit price', value: '$478.00 (estimate: a retailer listing for the DT-GP3-BLK, not a quote or an order)' },
      GP_SYSTEM, GP_SECTION, GP_BUILD, GP_CONN, GP_SPAN, GP_BASIS, GP_ENGR,
    ],
  },
  {
    id: 'gp-truss-2ft', name: 'DT-GP2 box truss 2 ft', category: 'structure', geometry: 'truss', trussSystem: 'DT-GP',
    dims: [24, 11.16, 11.16], color: '#17181b',
    description: '2 ft end-plated DT-GP box truss, black. Not one of ours: a stick to buy, so a leg of a 5 ft and a 2 ft lands the header on the lintel of a walk-through arch as a 4 ft and a 3 ft do.',
    specs: [
      { label: 'Part no.', value: 'GP0131 - DT-GP2-BLK (from retailer listings; not on any order. Global Truss lists the DT-GP2 as GP0222, colour not stated)' },
      { label: 'Owned', value: '0 (on none of our orders)' },
      { label: 'Unit price', value: '$407.00 (estimate: retailer listings for the DT-GP2-BLK, not a quote or an order)' },
      { label: 'Link', value: 'https://www.globaltruss.com/dt-gp2' },
      GP_SYSTEM, GP_SECTION, GP_BUILD, GP_CONN, GP_SPAN, GP_BASIS, GP_ENGR,
    ],
  },
  {
    id: 'gp-corner-6way', name: 'DT-GP 6-way corner block', category: 'structure', geometry: 'truss-block', trussSystem: 'DT-GP',
    dims: [11.16, 11.16, 11.16], color: '#17181b',
    description: 'Six-way GP truss corner block, black: a cube of the section with a way out of every face. The shoulder where a leg meets a span.',
    specs: [
      { label: 'Part no.', value: 'GP0352 - DT-6WB-BLK' },
      { label: 'Owned', value: '6 (Sales Order #735958)' },
      { label: 'Unit price', value: '$695.60 (Sales Order #735958, 5/20/2026)' },
      GP_SYSTEM, GP_SECTION, NOMINAL, GP_CONN, GP_ENGR,
    ],
  },
  {
    id: 'gp-base-36', name: 'DT-GP base plate 36 in', category: 'structure', geometry: 'truss-base', trussSystem: 'DT-GP',
    dims: [36, 1.5, 36], color: '#17181b',
    description: 'Heavy-duty base plate, black: 36 x 36 in and 1.5 in thick, flat on the floor. The first stick of a leg bolts straight onto it. One under each leg.',
    specs: [
      { label: 'Part no.', value: 'BP0300 - DT-GP-Base36-BLK' },
      { label: 'Owned', value: '6 (Sales Order #735958)' },
      { label: 'Unit price', value: '$1,468.16 (Sales Order #735958, 5/20/2026)' },
      { label: 'Plate', value: '36 x 36 in, 1.5 in thick (as we measure the plates we hold)' },
      { label: 'On the order', value: 'Bills six of this part against a quantity of 0, and lists six GP0287 DT-GP BASE/30BLK (30 in raised GP base) beside it at no charge' },
      GP_SYSTEM, GP_SECTION, GP_CONN,
    ],
  },

  {
    id: 'clamp-8002', name: 'Half coupler M10 slim (8002)', category: 'structure', geometry: 'clamp',
    dims: [1.26, 2.76, 3.15], color: '#9aa0a6',
    description: 'TAF 8002 slim aluminium half coupler. What bolts a cabinet to a truss chord.',
    specs: [
      { label: 'Part no.', value: '8002' },
      { label: 'Owned', value: '38 (Invoice INV-1131, Truss Concepts, 10/13/2026)' },
      { label: 'Unit price', value: '$18.75 (Invoice INV-1131: $20.83 less 10%)' },
      { label: 'Fits tube', value: '48 - 51 mm (1.9 - 2.0 in)' },
      { label: 'Fits our truss', value: 'DT-GP chord is 50 mm, inside the jaw range - read off the two specs, not stated by either document' },
      { label: 'Load', value: '200 kg (440 lb)' },
      { label: 'Bolt', value: 'M10, matching the M10 holes in our cabinets' },
      { label: 'Weight', value: '0.36 kg (0.79 lb) each' },
      { label: 'Finish', value: 'Natural aluminium - the black one is sold as 8002-B, and the invoice says 8002' },
      { label: 'Certification', value: 'CE, TUV Nord' },
      NOMINAL,
    ],
  },
  {
    id: 'f34-straight-1500', name: 'F34 square truss 1.5 m', category: 'structure', geometry: 'truss', trussSystem: 'F34',
    dims: [59.06, 11.42, 11.42], color: '#17181b',
    description: 'Global Truss F34 straight segment, 1.5 m, black.',
    specs: [
      { label: 'Part no.', value: 'SQ-4111 BLK/MTE' },
      { label: 'Owned', value: '2 (Sales Order #733795)' },
      { label: 'Length', value: '1.5 m (59.06 in)' },
      F34_SYSTEM, F34_SECTION, F34_CONN,
    ],
  },
  {
    id: 'f34-straight-1250', name: 'F34 square truss 1.25 m', category: 'structure', geometry: 'truss', trussSystem: 'F34',
    dims: [49.21, 11.42, 11.42], color: '#17181b',
    description: 'Global Truss F34 straight segment, 1.25 m, black.',
    specs: [
      { label: 'Part no.', value: 'SQ-4111-1250 BLK/MTE' },
      { label: 'Owned', value: '6 (Sales Order #733795)' },
      { label: 'Length', value: '1.25 m (49.21 in)' },
      F34_SYSTEM, F34_SECTION, F34_CONN,
    ],
  },
  {
    id: 'f34-corner-2way', name: 'F34 2-way 90 deg corner', category: 'structure', geometry: 'truss-corner', trussSystem: 'F34',
    dims: [20, 11.42, 20], color: '#17181b',
    description: 'Global Truss F34 two-way 90 degree corner, black.',
    specs: [
      { label: 'Part no.', value: 'SQ-4121 BLK/MTE' },
      { label: 'Owned', value: '4 (Sales Orders #733795 and #734958, 2 on each)' },
      F34_SYSTEM, F34_SECTION, NOMINAL, F34_CONN,
    ],
  },
  {
    id: 'f34-tee-3way', name: 'F34 3-way T junction', category: 'structure', geometry: 'truss-tee', trussSystem: 'F34',
    dims: [20, 11.42, 20], color: '#17181b',
    description: 'Global Truss F34 three-way T junction, black.',
    specs: [
      { label: 'Part no.', value: 'SQ-4129 BLK/MTE' },
      { label: 'Owned', value: '2 (Sales Order #733795)' },
      F34_SYSTEM, F34_SECTION, NOMINAL, F34_CONN,
    ],
  },
  {
    id: 'f34-block-6way', name: 'F34 6-way junction block', category: 'structure', geometry: 'truss-block', trussSystem: 'F34',
    dims: [22, 22, 22], color: '#17181b',
    description: 'Global Truss F34 universal six-way junction block, black.',
    specs: [
      { label: 'Part no.', value: 'ST-UJB-12/BLK/MTE' },
      { label: 'Owned', value: '0 (quoted on Estimate #162181 rev.; on none of our sales orders)' },
      F34_SYSTEM, F34_SECTION, NOMINAL, F34_CONN, F34_QUOTED,
    ],
  },
  {
    id: 'f34-base-1x4', name: 'F34 base plate 1 x 4 ft', category: 'structure', geometry: 'box', trussSystem: 'F34',
    dims: [12, 0.75, 48], color: '#17181b',
    description: 'Steel base plate for F34, 1 ft x 4 ft.',
    specs: [
      { label: 'Part no.', value: 'BASE PLATE 1.4S' },
      { label: 'Owned', value: '2 (Sales Order #734958)' },
      { label: 'Plate', value: '1 ft x 4 ft steel' },
      { label: 'Thickness', value: 'Nominal - the order gives none' },
      F34_SYSTEM,
    ],
  },
  {
    id: 'f34-base-30', name: 'F34 base plate 30 x 30 in', category: 'structure', geometry: 'box', trussSystem: 'F34',
    dims: [30, 0.375, 30], color: '#17181b',
    description: 'Global Truss 30 x 30 in aluminium base plate for F34, black.',
    specs: [
      { label: 'Part no.', value: 'BASE PLATE 30X30-BLK/MTE' },
      { label: 'Owned', value: '2 (Sales Order #736526)' },
      { label: 'Plate', value: '30 x 30 in, 3/8 in (9.5 mm) aluminium - from retailer listings; the order says only 30 X 30' },
      F34_SYSTEM,
    ],
  },
  {
    id: 'f34-base-12', name: 'F34 base plate 12 x 12 in', category: 'structure', geometry: 'box', trussSystem: 'F34',
    dims: [12, 0.75, 12], color: '#17181b',
    description: 'Global Truss 12 in x 12 in base plate for F34.',
    specs: [
      { label: 'Part no.', value: 'SQ-4137 BLK/MTE' },
      { label: 'Owned', value: '0 (quoted on Estimate #162195; on none of our sales orders)' },
      { label: 'Plate', value: '12 in x 12 in' },
      { label: 'Thickness', value: 'Nominal - the order gives none' },
      F34_SYSTEM, F34_QUOTED,
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

export const EQUIPMENT: EquipmentDef[] = [...VELOXITY_PRODUCTS, ...TRUSS_INVENTORY, ...PROPS];

export const EQUIPMENT_BY_ID: Record<string, EquipmentDef> = Object.fromEntries(EQUIPMENT.map(e => [e.id, e]));

export function equipmentDef(id: string): EquipmentDef | undefined {
  return EQUIPMENT_BY_ID[id];
}

/**
 * Owned quantity from a catalog `Owned` row, or undefined when the row is not a count.
 *
 * An `Owned` row reads "6 (Sales Order #735958)", so the count is the number it starts with, and a
 * row starting with a word deliberately yields nothing. A part with no `Owned` row at all, such
 * as a generic prop, is not stock, and it is not zero stock either -- how many we hold is simply
 * not something the catalog says. A part we were quoted but never ordered says so: `Owned` 0.
 *
 * Shared by the truss planner (which warns when a rig wants more legs than we hold) and the build
 * list (which flags the same shortfall on every line), because a shortfall is one idea and the two
 * screens must not disagree about it.
 */
/** What one costs to buy, in US dollars, from its "Unit price" row; undefined where the row gives none. */
export function unitPrice(def: EquipmentDef | undefined): number | undefined {
  const row = def?.specs?.find(s => s.label === 'Unit price')?.value;
  const m = row ? /^\s*\$([\d,]+(?:\.\d+)?)/.exec(row) : null;
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

export function ownedCount(def: EquipmentDef | undefined): number | undefined {
  const row = def?.specs?.find(s => s.label === 'Owned')?.value;
  const m = row ? /^\s*(\d+)/.exec(row) : null;
  return m ? Number(m[1]) : undefined;
}

/** Order the catalog groups appear in. */
export const CATEGORY_ORDER: CatalogCategory[] = ['charging', 'display', 'structure', 'furniture', 'reference', 'staging'];
