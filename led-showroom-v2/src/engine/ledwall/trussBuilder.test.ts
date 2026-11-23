import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { worldMatrix } from '../behaviours';
import { createDocument, createLedWall } from '../document/defaults';
import type { Document, Entity, GroupEntity, LedWallEntity } from '../document/types';
import { applyTrussRig, planTrussRig, rigEntityIds, type RigPiece, type TrussRigOptions, type TrussRigPlan } from './trussRig';
import {
  applyBuild, attach, autoTrussRig, baseAt, check, fillGap, gapFrom, openBuilder, openPorts, portsOf, removePiece, stockLeft, summarize,
  type BuildPiece, type Builder, type Port,
} from './trussBuilder';

/** iPoster and DT-GP measures, by hand from the spec, as in trussRig.test.ts. */
const PW = 25.2, GAP = 0.06, STEP = PW + GAP;
const SECTION = 11.16;
const PLATE = 1.5;

/** The 30 x 7 arch of trussRig.test.ts: piers two columns wide at each end and in the middle, a two-row lintel. */
function arch(rows = 7, lintel = 2): LedWallEntity {
  const wall = createLedWall({ cols: 30, rows });
  const pier = (c: number): boolean => c <= 1 || c === 14 || c === 15 || c >= 28;
  const cells: string[] = [];
  for (let c = 0; c < 30; c++) for (let r = 0; r < rows; r++) if (pier(c) || r < lintel) cells.push(`${c},${r}`);
  wall.shape = { mode: 'custom', cells };
  return wall;
}
const docWith = (...entities: Entity[]): Document => ({ ...createDocument(), entities: [...entities] });
const W = 30 * PW + 29 * GAP;
/** A column's left edge, world x, on the arch at the origin. */
const edge = (c: number): number => -W / 2 + c * STEP;

function open(doc: Document, wall: LedWallEntity): Builder {
  const b = openBuilder(doc, wall);
  if ('fail' in b) throw new Error(b.fail);
  return b;
}
const item = (b: Builder, id: string) => {
  const got = b.palette.find(i => i.catalogId === id);
  if (!got) throw new Error(`no ${id} in the palette`);
  return got;
};
/** The open port of piece `i` facing `dir`. */
const portOf = (b: Builder, pieces: readonly BuildPiece[], i: number, dir: THREE.Vector3): Port => {
  const got = openPorts(b, pieces).find(p => p.piece === i && p.dir.dot(dir) > 0.999);
  if (!got) throw new Error(`piece ${i} has no open port facing ${dir.toArray()}`);
  return got;
};
const UP = new THREE.Vector3(0, 1, 0);
/** `pieces` with `cand` put up, which must be allowed. */
function put(b: Builder, pieces: readonly BuildPiece[], cand: BuildPiece | null): BuildPiece[] {
  expect(cand).not.toBeNull();
  expect(check(b, pieces, cand!)).toEqual([]);
  return [...pieces, cand!];
}

/**
 * A leg put up by hand: a plate where the floor is clicked, then each piece on the top. With `exact`,
 * the plate goes down at `at` itself rather than where it snaps to, as a first plate set out by tape.
 */
function legBy(b: Builder, pieces: BuildPiece[], at: THREE.Vector3, ids: readonly string[], exact = false): BuildPiece[] {
  const plate = baseAt(b, pieces, at);
  if (plate && exact) {
    expect(Math.hypot(plate.position[0] - at.x, plate.position[2] - at.z)).toBeLessThan(0.25);
    plate.position = [at.x, plate.position[1], at.z];
  }
  let out = put(b, pieces, plate);
  for (const id of ids) out = put(b, out, attach(b, out, portOf(b, out, out.length - 1, UP), item(b, id)));
  return out;
}

/**
 * The arch rig Auto truss plans, put up piece by piece: each leg, then each span off a block's side.
 * With `taped`, the first plate goes down where Auto truss stands it; without, where the click snaps.
 */
