/**
 * Command-level guarantees that keep many items from interfering with each other: an undo has to
 * put back exactly what the `do` took, and a multi-item edit has to touch the document once.
 */
import { describe, expect, it } from 'vitest';
import { cmdRemoveEntities, cmdUpdateEntities, type DocHost } from './entity';
import { createDocument, createGroup, createStage } from '../document/defaults';
import type { Document, Entity, StageEntity } from '../document/types';

/** The whole surface the commands need. Counts `setDoc` calls so array copies are observable. */
function host(entities: Entity[]): DocHost & { setDocCalls: number } {
  const h = {
    doc: { ...createDocument(), entities } as Document,
    setDocCalls: 0,
    setDoc(doc: Document) { h.doc = doc; h.setDocCalls++; },
  };
  return h;
}

const ids = (h: DocHost): string[] => h.doc.entities.map(e => e.id);
const byId = (h: DocHost, id: string): Entity | undefined => h.doc.entities.find(e => e.id === id);

describe('cmdRemoveEntities', () => {
  it('restores the descendants the delete took with it', () => {
    const group = createGroup();
    const child = { ...createStage(24), parentId: group.id };
    const bystander = createStage(12);
    const h = host([group, child, bystander]);

    const cmd = cmdRemoveEntities(h, [group.id]);
    cmd.do();
    expect(ids(h)).toEqual([bystander.id]); // the child went too

    cmd.undo();
    // Both come back, in their original order — undoing a group used to leave its children deleted
    // with no history entry able to bring them back.
    expect(ids(h)).toEqual([group.id, child.id, bystander.id]);
    expect(byId(h, child.id)?.parentId).toBe(group.id);
  });

  it('restores an attachment that the delete had to null out', () => {
    const deck = createStage(24);
    const rider = { ...createStage(12), attachedTo: deck.id };
    const h = host([deck, rider]);

    const cmd = cmdRemoveEntities(h, [deck.id]);
    cmd.do();
    expect((byId(h, rider.id) as StageEntity).attachedTo).toBeNull();
    cmd.undo();
    expect((byId(h, rider.id) as StageEntity).attachedTo).toBe(deck.id);
  });

  it('survives a repeated do/undo cycle (redo re-runs `do`)', () => {
    const group = createGroup();
    const child = { ...createStage(24), parentId: group.id };
    const h = host([group, child]);
    const cmd = cmdRemoveEntities(h, [group.id]);
    for (let i = 0; i < 3; i++) { cmd.do(); expect(ids(h)).toEqual([]); cmd.undo(); expect(ids(h)).toEqual([group.id, child.id]); }
  });
});

describe('cmdUpdateEntities', () => {
  const a = createStage(24), b = createStage(12), c = createStage(6);

  it('patches every target and leaves the rest alone, in one document write', () => {
    const h = host([a, b, c]);
    const cmd = cmdUpdateEntities(h, [{ id: a.id, patch: { name: 'A2' } }, { id: c.id, patch: { name: 'C2' } }]);
    cmd.do();
    expect(h.doc.entities.map(e => e.name)).toEqual(['A2', b.name, 'C2']);
    // One write for k entities: patching through `withEntity` per id copied the whole array k times,
    // which is what made a multi-select gizmo drag quadratic in scene size.
    expect(h.setDocCalls).toBe(1);
  });

  it('applies several patches to the same id in order', () => {
    const h = host([a]);
    cmdUpdateEntities(h, [
      { id: a.id, patch: { name: 'first' } },
      { id: a.id, patch: e => ({ ...e, name: `${e.name}+fn` }) },
      { id: a.id, patch: { locked: true } },
    ]).do();
    expect(byId(h, a.id)?.name).toBe('first+fn');
    expect(byId(h, a.id)?.locked).toBe(true);
  });

  it('ignores ids that are not in the document', () => {
    const h = host([a]);
    cmdUpdateEntities(h, [{ id: 'gone', patch: { name: 'x' } }, { id: a.id, patch: { name: 'ok' } }]).do();
    expect(ids(h)).toEqual([a.id]);
    expect(byId(h, a.id)?.name).toBe('ok');
  });

  it('undo restores every entity it touched and nothing else', () => {
    const h = host([a, b, c]);
    const cmd = cmdUpdateEntities(h, [{ id: a.id, patch: { name: 'A2' } }, { id: b.id, patch: { name: 'B2' } }]);
    cmd.do();
    const untouched = byId(h, c.id);
    cmd.undo();
    expect(h.doc.entities.map(e => e.name)).toEqual([a.name, b.name, c.name]);
    expect(byId(h, c.id)).toBe(untouched); // identity preserved: it was never rewritten
  });
});
