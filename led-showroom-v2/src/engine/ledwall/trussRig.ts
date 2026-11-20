/**
 * Auto truss: a rig standing behind an LED wall, hidden by it, bolted into the cabinets' M10 holes.
 *
 * Two shapes of rig, from the stock we hold:
 *
 *  - A FRAME: legs (a base plate, GP sticks, a 6-way block on top) with horizontal sticks spanning
 *    block to block. Its legs stand behind columns filled from the floor to above their blocks; its
 *    spans run behind any band of cabinets at the blocks' height, so on an arch the legs stand
 *    behind the piers and the spans cross the doorways behind the lintel, sticks spliced end to end
 *    where one will not reach. The legs are as tall as the 3, 4, 5 and 8 ft sticks stack to: where
 *    a stack lands the header's front chord on a row of holes, a half coupler goes into every hole
 *    on that row that is clear of a weld; where none does, the spans only brace the legs. Where a
 *    leg's front chord happens to run down a line of holes, those take couplers too.
 *  - TOWERS for the columns no frame holds, as few as will hold them: a base plate and sticks, one
 *    front chord on one of a column's two hole lines, every hole on that line clamped.
 *
 * A column with couplers in it holds the columns bolted beside it too: both of them while its top
 * stands no higher than {@link TALL_IN} above the plates, and above that the one on the side of the
 * hole line its couplers are in. So one tower holds two or three columns, and a wall needs fewer
 * towers than it has columns.
 *
 * Three rules every rig keeps:
 *
 *  - Nothing shows from the front. Every leg and span stands inside the run it is behind, and
 *    within the cabinets in front of it. Only the base plates reach out, on the floor, and never
 *    sideways into a doorway.
 *  - The wall sits ON the base plates: its bottom is the plate's top plus a shim of at most
 *    {@link SHIM_MAX_IN}. The shim is what lets a header chord meet a row of holes exactly, since a
 *    coupler has a fixed reach and nothing else to give. The height is absolute, so a wall that was
 *    raised by hand comes back down to the plates.
 *  - Couplers close on the main chords only, never on a diagonal or within a jaw's length of a
 *    weld (`clearOfBraceNodes`), and never on a block.
 *
 * Stock decides what is drawn, not what is planned. Pieces past what we own (less what the rest of
 * the scene already uses) come out as ghosts: drawn see-through, counted as a shortfall, so a plan
 * shows what it would take rather than quietly stopping short.
 *
 * Pure: it reads a document and returns a plan. `applyTrussRig` turns a plan into the next document
 * in a single step, so a whole rig is one undo.
 */
import * as THREE from 'three';
import { parentMatrix, worldMatrix } from '../behaviours';
import { equipmentDef, ownedCount, type EquipmentDef } from '../catalog/equipment';
import {
  chordOffsetIn, chordRadiusIn, clampMetrics, clearOfBraceNodes, trussBaseProfile,
} from '../catalog/trussMetrics';
import { createEquipment, createGroup } from '../document/defaults';
import type { Vec3 } from '../math';
import type {
  Document, Entity, EquipmentEntity, EquipmentGeometry, GroupEntity, LedWallEntity,
} from '../document/types';
import { isStage } from '../document/types';
import {
  cellKey, columnLocalToWall, computeColumnLayout, computeSegments, filledCells, wallDims,
  wallMountPoints, type MountPoint,
} from './layout';
import { mountHoles, panelSpec } from './specs';

const DEG = 180 / Math.PI;

const BASE_ID = 'gp-base-36';
const BLOCK_ID = 'gp-corner-6way';
/** DT-GP stock. The catalog dims are for a stick lying down; a leg stands them on end. */
const STICK_IDS = ['gp-truss-8ft', 'gp-truss-5ft', 'gp-truss-4ft'] as const;
/**
 * DT-GP sticks we hold none of. Only a frame's leg takes one, and only where it lands the header on
 * a row of holes: a rig that takes one is drawn with it as a ghost, a stick to buy, and is chosen
 * only when it holds more columns than any rig of our own sticks. Over a walk-through arch's
 * five-row doorways, a 4 ft and a 3 ft under a spare block put the header on the lintel's low holes.
 */
const BUY_STICK_IDS = ['gp-truss-3ft'] as const;
const CLAMP_ID = 'clamp-8002';

export const RIG_GROUP_NAME = 'Truss rig';

/**
 * Most a wall may stand above its base plates' top, in inches.
 *
 * A packer under a cabinet, and all the slack there is: a header chord either meets a row of holes
 * within it or that header height is out.
 */
export const SHIM_MAX_IN = 0.25;

const EPS = 1e-4;
/** Steps a frame is slid along its run in, hunting for the best fit against the hole lines. */
const SLIDE_STEP_IN = 0.25;
/** Longest stack of sticks a leg is tried with. Four 8 ft sticks is 32 ft, past any wall here. */
const MAX_LEG_STICKS = 4;
/** Most sticks spliced into one span across an opening: eight 8 ft sticks is 64 ft. */
const MAX_SPAN_STICKS = 8;
/** Where the DT-GP span table stops, in inches: a longer span wants its own check. */
const SPAN_TABLE_IN = 240;
/**
 * How high a coupled column's top may stand above the plates and still hold a column each side of
 * it, in inches; one taller holds only the column beside its couplers. An 8 ft stick: a wall of
 * five iPoster rows holds three columns to a tower, one of six holds two.
 */
const TALL_IN = 96;

/** One piece of hardware, placed in WORLD space. */
export interface RigPiece {
  catalogId: string;
  name: string;
  geometry: EquipmentGeometry;
  dims: Vec3;
  color: string;
  /** Origin of the piece, as its builder defines it (bottom centre for truss and for a coupler). */
  position: Vec3;
  /** Euler YXZ in degrees, matching `Transform.rotation`. */
  rotation: Vec3;
  /** Needed but past our stock: drawn see-through and counted as a shortfall. */
  ghost: boolean;
}

/** One upright: a base, then sticks, then (on a frame) the block the spans meet at. */
export interface RigLeg {
  kind: 'frame' | 'tower';
  /** World XZ of the leg's axis. */
  axis: [number, number];
  /** Yaw in degrees: square to the run it stands behind. */
  rotY: number;
  /** World y of the top of the leg. */
  topY: number;
  /** Bottom up. */
  pieces: RigPiece[];
}

export interface RigShortfall { catalogId: string; name: string; need: number; have: number }

export interface TrussRigPlan {
  wallId: string;
  legs: RigLeg[];
  /** Horizontal sticks, block to block. */
  spans: RigPiece[];
  clamps: RigPiece[];
  /** How many frames (legs joined by spans) the rig has. */
  frames: number;
  /** World y of the header chord the couplers close on; null with no header. */
  headerY: number | null;
  /** World inches the wall moves, signed: down when it was standing higher than the plates. */
  liftIn: number;
  /** The same move in the wall's parent frame, which is what its transform takes. */
  liftLocalIn: number;
  /** World y of the wall's bottom once rigged. */
  bottomY: number;
  /** Packing between the plates' top and the wall's bottom. */
  shimIn: number;
  /** True when the floor-stand kit has to come off: its back supports stand where the rig does. */
  dropAccessories: boolean;
  /** Columns with at least one coupler, out of `columns`. */
  held: number;
  /** Columns held, out of `columns`: by couplers of their own, or by a coupled column beside them. */
  supported: number;
  /** Columns with any cabinets in them. */
  columns: number;
  /** Pieces drawn as ghosts. */
  ghosts: number;
  shortfall: RigShortfall[];
  /** Mount holes on a chord that got no coupler, by reason. */
  skipped: { offFace: number; weld: number };
  warnings: string[];
}

/* ───────────────────────────── helpers ───────────────────────────── */

const v3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Yaw of a pure-Y quaternion, radians. */
const yawOf = (q: THREE.Quaternion): number => new THREE.Euler().setFromQuaternion(q, 'YXZ').y;

/** Lexicographic, larger first: negative when `a` ranks ahead of `b`. */
function rank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

/** Every multiset of exactly `n` of `lens`, each listed longest first. */
function multisetsOf(lens: readonly number[], n: number): number[][] {
  const desc = [...new Set(lens)].sort((a, b) => b - a);
  const out: number[][] = [];
  const walk = (from: number, acc: number[]): void => {
    if (acc.length === n) { out.push(acc); return; }
    for (let i = from; i < desc.length; i++) walk(i, [...acc, desc[i]]);
  };
  walk(0, []);
  return out;
}

/** Every stack of at most `max` sticks, longest at the bottom, the empty stack included. */
function stickStacks(lens: readonly number[], max: number): number[][] {
  const out: number[][] = [];
  for (let n = 0; n <= max; n++) out.push(...multisetsOf(lens, n));
  return out;
}

/** Each distinct ordering of `xs`. */
function permutations(xs: readonly number[]): number[][] {
  const sorted = [...xs].sort((a, b) => a - b);
  const used = sorted.map(() => false);
  const cur: number[] = [];
  const out: number[][] = [];
  const walk = (): void => {
    if (cur.length === sorted.length) { out.push([...cur]); return; }
    for (let i = 0; i < sorted.length; i++) {
      if (used[i] || (i > 0 && sorted[i] === sorted[i - 1] && !used[i - 1])) continue;
      used[i] = true; cur.push(sorted[i]); walk(); cur.pop(); used[i] = false;
    }
  };
  walk();
  return out;
}

