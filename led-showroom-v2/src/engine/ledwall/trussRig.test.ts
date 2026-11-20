import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { worldMatrix } from '../behaviours';
import { equipmentDef, ownedCount } from '../catalog/equipment';
import {
  chordOffsetIn, chordRadiusIn, clampMetrics, clearOfBraceNodes, trussBaseProfile,
} from '../catalog/trussMetrics';
import { createDocument, createEquipment, createLedWall, createStage } from '../document/defaults';
import type {
  Document, Entity, EquipmentEntity, GroupEntity, LedWallEntity, StageEntity,
} from '../document/types';
import {
  columnLocalToWall, computeColumnLayout, computeSegments, filledCells, wallDims, wallMountPoints,
} from './layout';
import { IPOSTER } from './specs';
import { applyTrussRig, planTrussRig, rigEntityIds, RIG_GROUP_NAME, SHIM_MAX_IN } from './trussRig';

/**
 * Reference numbers for an iPoster wall, worked out by hand from the panel spec and the order.
 *
 * Deliberately NOT read back from the planner's own frame maths: a test that asks the planner where
 * it put a coupler, in the frame the planner chose, passes just as happily with a missing lift or an
 * inverted normal. These are the numbers the spec comment and the catalog state.
 */
const PW = 25.2, PH = 18.9, PD = 1.77;        // iPoster, inches
const GAP = 0.06;                             // between cabinets with their bezels on (the default)
const STEP = PW + GAP, PITCH = PH + GAP;      // column and row pitch
const HX = 11.40315;                          // hole centre, in from each side edge of the face
const HY = 8.25315;                           // hole centre, up/down from the face centre
const LOW = PH / 2 - HY, HIGH = PH / 2 + HY;  // a row's two hole heights above its bottom edge
const SECTION = 11.16;                        // DT-GP section
const R = 25 / 25.4;                          // DT-GP chord: a 50 mm tube
const CO = SECTION / 2 - R;                   // a leg's axis to its chords
const REACH = 1.96875;                        // 8002 bolt face to the chord axis in its jaw
const JAW_HALF = 1.26 / 2;                    // 8002 jaw, each way along the chord
const PLATE = 1.5;                            // DT-GP base: a plate on the floor, nothing standing on it
const LEG_Z = -PD / 2 - REACH - CO;           // a leg's axis, behind a wall at the origin
const BASE_ID = 'gp-base-36';

type Placed = LedWallEntity | EquipmentEntity | GroupEntity | StageEntity;
const docWith = (...entities: Placed[]): Document => ({ ...createDocument(), entities: [...entities] });
const byIdOf = (doc: Document): Map<string, Entity> => new Map(doc.entities.map(e => [e.id, e]));
const wallOf = (doc: Document, id: string): LedWallEntity => doc.entities.find(e => e.id === id) as LedWallEntity;
const equipmentOf = (doc: Document): EquipmentEntity[] =>
  doc.entities.filter((e): e is EquipmentEntity => e.type === 'equipment');
const rigOf = (doc: Document, wallId: string): EquipmentEntity[] => {
  const ids = rigEntityIds(doc, wallId);
  return equipmentOf(doc).filter(e => ids.has(e.id));
};
const isTruss = (e: EquipmentEntity): boolean =>
  e.geometry === 'truss' || e.geometry === 'truss-vertical' || e.geometry === 'truss-base' || e.geometry === 'truss-block';

/** A local point of a placed entity in world space, through the transform the renderer uses. */
const at = (doc: Document, e: Entity, lx: number, ly: number, lz: number): THREE.Vector3 =>
  new THREE.Vector3(lx, ly, lz).applyMatrix4(worldMatrix(e, byIdOf(doc)));

/** Where the bolt sits on a coupler: the back face of its plate, half way up. See `buildClamp`. */
const boltOf = (doc: Document, c: EquipmentEntity): THREE.Vector3 => at(doc, c, 0, c.dims[1] / 2, -c.dims[2] / 2);

/** Where the gripped chord runs: the axis of the jaw, one reach clear of the plate. */
const jawOf = (doc: Document, c: EquipmentEntity): THREE.Vector3 =>
  at(doc, c, 0, c.dims[1] / 2, -c.dims[2] / 2 + clampMetrics(c.dims).reachIn);

const near = (v: THREE.Vector3, x: number, y: number, z: number, p = 5): void => {
  expect(v.x).toBeCloseTo(x, p);
  expect(v.y).toBeCloseTo(y, p);
  expect(v.z).toBeCloseTo(z, p);
};

const fmt = (v: THREE.Vector3): string => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

/** Every hole a coupler can bolt into on `wall` as it stands in `doc`: world position and outward normal. */
function holesOf(doc: Document, wall: LedWallEntity): { pos: THREE.Vector3; normal: THREE.Vector3 }[] {
  const dims = wallDims(wall);
  const world = worldMatrix(wall, byIdOf(doc));
  return wallMountPoints(dims, computeColumnLayout(dims, wall.corners), filledCells(wall), wall.corners)
    .filter(m => m.onFace)
    .map(m => ({
      pos: new THREE.Vector3(...m.pos).applyMatrix4(world),
      normal: new THREE.Vector3(...m.normal).transformDirection(world),
    }));
}

/**
 * Does a jaw at `jaw`, running `along`, close on one of `p`'s chords clear of its welds? Read in the
 * piece's own frame, where `trussAlong` draws them: a horizontal stick's four run along X at
 * y = h/2 +- CO, z = +-CO; an upright's -- a stick stood on end, or a base's riser above its plate --
 * run up Y at x = +-CO, z = +-CO.
 */
function grips(doc: Document, p: EquipmentEntity, jaw: THREE.Vector3, along: THREE.Vector3): boolean {
  const inv = worldMatrix(p, byIdOf(doc)).invert();
  const l = jaw.clone().applyMatrix4(inv);
  const dir = along.clone().transformDirection(inv);
  const onChord = (v: number): boolean => Math.abs(Math.abs(v) - CO) < 1e-6;
  const [w, h] = p.dims;
  if (p.geometry === 'truss') {
    return onChord(l.y - h / 2) && onChord(l.z) && Math.abs(Math.abs(dir.x) - 1) < 1e-6
      && clearOfBraceNodes(l.x + w / 2, w, SECTION, JAW_HALF);
  }
  const from = p.geometry === 'truss-base' ? trussBaseProfile(p.dims).plateThick : 0;
  return onChord(l.x) && onChord(l.z) && Math.abs(Math.abs(dir.y) - 1) < 1e-6
    && clearOfBraceNodes(l.y - from, h - from, SECTION, JAW_HALF);
}

/**
 * The corners of the truss a piece draws, in world space. A base's plate is left out: it is the one
 * part of a rig meant to reach out from behind the wall, flat on the floor. A base that is all plate
 * has none.
 */
function trussCorners(doc: Document, p: EquipmentEntity): THREE.Vector3[] {
  const [w, h, d] = p.dims;
  const base = p.geometry === 'truss-base' ? trussBaseProfile(p.dims) : null;
  if (base && base.riserLen <= 1e-9) return [];
  const hw = base ? base.section / 2 : w / 2, hd = base ? base.section / 2 : d / 2, y0 = base ? base.plateThick : 0;
  const m = worldMatrix(p, byIdOf(doc));
  const out: THREE.Vector3[] = [];
  for (const x of [-hw, hw]) for (const y of [y0, h]) for (const z of [-hd, hd]) out.push(new THREE.Vector3(x, y, z).applyMatrix4(m));
  return out;
}

/** An 8 x 6 wall with the top three cabinets of its last column left out. */
function notched(): LedWallEntity {
  const wall = createLedWall({ cols: 8, rows: 6 });
  const cells: string[] = [];
  for (let c = 0; c < 8; c++) for (let r = 0; r < 6; r++) if (!(c === 7 && r < 3)) cells.push(`${c},${r}`);
  wall.shape = { mode: 'custom', cells };
  return wall;
}

/**
 * A 30-column arch `rows` high: piers two columns wide at each end and in the middle, and over the
 * two openings between them a lintel of the top `lintel` rows (row 0 is the top). As it comes, 30 x 7
 * under a two-row lintel, its openings are five-row doorways.
 */
function arch(rows = 7, lintel = 2): LedWallEntity {
  const wall = createLedWall({ cols: 30, rows });
  const pier = (c: number): boolean => c <= 1 || c === 14 || c === 15 || c >= 28;
  const cells: string[] = [];
  for (let c = 0; c < 30; c++) for (let r = 0; r < rows; r++) if (pier(c) || r < lintel) cells.push(`${c},${r}`);
  wall.shape = { mode: 'custom', cells };
  return wall;
}

