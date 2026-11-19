import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { matrixOf } from '../behaviours';
import { equipmentDef } from '../catalog/equipment';
import { chordOffsetIn, clampMetrics, diagonalRadiusIn } from '../catalog/trussMetrics';
import { createDocument, createLedWall } from '../document/defaults';
import type {
  Document, EquipmentEntity, GroupEntity, LedWallEntity, Transform,
} from '../document/types';
import type { Vec3 } from '../math';
import { IPOSTER } from './specs';
import { applyTrussRig, planTrussRig, rigEntityIds, RIG_GROUP_NAME, type RigPiece } from './trussRig';

/**
 * Reference numbers for a 1x1 iPoster at the origin, worked out by hand from the panel spec.
 *
 * Deliberately NOT read back from `wallMountPoints`, nor from the planner's own frame maths: a test
 * that asks the planner where it put a coupler, in the frame the planner chose, passes just as
 * happily with a missing lift or an inverted normal. These are the numbers the spec comment states.
 */
const PW = 25.2, PH = 18.9, PD = 1.77;        // iPoster, inches
const HX = 11.40315;                          // hole centre, in from each side edge of the face
const HY = 8.25315;                           // hole centre, up/down from the face centre
const ROW_Y = 9.45;                           // a single row's centre, off the floor
const SECTION = 11.16;                        // DT-GP section, from the catalog dims
const CO = 4.5957480;                         // axis to chord: section / 2 minus the 50 mm radius
const REACH = 1.96875;                        // 8002 bolt face to the chord axis in its jaw

const docWith = (...entities: (LedWallEntity | EquipmentEntity | GroupEntity)[]): Document => ({
  ...createDocument(),
  entities: [...entities],
});

const asEntity = (p: RigPiece): { transform: Transform; dims: Vec3 } => ({
  transform: { position: [...p.position] as Vec3, rotation: [...p.rotation] as Vec3, scale: [1, 1, 1] },
  dims: [...p.dims] as Vec3,
});

/** A local point of a placed piece in world space, through the transform the renderer uses. */
const at = (e: { transform: Transform }, lx: number, ly: number, lz: number): THREE.Vector3 =>
  new THREE.Vector3(lx, ly, lz).applyMatrix4(matrixOf(e.transform));

/** Where the bolt sits on a coupler: the back face of its plate, half way up. See `buildClamp`. */
const boltOf = (c: { transform: Transform; dims: Vec3 }): THREE.Vector3 =>
  at(c, 0, c.dims[1] / 2, -c.dims[2] / 2);

/** Where the gripped chord runs: the axis of the jaw, one reach clear of the plate. */
const jawOf = (c: { transform: Transform; dims: Vec3 }): THREE.Vector3 =>
  at(c, 0, c.dims[1] / 2, -c.dims[2] / 2 + clampMetrics(c.dims).reachIn);

const near = (v: THREE.Vector3, x: number, y: number, z: number, p = 5): void => {
  expect(v.x).toBeCloseTo(x, p);
  expect(v.y).toBeCloseTo(y, p);
  expect(v.z).toBeCloseTo(z, p);
};

const clampsOf = (doc: Document): EquipmentEntity[] => doc.entities
  .filter((e): e is EquipmentEntity => e.type === 'equipment' && e.catalogId === 'clamp-8002');

describe('the numbers a rig is laid out from', () => {
  it('are the ones the panel spec and the catalog publish', () => {
    expect([IPOSTER.widthIn, IPOSTER.heightIn, IPOSTER.depthIn]).toEqual([PW, PH, PD]);
    expect(PW / 2 - (1 + 0.3937 / 2)).toBeCloseTo(HX, 9);
    expect(PH / 2 - (1 + 0.3937 / 2)).toBeCloseTo(HY, 9);
    expect(equipmentDef('gp-base-36')!.dims).toEqual([SECTION, 36, SECTION]);
    expect(chordOffsetIn(SECTION)).toBeCloseTo(CO, 7);
    expect(clampMetrics(equipmentDef('clamp-8002')!.dims).reachIn).toBeCloseTo(REACH, 9);
  });
});

