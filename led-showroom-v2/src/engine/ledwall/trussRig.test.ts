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
import { computeColumnLayout, filledCells, wallDims, wallMountPoints } from './layout';
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
const PLATE = 1;                              // DT-GP base: a plate on the floor, nothing standing on it
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
    expect(owned('gp-truss-4ft')).toBe(8);
    expect(owned('gp-corner-6way')).toBe(6);
    expect(owned(BASE_ID)).toBe(6);
    expect(owned('clamp-8002')).toBe(38);
  });
});

describe('planTrussRig', () => {
  it('stands a 2 x 3 on two towers of a plate and a 4 ft stick, a plate apart, and sets it down on the plates', () => {
    const wall = createLedWall({ cols: 2, rows: 3 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.frames).toBe(0);
    expect(plan.spans).toEqual([]);
    expect(plan.headerY).toBeNull();
    expect(plan.legs.map(l => l.kind)).toEqual(['tower', 'tower']);
    // Each inboard of the outer hole line it grips; the second skips its column's inner line, which
    // would put the two plates on top of each other.
    const xs = [-(STEP / 2 + HX - CO), STEP / 2 + HX - CO];
    plan.legs.forEach((leg, i) => {
      expect(leg.axis[0]).toBeCloseTo(xs[i], 5);
      expect(leg.axis[1]).toBeCloseTo(LEG_Z, 5);
      expect(leg.axis[1] + SECTION / 2).toBeLessThan(-PD / 2);   // the whole section behind the cabinet
      expect(leg.rotY).toBeCloseTo(0, 9);
      // Three rows on the plates top out at 57.82 in: a 4 ft stick on a plate (49 in) fits under
      // them, and a 5 ft one (61 in) would not.
      expect(leg.pieces.map(p => p.catalogId)).toEqual([BASE_ID, 'gp-truss-4ft']);
      expect(leg.pieces.map(p => p.geometry)).toEqual(['truss-base', 'truss-vertical']);
      expect(leg.pieces.map(p => p.position[1])).toEqual([0, PLATE]);
      for (const p of leg.pieces) {
        expect(p.position[0]).toBeCloseTo(leg.axis[0], 9);
        expect(p.position[2]).toBeCloseTo(leg.axis[1], 9);
      }
      expect(leg.topY).toBeCloseTo(PLATE + 48, 9);
    });

    // The plate reaches forward under the cabinets, so the wall stands on it: an inch up, no shim.
    expect(plan.bottomY).toBeCloseTo(PLATE, 9);
    expect(plan.liftIn).toBeCloseTo(PLATE, 9);
    expect(plan.shimIn).toBe(0);
    expect(plan.warnings).toContain('The wall rises 1.00 in to sit on the 1.00 in base plates.');

    // Per leg, the holes on its line between the stick's ends. The stick stands where the wall does,
    // so each hole is its own height up the stick: 1.20 in sits on the foot weld and 36.66 in on the
    // panel weld at 36, which leaves the bottom row's top hole and the bottom holes of the two rows
    // above it. The top row's top hole, 55.62 in up, is past the stick's 48.
    expect(plan.clamps).toHaveLength(6);
    expect(plan.skipped).toEqual({ offFace: 0, weld: 4 });
    expect([plan.held, plan.columns, plan.ghosts]).toEqual([2, 2, 0]);

    const after = applyTrussRig(docWith(wall), wall, plan);
    const left = equipmentOf(after).filter(e => e.catalogId === 'clamp-8002')
      .map(c => boltOf(after, c)).filter(b => b.x < 0).sort((a, b) => a.y - b.y);
    expect(left).toHaveLength(3);
    near(left[0], -STEP / 2 - HX, PLATE + HIGH, -PD / 2);
    near(left[1], -STEP / 2 - HX, PLATE + PITCH + LOW, -PD / 2);
    near(left[2], -STEP / 2 - HX, PLATE + 2 * PITCH + LOW, -PD / 2);
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

    expect([plan.held, plan.columns]).toEqual([11, 11]);
    expect(plan.ghosts).toBe(0);
    expect(plan.shortfall).toEqual([]);
    expect(plan.clamps.length).toBeLessThanOrEqual(38);
  });

  it('puts towers a plate apart where no header fits, and leaves the columns between them hanging', () => {
    // Three rows are too short for a frame: a block on a 4 ft stick tops out at 60.16 in, over their 57.82.
    const wall = createLedWall({ cols: 8, rows: 3 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.frames).toBe(0);
    expect(plan.legs.every(l => l.kind === 'tower')).toBe(true);
    const xs = plan.legs.map(l => l.axis[0]);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(36 - 1e-9);
    expect([plan.held, plan.columns]).toEqual([6, 8]);
    expect(plan.warnings).toContain('2 columns have no coupler and hang off their neighbours.');
  });

  it('draws what it needs past our stock as ghosts, and says what is short', () => {
    // Towers a plate apart hold eight of eleven columns: eight bases, two past our six. Eight 4 ft
    // sticks are all we own and 24 couplers are well inside our 38, so the bases are all that is short.
    const wall = createLedWall({ cols: 11, rows: 3 });
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const name = equipmentDef(BASE_ID)!.name;

    expect(plan.legs).toHaveLength(8);
    const bases = plan.legs.map(l => l.pieces[0]);
    expect(bases.map(b => b.ghost)).toEqual([false, false, false, false, false, false, true, true]);
    expect(plan.ghosts).toBe(2);
    expect(plan.shortfall).toEqual([{ catalogId: BASE_ID, name, need: 8, have: 6 }]);
    expect(plan.warnings).toContain(`${name}: 8 needed, 6 available - 2 drawn as ghosts.`);

    const ghosts = equipmentOf(applyTrussRig(doc, wall, plan)).filter(e => e.ghost);
    expect(ghosts).toHaveLength(2);
    for (const g of ghosts) {
      expect(g.catalogId).toBe(BASE_ID);
      expect(g.name).toBe(`${name} (not owned)`);
    }
  });

  it('counts stock already standing elsewhere in the scene, but not ghosts', () => {
    const def = equipmentDef(BASE_ID)!;
    const placed = (n: number, ghost: number): EquipmentEntity[] => Array.from({ length: n }, (_, i) => {
      const e = createEquipment(def, [300 + 40 * i, 0, 0]);
      if (i < ghost) e.ghost = true;
      return e;
    });

    const wall = createLedWall({ cols: 2, rows: 3 });
    const short = planTrussRig(docWith(wall, ...placed(5, 0)), wall);
    expect(short.legs.map(l => l.pieces[0].ghost)).toEqual([false, true]);
    expect(short.shortfall).toEqual([{ catalogId: BASE_ID, name: def.name, need: 2, have: 1 }]);

    const enough = planTrussRig(docWith(wall, ...placed(5, 1)), wall);
    expect(enough.ghosts).toBe(0);
  });

  it('brings a wall standing higher down onto the plates', () => {
    const wall = createLedWall({ cols: 2, rows: 3, position: [0, 10, 0] });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.bottomY).toBeCloseTo(PLATE, 9);
    expect(plan.liftIn).toBeCloseTo(PLATE - 10, 9);
    expect(plan.liftLocalIn).toBeCloseTo(PLATE - 10, 9);
    expect(plan.warnings).toContain('The wall comes down 9.00 in to sit on the 1.00 in base plates.');
    expect(plan.legs.every(l => l.pieces[0].position[1] === 0)).toBe(true);
  });

  it('stands the legs on a stage deck the wall rides', () => {
    const { doc, wall } = onDeck();
    const plan = planTrussRig(doc, wall);

    expect(plan.legs).toHaveLength(2);
    for (const leg of plan.legs) expect(leg.pieces[0].position[1]).toBeCloseTo(24, 9);
    expect(plan.bottomY).toBeCloseTo(24 + PLATE, 9);
    expect(plan.liftIn).toBeCloseTo(PLATE, 9);
  });

  it('frames the full-height columns of a notched wall and gives the short one a tower under its top', () => {
    const wall = notched();
    const plan = planTrussRig(docWith(wall), wall);
    const W = 8 * PW + 7 * GAP;
    const col7 = -W / 2 + 7 * STEP;                    // left edge of the short column's face
    const top7 = plan.bottomY + 3 * PITCH - GAP;      // its top

    expect(plan.frames).toBe(1);
    for (const s of plan.spans) expect(s.position[0] + s.dims[0] / 2).toBeLessThan(col7);
    for (const l of plan.legs.filter(g => g.kind === 'frame')) expect(l.axis[0] + SECTION / 2).toBeLessThan(col7);

    const towers = plan.legs.filter(g => g.kind === 'tower');
    expect(towers).toHaveLength(1);
    expect(towers[0].axis[0] - SECTION / 2).toBeGreaterThanOrEqual(col7);
    expect(towers[0].axis[0] + SECTION / 2).toBeLessThanOrEqual(W / 2);
    expect(towers[0].topY).toBeLessThanOrEqual(top7);
    expect(plan.clamps.some(c => c.position[0] > col7)).toBe(true);
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
    // The shortest leg is a plate and a 4 ft stick, 49 in: over one row on the plates and over two.
    for (const rows of [1, 2]) {
      const short = createLedWall({ cols: 2, rows });
      const plan = planTrussRig(docWith(short), short);
      expect(plan.legs).toEqual([]);
      expect(plan.clamps).toEqual([]);
      expect(plan.warnings.join(' ')).toMatch(/taller than the wall/);
    }
    const two = createLedWall({ cols: 2, rows: 2 });
    expect(planTrussRig(docWith(two), two).warnings).toContain('The shortest leg, a base plate and a 4 ft stick, stands '
      + '49.0 in: taller than the wall in front of it, which stands 38.9 in, so it would show above it.');

    const tilted = createLedWall({ cols: 2, rows: 2 });
    tilted.transform.rotation = [10, 0, 0];
    const t = planTrussRig(docWith(tilted), tilted);
    expect(t.legs).toEqual([]);
    expect(t.warnings.join(' ')).toMatch(/tilted/);
  });
});

/** Walls of every shape the planner handles, each as a scene with the wall in it. */
const SCENES: [string, () => { doc: Document; wall: LedWallEntity }][] = [
  ['2 x 3', () => solo(createLedWall({ cols: 2, rows: 3 }))],
  ['8 x 3', () => solo(createLedWall({ cols: 8, rows: 3 }))],
  ['8 x 4', () => solo(createLedWall({ cols: 8, rows: 4 }))],
  ['11 x 8', () => solo(createLedWall({ cols: 11, rows: 8 }))],
  ['11 x 8 without bezels', () => solo(createLedWall({ cols: 11, rows: 8, bezels: false }))],
  ['11 x 3, past our bases', () => solo(createLedWall({ cols: 11, rows: 3 }))],
  ['8 x 6 with a notch', () => solo(notched())],
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

  // The folds are left out: a fold's columns do not stand square to the wall's own frame.
  it.each(SCENES.filter(([name]) => !name.includes('folded')))('%s: hides every truss behind the cabinets', (_, make) => {
    const { doc, wall } = make();
    const after = applyTrussRig(doc, wall, planTrussRig(doc, wall));
    const toLocal = worldMatrix(wallOf(after, wall.id), byIdOf(after)).invert();
    const { cols, rows } = wall;
    const gap = wall.bezels ? GAP : 0;
    const W = cols * PW + (cols - 1) * gap;
    // How tall each column's unbroken stack of cabinets stands, from the bottom (row 0 is the top).
    const cells = new Set(filledCells(wall));
    const tops = Array.from({ length: cols }, (_, c) => {
      let n = 0;
      while (n < rows && cells.has(`${c},${rows - 1 - n}`)) n++;
      return n * (PH + gap) - gap;
    });
    const topAt = (x: number): number => Math.min(...tops.filter((_, c) =>
      Math.abs(x - (-W / 2 + PW / 2 + c * (PW + gap))) <= (PW + gap) / 2 + 1e-6));

    const truss = rigOf(after, wall.id).filter(isTruss);
    expect(truss.length).toBeGreaterThan(0);
    for (const p of truss) {
      for (const v of trussCorners(after, p).map(c => c.applyMatrix4(toLocal))) {
        expect(Math.abs(v.x), `${p.name} pokes out past the side at ${fmt(v)}`).toBeLessThanOrEqual(W / 2 + 1e-6);
        expect(v.y, `${p.name} shows over the top at ${fmt(v)}`).toBeLessThanOrEqual(topAt(v.x) + 1e-6);
        expect(v.z, `${p.name} comes through the cabinet at ${fmt(v)}`).toBeLessThanOrEqual(-PD / 2 + 1e-6);
      }
    }
  });
});

describe('applyTrussRig', () => {
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
    expect(bRig.size).toBe(1 + 2 + 2 + 6);   // the group, two bases, two 4 ft sticks, six couplers

    const a2 = wallOf(doc, a.id);
    doc = applyTrussRig(doc, a2, planTrussRig(doc, a2));
    const ids = new Set(doc.entities.map(e => e.id));
    expect([...bRig].every(id => ids.has(id))).toBe(true);
  });
});