/** A 29-column arch, as {@link arch}, whose middle pier is a single column. */
function narrowPier(rows = 7, lintel = 2): LedWallEntity {
  const wall = createLedWall({ cols: 29, rows });
  const pier = (c: number): boolean => c <= 1 || c === 14 || c >= 27;
  const cells: string[] = [];
  for (let c = 0; c < 29; c++) for (let r = 0; r < rows; r++) if (pier(c) || r < lintel) cells.push(`${c},${r}`);
  wall.shape = { mode: 'custom', cells };
  return wall;
}

/** A 12-column arch `rows` high: two-column piers at the ends, a one-row lintel between them. */
function lintelArch(rows: number): LedWallEntity {
  const wall = createLedWall({ cols: 12, rows });
  const cells: string[] = [];
  for (let c = 0; c < 12; c++) for (let r = 0; r < rows; r++) if (c <= 1 || c >= 10 || r === 0) cells.push(`${c},${r}`);
  wall.shape = { mode: 'custom', cells };
  return wall;
}

function folded(angle: number): LedWallEntity {
  const wall = createLedWall({ cols: 4, rows: 3 });
  wall.corners = [{ afterCol: 1, angle }];
  return wall;
}

function turned(): LedWallEntity {
  const wall = createLedWall({ cols: 2, rows: 3, position: [40, 0, -10] });
  wall.transform.rotation = [0, 90, 0];
  return wall;
}

function onDeck(): { doc: Document; wall: LedWallEntity } {
  const stage = createStage(24);
  const wall = createLedWall({ cols: 2, rows: 3, position: [0, 24, 0] });
  wall.attachedTo = stage.id;
  return { doc: docWith(stage, wall), wall };
}

const solo = (wall: LedWallEntity): { doc: Document; wall: LedWallEntity } => ({ doc: docWith(wall), wall });

describe('the numbers a rig is laid out from', () => {
  it('are the ones the panel spec and the catalog publish', () => {
    expect([IPOSTER.widthIn, IPOSTER.heightIn, IPOSTER.depthIn]).toEqual([PW, PH, PD]);
    expect(PW / 2 - (1 + 0.3937 / 2)).toBeCloseTo(HX, 9);
    expect(PH / 2 - (1 + 0.3937 / 2)).toBeCloseTo(HY, 9);
    expect(chordRadiusIn(SECTION)).toBeCloseTo(R, 9);
    expect(chordOffsetIn(SECTION)).toBeCloseTo(CO, 9);
    expect(clampMetrics(equipmentDef('clamp-8002')!.dims).reachIn).toBeCloseTo(REACH, 9);
    expect(equipmentDef('clamp-8002')!.dims[0] / 2).toBe(JAW_HALF);
  });

  it('draw a base as a 36 in plate about an inch thick, flat on the floor with nothing standing on it', () => {
    expect(equipmentDef(BASE_ID)!.dims).toEqual([36, PLATE, 36]);
    expect(trussBaseProfile([36, PLATE, 36])).toEqual({ plateThick: PLATE, section: SECTION, riserLen: 0 });
    expect(equipmentDef('gp-corner-6way')!.dims).toEqual([SECTION, SECTION, SECTION]);
    expect(equipmentDef('gp-truss-8ft')!.dims).toEqual([96, SECTION, SECTION]);
    expect(equipmentDef('gp-truss-5ft')!.dims).toEqual([60, SECTION, SECTION]);
    expect(equipmentDef('gp-truss-4ft')!.dims).toEqual([48, SECTION, SECTION]);
  });

  it('constrain to the stock we own', () => {
    const owned = (id: string): number | undefined => ownedCount(equipmentDef(id));
    expect(owned('gp-truss-8ft')).toBe(3);
    expect(owned('gp-truss-5ft')).toBe(6);
    expect(owned('gp-truss-4ft')).toBe(12);          // 6 on each of two orders
    expect(owned('gp-corner-6way')).toBe(6);
    expect(owned(BASE_ID)).toBe(6);
    expect(owned('clamp-8002')).toBe(38);
  });
});

