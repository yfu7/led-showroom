import { describe, expect, it } from 'vitest';
import { createDocument, createEquipment, createLedWall, createStage } from '../document/defaults';
import type { Document, EquipmentEntity, LedWallEntity, StageEntity } from '../document/types';
import type { Vec3 } from '../math';
import {
  CABINETS_PER_CRATE, STAGE_DECK_ID, buildList, buildListText, wallBuild,
} from './buildList';

/**
 * The expected numbers here are the allocation sheet's, not this module's.
 *
 * Every count asserted below is written down in "LED Alloc 2026 - Rules & Assumptions": the 5x4 and
 * 9x5 walls of rule 3b, the poster and double-sided poster of rule 3, the 8-to-a-crate figure of
 * rules 7 and I, and the whole money20/20 order of rule C. A test written by reading
 * `buildList.ts` back would only agree with the code about the wrong answer.
 */

const docWith = (...entities: (LedWallEntity | EquipmentEntity | StageEntity)[]): Document => ({
  ...createDocument(),
  entities: [...entities],
});

/** An 8 ft GP stick, placed with whatever dimension order the caller wants. */
const stick = (dims: Vec3): EquipmentEntity => createEquipment({
  id: 'gp-truss-8ft', name: 'DT-GP8 box truss 8 ft', geometry: 'truss', dims, color: '#17181b',
});

/** A poster: one column, four rows (rule 3). */
const poster = (doubleSided = false): LedWallEntity => {
  const w = createLedWall({ cols: 1, rows: 4 });
  w.doubleSided = doubleSided;
  return w;
};

/**
 * The money20/20 "V", as rule 3b describes it: "4 flat + Left + Right + Double columns x 6 rows",
 * which rule C's line calls a "7 by 6 V-Shaped".
 *
 * Two ADJACENT folds are what put a Double on the list at all - a single fold gives one Right and
 * one Left and no column cut at both ends - so that is the only arrangement of a seven-column
 * wall that yields the 4 / 1 / 1 / 1 split the sheet states.
 */
const vWall = (angle = 90): LedWallEntity => {
  const w = createLedWall({ cols: 7, rows: 6 });
  w.corners = [{ afterCol: 2, angle }, { afterCol: 3, angle }];
  return w;
};

