/**
 * The build list: what a scene asks the warehouse to pull.
 *
 * The counting rules are not this app's invention. They are the allocation rulebook the fleet is
 * actually scheduled by ("LED Alloc 2026 - Rules & Assumptions", 2026-09-09), which cites
 * `ledwall/specs.ts` for its own cabinet dimensions -- the sheet and this app are a pair, and the
 * rule numbers below are that sheet's. The ones this module implements:
 *
 *   5.  A cabinet is 6 LED panels. THE UNIT IS THE CABINET: one wall cell is one cabinet, and a
 *       list that said "panels" would pull six times too much. Panels come out of a cabinet only to
 *       fill an empty frame, which is a warehouse operation and not something a build asks for, so
 *       the panel figure is a diagnostic here and not a line on the list.
 *   3b. Every column carries one powered cabinet OF ITS OWN CUT, so a W x H wall is W powered plus
 *       W x (H - 1) regular. Worked examples on the sheet: "5 by 4 wall: 5 powered cabinets, 15
 *       cabinets", "9 by 5 wall: 9 powered, 36 regular".
 *   3.  A double-sided build is two sides of the same grid: a double-sided poster is 8 cabinets,
 *       2 powered + 6 regular, against the single-sided 4 (1 + 3). Sides multiply the cabinets.
 *       They do not multiply the accessories -- two faces, one base.
 *   6.  Corner cabinets are cut: Left = a 45 degree cut on the left end of the cabinet, Right = the
 *       right end, Double = both ends. They come from their own pools and never from the flat count.
 *   7.  A crate takes 8 cabinets. Rule 7 caps a reroute leg at "8 cabinets per LED crate", and
 *       rule I reads the same figure back off the calendar: "Shoptalk -> CAIS 3 crates = 24
 *       cabinets". It is a fact about the crate, so it holds wherever cabinets are crated.
 *
 * Deliberately NOT here: batches (1, 4, 14), shipping windows (2), panel donors (9, 10) and
 * regular-to-powered conversions (13). Those are fleet-wide scheduling over many shows and dates;
 * nothing in one scene decides them, and a guess printed next to real numbers reads as a fact.
 */
import type { EquipmentDef } from '../catalog/equipment';
import { equipmentDef, ownedCount } from '../catalog/equipment';
import type { Document, EquipmentEntity, LedWallEntity } from '../document/types';
import type { Vec3 } from '../math';
import { filledCells, miterCutsForColumn, parseCell, wallDims } from '../ledwall/layout';
import { PANEL_SPECS } from '../ledwall/specs';
import { formatDims, type Unit } from '../units';

/** Rule 5. */
export const CABINET_PANELS = 6;
/** Rule 7's crate cap, cross-checked on rule I: "Shoptalk -> CAIS 3 crates = 24 cabinets". */
export const CABINETS_PER_CRATE = 8;
/**
 * The product the rulebook's ratios are recorded for: the 25.2 x 18.9 in fleet cabinet.
 *
 * A wall of anything else still counts as cabinets and columns, because that is geometry, but it
 * is left out of the panel and crate figures and says so. Six panels to a cabinet and eight to a
 * crate are facts about this product, not about LED.
 */
export const FLEET_CABINET = 'iposter';

/** Which ends of a cabinet are mitred. Rule 6. */
export type CutKind = 'flat' | 'left' | 'right' | 'double';

export const CUT_ORDER: readonly CutKind[] = ['flat', 'left', 'right', 'double'];

export const CUT_LABELS: Record<CutKind, string> = {
  flat: 'Flat', left: 'Left cut', right: 'Right cut', double: 'Double cut',
};

/** Powered and regular cabinets of one cut. */
export interface CabinetCount { powered: number; regular: number }

/** One column of a wall: how many cabinets it carries and which of its ends are cut. */
export interface ColumnBuild {
  col: number;
  /** Cabinets in this column, on one side. 0 where a custom shape has left the column empty. */
  cells: number;
  cut: CutKind;
  /** Fold angles at this column's left and right ends, degrees, or null where there is no fold. */
  leftDeg: number | null;
  rightDeg: number | null;
}