/** The orders a frame's spans are tried in: all of them while that stays small, else three. */
function spanOrders(spans: readonly number[]): number[][] {
  if (spans.length <= 4) return permutations(spans);
  const desc = [...spans].sort((a, b) => b - a);
  const middleOut: number[] = [];
  desc.forEach((l, i) => (i % 2 ? middleOut.push(l) : middleOut.unshift(l)));
  const seen = new Set<string>();
  return [desc, [...desc].reverse(), middleOut].filter(o => {
    const k = o.join(',');
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** A square footprint on the floor, for the collision check. */
interface Footprint { x: number; z: number; size: number; rotY: number }

/** Separating-axis test for two convex outlines on the floor, each by its corners in order. */
function outlinesOverlap(a: readonly THREE.Vector3[], b: readonly THREE.Vector3[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const ax = (p.z - q.z) / len, az = (q.x - p.x) / len;
      const pa = a.map(v => v.x * ax + v.z * az), pb = b.map(v => v.x * ax + v.z * az);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
    }
  }
  return true;
}

/** Separating-axis test for two rotated squares. */
function overlaps(a: Footprint, b: Footprint): boolean {
  // Squares whose circumcircles are apart are apart: most pairs the planner tries are nowhere near.
  if (Math.hypot(a.x - b.x, a.z - b.z) > (a.size + b.size) * Math.SQRT1_2 + 1e-6) return false;
  const corners = (f: Footprint): [number, number][] => {
    const c = Math.cos(f.rotY), s = Math.sin(f.rotY), h = f.size / 2;
    return ([[-h, -h], [h, -h], [h, h], [-h, h]] as [number, number][])
      .map(([lx, lz]): [number, number] => [f.x + lx * c + lz * s, f.z - lx * s + lz * c]);
  };
  const ca = corners(a), cb = corners(b);
  for (const f of [a, b]) {
    const axes: [number, number][] = [[Math.cos(f.rotY), -Math.sin(f.rotY)], [Math.sin(f.rotY), Math.cos(f.rotY)]];
    for (const [ax, az] of axes) {
      const pa = ca.map(([x, z]) => x * ax + z * az);
      const pb = cb.map(([x, z]) => x * ax + z * az);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
    }
  }
  return true;
}

/** A vertical line of mount holes: one column, one side. */
interface HoleLine { col: number; u: number; side: number; mounts: MountPoint[] }

/**
 * A flat stretch of the wall between folds, with its own frame: `u` runs along it from the centre
 * of its first column's back face, `U` is that direction in the world and `N` points straight back
 * out of the cabinets.
 */
interface Run {
  start: number; end: number;
  yaw: number;
  U: THREE.Vector3; N: THREE.Vector3; origin: THREE.Vector3;
  lines: HoleLine[];
}

/**
 * Where a frame's legs stand along a run, and the span between each pair, left to right: one stick,
 * or several spliced end to end where the legs stand either side of an opening.
 */
interface FrameLayout { run: number; legsU: number[]; spans: number[][] }

/** A leg's rise between base and top block: sticks, longest lowest, then spare blocks. */
interface LegStack { sticks: number[]; spacers: number; rise: number }

/** A chord a jaw can close on, in world y. */
interface ChordSpan { footY: number; len: number }

/* ───────────────────────────── planning ───────────────────────────── */

/**
 * Plan a rig for `wall`. Always returns a plan; an empty one carries the reason in `warnings` and
 * leaves the wall where it is.
 *
 * Everything resolves to WORLD space, through the wall's composed `parentId` chain, because the rig
 * is hardware standing on the floor rather than part of the wall: it keeps its own real size
 * whatever the wall is nested in or scaled to.
 */
export function planTrussRig(doc: Document, wall: LedWallEntity): TrussRigPlan {
  const warnings: string[] = [];
  const empty = (bottomY = 0): TrussRigPlan => ({
    wallId: wall.id, legs: [], spans: [], clamps: [], frames: 0, headerY: null,
    liftIn: 0, liftLocalIn: 0, bottomY, shimIn: 0, dropAccessories: false,
    held: 0, supported: 0, columns: 0, ghosts: 0, shortfall: [], skipped: { offFace: 0, weld: 0 }, warnings,
  });

  const spec = panelSpec(wall.product);
  const holes = mountHoles(spec);
  if (!holes.length || spec.mount?.face !== 'back') {
    warnings.push('This panel has no mount holes in its back face, so there is nothing to bolt a coupler into.');
    return empty();
  }

  const baseDef = equipmentDef(BASE_ID);
  const blockDef = equipmentDef(BLOCK_ID);
  const clampDef = equipmentDef(CLAMP_ID);
  const stickDefs = STICK_IDS.map(id => equipmentDef(id)).filter((d): d is EquipmentDef => !!d);
  if (!baseDef || !blockDef || !clampDef || !stickDefs.length) {
    warnings.push('The DT-GP truss, its base and block, or the 8002 coupler is missing from the catalog.');
    return empty();
  }

  const section = stickDefs[0].dims[1];
  const co = chordOffsetIn(section);
  const chordR = chordRadiusIn(section);
  const jawHalf = clampDef.dims[0] / 2;
  /** Back face to a leg's axis: the coupler's reach to its front chords, then the chord's inset. */
  const depth = clampMetrics(clampDef.dims).reachIn + co;
  const base = trussBaseProfile(baseDef.dims);
  const baseH = baseDef.dims[1];
  const plateSize = Math.max(baseDef.dims[0], baseDef.dims[2]);
  const blockH = blockDef.dims[1];
  const stickLens = stickDefs.map(d => d.dims[0]);
  const buyDefs = BUY_STICK_IDS.map(id => equipmentDef(id)).filter((d): d is EquipmentDef => !!d && d.dims[1] === section);
  const buyIds = new Set(buyDefs.map(d => d.id));
  const stickOf = (len: number): EquipmentDef =>
    stickDefs.find(d => d.dims[0] === len) ?? buyDefs.find(d => d.dims[0] === len) ?? stickDefs[0];
  /**
   * The shortest leg with a chord a coupler can close on: a base that stands a riser of its own,
   * otherwise the base plate and the shortest stick. A column whose top is lower hides no leg.
   */
  const shortestStick = Math.min(...stickLens);
  const shortestLeg = baseH + (base.riserLen > EPS ? 0 : shortestStick);

  // The wall's world placement. A tilted or unevenly scaled wall has no vertical line of holes for a
  // vertical chord to follow, so there is nothing honest to generate.
  const byId = new Map<string, Entity>(doc.entities.map(e => [e.id, e]));
  const world = worldMatrix(wall, byId);
  const wPos = new THREE.Vector3(), wQuat = new THREE.Quaternion(), wScale = new THREE.Vector3();
  world.decompose(wPos, wQuat, wScale);
  if (Math.abs(wScale.x - wScale.y) > 1e-4 || Math.abs(wScale.y - wScale.z) > 1e-4 || wScale.x <= 0) {
    warnings.push('The wall is scaled unevenly, which turns its hole normals out of true. Reset its scale first.');
    return empty();
  }
  if (Math.abs(wQuat.x) > 1e-4 || Math.abs(wQuat.z) > 1e-4) {
    warnings.push('The wall is tilted. A vertical chord cannot follow a tilted line of holes, so level it first.');
    return empty();
  }
  const s = wScale.y;
  const wallYaw = yawOf(wQuat);
  const toWorld = (p: Vec3): THREE.Vector3 => v3(p).applyMatrix4(world);
  const currentBottom = toWorld([0, 0, 0]).y;

  // What the legs stand on: a stage deck if the wall rides one, otherwise the floor.
  const support = wall.attachedTo ? byId.get(wall.attachedTo) : undefined;
  let supportY = 0;
  if (support && isStage(support)) {
    const sp = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
    worldMatrix(support, byId).decompose(sp, sq, ss);
    supportY = sp.y + support.heightIn * ss.y;
  }
  const plateTop = supportY + base.plateThick;

  // The floor-stand kit and the rig want the same space: its back supports stand behind the
  // cabinets where the legs do. A wall on truss does not stand on its own feet, so the kit comes
  // off -- and with it the quarter inch the renderer lifts the wall by for those feet, which is why
  // the wall's own origin is its bottom here.
  const dropAccessories = wall.accessories === true && !!spec.accessories;

  const dims = wallDims(wall);
  const layout = computeColumnLayout(dims, wall.corners);
  const cells = filledCells(wall);
  const mounts = wallMountPoints(dims, layout, cells, wall.corners);
  const onFace = mounts.filter(m => m.onFace);
  const offFace = mounts.length - onFace.length;
  if (!onFace.length) {
    warnings.push(mounts.length
      ? 'Every mount hole on this wall is cut away by a mitre.'
      : 'This wall has no cabinets with mount holes.');
    return empty(currentBottom);
  }

  const step = dims.panelW + dims.gap;
  /** Rows filled unbroken from the bottom of each column: how high a leg there stays hidden. */
  const solidRows = layout.map(col => {
    let n = 0;
    while (n < dims.rows && cells.has(cellKey(col.col, dims.rows - 1 - n))) n++;
    return n;
  });
  /** World height of column `c`'s solid stack above the wall's bottom. */
  const hiddenRise = (c: number): number =>
    solidRows[c] ? s * (solidRows[c] * dims.panelH + (solidRows[c] - 1) * dims.gap) : 0;
  const fullRise = s * dims.totalH;

  // Flat runs, each with its hole lines in run coordinates.
  const holeXs = [...new Set(holes.map(h => h.x))].sort((a, b) => a - b);
  const runs: Run[] = computeSegments(dims.cols, wall.corners).map(seg => {
    const col0 = layout[seg.startCol];
    const yaw = wallYaw + col0.rotY;
    const lines: HoleLine[] = [];
    for (let c = seg.startCol; c <= seg.endCol; c++) {
      for (const hx of holeXs) {
        const want = columnLocalToWall(layout[c], hx, 0, -dims.panelD / 2);
        const line = onFace.filter(m => m.col === c
          && Math.abs(m.pos[0] - want[0]) < 1e-6 && Math.abs(m.pos[2] - want[2]) < 1e-6);
        if (line.length) lines.push({ col: c, u: s * ((c - seg.startCol) * step + hx), side: Math.sign(hx), mounts: line });
      }
    }
    return {
      start: seg.startCol, end: seg.endCol, yaw,
      U: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
      N: new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)),
      origin: toWorld(columnLocalToWall(col0, 0, 0, -dims.panelD / 2)),
      lines,
    };
  });
  /** World point `u` along a run, at height `y`, `behind` inches back from its cabinets. */
  const at = (run: Run, u: number, y: number, behind: number): THREE.Vector3 =>
    run.origin.clone().addScaledVector(run.U, u).addScaledVector(run.N, behind).setY(y);

  /** Whether a hole line at `u` runs down one of the front chords of a leg standing at `legU`. */
  const onLegChord = (u: number, legU: number): boolean => Math.abs(Math.abs(u - legU) - co) < EPS;

  /** Columns `a` to `b` of a run, face edge to face edge, in run coordinates. */
  const extentOf = (run: Run, a: number, b: number): [number, number] =>
    [s * ((a - run.start) * step - dims.panelW / 2), s * ((b - run.start) * step + dims.panelW / 2)];

  /** Each column's unbroken bands of cabinets, bottom up, in world inches above the wall's bottom. */
  const bands = layout.map(col => {
    const filled = (k: number): boolean => cells.has(cellKey(col.col, dims.rows - 1 - k));
    const out: [number, number][] = [];
    for (let k = 0; k < dims.rows; k++) {
      if (!filled(k)) continue;
      const k0 = k;
      while (k + 1 < dims.rows && filled(k + 1)) k++;
      out.push([s * k0 * (dims.panelH + dims.gap), s * (k * (dims.panelH + dims.gap) + dims.panelH)]);
    }
    return out;
  });
  const runOfCol = layout.map((_, c) => runs.findIndex(r => c >= r.start && c <= r.end));

  /*
   * Across a fold, a piece behind one run can stand in front of, inside, or behind the columns of
   * another. Each column is looked at square on, from in front of it but no further out than the
   * nearest other cabinet: a piece in its strip -- its width, half a bezel gap past either edge --
   * shows if it stands in the column's own slot (through its cabinets, or in the open where it has
   * none), in front of its face, or behind it where it has no cabinets, with no other cabinet
   * between. No leg, span, coupler or plate is placed where it would; a plate is held to the
   * doorways alone, since it may reach under and in front of cabinets. A wall that folds can lose
   * legs a straight one would get. Within a run the frames and towers keep behind their own
   * columns already, so a straight wall never comes here.
   */
  const folded = runs.length > 1;
  const TOL = 1e-3;
  const stripHalf = s * step / 2, jambHalf = s * dims.panelW / 2, slabHalf = s * dims.panelD / 2;
  /** Each column's centre at mid-depth, in world XZ, with `ex` along its face and `ez` out of its front. */
  const colFrames = layout.map(col => {
    const yaw = wallYaw + col.rotY;
    const o = toWorld([col.x, 0, col.z]);
    return { x: o.x, z: o.z, ex: [Math.cos(yaw), -Math.sin(yaw)], ez: [Math.sin(yaw), Math.cos(yaw)] };
  });
  /** World XZ in column `c`'s frame: along its face, and out of its front. */
  const inCol = (c: number, x: number, z: number): [number, number] => {
    const F = colFrames[c], dx = x - F.x, dz = z - F.z;
    return [dx * F.ex[0] + dz * F.ex[1], dx * F.ez[0] + dz * F.ez[1]];
  };
  /** Where the line across at `x` meets a convex outline, as the depths it runs between. */
  const sliceAt = (poly: readonly (readonly [number, number])[], x: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      if ((ax - x) * (bx - x) > 0) continue;
      const z = Math.abs(bx - ax) < 1e-12 ? null : az + (x - ax) / (bx - ax) * (bz - az);
      lo = Math.min(lo, z ?? Math.min(az, bz));
      hi = Math.max(hi, z ?? Math.max(az, bz));
    }
    return lo <= hi ? [lo, hi] : null;
  };
  // Heights above the wall's bottom where some column's cabinets start or stop: between two of them
  // each column has cabinets or has not, so one height in each stands for the lot.
  const cuts: number[] = [];
  for (const y of [0, ...bands.flatMap(b => b.flatMap(([lo, hi]) => [lo, hi]))].sort((a, b) => a - b)) {
    if (!cuts.length || y - cuts[cuts.length - 1] > 1e-6) cuts.push(y);
  }
  const ivCount = cuts.length + 1;
  const ivLo = (i: number): number => (i === 0 ? -Infinity : cuts[i - 1]);
  const ivHi = (i: number): number => (i === cuts.length ? Infinity : cuts[i]);
  /** Whether column `c` has cabinets across interval `i`. A band on the bottom row runs on down to the floor. */
  const coverIv = bands.map(b => Array.from({ length: ivCount }, (_, i) => {
    const y = i === 0 ? cuts[0] - 1 : i === cuts.length ? cuts[i - 1] + 1 : (cuts[i - 1] + cuts[i]) / 2;
    return b.some(([lo, hi]) => (lo <= EPS ? -Infinity : lo) < y && y < hi);
  }));
  /** The intervals a piece from `lo` to `hi` above the wall's bottom stands across, first to last. */
  const ivRange = (lo: number, hi: number): [number, number] | null => {
    let a = -1, b = -1;
    for (let i = 0; i < ivCount; i++) {
      if (Math.max(ivLo(i), lo) < Math.min(ivHi(i), hi) - TOL) { if (a < 0) a = i; b = i; }
    }
    return a < 0 ? null : [a, b];
  };
  const anyIn = (flags: readonly boolean[], iv: readonly [number, number] | null): boolean => {
    if (!iv) return false;
    for (let i = iv[0]; i <= iv[1]; i++) if (flags[i]) return true;
    return false;
  };
  /** The other columns with cabinets, in column `c`'s frame, each a strip wide: a bezel gap hides nothing. */
  const blockerMemo = new Map<number, { k: number; poly: [number, number][]; x0: number; x1: number }[]>();
  const blockersOf = (c: number) => {
    let got = blockerMemo.get(c);
    if (!got) {
      got = [];
      for (let k = 0; k < layout.length; k++) {
        if (k === c || !bands[k].length) continue;
        const F = colFrames[k];
        const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => inCol(c,
          F.x + a * stripHalf * F.ex[0] + b * slabHalf * F.ez[0], F.z + a * stripHalf * F.ex[1] + b * slabHalf * F.ez[1]));
        const xs = poly.map(p => p[0]);
        got.push({ k, poly, x0: Math.min(...xs), x1: Math.max(...xs) });
      }
      blockerMemo.set(c, got);
    }
    return got;
  };
  /**
   * For a box behind run `ri` -- `u0` to `u1` along it, `n0` to `n1` back from its cabinets --
   * whether, standing across each interval of height, it is in or shows past a column of another
   * run. With `doorways`, only the columns open at the floor count, jamb to jamb.
   */
  const exposed = (ri: number, u0: number, u1: number, n0: number, n1: number, doorways: boolean): boolean[] => {
    const out = new Array<boolean>(ivCount).fill(false);
    const run = runs[ri];
    const box = [[u0, n0], [u1, n0], [u1, n1], [u0, n1]].map(([u, n]) => at(run, u, 0, n));
    for (let c = 0; c < layout.length; c++) {
      if (runOfCol[c] === ri || (doorways && solidRows[c])) continue;
      const half = doorways ? jambHalf : stripHalf;
      const q = box.map(p => inCol(c, p.x, p.z));
      const qx = q.map(p => p[0]);
      const xa = Math.max(Math.min(...qx), -half) + TOL, xb = Math.min(Math.max(...qx), half) - TOL;
      if (xa >= xb) continue;
      const ks = blockersOf(c).filter(k => k.x1 > xa && k.x0 < xb);
      // Every quarter inch across, and either side of each corner and of each crossing of a face.
      const xs: number[] = [];
      const n = Math.ceil((xb - xa) / 0.25);
      for (let j = 0; j <= n; j++) xs.push(xa + (xb - xa) * j / n);
      const near = (x: number): void => { for (const d of [-TOL, TOL]) if (x + d > xa && x + d < xb) xs.push(x + d); };
      for (const p of [...q, ...ks.flatMap(k => k.poly)]) near(p[0]);
      for (let i = 0; i < 4; i++) {
        const [ax, az] = q[i], [bx, bz] = q[(i + 1) % 4];
        for (const f of [-slabHalf, slabHalf]) if ((az - f) * (bz - f) < 0) near(ax + (f - az) / (bz - az) * (bx - ax));
      }
      for (const x of xs) {
        const qs = sliceAt(q, x);
        if (!qs) continue;
        const [z0, z1] = qs;
        if (Math.max(z0, -slabHalf) < Math.min(z1, slabHalf) - TOL) return out.fill(true);
        const kz: { k: number; z: [number, number] }[] = [];
        for (const k of ks) {
          const z = x > k.x0 && x < k.x1 ? sliceAt(k.poly, x) : null;
          if (z) kz.push({ k: k.k, z });
        }
        for (let i = 0; i < ivCount; i++) {
          if (out[i]) continue;
          if (z1 > slabHalf + TOL) {
            // Seen from no further out than the nearest other cabinet: past it, a viewer looks at that
            // cabinet, front or back, and not at this column, so what stands beyond is that one's to see.
            let stop = Infinity;
            for (const b of kz) if (coverIv[b.k][i] && b.z[1] > slabHalf) stop = Math.min(stop, Math.max(b.z[0], slabHalf));
            if (Math.max(z0, slabHalf) < Math.min(z1, stop) - TOL) { out[i] = true; continue; }
          }
          if (z0 < -slabHalf - TOL && !coverIv[c][i]) {
            let stop = -Infinity;
            for (const b of kz) if (coverIv[b.k][i] && b.z[0] < -slabHalf) stop = Math.max(stop, Math.min(b.z[1], -slabHalf));
            if (Math.max(z0, stop) < Math.min(z1, -slabHalf) - TOL) out[i] = true;
          }
        }
      }
    }
    return out;
  };
  /** Columns a piece was kept from across a fold, with their neighbours: what the warnings blame. */
  const foldBlocked = new Set<number>();
  const blame = (ri: number, u: number): void => {
    const run = runs[ri];
    const c = Math.min(run.end, Math.max(run.start, run.start + Math.round(u / (s * step))));
    for (const d of [-1, 0, 1]) if (runOfCol[c + d] === ri) foldBlocked.add(c + d);
  };
  /*
   * Legs and spans stand in one band behind their run, a section deep, and a stretch of it shows if
   * any part of it does. So each run's band is looked at once, a quarter inch along at a time, and a
   * leg or span shows if any stretch it stands across does: never less than the piece itself, and
   * at most a quarter inch more at either end.
   */
  const CELL = 0.25;
  const bandOf = runs.map((run, ri) => {
    if (!folded) return null;
    const [e0, e1] = extentOf(run, run.start, run.end);
    const k0 = Math.floor((e0 - section) / CELL), k1 = Math.ceil((e1 + section) / CELL);
    // seen[i][k - k0]: how many of the stretches before the k-th show across interval i.
    const seen = Array.from({ length: ivCount }, () => new Int32Array(k1 - k0 + 1));
    for (let k = k0; k < k1; k++) {
      const f = exposed(ri, k * CELL - TOL, (k + 1) * CELL + TOL, depth - section / 2, depth + section / 2, false);
      for (let i = 0; i < ivCount; i++) seen[i][k - k0 + 1] = seen[i][k - k0] + (f[i] ? 1 : 0);
    }
    return { k0, k1, seen };
  });
  /** Whether the band behind run `ri` from `a` to `b`, across intervals `iv`, is in or shows past another run. */
  const bandShows = (ri: number, a: number, b: number, iv: readonly [number, number] | null): boolean => {
    const band = bandOf[ri];
    if (!band || !iv || b <= a) return false;
    const lo = Math.floor(a / CELL + 1e-6), hi = Math.ceil(b / CELL - 1e-6);
    if (lo < band.k0 || hi > band.k1) return anyIn(exposed(ri, a, b, depth - section / 2, depth + section / 2, false), iv);
    for (let i = iv[0]; i <= iv[1]; i++) if (band.seen[i][hi - band.k0] > band.seen[i][lo - band.k0]) return true;
    return false;
  };
  /** Whether a leg at `u` behind run `ri`, standing across intervals `iv`, is in or shows past another run. */
  const legShows = (ri: number, u: number, iv: readonly [number, number] | null): boolean => {
    const shows = bandShows(ri, u - section / 2, u + section / 2, iv);
    if (shows) blame(ri, u);
    return shows;
  };
  /** The same for a span from `a` to `b` along run `ri`. */
  const spanShows = (ri: number, a: number, b: number, iv: readonly [number, number] | null): boolean => {
    const shows = bandShows(ri, a, b, iv);
    if (shows) { blame(ri, a); blame(ri, b); }
    return shows;
  };
  // Each hole belongs to one line, and each line is looked at many times over as frames are tried:
  // what a line's couplers stand across, and whether each hole is clear, are worked out once. A hole
  // found blocked is blamed the first time only, which is enough: `foldBlocked` is never cleared.
  const lineMemo = [new WeakMap<HoleLine, boolean[]>(), new WeakMap<HoleLine, boolean[]>()];
  const holeMemo = [new WeakMap<MountPoint, boolean>(), new WeakMap<MountPoint, boolean>()];
  /**
   * Whether a coupler in hole `m` of line `l` keeps clear of the other runs. On a leg it stands its
   * height across the wall and its jaw's width up the leg, on a header the other way about; either
   * way it reaches its depth back from the cabinets.
   */
  const clampClear = (l: HoleLine, m: MountPoint, header: boolean): boolean => {
    if (!folded) return true;
    const h = header ? 1 : 0;
    const known = holeMemo[h].get(m);
    if (known !== undefined) return known;
    const ri = runOfCol[l.col];
    const [hu, hy] = header ? [jawHalf, clampDef.dims[1] / 2] : [clampDef.dims[1] / 2, jawHalf];
    let f = lineMemo[h].get(l);
    if (!f) lineMemo[h].set(l, f = exposed(ri, l.u - hu, l.u + hu, 0, clampDef.dims[2], false));
    const y = s * m.pos[1];
    const clear = !anyIn(f, ivRange(y - hy, y + hy));
    if (!clear) blame(ri, l.u);
    holeMemo[h].set(m, clear);
    return clear;
  };
  /** Whether any hole in line `l` can take a coupler round a fold: what a frame is scored on. */
  const lineClear = (l: HoleLine, header: boolean): boolean => l.mounts.some(m => clampClear(l, m, header));

  /**
   * Whether a plate centred at `u` keeps out of the doorways. It may reach forward under the
   * cabinets and out past the wall's ends, but not sideways into a column that is open at the
   * floor, where it would show from the front and be walked into. Near a fold it can reach round
   * into another run's doorway too: there it keeps off the floor between that column's jambs, from
   * a plate's width in front of the wall to a plate's width behind it.
   */
  const doorways = runs.flatMap(r => {
    const out: { run: Run; jambs: [number, number]; floor: THREE.Vector3[] }[] = [];
    for (let c = r.start; c <= r.end; c++) {
      if (solidRows[c]) continue;
      const jambs = extentOf(r, c, c);
      const [front, back] = [-s * dims.panelD - plateSize, plateSize];
      out.push({ run: r, jambs, floor: [[jambs[0], front], [jambs[1], front], [jambs[1], back], [jambs[0], back]].map(([a, n]) => at(r, a, 0, n)) });
    }
    return out;
  });
  const clearMemo = new Map<string, boolean>();
  const plateClear = (run: Run, u: number): boolean => {
    const k = `${runs.indexOf(run)}|${u.toFixed(6)}`;
    const memo = clearMemo.get(k);
    if (memo !== undefined) return memo;
    const h = plateSize / 2;
    let plate: THREE.Vector3[] | null = null;
    let clear = true;
    for (const d of doorways) {
      if (d.run === run) {
        if (u + h > d.jambs[0] + EPS && u - h < d.jambs[1] - EPS) { clear = false; break; }
        continue;
      }
      if (!plate) plate = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([a, n]) => at(run, u + a, 0, depth + n));
      if (outlinesOverlap(plate, d.floor)) { clear = false; break; }
    }
    // Nor anywhere in a doorway round a fold, or in view of one; interval 0 is the floor's.
    if (clear && folded && exposed(runs.indexOf(run), u - h, u + h, depth - h, depth + h, true)[0]) {
      clear = false;
      blame(runs.indexOf(run), u);
    }
    clearMemo.set(k, clear);
    return clear;
  };

  /**
   * Where a tower could stand behind each column, per run: a front chord on one of the column's
   * hole lines, the whole section behind the column, the plate out of the doorways.
   */
  const towerSpots = runs.map(run => {
    const spots = new Map<number, { u: number; side: number }[]>();
    for (const l of run.lines) {
      const u = l.u - l.side * co;
      const centre = s * (l.col - run.start) * step;
      if (Math.abs(u - centre) + section / 2 > s * dims.panelW / 2 + EPS || !plateClear(run, u) || !lineClear(l, false)) continue;
      spots.set(l.col, [...(spots.get(l.col) ?? []), { u, side: l.side }]);
    }
    return spots;
  });
  /** The tower spots behind run `ri`'s `towerable` columns, along the run, with the columns each holds. */
  const spotsOf = (ri: number, towerable: readonly number[]): { u: number; holds: readonly number[] }[] =>
    towerable.flatMap(c => (towerSpots[ri].get(c) ?? []).map(sp => ({ u: sp.u, holds: holdsOf(c, sp.side) })))
      .sort((p, q) => p.u - q.u);
  /**
   * Of the columns a frame with legs at `legsU` (in order along the run) leaves unheld, how many a
   * tower could still hold from one of `spots`, its plate clear of every leg's: a frame that crowds
   * out the towers beside it holds less. Both lists run the same way, so each spot is checked
   * against the two legs either side of it alone.
   */
  const towerRoom = (spots: readonly { u: number; holds: readonly number[] }[], legsU: readonly number[], holds: ReadonlySet<number>): number => {
    const could = new Set<number>();
    let i = 0;
    for (const sp of spots) {
      if (sp.holds.every(h => holds.has(h) || could.has(h))) continue;
      while (i < legsU.length && legsU[i] <= sp.u) i++;
      if (i > 0 && sp.u - legsU[i - 1] < plateSize - 1e-6) continue;
      if (i < legsU.length && legsU[i] - sp.u < plateSize - 1e-6) continue;
      for (const h of sp.holds) if (!holds.has(h)) could.add(h);
    }
    return could.size;
  };

  /**
   * The columns couplers in column `c`'s hole line on `side` hold: `c`, and the columns bolted to
   * it -- beside it in the same run, sharing a row of cabinets with it. Both of those while `c`'s
   * top stands no higher than {@link TALL_IN} above the plates, only the one on `side` above that.
   */
  const joined = (a: number, b: number): boolean => b >= 0 && b < layout.length && runOfCol[a] === runOfCol[b]
    && [...Array(dims.rows).keys()].some(r => cells.has(cellKey(layout[a].col, r)) && cells.has(cellKey(layout[b].col, r)));
  const holdsBy = layout.map((_, c) => {
    const beside = (d: number): number[] => (joined(c, c + d) ? [c + d] : []);
    const top = bands[c].length ? bands[c][bands[c].length - 1][1] : 0;
    const both = [...beside(-1), c, ...beside(1)];
    return top > TALL_IN + EPS ? { left: [...beside(-1), c], right: [c, ...beside(1)] } : { left: both, right: both };
  });
  const holdsOf = (c: number, side: number): readonly number[] => (side < 0 ? holdsBy[c].left : holdsBy[c].right);

  /** How far a mix of sticks runs past what we own, so a layout can prefer what we hold. */
  const owned = (len: number): number => ownedCount(stickOf(len)) ?? Infinity;
  const overuseOf = (sticks: readonly number[]): number => {
    const counts = new Map<number, number>();
    for (const l of sticks) counts.set(l, (counts.get(l) ?? 0) + 1);
    return sum([...counts].map(([l, n]) => Math.max(0, n - owned(l))));
  };

  /** Every mix of up to {@link MAX_SPAN_STICKS} sticks, by the length they splice to, fewest sticks first. */
  const mixesByLen = new Map<number, number[][]>();
  for (let n = 1; n <= MAX_SPAN_STICKS; n++) {
    for (const mix of multisetsOf(stickLens, n)) {
      const L = sum(mix);
      mixesByLen.set(L, [...(mixesByLen.get(L) ?? []), mix]);
    }
  }
  /** The mixes that splice to exactly `len`; none when no mix of ours does. */
  const mixesOf = (len: number): number[][] => {
    const r = Math.round(len);
    return Math.abs(len - r) < 1e-6 ? mixesByLen.get(r) ?? [] : [];
  };
  /**
   * The grid a frame's legs keep to: the sticks' common measure, a foot for ours. Every span is a
   * whole number of feet, so once one leg is placed the rest of the frame can only move in feet.
   */
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const lattice = stickLens.map(l => Math.round(l)).reduce(gcd);
  const mod = (x: number): number => ((x % lattice) + lattice) % lattice;
  const key6 = (x: number): string => x.toFixed(6);

  /** One way to fill a zone: `k` legs, the single sticks between them in order, each leg's offset from the first. */
  interface Shape { k: number; spans: number[]; rel: number[]; L: number; overuse: number }
  /**
   * Every count of legs (at least `minK`) and mix of single sticks between them that fits in `W`:
   * only those leaving at most two columns bare when any does, of those the fewest legs and one
   * more, each in every order worth trying.
   */
  const shapesFor = (W: number, minK: number): Shape[] => {
    const minStick = Math.min(...stickLens);
    let fits: { k: number; mix: number[]; L: number }[] = [];
    for (let k = minK; k * section + (k - 1) * minStick <= W + EPS; k++) {
      for (const mix of multisetsOf(stickLens, k - 1)) {
        const L = k * section + sum(mix);
        if (L <= W + EPS) fits.push({ k, mix, L });
      }
    }
    if (!fits.length) return [];
    const wide = fits.filter(f => f.L >= W - 2 * s * step - EPS);
    if (wide.length) fits = wide;
    const kMin = Math.min(...fits.map(f => f.k));
    return fits.filter(f => f.k <= kMin + 1).flatMap(f => spanOrders(f.mix).map(spans => {
      const rel = [0];
      for (const len of spans) rel.push(rel[rel.length - 1] + section + len);
      return { k: f.k, spans, rel, L: f.L, overuse: overuseOf(f.mix) };
    }));
  };

  interface Take { holds: Set<number>; header: number; aligned: number }
  /**
   * What a frame laid out along `lines` would take: a coupler on each line that runs down a leg's
   * front chord, and -- when its `header` chord meets a row of holes -- on each that crosses a span
   * clear of a weld. Every stick in a span is end-plated, so a splice is a weld like any other. It
   * holds the columns those couplers are in, and the columns they hold.
   */
  const frameTake = (lines: readonly HoleLine[], legsU: readonly number[], spans: readonly (readonly number[])[], header: boolean): Take => {
    const holds = new Set<number>(), aligned = new Set<number>();
    const grip = (l: HoleLine): void => { for (const c of holdsOf(l.col, l.side)) holds.add(c); };
    let couplers = 0;
    for (let n = 0, i = 0; n < lines.length; n++) {
      const l = lines[n];
      while (i + 1 < legsU.length && legsU[i + 1] - section / 2 <= l.u) i++;
      const legU = legsU[i];
      if (Math.abs(l.u - legU) <= section / 2 + EPS) {
        if (onLegChord(l.u, legU) && lineClear(l, false)) { grip(l); aligned.add(i); }
        continue;
      }
      if (!header || l.u < legU || i >= spans.length) continue;
      let along = l.u - (legU + section / 2);
      for (const len of spans[i]) {
        if (along < len) {
          if (along > 0 && clearOfBraceNodes(along, len, section, jawHalf) && lineClear(l, true)) { couplers++; grip(l); }
          break;
        }
        along -= len;
      }
    }
    return { holds, header: couplers, aligned: aligned.size };
  };

  /**
   * A frame on one zone of columns tall enough to hide its legs: two legs or more, a single stick
   * between each pair. Every shape, slid along its slack in quarter inches and to every offset
   * that puts a leg chord on a hole line, best by: columns held -- by the frame, or by a tower it
   * leaves room for at one of `spots` -- fewest legs, sticks we own, header couplers, legs that take
   * couplers, then centred. Across a fold no leg stands across intervals `legIv`, nor span across
   * `spanIv`, where it would show.
   */
  const planZone = (ri: number, a: number, b: number, header: boolean, spots: readonly { u: number; holds: readonly number[] }[],
    legIv: [number, number] | null, spanIv: [number, number] | null): FrameLayout | null => {
    const run = runs[ri];
    const [zl, zr] = extentOf(run, a, b);
    const lines = run.lines.filter(l => l.col >= a && l.col <= b);
    let best: { score: number[]; legsU: number[]; spans: number[][] } | null = null;
    for (const sh of shapesFor(zr - zl, 2)) {
      const slack = Math.max(0, zr - zl - sh.L);
      const first = zl + section / 2;
      const spans = sh.spans.map(len => [len]);
      const offs = new Set<number>();
      const tryOff = (o: number): void => {
        if (o >= -EPS && o <= slack + EPS) offs.add(Math.round(Math.min(Math.max(o, 0), slack) * 1e6) / 1e6);
      };
      for (let o = 0; o <= slack + EPS; o += SLIDE_STEP_IN) tryOff(o);
      tryOff(slack / 2);
      tryOff(slack);
      for (const r of sh.rel) for (const l of lines) { tryOff(l.u - co - first - r); tryOff(l.u + co - first - r); }
      for (const off of offs) {
        const legsU = sh.rel.map(r => first + off + r);
        if (!legsU.every(u => plateClear(run, u) && !legShows(ri, u, legIv))) continue;
        if (legsU.some((u, j) => j > 0 && spanShows(ri, legsU[j - 1] + section / 2, u - section / 2, spanIv))) continue;
        const t = frameTake(lines, legsU, spans, header);
        const room = towerRoom(spots, legsU, t.holds);
        const score = [t.holds.size + room, -sh.k, -sh.overuse, t.header, t.aligned, -Math.abs(off - slack / 2)];
        if (!best || rank(score, best.score) < 0) best = { score, legsU, spans };
      }
    }
    return best && { run: ri, legsU: best.legsU, spans: best.spans };
  };

  /** A span across an opening, from one zone's last leg to the next zone's first. */
  interface Bridge { mix: number[]; len: number; holds: Set<number>; header: number; overuse: number }

  /**
   * A frame across several zones -- piers, say, with doorways between them under a lintel. Each
   * zone stands one leg or more on single sticks, as `planZone` would, and the last leg of one zone
   * joins the first of the next with a span of sticks spliced end to end, behind the lintel. A zone
   * no leg can stand in -- a pier one column wide, whose plate would reach into the doorways either
   * side of it -- is crossed: the span runs on behind it to the next. The frame may start and end
   * at any zone, but stands on two legs at least.
   *
   * Spans splice to whole feet, so the frame keeps to a one-foot grid from its first leg: tried at
   * every quarter inch of it, and at every offset that puts a single-leg zone's chord on a hole
   * line. Along the grid, zone by zone, the best frame ending at each last leg, by: columns held,
   * fewest legs, sticks we own, the shortest spans across the openings, header couplers, legs that
   * take couplers, then each zone's legs centred. Across a fold, legs and spans keep out of view as
   * in `planZone`.
   */
  const planBridged = (ri: number, zones: readonly [number, number][], header: boolean,
    legIv: [number, number] | null, spanIv: [number, number] | null): FrameLayout | null => {
    const run = runs[ri];
    const Z = zones.map(([a, b]) => {
      const [zl, zr] = extentOf(run, a, b);
      return { first: zl + section / 2, W: zr - zl, shapes: shapesFor(zr - zl, 1), lines: run.lines.filter(l => l.col >= a && l.col <= b) };
    });
    const lines = run.lines.filter(l => l.col >= zones[0][0] && l.col <= zones[zones.length - 1][1]);

    const zoneMemo = new Map<string, Take>();
    const zoneTake = (j: number, h: number, f: number): Take => {
      const k = `${j}|${h}|${key6(f)}`;
      let t = zoneMemo.get(k);
      if (!t) {
        const sh = Z[j].shapes[h];
        t = frameTake(Z[j].lines, sh.rel.map(r => f + r), sh.spans.map(len => [len]), header);
        zoneMemo.set(k, t);
      }
      return t;
    };
    /**
     * The span from a leg at `e` to one at `f`: any mix of the fewest sticks that make it, in any
     * order worth trying, best by: columns held, sticks we own, then header couplers. Splices are
     * welds, so where they fall decides which holes take a coupler. (Laying it out, `build` widens
     * this to two sticks more, to reach for the stock that is left.)
     */
    const bridgeMemo = new Map<string, Bridge | null>();
    const bridge = (e: number, f: number): Bridge | null => {
      const k = `${key6(e)}|${key6(f)}`;
      const hit = bridgeMemo.get(k);
      if (hit !== undefined) return hit;
      const len = f - e - section;
      const mixes = mixesOf(len);
      const cap = mixes[0]?.length ?? 0;
      const under = lines.filter(l => l.u > e + section / 2 + EPS && l.u < f - section / 2 - EPS);
      let out: Bridge | null = null, top: number[] | null = null;
      for (const mix of mixes) {
        if (mix.length > cap) continue;
        const overuse = overuseOf(mix);
        for (const order of header ? spanOrders(mix) : [mix]) {
          const t = frameTake(under, [e, f], [order], header);
          const score = [t.holds.size, -overuse, t.header];
          if (!top || rank(score, top) < 0) { top = score; out = { mix: order, len, holds: t.holds, header: t.header, overuse }; }
        }
      }
      bridgeMemo.set(k, out);
      return out;
    };

    // The grid's phase: every quarter inch, and every exact chord-on-line offset of a zone one leg
    // fills, at each count of legs that can stand ahead of it -- none, where the frame starts there.
    const phases = new Map<string, number>();
    const addPhase = (p: number): void => { const m = mod(p); phases.set(key6(m), m); };
    for (let p = 0; p < lattice - EPS; p += SLIDE_STEP_IN) addPhase(p);
    let iMax = 0;
    for (const z of Z) {
      const ks = z.shapes.map(h => h.k);
      if (!ks.length) continue;
      if (Math.max(...ks) === 1) {
        for (const l of z.lines) for (const sg of [-1, 1]) for (let i = 0; i <= iMax; i++) addPhase(l.u + sg * co - i * section);
      }
      iMax += Math.max(...ks);
    }

    /** The best frame so far ending at one last leg, with the tallies its score is built from. */
    interface St {
      e: number; score: number[]; holds: Set<number>; legsU: number[]; spans: number[][];
      legs: number; overuse: number; across: number; header: number; aligned: number; off: number;
    }
    let best: St | null = null;
    for (const phase of phases.values()) {
      let states = new Map<string, St>();
      for (let j = 0; j < Z.length; j++) {
        const z = Z[j];
        const next = new Map<string, St>();
        // A frame may start here; one that can stand no leg here crosses this zone on its next span.
        const from: (St | null)[] = [null, ...states.values()];
        for (const st of from) {
          let stood = false;
          z.shapes.forEach((sh, h) => {
            const slack = z.W - sh.L;
            const start = z.first + mod((st ? st.e + section : phase) - z.first);
            for (let f = start; f <= z.first + slack + EPS; f += lattice) {
              const br = st ? bridge(st.e, f) : null;
              if (st && !br) continue;
              if (st && spanShows(ri, st.e + section / 2, f - section / 2, spanIv)) continue;
              const legsU = sh.rel.map(r => f + r);
              if (!legsU.every(u => plateClear(run, u) && !legShows(ri, u, legIv))) continue;
              if (legsU.some((u, j) => j > 0 && spanShows(ri, legsU[j - 1] + section / 2, u - section / 2, spanIv))) continue;
              stood = true;
              const t = zoneTake(j, h, f);
              const extra: number[] = [];
              for (const c of br?.holds ?? []) if (!st?.holds.has(c)) extra.push(c);
              for (const c of t.holds) if (!(st?.holds.has(c) || br?.holds.has(c))) extra.push(c);
              const legs = (st?.legs ?? 0) + sh.k;
              const overuse = (st?.overuse ?? 0) + (br?.overuse ?? 0) + sh.overuse;
              const across = (st?.across ?? 0) + (br?.len ?? 0);
              const header = (st?.header ?? 0) + (br?.header ?? 0) + t.header;
              const aligned = (st?.aligned ?? 0) + t.aligned;
              const off = (st?.off ?? 0) + Math.abs(f - z.first - slack / 2);
              const score = [(st?.holds.size ?? 0) + extra.length, -legs, -overuse, -across, header, aligned, -off];
              const e = legsU[legsU.length - 1];
              const cur = next.get(key6(e));
              if (cur && rank(score, cur.score) >= 0) continue;
              next.set(key6(e), {
                e, score, legs, overuse, across, header, aligned, off,
                holds: new Set([...(st?.holds ?? []), ...extra]),
                legsU: [...(st?.legsU ?? []), ...legsU],
                spans: [...(st?.spans ?? []), ...(br ? [br.mix] : []), ...sh.spans.map(len => [len])],
              });
            }
          });
          if (st && !stood) {
            const cur = next.get(key6(st.e));
            if (!cur || rank(st.score, cur.score) < 0) next.set(key6(st.e), st);
          }
        }
        states = next;
      }
      for (const st of states.values()) if (st.legs >= 2 && (!best || rank(st.score, best.score) < 0)) best = st;
    }
    return best && { run: ri, legsU: best.legsU, spans: best.spans };
  };

  /**
   * The frames a leg of `stack` makes at `shim`. Its spans run at the top of the legs, block to
   * block, so they stand behind whichever columns have a band of cabinets covering that height: a
   * stretch of such columns can take a frame. Its legs stand only where the cabinets run unbroken
   * from the floor to above their blocks -- zones within the stretch -- and every zone gets one.
   * Where no header chord meets a row of holes the legs are laid out for the couplers they take.
   * Across a fold, the heights the legs, spans and shortest tower stand across key the layouts too.
   */
  const layoutMemo = new Map<string, FrameLayout[]>();
  const framesFor = (stack: LegStack, shim: number): FrameLayout[] => {
    const bottomY = plateTop + shim;
    const blockY = supportY + baseH + stack.rise;
    const chordYs = [blockY + chordR, blockY + section - chordR];
    const header = [...heights].some(hh => chordYs.some(cy => Math.abs(bottomY + hh - cy) < EPS));
    const cover = (c: number): boolean =>
      bands[c].some(([lo, hi]) => bottomY + lo <= blockY + EPS && blockY + blockH <= bottomY + hi + EPS);
    const legOK = (c: number): boolean => cover(c) && blockY + blockH <= bottomY + hiddenRise(c) + EPS;
    const legIv = folded ? ivRange(-shim, blockY + blockH - bottomY) : null;
    const spanIv = folded ? ivRange(blockY - bottomY, blockY + section - bottomY) : null;
    const towerIv = folded ? ivRange(-shim, supportY + shortestLeg - bottomY) : null;
    const out: FrameLayout[] = [];
    runs.forEach((run, ri) => {
      for (let c = run.start; c <= run.end;) {
        if (!cover(c)) { c++; continue; }
        const zones: [number, number][] = [];
        for (; c <= run.end && cover(c); c++) {
          if (!legOK(c)) continue;
          const last = zones[zones.length - 1];
          if (last && last[1] === c - 1) last[1] = c;
          else zones.push([c, c]);
        }
        if (!zones.length) continue;
        const towerable = [...towerSpots[ri].keys()].filter(k => supportY + shortestLeg <= bottomY + hiddenRise(k) + EPS);
        const key = `${ri}|${header}|${towerable.join(',')}|${zones.map(z => z.join('-')).join(',')}`
          + (folded ? `|${legIv}|${spanIv}|${towerIv}` : '');
        let got = layoutMemo.get(key);
        if (!got) {
          const spots = spotsOf(ri, towerable).filter(sp => !legShows(ri, sp.u, towerIv));
          const one = zones.length === 1 ? planZone(ri, ...zones[0], header, spots, legIv, spanIv) : planBridged(ri, zones, header, legIv, spanIv);
          // Zones no span of ours can join stand as frames of their own, if they are wide enough.
          got = one ? [one] : zones.length > 1
            ? zones.map(z => planZone(ri, ...z, header, spots, legIv, spanIv)).filter((f): f is FrameLayout => !!f) : [];
          layoutMemo.set(key, got);
        }
        out.push(...got);
      }
    });
    return out;
  };

  /**
   * How tall. Every leg of one stick or more, with a spare block under its top one or not, at the
   * shim that puts one of its header chords on a row of holes (within the quarter inch), and at no
   * shim at all: there the spans only brace the legs, which is still a frame.
   */
  const stacks: LegStack[] = stickStacks([...stickLens, ...buyDefs.map(d => d.dims[0])], MAX_LEG_STICKS).filter(sticks => sticks.length)
    .flatMap(sticks => [0, 1].map(spacers => ({ sticks, spacers, rise: sum(sticks) + spacers * blockH })));
  const heights = new Set<number>(onFace.map(m => s * m.pos[1]));
  const options = new Map<string, { stack: LegStack; shim: number }>();
  const addOption = (stack: LegStack, shim: number): void => {
    const key = `${stack.sticks.join(',')}|${stack.spacers}|${shim.toFixed(6)}`;
    if (!options.has(key)) options.set(key, { stack, shim });
  };
  for (const stack of stacks) {
    // A stick to buy earns its place by bolting a header; a brace stands on sticks we have.
    if (stack.sticks.every(l => stickLens.includes(l))) addOption(stack, 0);
    for (const c of [chordR, section - chordR]) {
      for (const hh of heights) {
        const shim = baseH + stack.rise + c - base.plateThick - hh;
        if (shim < -EPS || shim > SHIM_MAX_IN + EPS) continue;
        addOption(stack, Math.min(Math.max(shim, 0), SHIM_MAX_IN));
      }
    }
  }

  // Stock left for this rig: what we own, less what the rest of the scene already stands up.
  const mine = rigEntityIds(doc, wall.id);
  const usedElsewhere = new Map<string, number>();
  for (const e of doc.entities) {
    if (e.type !== 'equipment' || mine.has(e.id) || e.ghost) continue;
    usedElsewhere.set(e.catalogId, (usedElsewhere.get(e.catalogId) ?? 0) + 1);
  }
  const availMemo = new Map<string, number>();
  const available = (id: string): number => {
    let got = availMemo.get(id);
    if (got === undefined) {
      const own = ownedCount(equipmentDef(id));
      availMemo.set(id, got = own === undefined ? Infinity : Math.max(0, own - (usedElsewhere.get(id) ?? 0)));
    }
    return got;
  };

  /** Stacks a tower could stand at one spot, with the couplers each takes: the same spots recur across heights. */
  const towerMemo = new Map<string, { sticks: number[]; hits: number }[]>();

  /** Lay out a whole rig at `shim`: the frames in `layouts` on `stack` (none without one), then towers. */
  const build = (shim: number, stack: LegStack | null, layouts: readonly FrameLayout[]) => {
    const bottomY = plateTop + shim;
    /** Each leg with its plate's footprint on the floor, which no other plate may overlap. */
    const legs: (RigLeg & { foot: Footprint })[] = [];
    const footAt = (run: Run, axis: THREE.Vector3): Footprint => ({ x: axis.x, z: axis.z, size: plateSize, rotY: run.yaw });
    const spans: RigPiece[] = [];
    const clamps: { piece: RigPiece; col: number; header: boolean }[] = [];
    /** Columns with couplers of their own, and every column held: those and the columns they hold. */
    const held = new Set<number>(), supported = new Set<number>();
    /** Span lengths past the span table. */
    const long: number[] = [];
    let weld = 0;
    let headerY: number | null = null;

    // Stock as the rig takes it, so each later choice -- a span's sticks, a tower's -- goes to what is left.
    const taken = new Map<string, number>();
    const take = (pieces: readonly RigPiece[]): void => {
      for (const p of pieces) taken.set(p.catalogId, (taken.get(p.catalogId) ?? 0) + 1);
    };
    const short = (sticks: readonly number[]): number => {
      const counts = new Map<string, number>();
      for (const len of sticks) { const id = stickOf(len).id; counts.set(id, (counts.get(id) ?? 0) + 1); }
      let lack = 0;
      for (const [id, n] of counts) lack += Math.max(0, n - Math.max(0, available(id) - (taken.get(id) ?? 0)));
      return lack;
    };

    const place = (def: EquipmentDef, geometry: EquipmentGeometry, d: readonly number[], p: THREE.Vector3, yaw: number): RigPiece => ({
      catalogId: def.id, name: def.name, geometry, dims: [d[0], d[1], d[2]], color: def.color,
      position: [p.x, p.y, p.z], rotation: [0, yaw * DEG, 0], ghost: false,
    });
    const addClamp = (run: Run, m: MountPoint, y: number, col: number, side: number, chord: THREE.Vector3, header: boolean): void => {
      clamps.push({ piece: clampPiece(clampDef, toWorld(m.pos).setY(y), chord, run.N), col, header });
      held.add(col);
      for (const c of holdsOf(col, side)) supported.add(c);
    };

    /** A leg's pieces bottom up, and the chords on it a jaw can close on (not the blocks'). */
    const legAt = (run: Run, u: number, sticks: readonly number[], blocks: number) => {
      const axis = at(run, u, supportY, depth);
      const pieces = [place(baseDef, baseDef.geometry, baseDef.dims, axis, run.yaw)];
      const chords: ChordSpan[] = base.riserLen > EPS ? [{ footY: supportY + base.plateThick, len: base.riserLen }] : [];
      let y = supportY + baseH;
      for (const len of sticks) {
        pieces.push(place(stickOf(len), 'truss-vertical', [section, len, section], axis.clone().setY(y), run.yaw));
        chords.push({ footY: y, len });
        y += len;
      }
      for (let i = 0; i < blocks; i++) {
        pieces.push(place(blockDef, blockDef.geometry, blockDef.dims, axis.clone().setY(y), run.yaw));
        y += blockH;
      }
      return { axis, pieces, chords, topY: y };
    };

    /** Every hole on a line one of the leg's front chords runs down, and the ones a weld blocks. */
    const legHits = (run: Run, u: number, chords: readonly ChordSpan[]) => {
      const hits: { m: MountPoint; y: number; col: number; side: number }[] = [];
      let welds = 0;
      for (const l of run.lines) {
        if (!onLegChord(l.u, u)) continue;
        for (const m of l.mounts) {
          const y = bottomY + s * m.pos[1];
          const span = chords.find(q => y >= q.footY - 1e-6 && y <= q.footY + q.len + 1e-6);
          if (!span) continue;
          if (!clearOfBraceNodes(y - span.footY, span.len, section, jawHalf)) welds++;
          else if (clampClear(l, m, false)) hits.push({ m, y, col: l.col, side: l.side });
        }
      }
      return { hits, welds };
    };

    /** Holes a span's sticks, laid end to end from `from`, put on a header chord, and those a weld blocks. */
    const spanHits = (run: Run, from: number, sticks: readonly number[], chordYs: readonly number[]) => {
      const hits: { m: MountPoint; y: number; col: number; side: number; chordY: number }[] = [];
      let welds = 0;
      for (let i = 0, p = from; i < sticks.length; p += sticks[i], i++) {
        const len = sticks[i];
        for (const l of run.lines) {
          const along = l.u - p;
          if (along <= 0 || along >= len) continue;
          for (const m of l.mounts) {
            const y = bottomY + s * m.pos[1];
            const chordY = chordYs.find(cy => Math.abs(cy - y) < EPS);
            if (chordY === undefined) continue;
            if (!clearOfBraceNodes(along, len, section, jawHalf)) welds++;
            else if (clampClear(l, m, true)) hits.push({ m, y, col: l.col, side: l.side, chordY });
          }
        }
      }
      return { hits, welds };
    };

    const UP = new THREE.Vector3(0, 1, 0);
    const blockY = stack ? supportY + baseH + stack.rise : null;
    /** The frames that stand: one whose plate would land on another frame's -- round a fold -- does not. */
    const placed: FrameLayout[] = [];
    let dropped = 0;
    if (stack && blockY !== null) {
      const chordYs = [blockY + chordR, blockY + section - chordR];
      // Every frame's legs first, so the spans' sticks come from what the legs leave.
      for (const f of layouts) {
        const run = runs[f.run];
        if (f.legsU.some(u => legs.some(g => overlaps(g.foot, footAt(run, at(run, u, supportY, depth)))))) { dropped++; continue; }
        placed.push(f);
        for (const u of f.legsU) {
          const leg = legAt(run, u, stack.sticks, stack.spacers + 1);
          legs.push({ kind: 'frame', axis: [leg.axis.x, leg.axis.z], rotY: run.yaw * DEG, topY: leg.topY, pieces: leg.pieces, foot: footAt(run, leg.axis) });
          take(leg.pieces);
          const { hits, welds } = legHits(run, u, leg.chords);
          weld += welds;
          for (const h of hits) addClamp(run, h.m, h.y, h.col, h.side, UP, false);
        }
      }
      for (const f of placed) {
        const run = runs[f.run];
        f.spans.forEach((laid, j) => {
          const from = f.legsU[j] + section / 2;
          const len = sum(laid);
          if (len > SPAN_TABLE_IN + EPS) long.push(len);
          // A single stick stands as laid out. A spliced span is any mix of no more than two sticks
          // past the fewest that make it, in any order worth trying, best by: columns it holds that
          // nothing else does yet, sticks we have left, couplers on the header, then fewest sticks.
          let sticks = laid;
          if (laid.length > 1) {
            const mixes = mixesOf(len);
            const cap = (mixes[0]?.length ?? 0) + 2;
            let pick: { score: number[]; order: number[] } | null = null;
            for (const mix of mixes) {
              if (mix.length > cap) continue;
              const lack = short(mix);
              for (const order of spanOrders(mix)) {
                const { hits } = spanHits(run, from, order, chordYs);
                const fresh = new Set(hits.flatMap(h => holdsOf(h.col, h.side)).filter(c => !supported.has(c))).size;
                const score = [fresh, -lack, hits.length, -order.length];
                if (!pick || rank(score, pick.score) < 0) pick = { score, order };
              }
            }
            sticks = pick?.order ?? laid;
          }
          for (let i = 0, p = from; i < sticks.length; p += sticks[i], i++) {
            const def = stickOf(sticks[i]);
            const piece = place(def, def.geometry, [sticks[i], section, section], at(run, p + sticks[i] / 2, blockY, depth), run.yaw);
            spans.push(piece);
            take([piece]);
          }
          const { hits, welds } = spanHits(run, from, sticks, chordYs);
          weld += welds;
          for (const h of hits) {
            addClamp(run, h.m, h.y, h.col, h.side, run.U, true);
            headerY = Math.max(headerY ?? -Infinity, h.chordY);
          }
        });
      }
    }

    // Towers for whatever the frames leave unheld, as few as will hold it: for the first column
    // nothing holds yet, the tower that holds it and the most columns with it, then the furthest
    // on. It stands on a hole line of that column or one beside it, the section behind the column,
    // the plate out of the doorways and clear of every other leg's -- across a fold too, where two
    // runs' legs crowd the same corner -- and the stack under the column's top, out of view round a
    // fold. Then the stack that
    // leaves us least short, takes the most couplers, and is fewest and shortest sticks; then the
    // spot nearest the middle of the columns it holds.
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      for (let c = run.start; c <= run.end; c++) {
        if (supported.has(c)) continue;
        let pick: { score: number[]; u: number; foot: Footprint; sticks: number[] } | null = null;
        for (let k = Math.max(run.start, c - 1); k <= Math.min(run.end, c + 1); k++) {
          const top = bottomY + hiddenRise(k);
          if (supportY + shortestLeg > top + EPS) continue;
          for (const { u, side } of towerSpots[ri].get(k) ?? []) {
            const holds = holdsOf(k, side);
            if (!holds.includes(c)) continue;
            const foot = footAt(run, at(run, u, supportY, depth));
            if (legs.some(g => overlaps(g.foot, foot))) continue;
            const key = `${ri}|${key6(u)}|${key6(bottomY)}|${key6(top)}`;
            let cands = towerMemo.get(key);
            if (!cands) {
              cands = stickStacks(stickLens, MAX_LEG_STICKS)
                .filter(sticks => supportY + baseH + sum(sticks) <= top + EPS
                  && !legShows(ri, u, folded ? ivRange(-shim, supportY + baseH + sum(sticks) - bottomY) : null))
                .map(sticks => ({ sticks, hits: legHits(run, u, legAt(run, u, sticks, 0).chords).hits.length }))
                .filter(t => t.hits > 0);
              towerMemo.set(key, cands);
            }
            const fresh = holds.filter(h => !supported.has(h)).length;
            const middle = s * ((Math.min(...holds) + Math.max(...holds)) / 2 - run.start) * step;
            for (const t of cands) {
              const score = [fresh, Math.max(...holds), -short(t.sticks), t.hits, -t.sticks.length, -sum(t.sticks), -Math.abs(u - middle)];
              if (!pick || rank(score, pick.score) < 0) pick = { score, u, foot, sticks: t.sticks };
            }
          }
        }
        if (!pick) continue;
        const leg = legAt(run, pick.u, pick.sticks, 0);
        const got = legHits(run, pick.u, leg.chords);
        legs.push({ kind: 'tower', axis: [leg.axis.x, leg.axis.z], rotY: run.yaw * DEG, topY: leg.topY, pieces: leg.pieces, foot: pick.foot });
        take(leg.pieces);
        weld += got.welds;
        for (const h of got.hits) addClamp(run, h.m, h.y, h.col, h.side, UP, false);
      }
    }

    // Stock, in the order the rig goes up: frame legs, spans, towers, then couplers -- the first
    // coupler on each column ahead of the rest, so a short box of couplers still bolts every column on.
    const firstPerCol = new Set<number>();
    const lead: RigPiece[] = [], rest: RigPiece[] = [];
    for (const c of [...clamps].sort((a, b) => Number(b.header) - Number(a.header))) {
      if (firstPerCol.has(c.col)) rest.push(c.piece);
      else { firstPerCol.add(c.col); lead.push(c.piece); }
    }
    const left = new Map<string, number>();
    let ghosts = 0;
    const upright = (kind: RigLeg['kind']): RigPiece[] => legs.filter(g => g.kind === kind).flatMap(g => g.pieces);
    for (const p of [...upright('frame'), ...spans, ...upright('tower'), ...lead, ...rest]) {
      if (!left.has(p.catalogId)) left.set(p.catalogId, available(p.catalogId));
      const n = left.get(p.catalogId)!;
      p.ghost = n <= 0;
      if (p.ghost) ghosts++;
      left.set(p.catalogId, n - 1);
    }

    const frames = stack ? placed.length : 0;
    const bought = legs.reduce((a, g) => a + g.pieces.filter(p => buyIds.has(p.catalogId)).length, 0);
    const pieceCount = legs.reduce((a, g) => a + g.pieces.length, 0) + spans.length + clamps.length;
    return {
      shim, bottomY, legs, spans, clamps: clamps.map(c => c.piece), held, supported, weld, headerY, long, frames, ghosts, dropped,
      // A rig that holds nothing is no rig. Of the rest, the most columns held; then the fewest
      // sticks to buy, so one is bought only to hold more; then legs tied together by spans over
      // loose towers -- but never at the cost of a column left hanging; then the fewest ghosts and
      // the fewest legs; then the most columns with couplers of their own.
      score: [supported.size ? 1 : 0, supported.size, -bought, frames ? 1 : 0, -ghosts, -legs.length, held.size,
        headerY ?? -1e9, clamps.length, -pieceCount, -shim],
    };
  };

  let best = build(0, null, []);
  for (const o of options.values()) {
    const layouts = framesFor(o.stack, o.shim);
    if (!layouts.length) continue;
    const got = build(o.shim, o.stack, layouts);
    if (rank(got.score, best.score) < 0) best = got;
    if (got.dropped) {
      const other = build(o.shim, o.stack, [...layouts].reverse());
      if (rank(other.score, best.score) < 0) best = other;
    }
  }

  if (!best.legs.length || !best.held.size) {
    const tallest = Math.max(...layout.map((_, c) => hiddenRise(c)));
    const what = base.riserLen > EPS ? 'its base alone' : `a base plate and a ${+(shortestStick / 12).toFixed(2)} ft stick`;
    warnings.push(plateTop + tallest < supportY + shortestLeg - EPS
      ? `The shortest leg, ${what}, stands ${shortestLeg.toFixed(1)} in: taller than the wall in front of it, which stands ${(base.plateThick + tallest).toFixed(1)} in, so it would show above it.`
      : 'No leg fits behind this wall with a coupler on it.');
    return empty(currentBottom);
  }

  const pScale = new THREE.Vector3();
  parentMatrix(wall, byId).decompose(new THREE.Vector3(), new THREE.Quaternion(), pScale);
  const liftIn = best.bottomY - currentBottom;

  // Stock, as a shortfall per part.
  const need = new Map<string, { name: string; n: number; ghosts: number }>();
  for (const p of [...best.legs.flatMap(g => g.pieces), ...best.spans, ...best.clamps]) {
    const row = need.get(p.catalogId) ?? { name: p.name, n: 0, ghosts: 0 };
    row.n++;
    if (p.ghost) row.ghosts++;
    need.set(p.catalogId, row);
  }
  const shortfall: RigShortfall[] = [...need]
    .filter(([, r]) => r.ghosts > 0)
    .map(([catalogId, r]) => ({ catalogId, name: r.name, need: r.n, have: r.n - r.ghosts }));

  const plan: TrussRigPlan = {
    wallId: wall.id,
    legs: best.legs.map(({ kind, axis, rotY, topY, pieces }) => ({ kind, axis, rotY, topY, pieces })),
    spans: best.spans,
    clamps: best.clamps,
    frames: best.frames,
    headerY: best.headerY,
    liftIn,
    liftLocalIn: liftIn / (pScale.y || 1),
    bottomY: best.bottomY,
    shimIn: best.shim,
    dropAccessories,
    held: best.held.size,
    supported: best.supported.size,
    columns: bands.filter(b => b.length).length,
    ghosts: best.ghosts,
    shortfall,
    skipped: { offFace, weld: best.weld },
    warnings,
  };

  if (Math.abs(liftIn) > 1e-6) {
    warnings.push(`The wall ${liftIn > 0 ? 'rises' : 'comes down'} ${Math.abs(liftIn).toFixed(2)} in to sit on the ${base.plateThick.toFixed(2)} in base plates${
      plan.shimIn > 1e-6 ? `, on a ${plan.shimIn.toFixed(2)} in shim so the header chord meets a row of holes` : ''}.`);
  } else if (plan.shimIn > 1e-6) {
    warnings.push(`The wall sits on a ${plan.shimIn.toFixed(2)} in shim on the base plates, so the header chord meets a row of holes.`);
  }
  if (best.weld) {
    warnings.push(`${best.weld} ${best.weld === 1 ? 'hole sits' : 'holes sit'} level with a brace weld, where a coupler cannot close.`);
  }
  if (best.long.length) {
    const n = best.long.length;
    const ft = +(Math.max(...best.long) / 12).toFixed(1);
    warnings.push(`${n} ${n === 1 ? 'span runs' : 'spans run'} past ${SPAN_TABLE_IN / 12} ft, where the DT-GP span table stops (the longest is ${ft} ft): `
      + `have ${n === 1 ? 'it' : 'them'} checked before ${n === 1 ? 'it carries' : 'they carry'} the wall.`);
  }
  if (offFace) {
    warnings.push(`${offFace} ${offFace === 1 ? 'hole is' : 'holes are'} cut away by a mitre.`);
  }
  if (dropAccessories) {
    warnings.push('The floor-stand base plates and back supports come off: they stand where the legs do.');
  }
  const carried = plan.supported - plan.held;
  if (carried > 0) {
    warnings.push(`${carried} ${carried === 1 ? 'column has' : 'columns have'} no coupler of ${carried === 1 ? 'its' : 'their'} own: `
      + `${carried === 1 ? 'it is' : 'each is'} held by a coupled column beside it.`);
  }
  const loose = plan.columns - plan.supported;
  if (loose > 0) {
    warnings.push(`${loose} ${loose === 1 ? 'column is' : 'columns are'} out of reach of every coupler, and nothing holds ${loose === 1 ? 'it' : 'them'}.`);
    const byFold = layout.filter((_, c) => bands[c].length && !best.supported.has(c) && foldBlocked.has(c)).length;
    if (byFold) {
      warnings.push(`${byFold === loose ? (loose === 1 ? 'It stands' : 'They stand') : `${byFold} of them ${byFold === 1 ? 'stands' : 'stand'}`} beside a fold, where a leg, span or coupler `
        + 'would stand in the cabinets round the fold, or show past them.');
    }
  }
  for (const f of shortfall) {
    const k = f.need - f.have;
    warnings.push(buyIds.has(f.catalogId)
      ? `${f.name}: ${k} to buy, drawn as ${k === 1 ? 'a ghost' : 'ghosts'}. We hold none, and our own sticks put no header on a row of holes here.`
      : `${f.name}: ${f.need} needed, ${f.have} available - ${k} drawn as ${k === 1 ? 'a ghost' : 'ghosts'}.`);
  }

  return plan;
}

