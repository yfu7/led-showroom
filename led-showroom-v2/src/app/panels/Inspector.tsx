/**
 * Inspector router: picks the panel for the current selection.
 *  - nothing selected → SceneInspector
 *  - one entity → the type-specific inspector
 *  - several → "N objects" header, delta transform, bulk actions
 */
import { Copy, Trash2 } from 'lucide-react';
import { useEngine, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import type { Entity } from '@/engine/document/types';
import { duplicateSelection } from '@/app/menus/entityMenu';
import { SceneInspector } from '@/app/panels/SceneInspector';
import { StageInspector, EquipmentInspector, RoomInspector, ModelInspector, SplatInspector, DimensionInspector } from '@/app/panels/EntityInspectors';
import { LedWallInspector } from '@/app/panels/LedWallInspector';
import { TransformSection } from '@/app/panels/TransformSection';
import { SpecsSection } from '@/app/panels/SpecsSection';

export const TYPE_LABELS: Record<Entity['type'], string> = {
  'led-wall': 'LED wall', stage: 'Stage deck', equipment: 'Equipment', model: 'Model', splat: 'Splat', room: 'Venue space', dimension: 'Dimension', group: 'Group',
};

/* Duplicating is `duplicateSelection` (engine `duplicateEntities` + one history entry) for every
   entry point — the panel button, Ctrl+D and the context menu. A private clone loop here used to
   skip descendant expansion and parent remapping, so the button and the key gave different
   results: duplicating a group produced an empty group, and a duplicated child stayed parented
   to the original. */

export function Inspector() {
  const engine = useEngine();
  const selection = useStore(s => s.selection);
  const doc = useStore(s => s.doc);
  const entities = selection.map(id => doc?.entities.find(e => e.id === id)).filter(Boolean) as Entity[];

  if (entities.length === 0) return <SceneInspector />;

  if (entities.length > 1) {
    const counts = new Map<Entity['type'], number>();
    for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const breakdown = Array.from(counts.entries()).map(([t, n]) => `${n} ${TYPE_LABELS[t].toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
    return (
      <>
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 300 }}>{entities.length} objects</div>
          <div className="hint">{breakdown}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <Button size="sm" icon={<Copy size={14} strokeWidth={1.5} />} onClick={() => duplicateSelection(engine, entities.map(e => e.id))}>Duplicate</Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={14} strokeWidth={1.5} />} onClick={() => engine.remove(entities.map(e => e.id))}>Delete</Button>
          </div>
        </div>
        <TransformSection ids={entities.map(e => e.id)} />
      </>
    );
  }

  // `key={e.id}` is load-bearing: inspectors (and ContentPanel under them) keep local draft state
  // — a half-typed URL, a rename in progress, the open source tab. Without the key React reuses
  // the component across a selection change and that draft lands on the next item selected.
  const e = entities[0];
  switch (e.type) {
    case 'led-wall': return <LedWallInspector key={e.id} wall={e} />;
    case 'stage': return <StageInspector key={e.id} entity={e} />;
    case 'equipment': return <EquipmentInspector key={e.id} entity={e} />;
    case 'room': return <RoomInspector key={e.id} entity={e} />;
    case 'model': return <ModelInspector key={e.id} entity={e} />;
    case 'splat': return <SplatInspector key={e.id} entity={e} />;
    case 'dimension': return <DimensionInspector key={e.id} entity={e} />;
    case 'group': return <><TransformSection ids={[e.id]} /><SpecsSection entity={e} /></>;
  }
}
