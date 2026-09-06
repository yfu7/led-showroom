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
import { cmdAddEntities } from '@/engine/commands/entity';
import { cloneEntity, uniqueName } from '@/engine/document/Document';
import { newId } from '@/engine/ids';
import { SceneInspector } from '@/app/panels/SceneInspector';
import { StageInspector, EquipmentInspector, RoomInspector, ModelInspector, SplatInspector, DimensionInspector } from '@/app/panels/EntityInspectors';
import { LedWallInspector } from '@/app/panels/LedWallInspector';
import { TransformSection } from '@/app/panels/TransformSection';

const ID_PREFIX: Record<Entity['type'], string> = {
  'led-wall': 'wall', stage: 'stage', equipment: 'eq', model: 'model', splat: 'splat', room: 'room', dimension: 'dim', group: 'grp',
};

export const TYPE_LABELS: Record<Entity['type'], string> = {
  'led-wall': 'LED wall', stage: 'Stage deck', equipment: 'Equipment', model: 'Model', splat: 'Splat', room: 'Venue space', dimension: 'Dimension', group: 'Group',
};

/** Duplicate entities side by side (offset +24 in on x) and select the copies. */
export function duplicateEntities(engine: ReturnType<typeof useEngine>, entities: Entity[]): void {
  if (!entities.length) return;
  let doc = engine.doc;
  const copies = entities.map(e => {
    const c = cloneEntity(e);
    c.id = newId(ID_PREFIX[e.type]);
    c.name = uniqueName(doc, e.name.replace(/ \d+$/, ''));
    c.transform = { ...c.transform, position: [c.transform.position[0] + 24, c.transform.position[1], c.transform.position[2]] };
    doc = { ...doc, entities: [...doc.entities, c] };
    return c;
  });
  engine.run(cmdAddEntities(engine, copies, copies.length === 1 ? `Duplicate ${entities[0].name}` : `Duplicate ${copies.length} objects`));
  engine.select(copies.map(c => c.id));
}

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
            <Button size="sm" icon={<Copy size={14} strokeWidth={1.5} />} onClick={() => duplicateEntities(engine, entities)}>Duplicate</Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={14} strokeWidth={1.5} />} onClick={() => engine.remove(entities.map(e => e.id))}>Delete</Button>
          </div>
        </div>
        <TransformSection ids={entities.map(e => e.id)} />
      </>
    );
  }

  const e = entities[0];
  switch (e.type) {
    case 'led-wall': return <LedWallInspector wall={e} />;
    case 'stage': return <StageInspector entity={e} />;
    case 'equipment': return <EquipmentInspector entity={e} />;
    case 'room': return <RoomInspector entity={e} />;
    case 'model': return <ModelInspector entity={e} />;
    case 'splat': return <SplatInspector entity={e} />;
    case 'dimension': return <DimensionInspector entity={e} />;
    case 'group': return <TransformSection ids={[e.id]} />;
  }
}
