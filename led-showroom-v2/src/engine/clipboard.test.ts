import { describe, expect, it } from 'vitest';
import { Clipboard, clipboardAnchor, cloneEntities, collectEntities, pasteOffsetFor, PASTE_STEP_IN } from './clipboard';
import { createDocument, createGroup, createLedWall, createStage } from './document/defaults';
import { addEntity } from './document/Document';
import type { Document, Entity } from './document/types';
import type { Vec3 } from './math';

function docWith(...entities: Entity[]): Document {
  let d = createDocument();
  for (const e of entities) d = addEntity(d, e);
  return d;
}

const at = (e: Entity): Vec3 => e.transform.position;

describe('cloneEntities', () => {
  it('gives fresh ids, unique names and the offset', () => {
    const wall = createLedWall({ name: 'LED Wall', cols: 2, rows: 2 });
    wall.transform.position = [10, 0, 20];
    const doc = docWith(wall);
    const { clones, idMap } = cloneEntities(doc, [wall], [5, 0, 7]);
    expect(clones).toHaveLength(1);
    expect(clones[0].id).not.toBe(wall.id);
    expect(idMap.get(wall.id)).toBe(clones[0].id);
    expect(clones[0].name).not.toBe(wall.name);
    expect(at(clones[0])).toEqual([15, 0, 27]);
    // the source document is untouched
    expect(doc.entities).toHaveLength(1);
    expect(at(wall)).toEqual([10, 0, 20]);
  });

  it('re-points parent links at the clones and leaves children un-offset', () => {
    const group = createGroup('Rig');
    const wall = createLedWall({ name: 'LED Wall', cols: 1, rows: 1 });
    wall.parentId = group.id;
    wall.transform.position = [0, 0, 0];
    const doc = docWith(group, wall);
    const { clones } = cloneEntities(doc, [group, wall], [12, 0, 0]);
    const [gc, wc] = clones;
    expect(wc.parentId).toBe(gc.id);
    // the child keeps its parent-relative pose; only the top-level clone moves
    expect(at(wc)).toEqual([0, 0, 0]);
    expect(at(gc)).toEqual([12, 0, 0]);
  });

  it('re-points attachedTo when the support was copied too, and keeps it otherwise', () => {
    const stage = createStage(24, [0, 0, 0]);
    const wall = createLedWall({ name: 'LED Wall', cols: 1, rows: 1 });
    wall.attachedTo = stage.id;
    const doc = docWith(stage, wall);

    const both = cloneEntities(doc, [stage, wall], [0, 0, 0]);
    expect(both.clones[1].attachedTo).toBe(both.clones[0].id);

    const alone = cloneEntities(doc, [wall], [0, 0, 0]);
    expect(alone.clones[0].attachedTo).toBe(stage.id);
  });

  it('clones entities that are no longer in the document (paste after cut)', () => {
    const wall = createLedWall({ name: 'LED Wall', cols: 1, rows: 1 });
    const empty = createDocument();
    const { clones } = cloneEntities(empty, [wall], [0, 0, 0]);
    expect(clones).toHaveLength(1);
    expect(clones[0].id).not.toBe(wall.id);
  });
});

describe('collectEntities', () => {
  it('takes descendants along and deep-clones', () => {
    const group = createGroup('Rig');
    const wall = createLedWall({ name: 'LED Wall', cols: 1, rows: 1 });
    wall.parentId = group.id;
    const doc = docWith(group, wall);
    const taken = collectEntities(doc, [group.id]);
    expect(taken.map(e => e.id).sort()).toEqual([group.id, wall.id].sort());
    taken[0].transform.position = [999, 0, 0];
    expect(at(doc.entities[0])).not.toEqual([999, 0, 0]);
  });

  it('never takes an entity twice when a group and its child are both named', () => {
    const group = createGroup('Rig');
    const wall = createLedWall({ name: 'LED Wall', cols: 1, rows: 1 });
    wall.parentId = group.id;
    const doc = docWith(group, wall);
    expect(collectEntities(doc, [group.id, wall.id])).toHaveLength(2);
  });
});