describe('wallBuild', () => {
  it('gives every column one powered cabinet and the rest regular', () => {
    // Rule 3b, verbatim from the sheet: "5 by 4 wall: 5 powered cabinets, 15 cabinets".
    const w = wallBuild(createLedWall({ cols: 5, rows: 4 }));

    expect(w.total).toEqual({ powered: 5, regular: 15 });
    expect(w.cabinets).toBe(20);
    expect(w.byCut.flat).toEqual({ powered: 5, regular: 15 });
    expect(w.sides).toBe(1);
  });

  it('scales that to the sheet\'s larger worked example', () => {
    // "9 by 5 wall: 9 powered, 36 regular".
    expect(wallBuild(createLedWall({ cols: 9, rows: 5 })).total).toEqual({ powered: 9, regular: 36 });
  });

  it('counts a poster as four cabinets, one of them powered', () => {
    expect(wallBuild(poster()).total).toEqual({ powered: 1, regular: 3 });
  });

  it('doubles both halves of a double-sided build, and only those', () => {
    // Rule 3: a double-sided poster is 8 cabinets, 2 powered + 6 regular. Two faces, one grid, so
    // the powered count doubles with the rest - and the accessories do not, because there is still
    // only one base under it.
    const w = poster(true);
    w.accessories = true;
    const built = wallBuild(w);

    expect(built.sides).toBe(2);
    expect(built.total).toEqual({ powered: 2, regular: 6 });
    expect(built.cabinets).toBe(8);
    expect(built.accessorySets).toBe(1);
    expect(built.notes.join(' ')).toContain('Double-sided');
  });

  it('mitres the columns either side of a fold, and both ends of a column folded twice', () => {
    // Rule 6. Folds after columns 2 and 3 put a cut on the right of column 2, both ends of column
    // 3, and the left of column 4. The other four columns are untouched.
    const built = wallBuild(vWall());

    expect(built.columns.map(c => c.cut)).toEqual([
      'flat', 'flat', 'right', 'double', 'left', 'flat', 'flat',
    ]);
    expect(built.byCut.flat).toEqual({ powered: 4, regular: 20 });
    expect(built.byCut.left).toEqual({ powered: 1, regular: 5 });
    expect(built.byCut.right).toEqual({ powered: 1, regular: 5 });
    expect(built.byCut.double).toEqual({ powered: 1, regular: 5 });
    expect(built.total).toEqual({ powered: 7, regular: 35 });
    // The powered cabinet of a cut column is itself cut: rule 3b's "of its own cut". None of the
    // seven powered cabinets fell back into the flat pool.
    expect(built.byCut.flat.powered + built.byCut.left.powered
      + built.byCut.right.powered + built.byCut.double.powered).toBe(7);
  });

  it('records the fold angle on the end it belongs to', () => {
    const cols = wallBuild(vWall(120)).columns;

    expect(cols[2]?.rightDeg).toBe(120);
    expect(cols[3]?.leftDeg).toBe(120);
    expect(cols[3]?.rightDeg).toBe(120);
    expect(cols[4]?.leftDeg).toBe(120);
    expect(cols[0]?.leftDeg).toBeNull();
    expect(cols[6]?.rightDeg).toBeNull();
  });

  it('cuts a cabinet the same whichever way the wall folds', () => {
    // A concave fold mitres its cabinets exactly as a convex one does - the cut is 45 degrees off
    // the end of the cabinet either way. Rule 6's "convex" names the kind of build it is talking
    // about, not the direction of each joint. If these two ever disagree, a sign test has crept
    // back into the counting.
    const out = wallBuild(vWall(90));
    const back = wallBuild(vWall(-90));

    expect(back.columns.map(c => c.cut)).toEqual(out.columns.map(c => c.cut));
    expect(back.byCut).toEqual(out.byCut);
  });

  it('asks for nothing for a column a custom shape has emptied', () => {
    // Rule 3b gives a powered cabinet to a COLUMN. A gap in the middle of a custom shape is not a
    // column, so it gets neither a powered cabinet nor an accessory set.
    const w = createLedWall({ cols: 3, rows: 2 });
    w.shape = { mode: 'custom', cells: ['0,0', '0,1', '2,0', '2,1'] };
    w.accessories = true;
    const built = wallBuild(w);

    expect(built.columns.map(c => c.cells)).toEqual([2, 0, 2]);
    expect(built.total).toEqual({ powered: 2, regular: 2 });
    expect(built.accessorySets).toBe(2);
  });

  it('counts no accessories for a wall that is not standing on them', () => {
    const w = createLedWall({ cols: 4, rows: 3 });
    expect(w.accessories).toBe(false);          // a hung or trussed wall
    expect(wallBuild(w).accessorySets).toBe(0);
  });

  it('counts an unknown product by its shape and says it did', () => {
    const w = createLedWall({ cols: 2, rows: 2 });
    w.product = 'some-other-cabinet';
    const built = wallBuild(w);

    expect(built.total).toEqual({ powered: 2, regular: 2 });
    expect(built.fleet).toBe(false);
    expect(built.notes.join(' ')).toContain('Unknown product');
  });

  it('warns that a ring\'s closing joint is not modelled', () => {
    // Rule H's cubes want four Double-cut columns. The joint between the last column and the first
    // is not in `corners`, so the count cannot see it - better said than silently wrong.
    const w = createLedWall({ cols: 4, rows: 2 });
    w.corners = [{ afterCol: 0, angle: 90 }, { afterCol: 1, angle: 90 }, { afterCol: 2, angle: 90 }];
    const built = wallBuild(w);

    expect(built.columns.map(c => c.cut)).toEqual(['right', 'double', 'double', 'left']);
    expect(built.notes.join(' ')).toContain('between the last column and the first is not modelled');
  });
});

