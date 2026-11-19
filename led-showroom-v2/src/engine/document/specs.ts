/**
 * Derived, read-only specifications — for the show canvas and for each item standing on it.
 *
 * This is the bottom third of the inspector architecture: **show canvas → items → each item's
 * specs**. An item's *editable* fields are its own business and sit at the top of its inspector;
 * everything that is merely *computed* from those fields lands here and is rendered identically
 * for every type, at the bottom, by `SpecsSection`.
 *
 * Two properties matter and are the reason this lives in the engine rather than in the panels:
 *
 *  - **Idempotent.** A row set is a pure function of (entity, doc, unit). The same item always
 *    reads the same way no matter which inspector rendered it, how many items are in the scene,
 *    or what was selected before it. Nothing here touches React, three.js or the DOM.
 *  - **Per item.** Specs are derived from the entity passed in and from nothing ambient, so two
 *    walls of the same product can never show each other's numbers.
 */
import type { Document, Entity } from './types';
import type { Vec3 } from '../math';
import { v3dist } from '../math';
import { formatArea, formatDims, formatLength, fromInches, unitDecimals, type Unit } from '../units';
import { filledCount, isRectWall, shapeBBox, filledCells, wallDims } from '../ledwall/layout';
import { brightnessToNits } from '../ledwall/specs';
import { equipmentDef } from '../catalog/equipment';
import { descendants } from './Document';