describe('planTrussRig', () => {
  it('stands a 2 x 3 on one tower of a plate and a 4 ft stick, which holds both columns, and sets it down on the plates', () => {
    const wall = createLedWall({ cols: 2, rows: 3 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.frames).toBe(0);
    expect(plan.spans).toEqual([]);
    expect(plan.headerY).toBeNull();
    // Three rows top out under 8 ft, so the column the couplers are in holds the one bolted beside
    // it: one tower does for both. It grips an inner hole line, as near the middle as a tower can
    // stand -- the first column's, the second's being no nearer.
    expect(plan.legs.map(l => l.kind)).toEqual(['tower']);
    plan.legs.forEach(leg => {
      expect(leg.axis[0]).toBeCloseTo(-STEP / 2 + HX - CO, 5);
      expect(leg.axis[1]).toBeCloseTo(LEG_Z, 5);
      expect(leg.axis[1] + SECTION / 2).toBeLessThan(-PD / 2);   // the whole section behind the cabinet
      expect(leg.rotY).toBeCloseTo(0, 9);
      // Three rows on the plates top out at 57.82 in: a 4 ft stick on a plate (49 in), our shortest,
      // fits under them; a 5 ft one (61 in) would show.
      expect(leg.pieces.map(p => p.catalogId)).toEqual([BASE_ID, 'gp-truss-4ft']);
      expect(leg.pieces.map(p => p.geometry)).toEqual(['truss-base', 'truss-vertical']);
      expect(leg.pieces.map(p => p.position[1])).toEqual([0, PLATE]);
      for (const p of leg.pieces) {
        expect(p.position[0]).toBeCloseTo(leg.axis[0], 9);
        expect(p.position[2]).toBeCloseTo(leg.axis[1], 9);
      }
      expect(leg.topY).toBeCloseTo(PLATE + 48, 9);
    });

    // The plate reaches forward under the cabinets, so the wall stands on it: 1.5 in up, no shim.
    expect(plan.bottomY).toBeCloseTo(PLATE, 9);
    expect(plan.liftIn).toBeCloseTo(PLATE, 9);
    expect(plan.shimIn).toBe(0);
    expect(plan.warnings).toContain('The wall rises 1.50 in to sit on the 1.50 in base plates.');

    // The holes on its line between the stick's ends. The stick stands where the wall does, so each
    // hole is its own height up the stick: 1.20 in sits on the foot weld and 36.66 in on the panel
    // weld at 36, which leaves the bottom row's top hole and the bottom holes of the two rows above
    // it. The top row's top hole, 55.62 in up, is past the stick's 48.
    expect(plan.clamps).toHaveLength(3);
    expect(plan.skipped).toEqual({ offFace: 0, weld: 2 });
    expect([plan.held, plan.supported, plan.columns, plan.ghosts]).toEqual([1, 2, 2, 0]);
    expect(plan.warnings).toContain('1 column has no coupler of its own: it is held by a coupled column beside it.');

    const after = applyTrussRig(docWith(wall), wall, plan);
    const bolts = equipmentOf(after).filter(e => e.catalogId === 'clamp-8002')
      .map(c => boltOf(after, c)).sort((a, b) => a.y - b.y);
    expect(bolts).toHaveLength(3);
    near(bolts[0], -STEP / 2 + HX, PLATE + HIGH, -PD / 2);
    near(bolts[1], -STEP / 2 + HX, PLATE + PITCH + LOW, -PD / 2);
    near(bolts[2], -STEP / 2 + HX, PLATE + 2 * PITCH + LOW, -PD / 2);
  });

  it('frames the Financial Times wall: four legs, a header across them, every column held', () => {
    const wall = createLedWall({ cols: 11, rows: 8 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.frames).toBe(1);
    expect(plan.legs).toHaveLength(4);
    for (const leg of plan.legs) {
      expect(leg.kind).toBe('frame');
      expect(leg.pieces.map(p => p.catalogId)).toEqual([BASE_ID, 'gp-truss-4ft', 'gp-corner-6way']);
      expect(leg.pieces.map(p => p.position[1])).toEqual([0, PLATE, PLATE + 48]);
      expect(leg.topY).toBeCloseTo(PLATE + 48 + SECTION, 9);
    }
    // Spans meet the blocks face to face.
    expect(plan.spans.map(s => s.dims[0])).toEqual([60, 96, 60]);
    plan.spans.forEach((s, i) => {
      expect(plan.legs[i + 1].axis[0] - plan.legs[i].axis[0] - SECTION).toBeCloseTo(s.dims[0], 9);
      expect(s.position[1]).toBeCloseTo(PLATE + 48, 9);
    });

    // The header's top chord lands on the low hole of the fourth row up, which takes a 0.10 in shim.
    const headerY = PLATE + 48 + SECTION - R;
    const shim = headerY - PLATE - (3 * PITCH + LOW);
    expect(plan.headerY).toBeCloseTo(headerY, 9);
    expect(plan.shimIn).toBeCloseTo(shim, 9);
    expect(shim).toBeCloseTo(0.0989, 4);
    expect(plan.bottomY).toBeCloseTo(PLATE + shim, 9);

    expect([plan.held, plan.supported, plan.columns]).toEqual([11, 11, 11]);
    expect(plan.ghosts).toBe(0);
    expect(plan.shortfall).toEqual([]);
    expect(plan.clamps.length).toBeLessThanOrEqual(38);
  });

  it('stands a three-row wall on towers a plate apart, each holding a column either side of its own', () => {
    // The lowest frame leg, a block on a 4 ft stick, stands 60.16 in: over three rows' 57.82, where it
    // would show. Three rows top out under 8 ft, so a tower's column holds both its neighbours:
    // eight columns take three towers. Each, for the first column nothing holds yet, holds the most
    // columns and the furthest on, then stands nearest their middle: on the left hole line of
    // columns 1, 4 and 7 -- the last of those holding the two columns left, 6 and 7.
    const wall = createLedWall({ cols: 8, rows: 3 });
    const plan = planTrussRig(docWith(wall), wall);
    const W = 8 * PW + 7 * GAP;
    const centre = (c: number): number => -W / 2 + PW / 2 + c * STEP;

    expect(plan.frames).toBe(0);
    expect(plan.legs.every(l => l.kind === 'tower')).toBe(true);
    const xs = plan.legs.map(l => l.axis[0]);
    expect(xs).toHaveLength(3);
    [1, 4, 7].forEach((c, i) => expect(xs[i]).toBeCloseTo(centre(c) - HX + CO, 5));
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(36 - 1e-9);
    expect([plan.held, plan.supported, plan.columns]).toEqual([3, 8, 8]);
    expect(plan.warnings).toContain('5 columns have no coupler of their own: each is held by a coupled column beside it.');
  });

  it('holds three columns from a tower while the wall stands under 8 ft, and two past it', () => {
    // A one-row lintel takes no header, so this arch stands on towers: one behind each pier's inner
    // column, on its hole line toward the outer one (on the other its plate would reach into the
    // doorway). Five rows top out at 94.74 in, under 8 ft, so those couplers hold the outer column
    // and the lintel column beside too; seven top out at 132.66 in, and hold the outer column alone.
    expect(5 * PITCH - GAP).toBeLessThan(96);
    expect(7 * PITCH - GAP).toBeGreaterThan(96);

    const low = lintelArch(5);
    const lp = planTrussRig(docWith(low), low);
    const W = 12 * PW + 11 * GAP;
    const x = -W / 2 + PW / 2 + STEP - HX + CO;
    expect(lp.frames).toBe(0);
    expect(lp.legs.map(l => l.kind)).toEqual(['tower', 'tower']);
    expect(lp.legs[0].axis[0]).toBeCloseTo(x, 5);
    expect(lp.legs[1].axis[0]).toBeCloseTo(-x, 5);
    expect([lp.held, lp.supported, lp.columns]).toEqual([2, 6, 12]);
    expect(lp.warnings).toContain('6 columns are out of reach of every coupler, and nothing holds them.');

    const high = lintelArch(7);
    const hp = planTrussRig(docWith(high), high);
    expect(hp.frames).toBe(0);
    expect(hp.legs.map(l => l.kind)).toEqual(['tower', 'tower']);
    expect([hp.held, hp.supported, hp.columns]).toEqual([2, 4, 12]);
    expect(hp.warnings).toContain('8 columns are out of reach of every coupler, and nothing holds them.');
  });

  it('stands a 3 x 3 on one tower on the middle column, which holds all three', () => {
    // The lowest frame leg, a block on a 4 ft stick, stands 60.16 in, over the wall's 57.82, so
    // nothing braces it. Three rows top out under 8 ft, so one tower of a plate and a 4 ft stick, on
    // the middle column's left hole line, holds that column and both beside it.
    expect(PLATE + 48 + SECTION).toBeGreaterThan(PLATE + 3 * PITCH - GAP);
    const wall = createLedWall({ cols: 3, rows: 3 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.frames).toBe(0);
    expect(plan.spans).toEqual([]);
    expect(plan.legs.map(l => l.kind)).toEqual(['tower']);
    expect(plan.legs[0].pieces.map(p => p.catalogId)).toEqual([BASE_ID, 'gp-truss-4ft']);
    expect(plan.legs[0].axis[0]).toBeCloseTo(-HX + CO, 5);
    // As on the 2 x 3: the bottom row's top hole and the bottom holes of the two rows above it.
    expect(plan.clamps).toHaveLength(3);
    expect(plan.skipped).toEqual({ offFace: 0, weld: 2 });
    expect([plan.held, plan.supported, plan.columns]).toEqual([1, 3, 3]);
    expect(plan.warnings).toContain('2 columns have no coupler of their own: each is held by a coupled column beside it.');
  });

  it('draws what it needs past our stock as ghosts, and says what is short', () => {
    // A 24 x 8 frames as the Financial Times wall does, on legs of a plate, a 4 ft stick and a block,
    // but takes seven of them: seven plates and seven blocks, one of each past our six, so the last
    // leg is drawn with those ghosts. Its spans take four 8 ft sticks, one past our three.
    const wall = createLedWall({ cols: 24, rows: 8 });
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const S8 = 'gp-truss-8ft', BLOCK = 'gp-corner-6way';
    const name = (id: string): string => equipmentDef(id)!.name;

    expect(plan.headerY).toBeCloseTo(PLATE + 48 + SECTION - R, 9);
    expect(plan.legs.map(l => l.pieces.map(p => p.catalogId))).toEqual(Array(7).fill([BASE_ID, 'gp-truss-4ft', BLOCK]));
    expect(plan.legs.map(l => l.pieces.map(p => p.ghost)))
      .toEqual([...Array(6).fill([false, false, false]), [true, false, true]]);
    expect(plan.spans.filter(s => s.ghost).map(s => s.dims[0])).toEqual([96]);
    expect(plan.ghosts).toBe(3);
    expect([plan.supported, plan.columns]).toEqual([24, 24]);
    expect([...plan.shortfall].sort((a, b) => a.catalogId.localeCompare(b.catalogId))).toEqual([
      { catalogId: BASE_ID, name: name(BASE_ID), need: 7, have: 6 },
      { catalogId: BLOCK, name: name(BLOCK), need: 7, have: 6 },
      { catalogId: S8, name: name(S8), need: 4, have: 3 },
    ]);
    for (const id of [BASE_ID, BLOCK]) expect(plan.warnings).toContain(`${name(id)}: 7 needed, 6 available - 1 drawn as a ghost.`);
    expect(plan.warnings).toContain(`${name(S8)}: 4 needed, 3 available - 1 drawn as a ghost.`);

    const ghosts = equipmentOf(applyTrussRig(doc, wall, plan)).filter(e => e.ghost);
    expect(ghosts.map(g => g.catalogId).sort()).toEqual([BASE_ID, BLOCK, S8].sort());
    for (const g of ghosts) expect(g.name).toBe(`${name(g.catalogId)} (not owned)`);
  });

  it('counts stock already standing elsewhere in the scene, but not ghosts', () => {
    const def = equipmentDef(BASE_ID)!;
    const placed = (n: number, ghost: number): EquipmentEntity[] => Array.from({ length: n }, (_, i) => {
      const e = createEquipment(def, [300 + 40 * i, 0, 0]);
      if (i < ghost) e.ghost = true;
      return e;
    });

    // A 2 x 3 stands on one base; all six of ours stand elsewhere.
    const wall = createLedWall({ cols: 2, rows: 3 });
    const short = planTrussRig(docWith(wall, ...placed(6, 0)), wall);
    expect(short.legs.map(l => l.pieces[0].ghost)).toEqual([true]);
    expect(short.shortfall).toEqual([{ catalogId: BASE_ID, name: def.name, need: 1, have: 0 }]);

    const enough = planTrussRig(docWith(wall, ...placed(6, 1)), wall);
    expect(enough.ghosts).toBe(0);
  });

  it('brings a wall standing higher down onto the plates', () => {
    const wall = createLedWall({ cols: 2, rows: 3, position: [0, 10, 0] });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.bottomY).toBeCloseTo(PLATE, 9);
    expect(plan.liftIn).toBeCloseTo(PLATE - 10, 9);
    expect(plan.liftLocalIn).toBeCloseTo(PLATE - 10, 9);
    expect(plan.warnings).toContain('The wall comes down 8.50 in to sit on the 1.50 in base plates.');
    expect(plan.legs.every(l => l.pieces[0].position[1] === 0)).toBe(true);
  });

  it('stands the legs on a stage deck the wall rides', () => {
    const { doc, wall } = onDeck();
    const plan = planTrussRig(doc, wall);

    expect(plan.legs).toHaveLength(1);
    for (const leg of plan.legs) expect(leg.pieces[0].position[1]).toBeCloseTo(24, 9);
    expect(plan.bottomY).toBeCloseTo(24 + PLATE, 9);
    expect(plan.liftIn).toBeCloseTo(PLATE, 9);
  });

  it('frames the full-height columns of a notched wall, and stands the short one on a tower of its own', () => {
    const wall = notched();
    const plan = planTrussRig(docWith(wall), wall);
    const W = 8 * PW + 7 * GAP;
    const col7 = -W / 2 + 7 * STEP;                    // left edge of the short column's face
    const outer6 = col7 - GAP - PW / 2 + HX;           // column 6's hole line on the short column's side

    // A frame leg, a block on a 4 ft stick, stands 60.16 in, over the short column's three rows, so
    // the frame keeps to the full-height columns.
    expect(plan.frames).toBe(1);
    expect(plan.legs.map(l => l.kind)).toEqual(['frame', 'frame', 'frame', 'tower']);
    const frame = plan.legs.filter(l => l.kind === 'frame');
    for (const s of plan.spans) expect(s.position[0] + s.dims[0] / 2).toBeLessThan(col7);
    for (const l of frame) expect(l.axis[0] + SECTION / 2).toBeLessThan(col7);

    // Column 6 stands six rows, past 8 ft, so only its couplers on its outer hole line would hold the
    // short column, and the frame ends short of that line. A tower behind the short column holds it,
    // on its outer hole line, the plate reaching out past the wall's end.
    expect(Math.max(...frame.map(l => l.axis[0])) + SECTION / 2).toBeLessThan(outer6);
    const tower = plan.legs[3];
    expect(tower.pieces.map(p => p.catalogId)).toEqual([BASE_ID, 'gp-truss-4ft']);
    expect(tower.axis[0]).toBeCloseTo(col7 + PW / 2 + HX - CO, 5);
    expect(tower.topY).toBeLessThan(PLATE + 3 * PITCH - GAP);

    const after = applyTrussRig(docWith(wall), wall, plan);
    const bolts = equipmentOf(after).filter(e => e.catalogId === 'clamp-8002').map(c => boltOf(after, c));
    const short = bolts.filter(b => b.x > col7);
    expect(short).toHaveLength(3);
    for (const b of short) expect(b.x).toBeCloseTo(col7 + PW / 2 + HX, 6);
    expect([plan.held, plan.supported, plan.columns]).toEqual([7, 8, 8]);
    expect(plan.warnings).toContain('1 column has no coupler of its own: it is held by a coupled column beside it.');
  });

  it('frames an arch over low openings: a leg behind each pier, and sticks spliced across each opening behind the lintel', () => {
    // A 30 x 6 under a four-row lintel: openings two rows high, under the one frame our sticks give
    // with bezels on, a block on a 4 ft stick with its header on the fourth row's low holes.
    const wall = arch(6, 4);
    const plan = planTrussRig(docWith(wall), wall);
    const W = 30 * PW + 29 * GAP;
    const edge = (c: number): number => -W / 2 + c * STEP;   // a column's left edge
    const piers = [[0, 2], [14, 16], [28, 30]].map(([a, b]) => [edge(a), edge(b) - GAP]);
    const blockY = PLATE + 48;                               // the span's block, on 48 in of stick

    expect(plan.frames).toBe(1);
    expect(plan.legs.map(l => l.kind)).toEqual(['frame', 'frame', 'frame']);
    plan.legs.forEach((leg, i) => {
      const [l, r] = piers[i];
      expect(leg.axis[0] - SECTION / 2).toBeGreaterThanOrEqual(l - 1e-9);
      expect(leg.axis[0] + SECTION / 2).toBeLessThanOrEqual(r + 1e-9);
      // The plate may reach out past the wall's end, never into a doorway.
      if (i > 0) expect(leg.axis[0] - 18).toBeGreaterThanOrEqual(l - 1e-9);
      if (i < 2) expect(leg.axis[0] + 18).toBeLessThanOrEqual(r + 1e-9);
      expect(leg.pieces.map(p => p.catalogId)).toEqual([BASE_ID, 'gp-truss-4ft', 'gp-corner-6way']);
      expect(leg.topY).toBeCloseTo(blockY + SECTION, 9);
    });
    expect(PLATE + plan.shimIn + 2 * PITCH - GAP).toBeLessThan(blockY);   // the openings' tops, under it

    // Each doorway is bridged block face to block face, its sticks end to end at the top block.
    const chains: (typeof plan.spans)[] = [[], []];
    for (const s of plan.spans) {
      expect(s.position[1]).toBeCloseTo(blockY, 9);
      chains[s.position[0] < plan.legs[1].axis[0] ? 0 : 1].push(s);
    }
    chains.forEach((chain, i) => {
      expect(chain.length).toBeGreaterThan(1);
      let x = plan.legs[i].axis[0] + SECTION / 2;
      for (const s of [...chain].sort((a, b) => a.position[0] - b.position[0])) {
        expect(s.position[0] - s.dims[0] / 2).toBeCloseTo(x, 9);
        x += s.dims[0];
      }
      expect(x).toBeCloseTo(plan.legs[i + 1].axis[0] - SECTION / 2, 9);
    });

    // The header's top chord lands on the low holes of the fourth row up, as on the Financial Times wall.
    const headerY = blockY + SECTION - R;
    expect(plan.headerY).toBeCloseTo(headerY, 9);
    expect(plan.shimIn).toBeCloseTo(headerY - PLATE - (3 * PITCH + LOW), 9);
    expect(plan.shimIn).toBeCloseTo(0.0989, 4);

    // Every column is held, two of them by a coupled column bolted beside them.
    expect([plan.held, plan.supported, plan.columns]).toEqual([28, 30, 30]);
    expect(plan.warnings).toContain('2 columns have no coupler of their own: each is held by a coupled column beside it.');
    expect(plan.warnings).toContain('2 spans run past 20 ft, where the DT-GP span table stops (the longest is 30 ft): '
      + 'have them checked before they carry the wall.');
    // The couplers run past our 38; every stick, block and plate is one we own.
    expect(plan.shortfall.map(f => f.catalogId)).toEqual(['clamp-8002']);
    expect(plan.ghosts).toBe(plan.shortfall[0].need - plan.shortfall[0].have);
  });

  it('frames a walk-through arch over both doorways, on a 3 ft stick to buy in each leg', () => {
    // Over five-row doorways, the lintel's lowest holes stand 96.00 in up the wall. Of the legs of our
    // own sticks that stand under its top, the nearest is a block on 8 ft of stick, its header's
    // bottom chord 0.99 in over them: past the quarter-inch shim. A 4 ft and a 3 ft under a spare
    // block put it 0.15 in under them, inside it. We hold no 3 ft stick, so each leg's is a ghost, to
    // buy: the frame holds the lintel's 24 columns, which a tower behind each pier cannot reach.
    const miss = 96 + R - (5 * PITCH + LOW);
    expect(miss).toBeCloseTo(0.99, 2);
    expect(miss).toBeGreaterThan(SHIM_MAX_IN);
    const blockY = PLATE + 48 + 36 + SECTION;                // the span's block, on a spare one
    const shim = blockY + R - PLATE - (5 * PITCH + LOW);
    expect(shim).toBeCloseTo(0.147, 3);
    expect(shim).toBeLessThanOrEqual(SHIM_MAX_IN);

    const wall = arch();
    const plan = planTrussRig(docWith(wall), wall);
    const W = 30 * PW + 29 * GAP;
    const edge = (c: number): number => -W / 2 + c * STEP;   // a column's left edge
    const piers = [[0, 2], [14, 16], [28, 30]].map(([a, b]) => [edge(a), edge(b) - GAP]);

    expect(plan.frames).toBe(1);
    expect(plan.legs.map(l => l.kind)).toEqual(['frame', 'frame', 'frame']);
    plan.legs.forEach((leg, i) => {
      const [l, r] = piers[i];
      expect(leg.axis[0] - SECTION / 2).toBeGreaterThanOrEqual(l - 1e-9);
      expect(leg.axis[0] + SECTION / 2).toBeLessThanOrEqual(r + 1e-9);
      if (i > 0) expect(leg.axis[0] - 18).toBeGreaterThanOrEqual(l - 1e-9);
      if (i < 2) expect(leg.axis[0] + 18).toBeLessThanOrEqual(r + 1e-9);
      expect(leg.pieces.map(p => p.catalogId))
        .toEqual([BASE_ID, 'gp-truss-4ft', 'gp-truss-3ft', 'gp-corner-6way', 'gp-corner-6way']);
      expect(leg.pieces.map(p => p.ghost)).toEqual([false, false, true, false, false]);
      expect(leg.topY).toBeCloseTo(blockY + SECTION, 9);
    });

    // Each doorway is bridged block face to block face, behind the lintel over it.
    const chains: (typeof plan.spans)[] = [[], []];
    for (const s of plan.spans) {
      expect(s.position[1]).toBeCloseTo(blockY, 9);
      expect(s.ghost).toBe(false);
      chains[s.position[0] < plan.legs[1].axis[0] ? 0 : 1].push(s);
    }
    chains.forEach((chain, i) => {
      let x = plan.legs[i].axis[0] + SECTION / 2;
      for (const s of [...chain].sort((a, b) => a.position[0] - b.position[0])) {
        expect(s.position[0] - s.dims[0] / 2).toBeCloseTo(x, 9);
        x += s.dims[0];
      }
      expect(x).toBeCloseTo(plan.legs[i + 1].axis[0] - SECTION / 2, 9);
      // Couplers close on it over the doorway, where only the lintel stands.
      expect(plan.clamps.some(c => c.position[0] > piers[i][1] && c.position[0] < piers[i + 1][0])).toBe(true);
    });

    // The header's bottom chord lands on the low holes of the sixth row up, the lintel's lowest.
    expect(plan.headerY).toBeCloseTo(blockY + R, 9);
    expect(plan.shimIn).toBeCloseTo(shim, 9);
    expect(plan.bottomY).toBeCloseTo(PLATE + shim, 9);
    expect(PLATE + shim + 5 * PITCH - GAP).toBeLessThan(blockY);   // the doorways' tops, under it

    expect([plan.held, plan.supported, plan.columns]).toEqual([28, 30, 30]);
    expect(plan.warnings).toContain('The wall rises 1.65 in to sit on the 1.50 in base plates, on a 0.15 in shim so the header chord meets a row of holes.');
    expect(plan.warnings).toContain('DT-GP3 box truss 3 ft: 3 to buy, drawn as ghosts. We hold none, and our own sticks put no header on a row of holes here.');
    expect(plan.warnings).toContain('2 spans run past 20 ft, where the DT-GP span table stops (the longest is 30 ft): '
      + 'have them checked before they carry the wall.');
    expect(plan.shortfall.map(f => f.catalogId)).toEqual(['gp-truss-3ft', 'clamp-8002']);
    expect(plan.shortfall[0]).toMatchObject({ need: 3, have: 0 });
    expect(plan.ghosts).toBe(3 + plan.shortfall[1].need - plan.shortfall[1].have);
  });

  it('bridges a pier one column wide, where no plate can stand, with one span from pier to pier', () => {
    // A 29 x 6 under a four-row lintel, as the arch above: openings two rows high.
    const wall = narrowPier(6, 4);
    const plan = planTrussRig(docWith(wall), wall);
    const W = 29 * PW + 28 * GAP;
    const edge = (c: number): number => -W / 2 + c * STEP;   // a column's left edge

    // A 36 in plate behind the middle pier's 25.2 in column would reach into a doorway either side
    // of it, so the frame stands on the end piers alone, each plate clear of its doorway.
    expect(plan.frames).toBe(1);
    expect(plan.legs.map(l => l.kind)).toEqual(['frame', 'frame']);
    const [a, b] = plan.legs.map(l => l.axis[0]);
    expect(a - SECTION / 2).toBeGreaterThanOrEqual(edge(0) - 1e-9);
    expect(a + 18).toBeLessThanOrEqual(edge(2) - GAP + 1e-9);
    expect(b - 18).toBeGreaterThanOrEqual(edge(27) - 1e-9);
    expect(b + SECTION / 2).toBeLessThanOrEqual(W / 2 + 1e-9);

    // One span, block face to block face, behind both doorways and the pier between them: longer
    // than the 25 columns between the piers, and a whole number of feet.
    const len = b - a - SECTION;
    expect(len).toBeGreaterThan(edge(27) - GAP - edge(2));
    expect(len / 12).toBeCloseTo(Math.round(len / 12), 9);
    let x = a + SECTION / 2;
    for (const s of [...plan.spans].sort((p, q) => p.position[0] - q.position[0])) {
      expect(s.position[0] - s.dims[0] / 2).toBeCloseTo(x, 9);
      x += s.dims[0];
    }
    expect(x).toBeCloseTo(b - SECTION / 2, 9);
    expect(plan.warnings).toContain(`1 span runs past 20 ft, where the DT-GP span table stops (the longest is ${Math.round(len / 12)} ft): `
      + 'have it checked before it carries the wall.');

    // At 57 ft, the fewest sticks that make it are six 8 ft, a 5 and a 4: three 8 ft past our three.
    expect(len).toBeCloseTo(684, 9);
    expect(plan.spans.map(s => s.dims[0]).sort((p, q) => p - q)).toEqual([48, 60, 96, 96, 96, 96, 96, 96]);
    expect(plan.shortfall.find(f => f.catalogId === 'gp-truss-8ft')).toMatchObject({ need: 6, have: 3 });
    expect(plan.spans.filter(s => s.ghost).map(s => s.dims[0])).toEqual([96, 96, 96]);
    expect([plan.supported, plan.columns]).toEqual([29, 29]);
  });

  it('keeps a plate out of a doorway round a fold, and off the floor a plate either side of it', () => {
    // Open at the floor under a lintel: column 1 of the first wall, just past its 120 degree fold, and
    // column 0 of the second, two columns before its fold of -120 degrees. A plate behind the run on
    // the other side of the fold can reach round onto the floor of the opening, or the floor just in
    // front of or behind it; on 61555a4 the first wall's only plate stood in its doorway. Two checks
    // keep it out, the doorway's floor and what shows round the fold, each enough here alone: with
    // both taken out, one of the second wall's plates stands in its doorway. Both walls still get a
    // tower, so the check below has plates to look at.
    const tight = createLedWall({ cols: 3, rows: 3 });
    tight.corners = [{ afterCol: 0, angle: 120 }];
    tight.shape = { mode: 'custom', cells: ['0,0', '0,1', '0,2', '1,0', '2,0', '2,1', '2,2'] };
    const inward = createLedWall({ cols: 7, rows: 4 });
    inward.corners = [{ afterCol: 1, angle: -120 }];
    const open: string[] = [];
    for (let c = 0; c < 7; c++) for (let r = 0; r < 4; r++) if (c > 0 || r === 0) open.push(`${c},${r}`);
    inward.shape = { mode: 'custom', cells: open };

    /** Whether two convex outlines on the floor are apart, touching allowed. */
    const apart = (a: THREE.Vector3[], b: THREE.Vector3[]): boolean => [a, b].some(poly => poly.some((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const [ax, az] = [p.z - q.z, q.x - p.x];
      const pa = a.map(v => v.x * ax + v.z * az), pb = b.map(v => v.x * ax + v.z * az);
      return Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6;
    }));

    for (const wall of [tight, inward]) {
      const doc = docWith(wall);
      const after = applyTrussRig(doc, wall, planTrussRig(doc, wall));
      const world = worldMatrix(wallOf(after, wall.id), byIdOf(after));
      const layout = computeColumnLayout(wallDims(wall), wall.corners);
      const cells = new Set(filledCells(wall));
      const plates = rigOf(after, wall.id).filter(e => e.geometry === 'truss-base');
      expect(plates.length, `the ${wall.cols} x ${wall.rows} wall has no plates to check`).toBeGreaterThan(0);
      for (let c = 0; c < wall.cols; c++) {
        if (cells.has(`${c},${wall.rows - 1}`)) continue;
        // Between the jambs, from a plate's width in front of the face to a plate's width behind the back.
        const door = [[-PW / 2, PD / 2 + 36], [PW / 2, PD / 2 + 36], [PW / 2, -PD / 2 - 36], [-PW / 2, -PD / 2 - 36]]
          .map(([x, z]) => new THREE.Vector3(...columnLocalToWall(layout[c], x, 0, z)).applyMatrix4(world));
        for (const p of plates) {
          const [w, , d] = p.dims;
          const plate = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => at(after, p, x, 0, z));
          expect(apart(plate, door), `${p.name} reaches into the doorway of column ${c}`).toBe(true);
        }
      }
    }
  });

  it('counts only the columns with cabinets in them', () => {
    // Two 2 x 3 piers with an empty column between them. Three rows stand under 8 ft, so a tower on
    // either column of a pier holds both: four columns, all held, none out of reach.
    const wall = createLedWall({ cols: 5, rows: 3 });
    const cells: string[] = [];
    for (const c of [0, 1, 3, 4]) for (let r = 0; r < 3; r++) cells.push(`${c},${r}`);
    wall.shape = { mode: 'custom', cells };
    const plan = planTrussRig(docWith(wall), wall);

    expect([plan.supported, plan.columns]).toEqual([4, 4]);
    expect(plan.warnings.some(w => w.includes('out of reach'))).toBe(false);
  });

  it('keeps tower plates clear of each other across a fold', () => {
    const wall = folded(90);
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.legs.length).toBeGreaterThan(1);
    // Both runs are square to the axes, so two plates overlap only if they do on both.
    for (const l of plan.legs) expect(Math.abs(Math.round(l.rotY / 90) * 90 - l.rotY)).toBeLessThan(1e-9);
    for (let i = 0; i < plan.legs.length; i++) {
      for (let j = i + 1; j < plan.legs.length; j++) {
        const [a, b] = [plan.legs[i].axis, plan.legs[j].axis];
        expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeGreaterThanOrEqual(36 - 1e-9);
      }
    }
    expect(plan.warnings.some(w => w.includes('plates overlap'))).toBe(false);
  });

  it('takes the floor-stand kit off, since its back supports stand where the legs do', () => {
    const wall = createLedWall({ cols: 2, rows: 3, accessories: true });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.dropAccessories).toBe(true);
    expect(plan.warnings).toContain('The floor-stand base plates and back supports come off: they stand where the legs do.');
    expect(wallOf(applyTrussRig(docWith(wall), wall, plan), wall.id).accessories).toBe(false);
  });

  it('refuses a wall shorter than its shortest leg, and a tilted one', () => {
    // The shortest leg is a plate and a 4 ft stick, 49.5 in: over two rows on the plates, under three.
    // A 3 ft stick, which we would have to buy, stands a leg only where it lands a header.
    for (const [rows, tall] of [[1, '20.4'], [2, '39.4']] as const) {
      const wall = createLedWall({ cols: 2, rows });
      const plan = planTrussRig(docWith(wall), wall);
      expect(plan.legs).toEqual([]);
      expect(plan.clamps).toEqual([]);
      expect(plan.warnings).toContain('The shortest leg, a base plate and a 4 ft stick, stands '
        + `49.5 in: taller than the wall in front of it, which stands ${tall} in, so it would show above it.`);
    }

    const tilted = createLedWall({ cols: 2, rows: 3 });
    tilted.transform.rotation = [10, 0, 0];
    const t = planTrussRig(docWith(tilted), tilted);
    expect(t.legs).toEqual([]);
    expect(t.warnings.join(' ')).toMatch(/tilted/);
  });
});