describe('buildList', () => {
  it('crates eight cabinets at a time, pooled over the whole scene', () => {
    // Rule I: "Shoptalk -> CAIS 3 crates = 24 cabinets". Six posters are 24 cabinets, which is 3
    // crates - not 6, which is what rounding each poster up on its own would give.
    const list = buildList(docWith(poster(), poster(), poster(), poster(), poster(), poster()));

    expect(list.cabinets).toBe(24);
    expect(list.fleetCabinets).toBe(24);
    expect(list.crates).toBe(3);
    expect(CABINETS_PER_CRATE).toBe(8);
  });

  it('rounds the last crate up', () => {
    const list = buildList(docWith(createLedWall({ cols: 3, rows: 3 })));
    expect(list.cabinets).toBe(9);
    expect(list.crates).toBe(2);
  });

  it('counts the money20/20 order', () => {
    // Rule C, the largest order on the sheet, quoting its own line: "Money2020 - 6 7 by 6 V-Shaped,
    // 20 Posters, 30 Double Sided Posters", worked out there as
    //   104 powered flat  (6 V-walls x 4 + 20 posters x 1 + 30 double-sided x 2)
    //   360 regular flat  (6 x 20 + 20 x 3 + 30 x 6)
    //   6 / 6 / 6 powered and 30 / 30 / 30 regular Left / Right / Double = 572 cabinets
    // The crate count is not on that line: it follows from the 8-to-a-crate figure of rules 7 / I.
    const scene: LedWallEntity[] = [];
    for (let i = 0; i < 6; i++) scene.push(vWall());
    for (let i = 0; i < 20; i++) scene.push(poster());
    for (let i = 0; i < 30; i++) scene.push(poster(true));
    const list = buildList(docWith(...scene));

    expect(list.byCut.flat).toEqual({ powered: 104, regular: 360 });
    expect(list.byCut.left).toEqual({ powered: 6, regular: 30 });
    expect(list.byCut.right).toEqual({ powered: 6, regular: 30 });
    expect(list.byCut.double).toEqual({ powered: 6, regular: 30 });
    expect(list.cabinets).toBe(572);
    expect(list.powered).toBe(122);
    expect(list.regular).toBe(450);
    expect(list.crates).toBe(72);               // 572 / 8 = 71.5
    expect(list.walls).toHaveLength(56);
  });

  it('keeps the panel figure off the list and in the diagnostics', () => {
    // Rule 5. Six panels to a cabinet, so a list that said "panels" would pull six times too much.
    // The figure is still worth reporting, where it cannot be mistaken for a pull quantity.
    const list = buildList(docWith(poster()));
    expect(list.cabinets).toBe(4);
    expect(list.panels).toBe(24);
  });

  it('leaves a product the ratios are not recorded for out of the crate count', () => {
    const odd = createLedWall({ cols: 2, rows: 2 });
    odd.product = 'some-other-cabinet';
    const list = buildList(docWith(poster(), odd));

    expect(list.cabinets).toBe(8);              // the shape still counts
    expect(list.fleetCabinets).toBe(4);         // only the poster
    expect(list.crates).toBe(1);
    expect(list.panels).toBe(24);
  });

  it('says that a mitred corner could be butted with flats instead', () => {
    // Rule K: the HubSpot U-wall took no corner cabinets. So cut counts are what the fold implies,
    // not what the build must use.
    expect(buildList(docWith(vWall())).notes.join(' ')).toContain('butted with flat cabinets');
    expect(buildList(docWith(poster())).notes.join(' ')).not.toContain('butted with flat cabinets');
  });

  it('is empty for an empty scene', () => {
    const list = buildList(createDocument());
    expect(list).toMatchObject({ cabinets: 0, powered: 0, regular: 0, crates: 0, panels: 0 });
    expect(list.walls).toEqual([]);
    expect(list.equipment).toEqual([]);
    expect(list.notes).toEqual([]);
  });

  it('pulls one stick whichever way round it is standing', () => {
    // The same 8 ft GP, lying down as the catalog gives it and stood on end in a tower. One part,
    // one line, four of them - and three in stock, so the build is one short.
    const list = buildList(docWith(
      stick([96, 11.16, 11.16]), stick([96, 11.16, 11.16]),
      stick([11.16, 96, 11.16]), stick([11.16, 11.16, 96]),
    ));

    expect(list.equipment).toHaveLength(1);
    expect(list.equipment[0]).toMatchObject({
      catalogId: 'gp-truss-8ft', name: 'DT-GP8 box truss 8 ft', qty: 4, owned: 3, short: 1,
    });
  });

  it('counts ghosts as parts the build still needs', () => {
    // What the auto truss draws past our stock: three real 8 ft sticks and two ghosts is five
    // wanted, two short, and the line says the two are the ghosts.
    const ghost = (): EquipmentEntity => ({ ...stick([96, 11.16, 11.16]), ghost: true });
    const list = buildList(docWith(
      stick([96, 11.16, 11.16]), stick([96, 11.16, 11.16]), stick([11.16, 96, 11.16]), ghost(), ghost(),
    ));

    expect(list.equipment).toHaveLength(1);
    expect(list.equipment[0]).toMatchObject({ qty: 5, owned: 3, short: 2, ghosts: 2 });
    expect(buildListText(list, 'in')).toContain('SHORT 2 (3 owned, 2 drawn as ghosts)');
  });

  it('keeps genuinely different sizes apart', () => {
    const list = buildList(docWith(stick([96, 11.16, 11.16]), stick([60, 11.16, 11.16])));
    expect(list.equipment).toHaveLength(2);
    expect(list.equipment.map(l => l.qty)).toEqual([1, 1]);
  });

  it('reports no shortfall for a part the catalog does not say we own', () => {
    // A generic prop has no `Owned` row. That is not stock, and it is not zero stock either, so the
    // line carries no shortfall rather than a false one.
    const list = buildList(docWith(createEquipment({
      id: 'truss-12-8ft', name: 'Box truss 12" x 8 ft', geometry: 'truss',
      dims: [96, 12, 12], color: '#b9bcc2',
    })));

    expect(list.equipment[0]?.owned).toBeNull();
    expect(list.equipment[0]?.short).toBe(0);
  });

  it('flags a part we were quoted but never ordered as short', () => {
    // The F34 6-way block is on an estimate and on none of our sales orders: we hold none.
    const list = buildList(docWith(createEquipment({
      id: 'f34-block-6way', name: 'F34 6-way junction block', geometry: 'truss-block',
      dims: [22, 22, 22], color: '#17181b',
    })));

    expect(list.equipment[0]).toMatchObject({ catalogId: 'f34-block-6way', qty: 1, owned: 0, short: 1 });
  });

  it('lists stage decks as hardware, one line per size', () => {
    // Two 4 x 4 ft decks, a 4 x 8 ft deck placed both ways round, and a 4 x 4 ft deck on shorter
    // legs: three sizes. Turning a deck does not make it a different deck; lowering it does.
    const deck = (w: number, h: number, d: number): StageEntity => ({ ...createStage(h), widthIn: w, depthIn: d });
    const list = buildList(docWith(
      deck(48, 24, 48), deck(48, 24, 48), deck(96, 24, 48), deck(48, 24, 96), deck(48, 12, 48),
    ));

    expect(list.equipment).toHaveLength(3);
    const line = (dims: [number, number, number]) => list.equipment.find(l => l.dims.join() === dims.join());
    expect(line([48, 24, 48])).toMatchObject({ catalogId: STAGE_DECK_ID, name: 'Stage deck', qty: 2 });
    expect(line([96, 24, 48])).toMatchObject({ qty: 2 });
    expect(line([48, 12, 48])).toMatchObject({ qty: 1 });
    // No deck stock is recorded: no owned figure, so no false shortfall.
    for (const l of list.equipment) expect([l.owned, l.short, l.ghosts]).toEqual([null, 0, 0]);
    expect(list.cabinets).toBe(0);
  });

  it('sorts decks in with the rest of the hardware, most first', () => {
    const list = buildList(docWith(createStage(24), stick([96, 11.16, 11.16]), stick([96, 11.16, 11.16])));
    expect(list.equipment.map(l => [l.catalogId, l.qty])).toEqual([['gp-truss-8ft', 2], [STAGE_DECK_ID, 1]]);
  });
});

