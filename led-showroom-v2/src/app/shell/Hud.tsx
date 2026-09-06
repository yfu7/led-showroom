/**
 * Compact viewport readout (top-left). At most five lines about the primary selection — a wall's
 * grid, resolution and physical size, the selected content window, position, rotation and the
 * camera's distance to the screen face (v1 dist meter, 3665-3680). With nothing selected it
 * summarises the scene.
 */
import { useDoc, usePrimarySelection, useStore } from '@/app/store';
import { isEquipment, isLedWall, isModel, isRoom, isStage, type Entity } from '@/engine/document/types';
import { filledCount, isRectWall, wallDims } from '@/engine/ledwall/layout';
import { rectInches } from '@/engine/ledwall/contentWindows';
import { formatLength, type Unit } from '@/engine/units';

interface Line { k: string; v: string }

/** One decimal for inches (v1 readout), the unit default otherwise. */
function len(inches: number, unit: Unit): string {
  return formatLength(inches, unit, unit === 'in' ? { decimals: 1 } : {});
}

function dims(values: number[], unit: Unit): string {
  return values.map(v => len(v, unit)).join(' × ');
}

function entityDims(e: Entity, unit: Unit): string | null {
  if (isStage(e)) return dims([e.widthIn, e.depthIn, e.heightIn], unit);
  if (isEquipment(e)) return dims(e.dims, unit);
  if (isRoom(e)) return dims([e.widthIn, e.heightIn, e.depthIn], unit);
  if (isModel(e)) return e.dims ? dims(e.dims, unit) : null;
  return null;
}

const TYPE_LABEL: Record<Entity['type'], string> = {
  'led-wall': 'Wall', stage: 'Stage', equipment: 'Equipment', model: 'Model', splat: 'Splat', room: 'Room', dimension: 'Dimension', group: 'Group',
};

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function Hud() {
  const doc = useDoc();
  const entity = usePrimarySelection();
  const distance = useStore(s => s.distanceToSelection);
  const windowId = useStore(s => (entity ? s.selectedWindowByWall[entity.id] ?? null : null));
  const unit = doc.settings.units;

  const lines: Line[] = [];

  if (!entity) {
    const walls = doc.entities.filter(e => e.type === 'led-wall').length;
    const stages = doc.entities.filter(e => e.type === 'stage').length;
    const others = doc.entities.length - walls - stages;
    lines.push({ k: 'Scene', v: doc.name });
    lines.push({ k: 'Contents', v: [plural(walls, 'wall'), stages ? plural(stages, 'stage') : null, others ? plural(others, 'item') : null].filter(Boolean).join(' · ') });
  } else if (isLedWall(entity)) {
    const d = wallDims(entity);
    const panels = isRectWall(entity) ? `${entity.cols}×${entity.rows}` : `${filledCount(entity)} panels in ${entity.cols}×${entity.rows}`;
    lines.push({ k: 'Wall', v: `${panels} · ${d.wallWPx}×${d.wallHPx} px · ${dims([d.totalW, d.totalH], unit)}` });
    const win = windowId ? entity.contentWindows.find(w => w.id === windowId) : undefined;
    if (win) {
      const r = rectInches(win.rect, d);
      lines.push({ k: 'Window', v: `${Math.round(win.rect.w)}×${Math.round(win.rect.h)} px (${dims([r.w, r.h], unit)})` });
    }
    const [x, y, z] = entity.transform.position;
    lines.push({ k: 'Position', v: `${len(x, unit)}, ${len(y, unit)}, ${len(z, unit)}` });
    lines.push({ k: 'Rotation', v: `${entity.transform.rotation[1].toFixed(1)}°` });
    lines.push({ k: 'Distance', v: distance === null ? '—' : `${len(distance, unit)} to face` });
  } else {
    lines.push({ k: TYPE_LABEL[entity.type], v: entity.name });
    const size = entityDims(entity, unit);
    if (size) lines.push({ k: 'Size', v: size });
    const [x, y, z] = entity.transform.position;
    lines.push({ k: 'Position', v: `${len(x, unit)}, ${len(y, unit)}, ${len(z, unit)}` });
    lines.push({ k: 'Rotation', v: `${entity.transform.rotation[1].toFixed(1)}°` });
    if (distance !== null) lines.push({ k: 'Distance', v: len(distance, unit) });
  }

  // No live region while a selection exists: the distance line updates ~10 Hz while orbiting and
  // would be announced on every change. The scene summary changes only on edits, so it may be a status.
  return (
    <div className="hud vp-corner-tl" role={entity ? undefined : 'status'}>
      {lines.slice(0, 5).map(l => (
        <div key={l.k} className="hud-line">
          <span className="k">{l.k}</span>
          <span className="v truncate">{l.v}</span>
        </div>
      ))}
    </div>
  );
}