/** Walls of every shape the planner handles, each as a scene with the wall in it. */
const SCENES: [string, () => { doc: Document; wall: LedWallEntity }][] = [
  ['2 x 3', () => solo(createLedWall({ cols: 2, rows: 3 }))],
  ['3 x 3', () => solo(createLedWall({ cols: 3, rows: 3 }))],
  ['3 x 4, framed', () => solo(createLedWall({ cols: 3, rows: 4 }))],
  ['8 x 3', () => solo(createLedWall({ cols: 8, rows: 3 }))],
  ['8 x 4', () => solo(createLedWall({ cols: 8, rows: 4 }))],
  ['11 x 8', () => solo(createLedWall({ cols: 11, rows: 8 }))],
  ['11 x 8 without bezels', () => solo(createLedWall({ cols: 11, rows: 8, bezels: false }))],
  ['11 x 3', () => solo(createLedWall({ cols: 11, rows: 3 }))],
  ['8 x 6 with a notch', () => solo(notched())],
  ['24 x 8, past our stock', () => solo(createLedWall({ cols: 24, rows: 8 }))],
  ['30 x 7 arch, on towers', () => solo(arch())],
  ['30 x 6 arch over two-row openings', () => solo(arch(6, 4))],
  ['29 x 7 arch on a one-column middle pier, on towers', () => solo(narrowPier())],
  ['29 x 6 arch on a one-column middle pier', () => solo(narrowPier(6, 4))],
  ['12 x 5 arch under a one-row lintel', () => solo(lintelArch(5))],
  ['12 x 7 arch under a one-row lintel', () => solo(lintelArch(7))],
  ['4 x 3 folded 90 degrees', () => solo(folded(90))],
  ['4 x 3 folded 120 degrees', () => solo(folded(120))],
  ['2 x 3 turned to face +x', () => solo(turned())],
  ['2 x 3 standing 10 in up', () => solo(createLedWall({ cols: 2, rows: 3, position: [0, 10, 0] }))],
  ['2 x 3 on a stage deck', onDeck],
];