/** One label/value row. `mono` asks the renderer for tabular digits (coordinates, ids). */
export interface SpecRow {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * Values the panels measure at runtime and the document does not store — an imported model's
 * real bounding box is only known once the file has been parsed, for instance. Passing them in
 * keeps this module pure instead of making it load anything.
 */
export interface SpecExtras {
  /** Measured bounding size of an imported model, in inches. */
  measured?: Vec3 | null;
  /** The measurement is still running. */
  measuring?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * "12.5, 0, -30" in the document's unit — the endpoints of a measurement. Feet keep their
 * ft/in formatting per axis; every other unit prints bare numbers and names the unit once.
 */
function pointText(p: Vec3, unit: Unit): string {
  const d = unitDecimals(unit);
  const body = p.map(v => (unit === 'ft' ? formatLength(v, 'ft') : String(+fromInches(v, unit).toFixed(d)))).join(', ');
  return unit === 'ft' || unit === 'in' ? body : `${body} ${unit}`;
}

/**
 * Every computed row for one item. Order is stable and meaningful: identity first, then size,
 * then the numbers derived from size. An empty array is a legitimate answer (a bare group).
 */
export function entitySpecs(entity: Entity, doc: Document, unit: Unit, extras: SpecExtras = {}): SpecRow[] {
  const rows: SpecRow[] = [];
  const push = (label: string, value: string | null | undefined, mono?: boolean): void => {
    if (value !== null && value !== undefined && value !== '') rows.push(mono ? { label, value, mono } : { label, value });
  };

  switch (entity.type) {
    case 'led-wall': {
      const dims = wallDims(entity);
      const bbox = isRectWall(entity) ? { cols: entity.cols, rows: entity.rows } : shapeBBox(filledCells(entity));
      push('Product', dims.spec.name);
      push('Panels', String(filledCount(entity)));
      push('Grid', `${bbox.cols} × ${bbox.rows}`);
      push('Resolution', `${dims.wallWPx} × ${dims.wallHPx} px`);
      push('Physical size', formatDims([dims.totalW, dims.totalH], unit));
      // The quote is written in feet whatever the working unit is, so always offer it.
      if (unit !== 'ft') push('Size (ft)', formatDims([dims.totalW, dims.totalH], 'ft'));
      push('Screen area', formatArea(dims.totalW * dims.totalH, unit));
      push('Pixel pitch', dims.spec.pitchMm ? `${dims.spec.pitchMm} mm` : `${(dims.inPerPxX * 25.4).toFixed(2)} mm`);
      push('Brightness', `${Math.round(entity.brightness)} % · ${brightnessToNits(entity.brightness, dims.spec)} nits`);
      if (entity.corners.length) push('Folds', plural(entity.corners.length, 'corner'));
      if (entity.contentWindows.length) push('Content', plural(entity.contentWindows.length, 'window'));
      break;
    }
    case 'stage': {
      push('Deck size', formatDims([entity.widthIn, entity.depthIn], unit));
      push('Deck height', formatLength(entity.heightIn, unit));
      push('Top at', formatLength(entity.transform.position[1] + entity.heightIn, unit));
      push('Deck area', formatArea(entity.widthIn * entity.depthIn, unit));
      break;
    }
    case 'equipment': {
      const def = equipmentDef(entity.catalogId);
      push('Catalog', def?.name ?? entity.catalogId);
      push('Size', formatDims([entity.dims[0], entity.dims[1], entity.dims[2]], unit));
      // The manufacturer's published sheet, verbatim — not derived, but it is still read-only
      // reference that belongs beside the derived numbers rather than among the edit controls.
      for (const s of def?.specs ?? []) push(s.label, s.value);
      break;
    }
    case 'model': {
      push('File', entity.fileName);
      push('Format', entity.format.toUpperCase());
      push('Authored in', entity.sourceUnit);
      const measured = extras.measured ?? entity.dims ?? null;
      push('Measured', extras.measuring ? 'Loading…' : measured ? formatDims(measured, unit) : '—');
      if (measured) {
        const s = entity.transform.scale;
        push('Scaled', formatDims([measured[0] * s[0], measured[1] * s[1], measured[2] * s[2]], unit));
      }
      break;
    }
    case 'splat': {
      push('File', entity.fileName);
      push('Format', entity.format.toUpperCase());
      break;
    }
    case 'room': {
      push('Footprint', formatDims([entity.widthIn, entity.depthIn], unit));
      if (unit !== 'ft') push('Footprint (ft)', formatDims([entity.widthIn, entity.depthIn], 'ft'));
      push('Height', formatLength(entity.heightIn, unit));
      push('Floor area', formatArea(entity.widthIn * entity.depthIn, unit));
      push('Walls', entity.outlineWalls ? 'Outlined (footprint + guides)' : 'Solid surfaces');
      break;
    }
    case 'dimension': {
      push('Length', formatLength(v3dist(entity.a, entity.b), unit));
      push('Point A', pointText(entity.a, unit), true);
      push('Point B', pointText(entity.b, unit), true);
      push('Label', entity.label);
      break;
    }
    case 'group': {
      const kids = descendants(doc, entity.id);
      push('Members', plural(kids.length, 'object'));
      break;
    }
  }
  return rows;
}

/** Singular/plural display names, by entity type, for the canvas tally. */
const TYPE_COUNT_LABELS: { type: Entity['type']; one: string; many: string }[] = [
  { type: 'led-wall', one: 'LED wall', many: 'LED walls' },
  { type: 'stage', one: 'Stage deck', many: 'Stage decks' },
  { type: 'equipment', one: 'Equipment item', many: 'Equipment items' },
  { type: 'model', one: 'Model', many: 'Models' },
  { type: 'splat', one: 'Splat', many: 'Splats' },
  { type: 'room', one: 'Venue space', many: 'Venue spaces' },
  { type: 'dimension', one: 'Measurement', many: 'Measurements' },
  { type: 'group', one: 'Group', many: 'Groups' },
];

/**
 * Computed rows for the show canvas itself: what is standing on it, and the totals a proposal
 * quotes. The per-type tally comes first so the canvas reads as a container of items.
 */
export function sceneSpecs(doc: Document, unit: Unit): SpecRow[] {
  const rows: SpecRow[] = [];
  for (const t of TYPE_COUNT_LABELS) {
    const n = doc.entities.filter(e => e.type === t.type).length;
    if (n > 0) rows.push({ label: n === 1 ? t.one : t.many, value: String(n) });
  }

  // LED totals across every wall — the single number a quote is built from.
  let panels = 0, areaSqIn = 0;
  for (const e of doc.entities) {
    if (e.type !== 'led-wall') continue;
    const d = wallDims(e);
    panels += filledCount(e);
    areaSqIn += d.totalW * d.totalH;
  }
  if (panels > 0) {
    rows.push({ label: 'LED panels', value: String(panels) });
    rows.push({ label: 'LED area', value: formatArea(areaSqIn, unit) });
  }

  rows.push({ label: 'Floor', value: formatLength(doc.environment.floor.sizeIn, unit) });
  return rows;
}