function buildLikePlan(b: Builder, plan: TrussRigPlan, taped = true): { pieces: BuildPiece[]; tops: number[] } {
  let pieces: BuildPiece[] = [];
  const tops: number[] = [];
  // The first plate where Auto truss stands it; each after it snaps a whole number of sticks on.
  plan.legs.forEach((leg, i) => {
    pieces = legBy(b, pieces, new THREE.Vector3(leg.axis[0], 0, leg.axis[1]), leg.pieces.slice(1).map(p => p.catalogId), taped && i === 0);
    tops.push(pieces.length - 1);
  });
  const U = b.ctx.runs[0].U;
  for (let i = 0; i + 1 < plan.legs.length; i++) {
    const chain = plan.spans
      .filter(s => s.position[0] > plan.legs[i].axis[0] && s.position[0] < plan.legs[i + 1].axis[0])
      .sort((p, q) => p.position[0] - q.position[0]);
    let from = tops[i];
    for (const s of chain) {
      pieces = put(b, pieces, attach(b, pieces, portOf(b, pieces, from, U), item(b, s.catalogId)));
      from = pieces.length - 1;
    }
  }
  return { pieces, tops };
}

const keyOf = (p: RigPiece): string => [...p.position, ...p.rotation].map(v => v.toFixed(5)).join(' ');