describe('every rig it draws', () => {
  it.each(SCENES)('%s: bolts each coupler into a hole and closes its jaw on a chord, clear of the welds', (_, make) => {
    const { doc, wall } = make();
    const plan = planTrussRig(doc, wall);
    const after = applyTrussRig(doc, wall, plan);
    const holes = holesOf(after, wallOf(after, wall.id));
    const parts = rigOf(after, wall.id);
    const carriers = parts.filter(e => e.geometry === 'truss' || e.geometry === 'truss-vertical' || e.geometry === 'truss-base');
    const clamps = parts.filter(e => e.catalogId === 'clamp-8002');

    expect(plan.legs.length).toBeGreaterThan(0);
    expect(plan.shimIn).toBeGreaterThanOrEqual(0);
    expect(plan.shimIn).toBeLessThanOrEqual(SHIM_MAX_IN);
    expect(clamps).toHaveLength(plan.clamps.length);
    for (const c of clamps) {
      const m = worldMatrix(c, byIdOf(after));
      const bolt = boltOf(after, c);
      const hole = holes.find(h => h.pos.distanceTo(bolt) < 1e-6);
      expect(hole, `coupler bolt at ${fmt(bolt)} is in no hole`).toBeDefined();
      // Flat on the back face: the plate's own z is the hole's outward normal.
      expect(new THREE.Vector3(0, 0, 1).transformDirection(m).dot(hole!.normal)).toBeCloseTo(1, 9);
      const jaw = jawOf(after, c);
      const along = new THREE.Vector3(1, 0, 0).transformDirection(m);
      expect(carriers.some(p => grips(after, p, jaw, along)), `jaw at ${fmt(jaw)} closes on no chord`).toBe(true);
    }
  });

  it.each(SCENES)('%s: builds from DT-GP alone, never a part of F34', (_, make) => {
    // DT-GP and F34 do not connect, so a rig takes DT-GP parts and couplers and nothing else, ghosts included.
    const { doc, wall } = make();
    const parts = rigOf(applyTrussRig(doc, wall, planTrussRig(doc, wall)), wall.id);
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) {
      if (p.catalogId === 'clamp-8002') continue;
      expect(equipmentDef(p.catalogId)?.trussSystem, `${p.name} (${p.catalogId})`).toBe('DT-GP');
    }
  });

  // The folds are left out: a fold's columns do not stand square to the wall's own frame.
  it.each(SCENES.filter(([name]) => !name.includes('folded')))('%s: hides every truss behind the cabinets, and keeps the plates out of the doorways', (_, make) => {
    const { doc, wall } = make();
    const after = applyTrussRig(doc, wall, planTrussRig(doc, wall));
    const toLocal = worldMatrix(wallOf(after, wall.id), byIdOf(after)).invert();
    const { cols, rows } = wall;
    const gap = wall.bezels ? GAP : 0;
    const W = cols * PW + (cols - 1) * gap;
    // Each column's strip, half a gap past its edges, and its unbroken bands of cabinets, bottom up
    // (row 0 is the top). A band on the bottom row runs on down to the floor the legs stand on.
    const strip = (c: number): [number, number] => [-W / 2 + c * (PW + gap) - gap / 2, -W / 2 + c * (PW + gap) + PW + gap / 2];
    const cells = new Set(filledCells(wall));
    const bands = Array.from({ length: cols }, (_, c) => {
      const out: [number, number][] = [];
      for (let k = 0; k < rows; k++) {
        if (!cells.has(`${c},${rows - 1 - k}`)) continue;
        const lo = k * (PH + gap), last = out[out.length - 1];
        if (last && Math.abs(last[1] + gap - lo) < 1e-9) last[1] = lo + PH;
        else out.push([k === 0 ? -Infinity : lo, lo + PH]);
      }
      return out;
    });
    const across = (x0: number, x1: number): number[] =>
      [...Array(cols).keys()].filter(c => x1 > strip(c)[0] + 1e-6 && x0 < strip(c)[1] - 1e-6);

    const rig = rigOf(after, wall.id);
    const truss = rig.filter(isTruss);
    expect(truss.length).toBeGreaterThan(0);
    for (const p of truss) {
      const vs = trussCorners(after, p).map(c => c.applyMatrix4(toLocal));
      if (!vs.length) continue;
      const xs = vs.map(v => v.x), ys = vs.map(v => v.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      expect(Math.max(-x0, x1), `${p.name} pokes out past the side`).toBeLessThanOrEqual(W / 2 + 1e-6);
      // Every column it passes behind covers it, top to bottom.
      for (const c of across(x0, x1)) {
        expect(bands[c].some(([lo, hi]) => y0 >= lo - 1e-6 && y1 <= hi + 1e-6),
          `${p.name}, ${y0.toFixed(3)} to ${y1.toFixed(3)} in up, shows past the cabinets of column ${c}`).toBe(true);
      }
      for (const v of vs) expect(v.z, `${p.name} comes through the cabinet at ${fmt(v)}`).toBeLessThanOrEqual(-PD / 2 + 1e-6);
    }

    // A plate may reach out on the floor past the wall's end, but not under a column open to the floor.
    const doorways = new Set([...Array(cols).keys()].filter(c => !cells.has(`${c},${rows - 1}`)));
    for (const p of rig.filter(e => e.geometry === 'truss-base')) {
      const [w, , d] = p.dims;
      const xs = [-w / 2, w / 2].flatMap(x => [-d / 2, d / 2].map(z => at(after, p, x, 0, z).applyMatrix4(toLocal).x));
      expect(across(Math.min(...xs), Math.max(...xs)).filter(c => doorways.has(c)), `${p.name} reaches into a doorway`).toEqual([]);
    }
  });
});