/**
 * Place one coupler: its bolt in the hole, its jaw round the chord behind it.
 *
 * `buildClamp` draws the part with its plate at the back, its jaw forward at +Z and the chord it
 * grips running along its local X. So local +Z is the hole's outward normal and local +X is the
 * chord -- straight up on a leg, along the wall on a header -- and the bolt sits at local
 * (0, h/2, -d/2). The basis goes through a matrix rather than hand-rolled angles because that bolt
 * has to land IN the hole, and a sign slipped in an Euler is invisible until a coupler is floating
 * in mid air.
 */
function clampPiece(def: EquipmentDef, hole: THREE.Vector3, chord: THREE.Vector3, normal: THREE.Vector3): RigPiece {
  const [, h, d] = def.dims;
  const xAxis = chord.clone().normalize();
  const zAxis = normal.clone().normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis), 'YXZ');
  const pos = hole.clone().addScaledVector(yAxis, -h / 2).addScaledVector(zAxis, d / 2);
  return {
    catalogId: def.id, name: def.name, geometry: def.geometry,
    dims: [...def.dims] as Vec3, color: def.color,
    position: [pos.x, pos.y, pos.z],
    rotation: [e.x * DEG, e.y * DEG, e.z * DEG],
    ghost: false,
  };
}

/* ───────────────────────────── applying ───────────────────────────── */