export interface WallBuild {
  id: string;
  name: string;
  /** Panel spec id and name. */
  product: string;
  productName: string;
  cols: number;
  rows: number;
  /** 2 for a double-sided build (rule 3). */
  sides: 1 | 2;
  /** Whether the rulebook's per-cabinet ratios are recorded for this product. */
  fleet: boolean;
  columns: ColumnBuild[];
  byCut: Record<CutKind, CabinetCount>;
  total: CabinetCount;
  cabinets: number;
  /** Base plate + two back supports per occupied column, when the wall is standing on them. */
  accessorySets: number;
  notes: string[];
}

/** One line of hardware, as the warehouse would pull it. */
export interface EquipmentLine {
  catalogId: string;
  name: string;
  qty: number;
  /** The group's dimensions, as placed, width x height x depth in inches. */
  dims: Vec3;
  /** Quantity the catalog records as owned, or null where the row is not a count (a quote is not stock). */
  owned: number | null;
  /** How many more than we own this build wants. */
  short: number;
}

export interface BuildList {
  walls: WallBuild[];
  byCut: Record<CutKind, CabinetCount>;
  cabinets: number;
  powered: number;
  regular: number;
  /** The cabinets the crate and panel figures cover -- see {@link FLEET_CABINET}. */
  fleetCabinets: number;
  /** Rule 5. A diagnostic, not a line on the list: see the module header. */
  panels: number;
  /** Rule 7, pooled over the scene rather than rounded up per wall. */
  crates: number;
  accessorySets: number;
  equipment: EquipmentLine[];
  notes: string[];
}

const zeroCuts = (): Record<CutKind, CabinetCount> => ({
  flat: { powered: 0, regular: 0 },
  left: { powered: 0, regular: 0 },
  right: { powered: 0, regular: 0 },
  double: { powered: 0, regular: 0 },
});

const addInto = (into: CabinetCount, from: CabinetCount): void => {
  into.powered += from.powered;
  into.regular += from.regular;
};

/**
 * Which ends of a column are mitred.
 *
 * Both ends is a Double, and the sign of the fold does not come into it: rule 6's "convex" names
 * the KIND of build it is talking about (a corner, a V, a cube, a U, a tower), not the direction of
 * each individual joint, and a cabinet mitred the other way is still a cabinet with a cut end.
 */
function cutOf(left: unknown, right: unknown): CutKind {
  if (left && right) return 'double';
  if (right) return 'right';
  if (left) return 'left';
  return 'flat';
}

/** Cabinets per column of a wall, by column index, on ONE side. */
function cellsPerColumn(wall: LedWallEntity): number[] {
  const per = new Array<number>(wall.cols).fill(0);
  for (const key of filledCells(wall)) {
    const [c] = parseCell(key);
    if (c >= 0 && c < wall.cols) per[c] = (per[c] ?? 0) + 1;
  }
  return per;
}