describe('truss builder', () => {
  it('puts up the 30 x 7 arch by hand, and couples it to the holes Auto truss picks', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    expect(b.pieces).toEqual([]);
    expect(b.hand).toBe(false);

    const { pieces, tops } = buildLikePlan(b, plan);

    // Each plate snaps to where Auto truss stands the leg, and each leg stands as tall.
    const bases = pieces.filter(p => p.kind === 'base');
    expect(bases).toHaveLength(3);
    bases.forEach((p, i) => {
      expect(p.position[0]).toBeCloseTo(plan.legs[i].axis[0], 9);
      expect(p.position[2]).toBeCloseTo(plan.legs[i].axis[1], 9);
      expect(p.position[1]).toBe(0);
    });
    tops.forEach((t, i) => expect(pieces[t].position[1] + SECTION).toBeCloseTo(plan.legs[i].topY, 9));

    // Every span closes block face to block face: no open side face is left between the legs.
    const U = b.ctx.runs[0].U;
    for (let i = 0; i + 1 < tops.length; i++) {
      expect(openPorts(b, pieces).some(p => p.piece === tops[i] && p.dir.dot(U) > 0.999)).toBe(false);
      expect(openPorts(b, pieces).some(p => p.piece === tops[i + 1] && p.dir.dot(U) < -0.999)).toBe(false);
    }
    expect(pieces.filter(p => p.kind === 'stick' && !p.vertical)).toHaveLength(plan.spans.length);

    // The wall goes on the same shim, and the couplers into the same holes, square the same way.
    const sum = summarize(b, pieces);
    expect(sum.coupling.shim).toBeCloseTo(plan.shimIn, 9);
    expect(sum.coupling.bottomY).toBeCloseTo(plan.bottomY, 9);
    expect(sum.coupling.clamps.map(c => keyOf(c.piece)).sort()).toEqual(plan.clamps.map(keyOf).sort());
    expect([sum.coupling.held.size, sum.coupling.supported.size, sum.columns]).toEqual([plan.held, plan.supported, plan.columns]);
    expect(sum.coupling.welds).toBe(plan.skipped.weld);
    expect(sum.coupling.bared.size).toBe(0);

    // The same stock: the 2 ft sticks to buy and the couplers past ours are ghosts.
    expect(sum.ghosts).toBe(plan.ghosts);
    expect(pieces.filter((p, i) => sum.pieceGhosts[i]).map(p => p.catalogId)).toEqual(['gp-truss-2ft', 'gp-truss-2ft', 'gp-truss-2ft']);
    expect(sum.buyUsd).toBeCloseTo(plan.buyUsd, 6);
    expect(sum.shortfall).toEqual(plan.shortfall);
    expect(sum.long).toHaveLength(2);
  });

  it('puts up the arch from plain clicks on the floor, and every span still closes', () => {
    // No plate set out by tape: the first lands on the quarter-inch grid a few hundredths off Auto
    // truss's, and each one after it has to snap to whole sticks from it, not to a line of holes.
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    const { pieces, tops } = buildLikePlan(b, plan, false);
    const U = b.ctx.runs[0].U;
    for (let i = 0; i + 1 < tops.length; i++) {
      expect(openPorts(b, pieces).some(p => p.piece === tops[i] && p.dir.dot(U) > 0.999)).toBe(false);
      expect(openPorts(b, pieces).some(p => p.piece === tops[i + 1] && p.dir.dot(U) < -0.999)).toBe(false);
    }
    const sum = summarize(b, pieces);
    expect(sum.coupling.bared.size).toBe(0);
    expect(sum.coupling.shim).toBeCloseTo(plan.shimIn, 9);
    const header = (c0: number, c1: number) =>
      sum.coupling.clamps.some(c => c.header && c.piece.position[0] > edge(c0) && c.piece.position[0] < edge(c1));
    expect(header(2, 14)).toBe(true);
    expect(header(16, 28)).toBe(true);
  });

  it('writes the rig as one built by hand, sets the wall on its shim, and reads it back', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    const { pieces } = buildLikePlan(b, plan);
    const next = applyBuild(doc, b, pieces);

    const group = next.entities.find((e): e is GroupEntity => e.type === 'group' && e.rigFor === wall.id)!;
    expect(group.rigHand).toBe(true);
    const sum = summarize(b, pieces);
    expect(rigEntityIds(next, wall.id).size).toBe(1 + pieces.length + sum.coupling.clamps.length);
    const moved = next.entities.find(e => e.id === wall.id) as LedWallEntity;
    const byId = new Map(next.entities.map(e => [e.id, e]));
    expect(new THREE.Vector3().applyMatrix4(worldMatrix(moved, byId)).y).toBeCloseTo(plan.bottomY, 9);

    const again = open(next, moved);
    expect(again.hand).toBe(true);
    expect(again.pieces).toHaveLength(pieces.length);
    again.pieces.forEach((p, i) => {
      expect(p.catalogId).toBe(pieces[i].catalogId);
      expect(p.vertical).toBe(pieces[i].vertical);
      expect(p.len).toBeCloseTo(pieces[i].len, 9);
      p.position.forEach((v, k) => expect(v).toBeCloseTo(pieces[i].position[k], 9));
    });
    // Re-applied unchanged, it lands the same, and the wall does not move again.
    const twice = applyBuild(next, again, again.pieces);
    const moved2 = twice.entities.find(e => e.id === wall.id) as LedWallEntity;
    expect(moved2.transform.position).toEqual(moved.transform.position);
    expect(rigEntityIds(twice, wall.id).size).toBe(rigEntityIds(next, wall.id).size);
    // With nothing left, the rig goes and the wall stays put.
    const none = applyBuild(next, again, []);
    expect(rigEntityIds(none, wall.id).size).toBe(0);
    expect((none.entities.find(e => e.id === wall.id) as LedWallEntity).transform.position).toEqual(moved.transform.position);
  });

  it('reads an Auto truss rig as pieces, and couples it as Auto truss did', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const rigged = applyTrussRig(doc, wall, plan);
    const b = open(rigged, rigged.entities.find(e => e.id === wall.id) as LedWallEntity);
    expect(b.hand).toBe(false);
    expect(b.pieces).toHaveLength(plan.legs.reduce((a, l) => a + l.pieces.length, 0) + plan.spans.length);
    const sum = summarize(b, b.pieces);
    expect(sum.coupling.shim).toBeCloseTo(plan.shimIn, 9);
    expect(sum.coupling.clamps.map(c => keyOf(c.piece)).sort()).toEqual(plan.clamps.map(keyOf).sort());
  });

  describe('keeps every piece out of view', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    const leg0 = new THREE.Vector3(plan.legs[0].axis[0], 0, plan.legs[0].axis[1]);

    it('puts no plate in a doorway', () => {
      const z = plan.legs[0].axis[1];
      const cand = baseAt(b, [], new THREE.Vector3(edge(6) + PW / 2, 0, z));
      expect(cand).not.toBeNull();
      expect(check(b, [], cand!)).toContain('The plate would reach into a doorway.');
    });

    it('runs no span across a doorway below the lintel', () => {
      const pieces = legBy(b, [], leg0, ['gp-truss-4ft', 'gp-corner-6way']);
      const span = attach(b, pieces, portOf(b, pieces, pieces.length - 1, b.ctx.runs[0].U), item(b, 'gp-truss-8ft'));
      expect(check(b, pieces, span!).join(' ')).toMatch(/column 3/);
    });

    it('runs no stick into the cabinets', () => {
      const pieces = legBy(b, [], leg0, ['gp-truss-4ft', 'gp-corner-6way']);
      const toward = b.ctx.runs[0].N.clone().negate();
      const stick = attach(b, pieces, portOf(b, pieces, pieces.length - 1, toward), item(b, 'gp-truss-4ft'));
      expect(check(b, pieces, stick!)).toContain('It would reach into the cabinets.');
    });

    it('stands no leg above its pier', () => {
      const pieces = legBy(b, [], leg0, ['gp-truss-8ft']);
      const over = attach(b, pieces, portOf(b, pieces, pieces.length - 1, UP), item(b, 'gp-truss-8ft'));
      expect(check(b, pieces, over!).join(' ')).toMatch(/above the cabinets/);
    });

    it('stands no plate on another', () => {
      const pieces = put(b, [], baseAt(b, [], leg0));
      expect(check(b, pieces, baseAt(b, pieces, leg0)!)).toContain('It would run into the base plate.');
    });

    it('takes no plate on a block', () => {
      const pieces = legBy(b, [], leg0, ['gp-truss-4ft', 'gp-corner-6way']);
      const under = portsOf(b, pieces[pieces.length - 1], pieces.length - 1).find(p => p.dir.y < -0.5)!;
      expect(attach(b, pieces, under, item(b, 'gp-base-36'))).toBeNull();
    });
  });

  it('turns a stick on a block’s top upright and one on its side along the wall', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    const pieces = legBy(b, [], new THREE.Vector3(plan.legs[0].axis[0], 0, plan.legs[0].axis[1]), ['gp-truss-4ft', 'gp-corner-6way']);
    const block = pieces.length - 1;
    expect(attach(b, pieces, portOf(b, pieces, block, UP), item(b, 'gp-truss-5ft'))!.vertical).toBe(true);
    const along = attach(b, pieces, portOf(b, pieces, block, b.ctx.runs[0].U), item(b, 'gp-truss-5ft'))!;
    expect(along.vertical).toBe(false);
    expect(along.position[0] - 30).toBeCloseTo(pieces[block].position[0] + SECTION / 2, 9);
    expect(along.position[1]).toBeCloseTo(pieces[block].position[1], 9);
  });

  it('takes a piece down with whatever stood on the floor only through it', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    // A leg on its own: its 4 ft stick takes the 3 ft stick and both blocks with it.
    const leg = plan.legs[0];
    const alone = legBy(b, [], new THREE.Vector3(leg.axis[0], 0, leg.axis[1]), leg.pieces.slice(1).map(p => p.catalogId), true);
    const left = removePiece(b, alone, 1);
    expect(left).toEqual([alone[0]]);
    // Spanned to the next leg, what stood on it hangs off the spans instead, so only the stick goes.
    const { pieces } = buildLikePlan(b, plan);
    const hung = removePiece(b, pieces, 1);
    expect(hung).toHaveLength(pieces.length - 1);
    expect(hung).not.toContain(pieces[1]);
    // Take a plate up and the leg it held goes only where nothing else holds it up.
    expect(removePiece(b, alone, 0)).toEqual([]);
  });

  it('fills the gap between two blocks with sticks that close it exactly and put the header on the lintel', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    let pieces: BuildPiece[] = [];
    plan.legs.slice(0, 2).forEach((leg, i) => {
      pieces = legBy(b, pieces, new THREE.Vector3(leg.axis[0], 0, leg.axis[1]), leg.pieces.slice(1).map(p => p.catalogId), i === 0);
    });
    const top0 = 4;
    const from = portOf(b, pieces, top0, b.ctx.runs[0].U);
    const gap = gapFrom(b, pieces, from)!;
    expect(gap.len).toBeCloseTo(plan.legs[1].axis[0] - plan.legs[0].axis[0] - SECTION, 9);
    const got = fillGap(b, pieces, from);
    if ('fail' in got) throw new Error(got.fail);
    expect(got.add.reduce((a, p) => a + p.len, 0)).toBeCloseTo(gap.len, 9);
    const all = [...pieces, ...got.add];
    expect(openPorts(b, all).some(p => p.piece === top0 && p.dir.dot(b.ctx.runs[0].U) > 0.999)).toBe(false);
    const sum = summarize(b, all);
    expect(sum.coupling.shim).toBeCloseTo(plan.shimIn, 9);
    expect(sum.coupling.clamps.some(c => c.header && c.piece.position[0] > edge(2) && c.piece.position[0] < edge(14))).toBe(true);
  });

  it('fills from the sticks on hand before reaching for ones to buy', () => {
    // The order it went in by hand: the 28 ft span first, which can take all three 8 ft, then the
    // 30 ft. Fewest sticks first, the 30 ft came out 8, 8, 5, 5, 4 with both 8 ft to buy, though the
    // rack closes it as well: the legs take three of the six 5 ft, so five 4 ft and two 5 ft.
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    let pieces: BuildPiece[] = [];
    const tops: number[] = [];
    plan.legs.forEach((leg, i) => {
      pieces = legBy(b, pieces, new THREE.Vector3(leg.axis[0], 0, leg.axis[1]), leg.pieces.slice(1).map(p => p.catalogId), i === 0);
      tops.push(pieces.length - 1);
    });
    const fills: number[][] = [];
    for (const t of [tops[1], tops[0]]) {
      const got = fillGap(b, pieces, portOf(b, pieces, t, b.ctx.runs[0].U));
      if ('fail' in got) throw new Error(got.fail);
      pieces = [...pieces, ...got.add];
      fills.push(got.add.map(p => Math.round(p.len / 12)).sort((a, z) => a - z));
    }
    expect(fills).toEqual([[4, 8, 8, 8], [4, 4, 4, 4, 4, 5, 5]]);
    for (const i of b.palette.filter(p => p.kind === 'stick' && !p.buy)) expect([i.catalogId, stockLeft(i, pieces) >= 0]).toEqual([i.catalogId, true]);
    const sum = summarize(b, pieces);
    expect(sum.coupling.supported.size).toBe(plan.supported);
    expect(sum.coupling.shim).toBeCloseTo(plan.shimIn, 9);
  });

  it.each([90, -90])('stands a leg behind either run of a wall folded %i degrees', angle => {
    // Behind an outside corner a piece stands behind both runs at once. It is judged by the run it
    // stands a coupler's reach behind, as its plate is snapped, or a plate behind the second run was
    // refused for not standing that far behind the first.
    const wall = createLedWall({ cols: 10, rows: 5 });
    wall.corners = [{ afterCol: 4, angle }];
    const b = open(docWith(wall), wall);
    expect(b.ctx.runs.length).toBe(2);
    let pieces: BuildPiece[] = [];
    for (const run of b.ctx.runs) {
      const [e0, e1] = b.ctx.extentOf(run, run.start, run.end);
      const at = run.origin.clone().addScaledVector(run.U, (e0 + e1) / 2).addScaledVector(run.N, b.ctx.depth).setY(0);
      pieces = legBy(b, pieces, at, ['gp-truss-4ft', 'gp-corner-6way']);
    }
    expect(summarize(b, pieces).coupling.bared.size).toBe(0);
  });

  it('snaps a plate a whole number of sticks from the last, block face to block face', () => {
    const wall = arch();
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const b = open(doc, wall);
    const first = put(b, [], baseAt(b, [], new THREE.Vector3(plan.legs[0].axis[0], 0, plan.legs[0].axis[1])));
    const want = first[0].position[0] + SECTION + 96 + 48;
    const snapped = baseAt(b, first, new THREE.Vector3(want + 1.5, 0, 0))!;
    expect(snapped.position[0]).toBeCloseTo(want, 9);
    expect(snapped.position[2]).toBeCloseTo(first[0].position[2], 9);
  });
});