/** Every entity belonging to a rig generated for `wallId`: the group and everything under it. */
export function rigEntityIds(doc: Document, wallId: string): Set<string> {
  const ids = new Set(doc.entities.filter(e => e.type === 'group' && e.rigFor === wallId).map(e => e.id));
  for (const e of doc.entities) if (e.parentId && ids.has(e.parentId)) ids.add(e.id);
  return ids;
}

/**
 * The next document with `plan` built: the old rig for this wall gone, the new one in, the wall
 * set down on the plates and its floor-stand kit dropped.
 *
 * One function so one `cmdPatchDocument` covers the lot and a whole rig is a single undo. The
 * group's transform stays identity because its children carry world coordinates.
 */
export function applyTrussRig(doc: Document, wall: LedWallEntity, plan: TrussRigPlan): Document {
  const stale = rigEntityIds(doc, wall.id);
  const group: GroupEntity = { ...createGroup(RIG_GROUP_NAME), rigFor: wall.id };

  const parts: EquipmentEntity[] = [...plan.legs.flatMap(l => l.pieces), ...plan.spans, ...plan.clamps].map(p => {
    const e = createEquipment(
      { id: p.catalogId, name: p.ghost ? `${p.name} (not owned)` : p.name, geometry: p.geometry, dims: p.dims, color: p.color },
      [...p.position] as Vec3,
    );
    e.transform.rotation = [...p.rotation] as Vec3;
    e.parentId = group.id;
    if (p.ghost) e.ghost = true;
    return e;
  });

  const entities = doc.entities
    .filter(e => !stale.has(e.id))
    .map(e => {
      if (e.id !== wall.id) return e;
      const next = { ...e } as LedWallEntity;
      if (Math.abs(plan.liftLocalIn) > 1e-6) {
        const [x, y, z] = next.transform.position;
        next.transform = { ...next.transform, position: [x, y + plan.liftLocalIn, z] };
      }
      if (plan.dropAccessories) next.accessories = false;
      return next;
    });

  return { ...doc, entities: [...entities, group, ...parts] };
}