describe('clipboardAnchor', () => {
  it('is the mean of the top-level positions', () => {
    const a = createStage(24, [0, 0, 0]);
    const b = createStage(24, [40, 0, 20]);
    expect(clipboardAnchor([a, b])).toEqual([20, 0, 10]);
  });

  it('ignores children of copied groups', () => {
    const group = createGroup('Rig');
    group.transform.position = [100, 0, 0];
    const wall = createLedWall({ name: 'LED Wall', cols: 1, rows: 1 });
    wall.parentId = group.id;
    wall.transform.position = [0, 0, 0];
    expect(clipboardAnchor([group, wall])).toEqual([100, 0, 0]);
  });

  it('is the origin for an empty set', () => {
    expect(clipboardAnchor([])).toEqual([0, 0, 0]);
  });
});

describe('pasteOffsetFor', () => {
  it('moves the anchor onto the target point and never changes the height', () => {
    expect(pasteOffsetFor([10, 30, 20], [50, 0, 5], 1)).toEqual([40, 0, -15]);
  });

  it('steps to the right when there is no target point, once per paste', () => {
    expect(pasteOffsetFor([0, 0, 0], undefined, 1)).toEqual([PASTE_STEP_IN, 0, 0]);
    expect(pasteOffsetFor([0, 0, 0], undefined, 3)).toEqual([PASTE_STEP_IN * 3, 0, 0]);
  });
});

describe('Clipboard', () => {
  it('starts empty and reports what it holds', () => {
    const c = new Clipboard();
    expect(c.canPaste).toBe(false);
    expect(c.paste(createDocument()).clones).toHaveLength(0);

    const a = createStage(24, [0, 0, 0]);
    const b = createStage(24, [40, 0, 0]);
    const doc = docWith(a, b);
    expect(c.copy(doc, [a.id, b.id])).toBe(2);
    expect(c.canPaste).toBe(true);
    expect(c.size).toBe(2);
  });

  it('keeps the relative offsets of a multi-entity copy and lands the anchor on the point', () => {
    const a = createStage(24, [0, 0, 0]);
    const b = createStage(24, [40, 0, 0]);
    const doc = docWith(a, b);
    const c = new Clipboard();
    c.copy(doc, [a.id, b.id]);
    const { clones } = c.paste(doc, [100, 0, 100]);
    expect(clones).toHaveLength(2);
    // anchor was (20, ·, 0) → the pair straddles the drop point, 40" apart as before
    expect(at(clones[0])).toEqual([80, 0, 100]);
    expect(at(clones[1])).toEqual([120, 0, 100]);
  });

  it('walks repeated pastes to the right instead of stacking them', () => {
    const a = createStage(24, [0, 0, 0]);
    const doc = docWith(a);
    const c = new Clipboard();
    c.copy(doc, [a.id]);
    expect(at(c.paste(doc).clones[0])).toEqual([PASTE_STEP_IN, 0, 0]);
    expect(at(c.paste(doc).clones[0])).toEqual([PASTE_STEP_IN * 2, 0, 0]);
  });

  it('still pastes after the originals were removed', () => {
    const a = createStage(24, [5, 0, 5]);
    const doc = docWith(a);
    const c = new Clipboard();
    c.copy(doc, [a.id]);
    const after = createDocument();
    const { clones } = c.paste(after, [0, 0, 0]);
    expect(clones).toHaveLength(1);
    expect(at(clones[0])).toEqual([0, 0, 0]);
  });

  it('copying nothing leaves the previous contents alone', () => {
    const a = createStage(24, [0, 0, 0]);
    const doc = docWith(a);
    const c = new Clipboard();
    c.copy(doc, [a.id]);
    expect(c.copy(doc, ['missing'])).toBe(0);
    expect(c.canPaste).toBe(true);
  });
});