/** What one wall needs. */
export function wallBuild(wall: LedWallEntity): WallBuild {
  const spec = PANEL_SPECS[wall.product];
  const dims = wallDims(wall);
  const sides: 1 | 2 = wall.doubleSided ? 2 : 1;
  const fleet = wall.product === FLEET_CABINET;
  const cornerAt = new Map(wall.corners.map(c => [c.afterCol, c.angle]));
  const per = cellsPerColumn(wall);

  const columns: ColumnBuild[] = [];
  const byCut = zeroCuts();
  let accessorySets = 0;

  for (let col = 0; col < wall.cols; col++) {
    const cells = per[col] ?? 0;
    const { left, right } = miterCutsForColumn(col, dims, wall.corners);
    const cut = cutOf(left, right);
    columns.push({
      col,
      cells,
      cut,
      leftDeg: left ? cornerAt.get(col - 1) ?? null : null,
      rightDeg: right ? cornerAt.get(col) ?? null : null,
    });
    // An empty column asks for nothing -- no cabinet, and so no powered cabinet either. Rule 3b
    // gives one powered cabinet to a COLUMN, and a column a custom shape has emptied is not one.
    if (cells === 0) continue;
    addInto(byCut[cut], { powered: sides, regular: (cells - 1) * sides });
    accessorySets++;
  }

  const total: CabinetCount = { powered: 0, regular: 0 };
  for (const kind of CUT_ORDER) addInto(total, byCut[kind]);

  const notes: string[] = [];
  if (!spec) notes.push(`Unknown product "${wall.product}": counted as cabinets by the shape alone.`);
  else if (!fleet) {
    notes.push(`${spec.name} is not the 25.2 x 18.9 in fleet cabinet, so the six-panels and eight-to-a-crate figures are left off: those are recorded for that cabinet, not for LED in general.`);
  }
  // Rule H's cubes: four Double-cut columns, because the fourth column meets the first. The joint
  // that closes a ring is not in `corners` at all -- `miterCutsForColumn` only mitres joints the
  // layout folds at, between column c and c + 1 -- so a ring reads as one Right and one Left where
  // it wants two Doubles. Said out loud rather than guessed at.
  if (wall.cols >= 3 && wall.corners.length >= wall.cols - 1) {
    notes.push('Folded at every joint: if this closes into a ring (a cube or a tower), the joint between the last column and the first is not modelled, so its two end columns want Double cuts rather than the Left and Right shown.');
  }
  if (wall.doubleSided) notes.push('Double-sided: two sides of the same grid, so twice the cabinets and twice the powered (rule 3), on one set of accessories.');

  return {
    id: wall.id,
    name: wall.name,
    product: wall.product,
    productName: spec?.name ?? wall.product,
    cols: wall.cols,
    rows: wall.rows,
    sides,
    fleet,
    columns,
    byCut,
    total,
    cabinets: total.powered + total.regular,
    accessorySets: wall.accessories ? accessorySets : 0,
    notes,
  };
}

/**
 * Group key for a hardware line: the catalog item plus its SORTED dimensions.
 *
 * Sorted because the same stick is placed both ways: a tower stands an 8 ft GP on end as
 * [11.16, 96, 11.16] where the catalog lies it down as [96, 11.16, 11.16]. Unsorted, one order
 * would pull two different items for the same part.
 */
const dimsKey = (dims: Vec3): string => [...dims]
  .map(d => Math.round(d * 100) / 100)
  .sort((a, b) => a - b)
  .join('x');

function equipmentLines(items: EquipmentEntity[]): EquipmentLine[] {
  const groups = new Map<string, EquipmentLine>();
  for (const e of items) {
    const key = `${e.catalogId}|${dimsKey(e.dims)}`;
    const hit = groups.get(key);
    if (hit) { hit.qty++; continue; }
    const def: EquipmentDef | undefined = equipmentDef(e.catalogId);
    const owned = ownedCount(def);
    groups.set(key, {
      catalogId: e.catalogId,
      name: def?.name ?? e.catalogId,
      qty: 1,
      dims: [...e.dims] as Vec3,
      owned: owned ?? null,
      short: 0,
    });
  }
  const lines = [...groups.values()];
  for (const l of lines) l.short = l.owned === null ? 0 : Math.max(0, l.qty - l.owned);
  return lines.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

/** What the whole scene needs pulled. */
export function buildList(doc: Document): BuildList {
  const walls = doc.entities.filter((e): e is LedWallEntity => e.type === 'led-wall').map(wallBuild);
  const equipment = equipmentLines(doc.entities.filter((e): e is EquipmentEntity => e.type === 'equipment'));

  const byCut = zeroCuts();
  let fleetCabinets = 0, accessorySets = 0;
  for (const w of walls) {
    for (const kind of CUT_ORDER) addInto(byCut[kind], w.byCut[kind]);
    if (w.fleet) fleetCabinets += w.cabinets;
    accessorySets += w.accessorySets;
  }
  const powered = CUT_ORDER.reduce((n, k) => n + byCut[k].powered, 0);
  const regular = CUT_ORDER.reduce((n, k) => n + byCut[k].regular, 0);

  const notes: string[] = [];
  if (CUT_ORDER.some(k => k !== 'flat' && byCut[k].powered + byCut[k].regular > 0)) {
    notes.push('Cut cabinets are what the mitred joints imply. A fold can also be butted with flat cabinets instead -- the HubSpot U-wall was built that way (rule K) -- so these are the cut cabinets to pull if the corners are to close flush.');
  }
  for (const w of walls) for (const n of w.notes) if (!notes.includes(n)) notes.push(n);

  return {
    walls,
    byCut,
    cabinets: powered + regular,
    powered,
    regular,
    fleetCabinets,
    panels: fleetCabinets * CABINET_PANELS,
    // Pooled over the scene, not rounded up per wall: rule I crates 24 cabinets (six posters) into
    // 3, where rounding each poster separately would call for 6.
    crates: Math.ceil(fleetCabinets / CABINETS_PER_CRATE),
    accessorySets,
    equipment,
    notes,
  };
}

/* ───────────────────────────── plain text ───────────────────────────── */

/** Base plates and back supports one accessory set is: the manufacturer's assembly, one per column. */
export const PLATES_PER_SET = 1;
export const SUPPORTS_PER_SET = 2;

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);
const padL = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s;