describe('buildListText', () => {
  it('writes the totals, the walls, the hardware and the notes', () => {
    const w = createLedWall({ cols: 5, rows: 4, name: 'Main wall' });
    w.accessories = true;
    const list = buildList(docWith(w, stick([96, 11.16, 11.16])));
    const text = buildListText(list, 'ft', 'Money20/20');

    expect(text).toContain('BUILD LIST - Money20/20');
    expect(text).toContain('CABINETS   20 total - 5 powered + 15 regular');
    expect(text).toContain('CRATES     3 at 8 cabinets a crate');
    expect(text).toContain('5 base plates + 10 back supports');
    expect(text).toContain('Main wall');
    expect(text).toContain('20 cabinets (5 powered + 15 regular)');
    expect(text).toContain('DT-GP8 box truss 8 ft');
    expect(text).toContain('3 owned');
    // Only the cuts that are actually in the order get a line.
    expect(text).toContain('Flat');
    expect(text).not.toContain('Double cut');
  });

  it('names the cut pools and the shortfall when there are any', () => {
    const text = buildListText(buildList(docWith(vWall(), stick([96, 11.16, 11.16]),
      stick([96, 11.16, 11.16]), stick([96, 11.16, 11.16]), stick([96, 11.16, 11.16]))), 'in');

    expect(text).toContain('Left cut');
    expect(text).toContain('Right cut');
    expect(text).toContain('Double cut      6  (1 powered + 5 regular)');
    expect(text).toContain('SHORT 1 (3 owned)');
    expect(text).toContain('NOTES');
  });

  it('writes a scene of nothing but a deck as one hardware line, with no owned figure', () => {
    const text = buildListText(buildList(docWith(createStage(24))), 'in');
    expect(text).not.toContain('Nothing in the scene to pull.');
    expect(text).not.toContain('CABINETS');
    const deckLine = text.split('\n').find(l => l.includes('Stage deck'));
    expect(deckLine).toMatch(/^ {2,}1 {2}Stage deck/);
    expect(deckLine).not.toContain('owned');
  });

  it('says so plainly when there is nothing to pull', () => {
    expect(buildListText(buildList(createDocument()), 'in')).toContain('Nothing in the scene to pull.');
  });
});