/* ───────────────────────────── Across folds ───────────────────────────── */

/**
 * The box a rig piece fills in its own frame: a stick, a block or a coupler whole, a base's riser
 * above its plate. The plate lies flat on the floor, where it may reach out, so it is left out.
 */
function solidOf(p: EquipmentEntity): THREE.Box3 | null {
  const [w, h, d] = p.dims;
  if (p.catalogId === 'clamp-8002') return new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, h, d / 2));
  if (!isTruss(p)) return null;
  const base = p.geometry === 'truss-base' ? trussBaseProfile(p.dims) : null;
  if (base && base.riserLen <= 1e-9) return null;
  const hw = base ? base.section / 2 : w / 2, hd = base ? base.section / 2 : d / 2, y0 = base ? base.plateThick : 0;
  return new THREE.Box3(new THREE.Vector3(-hw, y0, -hd), new THREE.Vector3(hw, h, hd));
}

/** Points over a box's six faces, no more than `step` apart. */
function facePoints(b: THREE.Box3, step: number): THREE.Vector3[] {
  const lo = b.min.toArray(), hi = b.max.toArray();
  const n = [0, 1, 2].map(i => Math.max(1, Math.ceil((hi[i] - lo[i]) / step)));
  const out: THREE.Vector3[] = [];
  for (let a = 0; a < 3; a++) {
    const [u, v] = [(a + 1) % 3, (a + 2) % 3];
    for (const side of [lo[a], hi[a]]) for (let j = 0; j <= n[u]; j++) for (let k = 0; k <= n[v]; k++) {
      const p = [0, 0, 0];
      p[a] = side; p[u] = lo[u] + (hi[u] - lo[u]) * j / n[u]; p[v] = lo[v] + (hi[v] - lo[v]) * k / n[v];
      out.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
  }
  return out;
}

/**
 * What of `wall`'s rig shows, read off the scene rather than the planner's own sums, and so good
 * at any fold: each piece's faces are sampled, and a point shows where it stands inside a column's
 * cabinets or open slot, in front of a column, or behind a column where it has no cabinet -- unless
 * another column's cabinets stand between the point and that column's face. A coupler is checked
 * against the columns of other runs only, as the planner checks it: one can reach a fifth of an inch
 * past its column's strip, behind an open slot in the column beside it, on a straight wall too.
 */
function showing(doc: Document, wallId: string, step: number): string[] {
  const byId = byIdOf(doc);
  const wall = wallOf(doc, wallId);
  const dims = wallDims(wall);
  const cells = new Set(filledCells(wall));
  const toWorld = worldMatrix(wall, byId);
  const runOf: number[] = [];
  computeSegments(dims.cols, wall.corners).forEach((s, i) => { for (let c = s.startCol; c <= s.endCol; c++) runOf[c] = i; });
  const T = 2e-3, strip = (dims.panelW + dims.gap) / 2, slab = dims.panelD / 2;
  const cols = computeColumnLayout(dims, wall.corners).map(col => {
    const m = toWorld.clone()
      .multiply(new THREE.Matrix4().makeTranslation(col.x, 0, col.z))
      .multiply(new THREE.Matrix4().makeRotationY(col.rotY));
    // Each unbroken band of cabinets, bottom up; one on the bottom row runs on down to the floor.
    const solid: THREE.Box3[] = [], hides: THREE.Box3[] = [];
    let lo: number | null = null;
    for (let k = 0; k <= dims.rows; k++) {
      const filled = k < dims.rows && cells.has(`${col.col},${dims.rows - 1 - k}`);
      if (filled && lo === null) lo = k === 0 ? -1e6 : k * (dims.panelH + dims.gap);
      else if (!filled && lo !== null) {
        const hi = k * (dims.panelH + dims.gap) - dims.gap;
        solid.push(new THREE.Box3(new THREE.Vector3(-dims.panelW / 2 + T, lo + T, -slab + T), new THREE.Vector3(dims.panelW / 2 - T, hi - T, slab - T)));
        hides.push(new THREE.Box3(new THREE.Vector3(-strip + T, lo + T, -slab + T), new THREE.Vector3(strip - T, hi - T, slab - T)));
        lo = null;
      }
    }
    return { run: runOf[col.col], toWorld: m, toLocal: m.clone().invert(), solid, hides };
  });
  const local = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), end = new THREE.Vector3();
  /** How far the segment from `p` to `q` runs inside `box`. */
  const through = (box: THREE.Box3, p: THREE.Vector3, q: THREE.Vector3): number => {
    let t0 = 0, t1 = 1;
    for (const ax of ['x', 'y', 'z'] as const) {
      const d = q[ax] - p[ax];
      if (Math.abs(d) < 1e-12) { if (p[ax] <= box.min[ax] || p[ax] >= box.max[ax]) return 0; continue; }
      const ta = (box.min[ax] - p[ax]) / d, tb = (box.max[ax] - p[ax]) / d;
      t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 >= t1) return 0;
    }
    return (t1 - t0) * p.distanceTo(q);
  };
  /** Whether cabinets of a column other than `c` stand between world points `p` and `q`. */
  const between = (c: number, p: THREE.Vector3, q: THREE.Vector3): boolean => cols.some((k, i) => {
    if (i === c) return false;
    a.copy(p).applyMatrix4(k.toLocal); b.copy(q).applyMatrix4(k.toLocal);
    return k.hides.some(box => through(box, a, b) > T);
  });
  const fault = (p: THREE.Vector3, skipRun: number): string | null => {
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.run === skipRun) continue;
      local.copy(p).applyMatrix4(c.toLocal);
      if (Math.abs(local.x) >= strip - T) continue;
      const z = local.z;
      if (Math.abs(z) < slab - T) return c.solid.some(box => box.containsPoint(local)) ? `through column ${i}` : `in the open slot of column ${i}`;
      if (z <= slab + T && z >= -slab - T) continue;   // on a face: touching
      if (z < 0 && c.hides.some(box => local.y >= box.min.y - 2 * T && local.y <= box.max.y + 2 * T)) continue;
      end.set(local.x, local.y, z > 0 ? slab : -slab).applyMatrix4(c.toWorld);
      if (!between(i, p, end)) return z > 0 ? `in front of column ${i}` : `behind the open slot of column ${i}`;
    }
    return null;
  };
  /** The run of the column whose back face a coupler is bolted to. */
  const hostRun = (cp: EquipmentEntity): number => {
    const bolt = boltOf(doc, cp);
    let best = -1, gap = Infinity;
    cols.forEach(c => {
      local.copy(bolt).applyMatrix4(c.toLocal);
      const off = Math.abs(local.x) <= dims.panelW / 2 ? Math.abs(local.z + slab) : Infinity;
      if (off < gap) { gap = off; best = c.run; }
    });
    return best;
  };
  const out: string[] = [];
  for (const p of rigOf(doc, wallId)) {
    const box = solidOf(p);
    if (!box) continue;
    const skipRun = p.catalogId === 'clamp-8002' ? hostRun(p) : -1;
    const m = worldMatrix(p, byId);
    for (const q of facePoints(box, step)) {
      const w = q.applyMatrix4(m);
      const f = fault(w, skipRun);
      if (f) { out.push(`${p.name}${p.ghost ? ' (ghost)' : ''} at ${fmt(w)}: ${f}`); break; }
    }
  }
  return out;
}