describe('planTrussRig', () => {
  it('puts one tower behind the single column, inboard of the hole line it grips', () => {
    const wall = createLedWall({ cols: 1, rows: 1 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.towers).toHaveLength(1);
    const t = plan.towers[0];
    // Inboard of the left hole column, and back by the coupler's reach plus the chord's own inset.
    expect(t.axis[0]).toBeCloseTo(-HX + CO, 5);
    expect(t.axis[1]).toBeCloseTo(-PD / 2 - REACH - CO, 5);
    expect(t.rotY).toBeCloseTo(0, 9);
    // The whole 11.16 in section lands behind the cabinet, not through it.
    expect(t.axis[1] + SECTION / 2).toBeLessThan(-PD / 2);
    // One row reaches nowhere near the top of a 36 in base, so nothing is stacked on it.
    expect(t.pieces).toHaveLength(1);
    expect(t.pieces[0].catalogId).toBe('gp-base-36');
    expect(t.pieces[0].position).toEqual([t.axis[0], 0, t.axis[1]]);
    expect(t.topY).toBeCloseTo(36, 9);
  });

  it('lands every bolt in a hole and every jaw on the gripped chord', () => {
    const wall = createLedWall({ cols: 1, rows: 1 });
    const plan = planTrussRig(docWith(wall), wall);
    const lift = plan.liftIn;

    // The lower hole sits 1.19685 in up, and a jaw needs 1.13 in to clear the base plate it stands
    // on -- that part fits. What does not is the end-frame weld 0.49 in up the chord: the jaw is
    // 0.63 in each way and the diagonal 0.49 in across, so the hole has to stand 1.61 in up the
    // stick, and the search finds that at one inch of rise.
    expect(lift).toBeCloseTo(1, 6);
    expect(plan.skipped).toEqual({ offFace: 0, weld: 0, aboveTop: 0 });
    expect(plan.clamps).toHaveLength(2);
    expect(plan.liftLocalIn).toBeCloseTo(lift, 9);

    const clamps = clampsOf(applyTrussRig(docWith(wall), wall, plan));
    expect(clamps).toHaveLength(2);

    const want = [ROW_Y - HY + lift, ROW_Y + HY + lift];
    const got = [...clamps].sort((a, b) => boltOf(a).y - boltOf(b).y);
    got.forEach((c, i) => near(boltOf(c), -HX, want[i], -PD / 2));
    // And each jaw closes on the chord one reach behind that hole -- the chord the tower put there.
    for (const c of clamps) {
      const jaw = jawOf(c);
      expect(jaw.x).toBeCloseTo(-HX, 5);
      expect(jaw.z).toBeCloseTo(-PD / 2 - REACH, 5);
      expect(jaw.x).toBeCloseTo(plan.towers[0].axis[0] - CO, 5);
      expect(jaw.z).toBeCloseTo(plan.towers[0].axis[1] + CO, 5);
    }
  });

  it('spends a whole bay of rise when that is what it takes to clear every splice', () => {
    // The guard on the size of the search window. One inch of rise clears the end frame under a
    // single row, but every row has to clear at once, and two sticks meeting stand their end
    // frames back to back: a 3.2 in dead band, wider than the 2.24 in it takes to shift one hole
    // off one weld. A four-row wall lands all eight holes in clear tube only at 7.6 in. A window
    // derived from a single keep-out would strand couplers on every wall this tall.
    const wall = createLedWall({ cols: 1, rows: 4 });
    const plan = planTrussRig(docWith(wall), wall);
    const jawHalf = 1.26 / 2;                                 // the 8002, across its jaw

    expect(plan.liftIn).toBeCloseTo(7.6, 6);
    expect(plan.liftIn).toBeGreaterThan(2 * (jawHalf + diagonalRadiusIn(SECTION)));
    expect(plan.skipped).toEqual({ offFace: 0, weld: 0, aboveTop: 0 });
    expect(plan.clamps).toHaveLength(8);
  });

  it('carries the whole rig round with a yawed wall', () => {
    const wall = createLedWall({ cols: 1, rows: 1, position: [40, 0, -10] });
    wall.transform.rotation = [0, 90, 0];
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.clamps).toHaveLength(2);
    expect(plan.towers[0].rotY).toBeCloseTo(90, 5);
    // A +90 yaw sends wall-local +X to world -Z and local +Z to world +X, so a local (lx, lz)
    // lands at (40 + lz, -10 - lx).
    expect(plan.towers[0].axis[0]).toBeCloseTo(40 + (-PD / 2 - REACH - CO), 5);
    expect(plan.towers[0].axis[1]).toBeCloseTo(-10 - (-HX + CO), 5);

    for (const c of clampsOf(applyTrussRig(docWith(wall), wall, plan))) {
      const bolt = boltOf(c), jaw = jawOf(c);
      // The bolt is in the wall's back face, which after that yaw is the plane x = 40 - PD / 2.
      expect(bolt.x).toBeCloseTo(40 - PD / 2, 5);
      expect(Math.abs(bolt.z + 10)).toBeCloseTo(HX, 5);
      // The chord runs vertically, one reach straight back from the hole.
      expect(jaw.x).toBeCloseTo(40 - PD / 2 - REACH, 5);
      expect(jaw.z).toBeCloseTo(bolt.z, 5);
      expect(jaw.y).toBeCloseTo(bolt.y, 5);
    }
  });

  it('gives every column of a folded wall its own tower, square to its own run', () => {
    const wall = createLedWall({ cols: 4, rows: 2 });
    wall.corners = [{ afterCol: 1, angle: 90 }];
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.towers).toHaveLength(4);
    expect(new Set(plan.towers.map(t => Math.round(t.rotY))).size).toBe(2);   // two runs, two headings
    // A 90 degree mitre trims 0.885 in off the back face and the holes sit 1.19685 in in, so they
    // all survive it. One hole line per column, and a line takes both of each cabinet's holes on
    // that edge: 4 columns x 2 rows x 2 holes.
    expect(plan.skipped).toEqual({ offFace: 0, weld: 0, aboveTop: 0 });
    expect(plan.clamps).toHaveLength(16);

    for (const c of plan.clamps.map(asEntity)) {
      const bolt = boltOf(c), jaw = jawOf(c);
      expect(bolt.distanceTo(jaw)).toBeCloseTo(REACH, 5);
      expect(Math.abs(jaw.y - bolt.y)).toBeLessThan(1e-9);                   // the chord is vertical
    }
  });

  it('falls back to the far hole line when a tight fold cuts the near one away', () => {
    const wall = createLedWall({ cols: 4, rows: 2 });
    wall.corners = [{ afterCol: 1, angle: 120 }];
    const plan = planTrussRig(docWith(wall), wall);

    // 120 degrees trims 1.533 in, which is past the holes: both columns at the fold lose the four
    // holes on their inside edge.
    expect(plan.skipped.offFace).toBe(8);
    // Every column still gets a leg, and the one whose left line went uses its right line instead.
    expect(plan.towers.map(t => t.col)).toEqual([0, 1, 2, 3]);
    expect(plan.clamps).toHaveLength(16);
    expect(plan.warnings.join(' ')).not.toContain('no line of holes left');

    for (const c of plan.clamps.map(asEntity)) {
      expect(boltOf(c).distanceTo(jawOf(c))).toBeCloseTo(REACH, 5);
    }
  });

  it('takes the floor-stand kit off, because its back supports stand where the legs do', () => {
    const wall = createLedWall({ cols: 2, rows: 2, accessories: true });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.dropAccessories).toBe(true);
    expect(plan.warnings.join(' ')).toContain('floor-stand');
    const next = applyTrussRig(docWith(wall), wall, plan);
    expect((next.entities.find(e => e.id === wall.id) as LedWallEntity).accessories).toBe(false);
  });

  it('stacks sticks on the base for a wall taller than the riser', () => {
    const wall = createLedWall({ cols: 1, rows: 5 });
    const plan = planTrussRig(docWith(wall), wall);
    const t = plan.towers[0];

    expect(t.pieces[0].catalogId).toBe('gp-base-36');
    expect(t.pieces.length).toBeGreaterThan(1);
    for (const p of t.pieces.slice(1)) {
      expect(p.geometry).toBe('truss-vertical');
      // Stood on end: section, length, section -- not the lying-down catalog dims.
      expect(p.dims[0]).toBeCloseTo(SECTION, 6);
      expect(p.dims[2]).toBeCloseTo(SECTION, 6);
      expect(p.dims[1]).toBeGreaterThan(SECTION);
    }
    // Flush stack: no gap at a splice and no piece inside another.
    let y = 0;
    for (const p of t.pieces) {
      expect(p.position[1]).toBeCloseTo(y, 6);
      y += p.dims[1];
    }
    expect(t.topY).toBeCloseTo(y, 6);
    // And it stands past the top coupler rather than ending underneath it.
    const highest = Math.max(...plan.clamps.map(c => boltOf(asEntity(c)).y));
    expect(t.topY).toBeGreaterThan(highest);
    expect(plan.skipped.aboveTop).toBe(0);
  });

  it('refuses a tilted wall rather than drawing chords that miss', () => {
    const wall = createLedWall({ cols: 2, rows: 2 });
    wall.transform.rotation = [12, 0, 0];
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.towers).toHaveLength(0);
    expect(plan.clamps).toHaveLength(0);
    expect(plan.liftIn).toBe(0);
    expect(plan.warnings.join(' ')).toContain('tilted');
  });

  it('says so when a rig needs more hardware than we own', () => {
    const wall = createLedWall({ cols: 8, rows: 4 });
    const plan = planTrussRig(docWith(wall), wall);

    expect(plan.towers).toHaveLength(8);
    expect(plan.warnings.join('\n')).toContain('DT-GP raised base 36 in: 8 needed, 6 owned.');
  });
});