describe('Auto truss through the builder', () => {
  /** Auto truss on `wall`, against the plan it puts up: every piece goes up, coupled as planned. */
  function same(wall: LedWallEntity, opts: TrussRigOptions = {}) {
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall, opts);
    const got = autoTrussRig(doc, wall, opts);
    if ('fail' in got) throw new Error(got.fail);
    const c = got.summary.coupling;
    expect(got.auto.refused).toEqual([]);
    expect(got.legs).toBe(plan.legs.length);
    expect(got.spans).toBe(plan.spans.length);
    expect(c.shim).toBeCloseTo(plan.shimIn, 9);
    expect(c.bottomY).toBeCloseTo(plan.bottomY, 9);
    expect(c.clamps.map(x => keyOf(x.piece)).sort()).toEqual(plan.clamps.map(keyOf).sort());
    expect([c.held.size, c.supported.size, got.summary.columns]).toEqual([plan.held, plan.supported, plan.columns]);
    expect(got.summary.ghosts).toBe(plan.ghosts);
    expect(got.summary.buyUsd).toBeCloseTo(plan.buyUsd, 6);
    return { doc, plan, got };
  }

  it('puts up the arch that hides its couplers as planned: five blocks a leg, the wall on the plates', () => {
    const wall = arch();
    const { plan, got } = same(wall, { header: 'hide' });
    expect(got.summary.coupling.shim).toBe(0);
    expect(got.summary.coupling.bared.size).toBe(0);
    expect(got.summary.coupling.clamps.filter(c => c.low)).toEqual([]);
    expect(got.auto.pieces.filter(p => p.catalogId === 'gp-corner-6way')).toHaveLength(15);
    expect(plan.headerDropIn).toBeGreaterThan(0);
    // The planner's word on the block stack and the drop reaches the person who asked.
    expect(got.notes).toContain('Each frame leg stacks 4 spare blocks under its top one to put the header on hidden holes: have the stack checked before it carries the wall.');
    expect(got.notes.some(n => /under the row of holes it couples to/.test(n))).toBe(true);

    // The rig keeps its mode: opened again in Build truss, it couples the same, couplers hidden.
    const group = got.next.entities.find((e): e is GroupEntity => e.type === 'group' && e.rigFor === wall.id)!;
    expect(group.rigHeader).toBe('hide');
    const again = open(got.next, wall);
    expect(again.header).toBe('hide');
    const c = summarize(again, again.pieces).coupling;
    expect(c.shim).toBe(got.summary.coupling.shim);
    expect(c.clamps.map(x => keyOf(x.piece)).sort()).toEqual(got.summary.coupling.clamps.map(x => keyOf(x.piece)).sort());

    // Cheapest marks nothing, and couples the bottom row as before.
    const cheap = same(wall);
    expect(cheap.got.next.entities.some(e => e.type === 'group' && 'rigHeader' in e)).toBe(false);
    expect(cheap.got.summary.coupling.clamps.some(x => x.low)).toBe(true);
  });

  it('puts up the 30 x 7 arch as planned, as a rig Auto truss replaces again without asking', () => {
    const { plan, got } = same(arch());
    // Every gap between frame tops that the plan spans is closed by F.
    expect(got.auto.filled).toBe(2);
    expect(got.auto.kept).toBe(0);
    expect(got.auto.pieces.filter(p => p.kind === 'stick' && !p.vertical).map(p => p.catalogId).sort())
      .toEqual(plan.spans.map(s => s.catalogId).sort());

    const group = got.next.entities.find((e): e is GroupEntity => e.type === 'group' && e.rigFor === got.plan.wallId);
    expect(group).toBeDefined();
    expect(group!.rigHand).toBeUndefined();

    // It opens in Build truss piece by piece, as Auto truss's, coupled the same.
    const wall2 = got.next.entities.find(e => e.id === got.plan.wallId) as LedWallEntity;
    const b = open(got.next, wall2);
    expect(b.hand).toBe(false);
    expect(b.pieces).toHaveLength(got.auto.pieces.length);
    expect(summarize(b, b.pieces).coupling.clamps.map(x => keyOf(x.piece)).sort()).toEqual(plan.clamps.map(keyOf).sort());

    // Run again over its own rig, it replaces it with the same rig, not a second one.
    const again = autoTrussRig(got.next, wall2);
    if ('fail' in again) throw new Error(again.fail);
    expect(rigEntityIds(again.next, wall2.id).size).toBe(rigEntityIds(got.next, wall2.id).size);
    expect(again.summary.coupling.clamps.map(x => keyOf(x.piece)).sort()).toEqual(plan.clamps.map(keyOf).sort());
  });

  it('puts up a wall turned and moved as planned', () => {
    const arched = arch();
    arched.transform = { ...arched.transform, rotation: [0, -120, 0] };
    same(arched);
    const flat = createLedWall({ cols: 20, rows: 7 });
    flat.transform = { ...flat.transform, position: [100, 0, -50], rotation: [0, 37, 0] };
    expect(same(flat).got.auto.filled).toBe(5);
  });

  it('puts up a folded wall as planned, either way round', () => {
    for (const angle of [90, -90]) {
      const wall = createLedWall({ cols: 10, rows: 5 });
      wall.corners = [{ afterCol: 4, angle }];
      expect(same(wall).got.legs).toBe(4);
    }
  });

  it('closes a flat wall’s gaps from the sticks on hand, on the plan’s couplers', () => {
    const wall = createLedWall({ cols: 30, rows: 7 });
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const got = autoTrussRig(doc, wall);
    if ('fail' in got) throw new Error(got.fail);
    const c = got.summary.coupling;
    expect(got.auto.refused).toEqual([]);
    expect(got.legs).toBe(plan.legs.length);
    expect(c.clamps.map(x => keyOf(x.piece)).sort()).toEqual(plan.clamps.map(keyOf).sort());
    expect(c.shim).toBeCloseTo(plan.shimIn, 9);
    expect([c.held.size, c.supported.size]).toEqual([plan.held, plan.supported]);
    // The plan splices a span past our 8 ft from a 5 ft and a 3 ft to buy, as F does: the same
    // sticks, ghosts and cost.
    expect([plan.spans.length, got.spans]).toEqual([10, 10]);
    expect([plan.ghosts, got.summary.ghosts]).toEqual([12, 12]);
    expect(got.summary.buyUsd).toBeCloseTo(plan.buyUsd, 6);
    expect(plan.spans.filter(s => s.ghost).map(s => s.catalogId)).toEqual(['gp-truss-3ft']);
  });

  it('says why a mitre or a fold leaves holes and columns out, as the plan does', () => {
    for (const [cols, rows, afterCol, angle, n] of [[16, 6, 7, 120, 2], [20, 8, 9, 60, 1]] as const) {
      const wall = createLedWall({ cols, rows });
      wall.corners = [{ afterCol, angle }];
      const doc = docWith(wall);
      const why = planTrussRig(doc, wall).warnings.filter(w => /mitre|fold/.test(w));
      expect(why).toHaveLength(n);
      const got = autoTrussRig(doc, wall);
      if ('fail' in got) throw new Error(got.fail);
      for (const w of why) expect(got.notes).toContain(w);
    }
  });

  it('says why where no leg fits, and puts nothing up', () => {
    const wall = createLedWall({ cols: 1, rows: 1 });
    const doc = docWith(wall);
    const plan = planTrussRig(doc, wall);
    const got = autoTrussRig(doc, wall);
    expect(plan.legs).toHaveLength(0);
    expect(got).toEqual({ fail: plan.warnings[0] });
  });
});