/** A wall `cols` wide whose column c has cabinets in its top `tops[c]` rows (row 0 is the top). */
function hungWall(cols: number, rows: number, tops: readonly number[]): LedWallEntity {
  const wall = createLedWall({ cols, rows });
  const cells: string[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < tops[c]; r++) cells.push(`${c},${r}`);
  wall.shape = { mode: 'custom', cells };
  return wall;
}

const foldWall = (
  wall: LedWallEntity, afterCol: number, angle: number, scale = 1, yaw = 0, pos?: [number, number, number],
): LedWallEntity => {
  wall.corners = [{ afterCol, angle }];
  wall.transform.scale = [scale, scale, scale];
  wall.transform.rotation = [0, yaw, 0];
  if (pos) wall.transform.position = pos;
  return wall;
};

/** Folded walls that once had truss or couplers showing past the cabinets of the run across the fold. */
const FOLDS: [string, () => LedWallEntity][] = [
  ['4 x 3 folded 90 degrees after column 1', () => foldWall(createLedWall({ cols: 4, rows: 3 }), 1, 90)],
  ['4 x 3 folded 120 degrees after column 1', () => foldWall(createLedWall({ cols: 4, rows: 3 }), 1, 120)],
  ['7 x 4 folded 90 degrees after column 3', () => foldWall(createLedWall({ cols: 7, rows: 4 }), 3, 90)],
  ['7 x 4 folded -90 degrees after column 3', () => foldWall(createLedWall({ cols: 7, rows: 4 }), 3, -90)],
  ['8 x 3 folded 135 degrees after column 3', () => foldWall(createLedWall({ cols: 8, rows: 3 }), 3, 135)],
  ['8 x 3 folded -135 degrees after column 3', () => foldWall(createLedWall({ cols: 8, rows: 3 }), 3, -135)],
  ['a ragged 7 x 5 folded 90 degrees, at twice size and turned', () => foldWall(hungWall(7, 5, [2, 5, 5, 1, 1, 3, 4]), 3, 90, 2, -20, [-2, 0, 59])],
  ['a 5 x 3 a row short at one end, folded -135 degrees at twice size', () => foldWall(hungWall(5, 3, [3, 3, 3, 3, 2]), 2, -135, 2)],
  ['a ragged 6 x 4 folded -90 degrees', () => foldWall(hungWall(6, 4, [4, 3, 1, 4, 2, 4]), 2, -90)],
  ['a ragged 6 x 4 folded 90 degrees', () => foldWall(hungWall(6, 4, [4, 3, 1, 4, 2, 4]), 2, 90)],
  ['6 x 3 folded -90 degrees at 1.5 times size, turned 35 degrees', () => foldWall(createLedWall({ cols: 6, rows: 3 }), 2, -90, 1.5, 35)],
];