/**
 * The list as plain text, for pasting into the allocation sheet or an email.
 *
 * Pure, and tested, because this is the artefact that leaves the app: the screen is read once and
 * the paste is what someone pulls gear against.
 */
export function buildListText(list: BuildList, unit: Unit, title?: string): string {
  const L: string[] = [];
  L.push(title ? `BUILD LIST - ${title}` : 'BUILD LIST');
  L.push('');

  if (!list.cabinets && !list.equipment.length) {
    L.push('Nothing in the scene to pull.');
    return L.join('\n');
  }

  if (list.cabinets) {
    L.push(`CABINETS   ${list.cabinets} total - ${list.powered} powered + ${list.regular} regular`);
    for (const kind of CUT_ORDER) {
      const c = list.byCut[kind];
      if (!c.powered && !c.regular) continue;
      L.push(`  ${pad(CUT_LABELS[kind], 12)}${padL(String(c.powered + c.regular), 5)}  (${c.powered} powered + ${c.regular} regular)`);
    }
    if (list.fleetCabinets) L.push(`CRATES     ${list.crates} at ${CABINETS_PER_CRATE} cabinets a crate`);
    if (list.accessorySets) {
      L.push(`ACCESSORY  ${list.accessorySets * PLATES_PER_SET} base plates + ${list.accessorySets * SUPPORTS_PER_SET} back supports`);
    }
    L.push('');
    L.push('WALLS');
    for (const w of list.walls) {
      const cuts = CUT_ORDER.filter(k => k !== 'flat' && (w.byCut[k].powered || w.byCut[k].regular))
        .map(k => `${w.byCut[k].powered + w.byCut[k].regular} ${CUT_LABELS[k].toLowerCase()}`);
      L.push(`  ${pad(w.name, 18)}${pad(`${w.cols} x ${w.rows}${w.sides === 2 ? ', double-sided' : ''}`, 24)}`
        + `${padL(String(w.cabinets), 4)} cabinets (${w.total.powered} powered + ${w.total.regular} regular)`
        + (cuts.length ? ` - ${cuts.join(', ')}` : ''));
    }
  }

  if (list.equipment.length) {
    L.push('');
    L.push('HARDWARE');
    for (const e of list.equipment) {
      L.push(`  ${padL(String(e.qty), 3)}  ${pad(e.name, 30)}${pad(formatDims(e.dims, unit), 22)}`
        + (e.short ? `SHORT ${e.short} (${e.owned ?? 0} owned)` : e.owned !== null ? `${e.owned} owned` : ''));
    }
  }

  if (list.notes.length) {
    L.push('');
    L.push('NOTES');
    for (const n of list.notes) L.push(`  - ${n}`);
  }
  return L.join('\n');
}
