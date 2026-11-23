/**
 * The drawing sheet's detail: what goes in the schedule column beside the views, the wall tags
 * that tie the schedule to the drawing, and the edges a chain of dimensions runs along. Pure, so
 * every figure the sheet prints is testable without a canvas.
 *
 * Everything printed comes from the document and the catalog: no part, price or rating the
 * document does not hold. A ghost (needed, not held) is counted apart as "to buy".
 */
import type { Document, Entity, LedWallEntity } from '../document/types';
import { equipmentDef } from '../catalog/equipment';
import { filledCount, wallDims } from '../ledwall/layout';
import { hiddenEntityIds } from '../tools/BoxSelect';
import { formatDims, formatLength, UNITS, type Unit } from '../units';

export interface ScheduleRow {
  text: string;
  /** A heading line for one item (a wall's tag and name). */
  strong?: boolean;
  /** A detail line under the item above it. */
  indent?: boolean;
}

export interface ScheduleSection {
  title: string;
  rows: ScheduleRow[];
}

/** The visible walls in document order, each with the tag the sheet prints for it (W1, W2, ...). */
export function wallTags(doc: Document): { wall: LedWallEntity; tag: string }[] {
  const hidden = hiddenEntityIds(doc.entities);
  return doc.entities
    .filter((e): e is LedWallEntity => e.type === 'led-wall' && !hidden.has(e.id))
    .map((wall, i) => ({ wall, tag: `W${i + 1}` }));
}

/** 12345 -> "12,345", without the locale: the sheet reads the same wherever it is made. */
const thousands = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Pixel pitch in mm: the spec's nominal one, or the face width over its pixels. */
export const pitchMmOf = (spec: { pitchMm?: number; widthIn: number; pxW: number }): number =>
  spec.pitchMm ?? (spec.widthIn * 25.4) / Math.max(1, spec.pxW);

/** One line per item of equipment, by catalog part: how many, and how many of those are to buy. */
function equipmentRows(entities: readonly Entity[], unit: Unit): ScheduleRow[] {
  const groups = new Map<string, { name: string; n: number; ghost: number }>();
  const add = (key: string, name: string, ghost: boolean) => {
    const g = groups.get(key) ?? { name, n: 0, ghost: 0 };
    g.n++;
    if (ghost) g.ghost++;
    groups.set(key, g);
  };
  for (const e of entities) {
    if (e.type === 'equipment') add(`eq:${e.catalogId}`, equipmentDef(e.catalogId)?.name ?? e.name, !!e.ghost);
    else if (e.type === 'stage') add(`st:${e.widthIn}|${e.depthIn}|${e.heightIn}`, `Stage ${formatDims([e.widthIn, e.depthIn, e.heightIn], unit)}`, false);
    else if (e.type === 'model') add(`md:${e.name}`, e.name || 'Imported model', false);
  }
  return [...groups.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map(g => ({ text: `${g.n} × ${g.name}${g.ghost ? ` (${g.ghost} to buy)` : ''}` }));
}

/**
 * The schedule column: each wall's panel, array, size, pixels and weight; the equipment by part;
 * and the notes that hold for this document.
 */
export function sheetSchedule(doc: Document, unit: Unit, opts: { isoNts?: boolean } = {}): ScheduleSection[] {
  const sections: ScheduleSection[] = [];
  const hidden = hiddenEntityIds(doc.entities);
  const shown = doc.entities.filter(e => !hidden.has(e.id));
  const tags = wallTags(doc);

  if (tags.length) {
    const rows: ScheduleRow[] = [];
    let panels = 0, lb = 0, weighed = true;
    for (const { wall, tag } of tags) {
      const d = wallDims(wall);
      const n = filledCount(wall);
      panels += n;
      rows.push({ text: `${tag}  ${wall.name || 'LED wall'}`, strong: true });
      rows.push({ text: `${d.spec.name} · ${pitchMmOf(d.spec).toFixed(2)} mm`, indent: true });
      rows.push({ text: `${d.cols} × ${d.rows} array · ${n} panels`, indent: true });
      rows.push({ text: `${formatDims([d.totalW, d.totalH], unit)} · ${d.wallWPx} × ${d.wallHPx} px`, indent: true });
      if (d.spec.weightLb) {
        lb += n * d.spec.weightLb;
        rows.push({ text: `${thousands(n * d.spec.weightLb)} lb`, indent: true });
      } else weighed = false;
    }
    rows.push({ text: `TOTAL  ${panels} panels${weighed && lb ? ` · ${thousands(lb)} lb` : ''}`, strong: true });
    sections.push({ title: 'LED WALL SCHEDULE', rows });
  }

  const equipment = equipmentRows(shown, unit);
  if (equipment.length) sections.push({ title: 'EQUIPMENT', rows: equipment });

  const notes: string[] = [];
  notes.push(`Dimensions in ${(UNITS.find(u => u.id === unit)?.long ?? unit).toLowerCase()}.`);
  if (tags.length) notes.push('Heights marked + are above the floor. Tags W1... match the schedule.');
  if (opts.isoNts) notes.push('The isometric view is not to scale.');
  const mounts = new Map<string, string>();
  for (const { wall } of tags) {
    const spec = wallDims(wall).spec;
    if (spec.mount && !mounts.has(spec.id)) {
      mounts.set(spec.id, `${spec.name} cabinets hang from ${spec.mount.bolt} holes in the back face corners, each hole starting ${formatLength(spec.mount.holeInsetIn, unit)} in from the edges.`);
    }
  }
  notes.push(...mounts.values());
  const systems = new Set(shown.flatMap(e => (e.type === 'equipment' ? [equipmentDef(e.catalogId)?.trussSystem] : [])).filter(Boolean));
  if (systems.has('DT-GP') && systems.has('F34')) notes.push('DT-GP and F34 truss do not connect: no part of one joins the other.');
  if (shown.some(e => e.type === 'equipment' && e.ghost)) notes.push('Parts marked "to buy" are needed but not held.');
  sections.push({ title: 'NOTES', rows: notes.map((t, i) => ({ text: `${i + 1}. ${t}` })) });
  return sections;
}

/**
 * The edges a chain of dimensions runs along: every span's two ends, sorted, with ends closer than
 * `tol` merged so two walls that butt read as one edge rather than a sliver.
 */
export function chainEdges(spans: readonly (readonly [number, number])[], tol = 0.5): number[] {
  const all = spans.flatMap(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of all) if (!out.length || x - out[out.length - 1] > tol) out.push(x);
  return out;
}

/** The distinct heights in `ys`, ends closer than `tol` merged, lowest first. */
export const levels = (ys: readonly number[], tol = 0.5): number[] => chainEdges(ys.map(y => [y, y] as const), tol);

/** Border zones: about one every two inches of border, at least two each way. */
export function zoneCounts(wIn: number, hIn: number): { cols: number; rows: number } {
  return { cols: Math.max(2, Math.round(wIn / 2)), rows: Math.max(2, Math.round(hIn / 2)) };
}