/** A seeded random number generator (mulberry32), so a sweep draws the same walls every run. */
const seeded = (seed: number) => (): number => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A wall of up to 14 x 10 with one to three folds, drawn from `seed`: whole, notched, an arch, or
 * holed at random; bezels on or off; moved, turned and scaled; one in ten on a stage deck.
 */
function foldedScene(seed: number): { doc: Document; wall: LedWallEntity } {
  const r = seeded(seed), ri = (a: number, b: number): number => a + Math.floor(r() * (b - a + 1));
  const cols = ri(1, 14), rows = ri(1, 10);
  const wall = createLedWall({ cols, rows, bezels: r() < 0.8, position: [ri(-60, 60), r() < 0.2 ? ri(1, 20) : 0, ri(-60, 60)] });
  wall.transform.rotation = [0, r() < 0.5 ? 0 : ri(-180, 180), 0];
  if (r() < 0.3) { const sc = [1.5, 2, 0.5][ri(0, 2)]; wall.transform.scale = [sc, sc, sc]; }
  const kind = ri(0, 3);
  if (kind > 0) {
    const cells: string[] = [];
    const tops = Array.from({ length: cols }, () => ri(0, rows - 1));
    const lintel = ri(1, Math.max(1, rows - 1));
    const piers = new Set(Array.from({ length: cols }, (_, c) => c).filter(() => r() < 0.4));
    for (let c = 0; c < cols; c++) for (let rr = 0; rr < rows; rr++) {
      const keep = kind === 1 ? rr >= tops[c] : kind === 2 ? (piers.has(c) || rr < lintel) : r() < 0.8;
      if (keep) cells.push(`${c},${rr}`);
    }
    if (cells.length) wall.shape = { mode: 'custom', cells };
  }
  if (cols > 1) {
    const n = ri(1, Math.min(3, cols - 1));
    const used = new Set<number>();
    wall.corners = [];
    for (let i = 0; i < n; i++) {
      const at = ri(0, cols - 2);
      if (used.has(at)) continue;
      used.add(at);
      wall.corners.push({ afterCol: at, angle: [90, -90, 120, -120, 135, -135, 150, -150, 45, -45, 30, -30][ri(0, 11)] });
    }
    wall.corners.sort((p, q) => p.afterCol - q.afterCol);
  }
  if (r() < 0.1) {
    const deck = createStage(ri(12, 36));
    wall.transform.position[1] = deck.heightIn;
    wall.attachedTo = deck.id;
    return { doc: docWith(deck, wall), wall };
  }
  return { doc: docWith(wall), wall };
}

describe('every rig it draws, across folds', () => {
  it.each(FOLDS)('%s: shows nothing past the cabinets', (_, make) => {
    const wall = make();
    const doc = docWith(wall);
    expect(showing(applyTrussRig(doc, wall, planTrussRig(doc, wall)), wall.id, 0.5)).toEqual([]);
  });

  it('shows nothing past the cabinets on folded walls drawn at random', () => {
    let walls = 0, rigged = 0;
    for (let seed = 20001; seed <= 20060; seed++) {
      const { doc, wall } = foldedScene(seed);
      if (!wall.corners.length) continue;
      walls++;
      const after = applyTrussRig(doc, wall, planTrussRig(doc, wall));
      if (rigOf(after, wall.id).length) rigged++;
      expect(showing(after, wall.id, 1), `seed ${seed}`).toEqual([]);
    }
    expect(walls).toBe(59);
    // Strict across a fold, the planner leaves some walls bare: 28 of these 59 get a rig.
    expect(rigged).toBeGreaterThanOrEqual(28);
  }, 60000);
});

describe('applyTrussRig', () => {
  it('plans round a stick the catalog no longer carries, and leaves it be', () => {
    // A scene saved with a stick since taken out of the catalog stands apart from the wall. The plan
    // is the one the wall gets alone, and the stick is untouched.
    const wall = createLedWall({ cols: 11, rows: 4 });
    const stale = createEquipment({
      id: 'gp-truss-7ft', name: 'DT-GP7 box truss 7 ft', geometry: 'truss', dims: [84, SECTION, SECTION], color: '#17181b',
    }, [0, 0, 200]);
    expect(equipmentDef(stale.catalogId)).toBeUndefined();
    const doc = docWith(wall, stale);
    const plan = planTrussRig(doc, wall);
    expect(plan).toEqual(planTrussRig(docWith(wall), wall));
    expect(applyTrussRig(doc, wall, plan).entities.find(e => e.id === stale.id)).toEqual(stale);
  });

  it('adds one group holding every piece, and moves the wall onto the plates', () => {
    const wall = createLedWall({ cols: 2, rows: 3, position: [0, 10, 0] });
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const after = applyTrussRig(doc, wall, plan);

    const groups = after.entities.filter((e): e is GroupEntity => e.type === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: RIG_GROUP_NAME, rigFor: wall.id });
    const pieces = equipmentOf(after);
    expect(pieces).toHaveLength(plan.legs.reduce((n, l) => n + l.pieces.length, 0) + plan.spans.length + plan.clamps.length);
    expect(pieces.every(p => p.parentId === groups[0].id)).toBe(true);
    expect(wallOf(after, wall.id).transform.position[1]).toBeCloseTo(PLATE, 9);
    expect(wall.transform.position[1]).toBe(10);   // the input is left as it was
    expect(doc.entities).toEqual([wall]);
  });

  it('replaces its own rig when run again, and moves nothing the second time', () => {
    const wall = createLedWall({ cols: 11, rows: 8 });
    const once = applyTrussRig(docWith(wall), wall, planTrussRig(docWith(wall), wall));
    const first = rigEntityIds(once, wall.id);

    const again = planTrussRig(once, wallOf(once, wall.id));
    expect(again.liftIn).toBeCloseTo(0, 9);
    expect(again.ghosts).toBe(0);   // its own rig is not stock in use elsewhere
    const twice = applyTrussRig(once, wallOf(once, wall.id), again);
    const second = rigEntityIds(twice, wall.id);

    expect(twice.entities).toHaveLength(once.entities.length);
    expect(second.size).toBe(first.size);
    expect([...first].some(id => second.has(id))).toBe(false);
  });

  it("leaves another wall's rig alone", () => {
    const a = createLedWall({ cols: 2, rows: 3 });
    const b = createLedWall({ cols: 2, rows: 3, position: [200, 0, 0] });
    let doc = docWith(a, b);
    doc = applyTrussRig(doc, a, planTrussRig(doc, a));
    doc = applyTrussRig(doc, b, planTrussRig(doc, b));
    const bRig = rigEntityIds(doc, b.id);
    expect(bRig.size).toBe(1 + 1 + 1 + 3);   // the group, a base, a 4 ft stick, three couplers

    const a2 = wallOf(doc, a.id);
    doc = applyTrussRig(doc, a2, planTrussRig(doc, a2));
    const ids = new Set(doc.entities.map(e => e.id));
    expect([...bRig].every(id => ids.has(id))).toBe(true);
  });
});
