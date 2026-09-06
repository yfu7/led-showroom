import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { LoaderCircle } from 'lucide-react';
import { useStore } from '@/app/store';
import { LengthField } from '@/app/components/NumberField';
import { formatLength, UNITS } from '@/engine/units';
import { isLedWall, type Entity } from '@/engine/document/types';
import { wallDims, filledCount, isRectWall } from '@/engine/ledwall/layout';
import type { Unit } from '@/engine/units';
import type { Engine } from '@/engine/Engine';

const TYPE_LABEL: Record<Entity['type'], string> = {
  'led-wall': 'LED Wall', stage: 'Stage', equipment: 'Equipment', model: 'Model', splat: 'Splat', room: 'Room', dimension: 'Dimension', group: 'Group',
};

function selectionSummary(entities: Entity[], unit: Unit): string {
  if (!entities.length) return 'Nothing selected';
  if (entities.length > 1) return `${entities.length} objects`;
  const e = entities[0];
  if (isLedWall(e)) {
    const d = wallDims(e);
    const grid = isRectWall(e) ? `${e.cols}×${e.rows}` : `${e.cols}×${e.rows} · ${filledCount(e)} panels`;
    return `${TYPE_LABEL[e.type]} · ${grid} · ${formatLength(d.totalW, unit)} × ${formatLength(d.totalH, unit)}`;
  }
  const dims = e.type === 'stage' ? [e.widthIn, e.depthIn, e.heightIn]
    : e.type === 'room' ? [e.widthIn, e.depthIn, e.heightIn]
    : e.type === 'equipment' ? [e.dims[0], e.dims[1], e.dims[2]]
    : e.type === 'model' && e.dims ? [e.dims[0], e.dims[1], e.dims[2]]
    : null;
  return dims ? `${e.name} · ${dims.map(v => formatLength(v, unit)).join(' × ')}` : `${e.name} · ${TYPE_LABEL[e.type]}`;
}

/**
 * Inline distance editor. Focuses once on mount and closes on blur whether or not the text parsed,
 * so the field can always be left. The displayed distance is measured from the selection (an LED
 * wall's face or the bounds centre), so the camera offset from that centre is scaled by
 * requested / current — the readout then settles on the requested value even for oblique views —
 * rather than placing the camera `v` from the orbit target.
 */
function DistanceEditor({ engine, unit, distance, onDone }: { engine: Engine; unit: Unit; distance: number | null; onDone(): void }) {
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => { wrap.current?.querySelector('input')?.focus(); }, []);
  const apply = (v: number) => {
    const cur = distance ?? engine.camera.distanceToTarget();
    const box = engine.boundsOf(engine.selection);
    if (box.isEmpty() || !(cur > 0)) { engine.camera.setDistance(v); return; }
    const c = box.getCenter(new THREE.Vector3());
    const pos = c.clone().add(engine.camera.position.clone().sub(c).multiplyScalar(v / cur));
    engine.camera.moveTo(pos, c);
  };
  return (
    <span
      ref={wrap} style={{ width: 96, display: 'inline-flex' }}
      onKeyDown={e => e.stopPropagation()}
      // LengthField commits on the input's own blur first; close a tick later.
      onBlur={() => { window.setTimeout(onDone, 0); }}
    >
      <LengthField
        inches={distance ?? engine.camera.distanceToTarget()} unit={unit} min={12} max={6000}
        onChange={apply}
        className="sb-dist" title="Inches, feet-and-inches or metric"
      />
    </span>
  );
}

/** Docked footer: tool hint and selection on the left; units, distance, projection, fps on the right. */
export function StatusBar() {
  const engine = useStore(s => s.engine);
  const tool = useStore(s => s.tool);
  const doc = useStore(s => s.doc);
  const selection = useStore(s => s.selection);
  const distance = useStore(s => s.distanceToSelection);
  const projection = useStore(s => s.projection);
  const fps = useStore(s => s.fps);
  const loadingCount = useStore(s => s.loading.size);
  const [, bump] = useState(0);
  const [editDist, setEditDist] = useState(false);

  // Tools re-emit their id when the hint text changes; a tick re-reads `activeTool.hint`.
  useEffect(() => engine?.tools.onChange(() => bump(t => t + 1)), [engine]);

  if (!engine || !doc) return <footer className="statusbar" />;

  const unit = doc.settings.units;
  const hint = engine.tools.activeTool?.hint ?? '';
  const entities = selection.map(id => doc.entities.find(e => e.id === id)).filter(Boolean) as Entity[];
  const unitLong = UNITS.find(u => u.id === unit)?.long ?? unit;

  return (
    <footer className="statusbar">
      <span className="item truncate" style={{ minWidth: 0, flex: '0 1 auto' }} title={tool ?? undefined}>{hint}</span>
      {hint && <span style={{ width: 1, height: 12, background: 'var(--line-strong)' }} />}
      <span className="item v truncate" style={{ minWidth: 0, flex: '0 1 auto' }}>{selectionSummary(entities, unit)}</span>
      <span className="spacer" />
      {loadingCount > 0 && (
        <span className="item" title={`${loadingCount} loading`}>
          <style>{'@keyframes sb-spin{to{transform:rotate(360deg)}}'}</style>
          <LoaderCircle style={{ animation: 'sb-spin 1s linear infinite', color: 'var(--accent-text)' }} />
          Loading
        </span>
      )}
      <span className="item" title={unitLong}>Units <span className="v">{unit}</span></span>
      <span className="item" title="Distance from the camera to the selection's front face — click to set">
        Distance
        {editDist ? (
          <DistanceEditor engine={engine} unit={unit} distance={distance} onDone={() => setEditDist(false)} />
        ) : (
          <button type="button" className="v" style={{ color: 'var(--fg-1)', cursor: 'text' }} onClick={() => setEditDist(true)}>
            {distance !== null ? formatLength(distance, unit) : '—'}
          </button>
        )}
      </span>
      <button type="button" className="item v" style={{ color: 'var(--fg-1)' }} title="Toggle projection (Alt+5)" onClick={() => engine.camera.toggleProjection()}>
        {projection === 'perspective' ? 'Perspective' : 'Orthographic'}
      </button>
      <span className="item" style={{ color: 'var(--fg-3)', minWidth: 44, justifyContent: 'flex-end' }}>
        <span className="num">{Math.round(fps)}</span> fps
      </span>
    </footer>
  );
}