describe('applyTrussRig', () => {
  it('parents the rig to one identity group tagged with the wall', () => {
    const wall = createLedWall({ cols: 2, rows: 2 });
    const plan = planTrussRig(docWith(wall), wall);
    const next = applyTrussRig(docWith(wall), wall, plan);

    const groups = next.entities.filter((e): e is GroupEntity => e.type === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0].rigFor).toBe(wall.id);
    expect(groups[0].name).toBe(RIG_GROUP_NAME);
    // Identity, because every child already carries world coordinates.
    expect(groups[0].transform.position).toEqual([0, 0, 0]);
    expect(groups[0].transform.rotation).toEqual([0, 0, 0]);
    expect(groups[0].transform.scale).toEqual([1, 1, 1]);

    const parts = next.entities.filter((e): e is EquipmentEntity => e.type === 'equipment');
    expect(parts).toHaveLength(plan.towers.flatMap(t => t.pieces).length + plan.clamps.length);
    for (const p of parts) expect(p.parentId).toBe(groups[0].id);
  });

  it('replaces the previous rig instead of stacking a second one on top of it', () => {
    const wall = createLedWall({ cols: 2, rows: 2 });
    const first = applyTrussRig(docWith(wall), wall, planTrussRig(docWith(wall), wall));
    const w1 = first.entities.find(e => e.id === wall.id) as LedWallEntity;
    expect(w1.transform.position[1]).toBeGreaterThan(0);                 // it rose the first time

    const second = applyTrussRig(first, w1, planTrussRig(first, w1));
    expect(second.entities.filter(e => e.type === 'group')).toHaveLength(1);
    expect(second.entities.filter(e => e.type === 'equipment'))
      .toHaveLength(first.entities.filter(e => e.type === 'equipment').length);
    // Idempotent: the second pass finds the wall already clear and leaves it where it is.
    expect((second.entities.find(e => e.id === wall.id) as LedWallEntity).transform.position)
      .toEqual(w1.transform.position);
  });

  it("leaves another wall's rig alone", () => {
    const a = createLedWall({ cols: 1, rows: 1 });
    const b = createLedWall({ cols: 1, rows: 1, position: [200, 0, 0] });
    let doc = docWith(a, b);
    doc = applyTrussRig(doc, a, planTrussRig(doc, a));
    const movedA = (doc.entities.find(e => e.id === a.id) as LedWallEntity).transform.position;
    doc = applyTrussRig(doc, b, planTrussRig(doc, b));

    expect(doc.entities.filter(e => e.type === 'group')).toHaveLength(2);
    const ra = rigEntityIds(doc, a.id), rb = rigEntityIds(doc, b.id);
    expect(ra.size).toBe(1 + 1 + 2);                                     // group, base, two couplers
    expect(rb.size).toBe(ra.size);
    expect([...ra].some(id => rb.has(id))).toBe(false);
    expect((doc.entities.find(e => e.id === a.id) as LedWallEntity).transform.position)
      .toEqual(movedA);
  });
});
