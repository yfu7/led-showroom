/**
 * Auto truss: a rig standing behind an LED wall, hidden by it, bolted into the cabinets' M10 holes.
 *
 * Two shapes of rig, from the stock we hold:
 *
 *  - A FRAME on a straight run of full-height columns: legs (a base plate, GP sticks, a 6-way block
 *    on top) with horizontal sticks spanning block to block. The header's front chord runs along a
 *    row of holes, so a half coupler goes into every hole on that row that is clear of a weld, and
 *    where a leg's front chord happens to run down a line of holes those take couplers too.
 *  - A TOWER behind a column the frame does not reach: a base plate and sticks, one front chord on one of
 *    the column's two hole lines, every hole on that line clamped.
 *
 * Three rules every rig keeps:
 *
 *  - Nothing shows from the front. Every leg and span stands inside the run it is behind, and
 *    no higher than the cabinets in front of it. Only the base plates reach out, on the floor.
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

/** Separating-axis test for two rotated squares. */
function overlaps(a: Footprint, b: Footprint): boolean {
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

/** Where a frame's legs stand along a run, and the spans between them, left to right. */
interface FrameLayout { run: number; legsU: number[]; spans: number[] }

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
    held: 0, columns: 0, ghosts: 0, shortfall: [], skipped: { offFace: 0, weld: 0 }, warnings,
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
  const stickOf = (len: number): EquipmentDef => stickDefs.find(d => d.dims[0] === len) ?? stickDefs[0];
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

  /**
   * Stage one: where a frame's legs go along a stretch of full-height columns, independent of how
   * tall they are. Every leg count and span mix that fits, every order, slid along the slack in
   * quarter inches and to every offset that puts a leg chord on a hole line, kept if it holds
   * at least two thirds of the stretch -- about what towers manage -- and best by: columns held,
   * fewest legs, spans we own, header couplers, legs that take couplers, then centred.
   */
  const planFrame = (ri: number, a: number, b: number): FrameLayout | null => {
    const run = runs[ri];
    const uLeft = s * ((a - run.start) * step - dims.panelW / 2);
    const W = s * ((b - a) * step + dims.panelW);
    const lines = run.lines.filter(l => l.col >= a && l.col <= b);
    const minSpan = Math.min(...stickLens);

    let fits: { k: number; spans: number[]; L: number }[] = [];
    for (let k = 2; k * section + (k - 1) * minSpan <= W + EPS; k++) {
      for (const set of multisetsOf(stickLens, k - 1)) {
        const L = k * section + sum(set);
        if (L <= W + EPS) fits.push({ k, spans: set, L });
      }
    }
    // A frame that leaves more than two columns' width bare is not worth weighing against one that does not.
    const wide = fits.filter(f => f.L >= W - 2 * s * step - EPS);
    if (wide.length) fits = wide;

    const owned = (len: number): number => ownedCount(stickOf(len)) ?? Infinity;
    let best: { score: number[]; legsU: number[]; spans: number[] } | null = null;
    for (const fit of fits) {
      const slack = Math.max(0, W - fit.L);
      const counts = new Map<number, number>();
      for (const l of fit.spans) counts.set(l, (counts.get(l) ?? 0) + 1);
      const overuse = sum([...counts].map(([l, n]) => Math.max(0, n - owned(l))));
      for (const spans of spanOrders(fit.spans)) {
        const rel: number[] = [];
        for (let i = 0, p = uLeft + section / 2; i < fit.k; i++) { rel.push(p); p += section + (spans[i] ?? 0); }
        const offs = new Set<number>();
        const tryOff = (o: number): void => {
          if (o >= -EPS && o <= slack + EPS) offs.add(Math.round(Math.min(Math.max(o, 0), slack) * 1e6) / 1e6);
        };
        for (let o = 0; o <= slack + EPS; o += SLIDE_STEP_IN) tryOff(o);
        tryOff(slack / 2);
        tryOff(slack);
        for (const axis of rel) for (const l of lines) { tryOff(l.u - co - axis); tryOff(l.u + co - axis); }

        for (const off of offs) {
          // One pass: lines and legs both run left to right, so each line only meets the leg at or
          // before it, the span after that leg, and the next leg's near chord.
          const held = new Set<number>(), alignedLegs = new Set<number>();
          let header = 0;
          for (let i = 0, j = 0; i < lines.length; i++) {
            const l = lines[i];
            while (j + 1 < fit.k && rel[j + 1] + off <= l.u) j++;
            const legU = rel[j] + off;
            const along = l.u - (legU + section / 2);
            if (j < spans.length && along > 0 && along < spans[j] && clearOfBraceNodes(along, spans[j], section, jawHalf)) {
              header++;
              held.add(l.col);
            } else if (onLegChord(l.u, legU)) {
              held.add(l.col); alignedLegs.add(j);
            } else if (j + 1 < fit.k && onLegChord(l.u, rel[j + 1] + off)) {
              held.add(l.col); alignedLegs.add(j + 1);
            }
          }
          const score = [held.size, -fit.k, -overuse, header, alignedLegs.size, -Math.abs(off - slack / 2)];
          if (!best || rank(score, best.score) < 0) best = { score, legsU: rel.map(x => x + off), spans };
        }
      }
    }
    const n = b - a + 1;
    return best && best.score[0] >= Math.ceil((2 * n) / 3) ? { run: ri, legsU: best.legsU, spans: best.spans } : null;
  };

  const frameLayouts: FrameLayout[] = [];
  runs.forEach((run, ri) => {
    let a = -1;
    for (let c = run.start; c <= run.end + 1; c++) {
      const full = c <= run.end && solidRows[c] === dims.rows;
      if (full && a < 0) a = c;
      if (!full && a >= 0) {
        const f = planFrame(ri, a, c - 1);
        if (f) frameLayouts.push(f);
        a = -1;
      }
    }
  });

  /**
   * Stage two: how tall. A leg's rise and the shim together put a header chord on a row of holes,
   * with the shim inside its quarter inch and the top block no higher than the wall. Each such
   * pairing is a candidate.
   */
  const stacks: LegStack[] = stickStacks(stickLens, MAX_LEG_STICKS)
    .flatMap(sticks => [0, 1].map(spacers => ({ sticks, spacers, rise: sum(sticks) + spacers * blockH })));
  const options: { stack: LegStack; shim: number }[] = [];
  if (frameLayouts.length) {
    const heights = new Set<number>();
    for (const f of frameLayouts) for (const l of runs[f.run].lines) for (const m of l.mounts) heights.add(s * m.pos[1]);
    const seen = new Set<string>();
    for (const stack of stacks) {
      for (const c of [chordR, section - chordR]) {
        for (const hh of heights) {
          const shim = baseH + stack.rise + c - base.plateThick - hh;
          if (shim < -EPS || shim > SHIM_MAX_IN + EPS) continue;
          const e = Math.min(Math.max(shim, 0), SHIM_MAX_IN);
          if (supportY + baseH + stack.rise + blockH > plateTop + e + fullRise + EPS) continue;
          const key = `${stack.sticks.join(',')}|${stack.spacers}|${e.toFixed(6)}`;
          if (!seen.has(key)) { seen.add(key); options.push({ stack, shim: e }); }
        }
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
  const available = (id: string): number => {
    const owned = ownedCount(equipmentDef(id));
    return owned === undefined ? Infinity : Math.max(0, owned - (usedElsewhere.get(id) ?? 0));
  };

  /** Lay out a whole rig: frames on `stack` (none without one), then towers, at `shim`. */
  const build = (shim: number, stack: LegStack | null) => {
    const bottomY = plateTop + shim;
    /** Each leg with its plate's footprint on the floor, which no other plate may overlap. */
    const legs: (RigLeg & { foot: Footprint })[] = [];
    const footAt = (run: Run, axis: THREE.Vector3): Footprint => ({ x: axis.x, z: axis.z, size: plateSize, rotY: run.yaw });
    const spans: RigPiece[] = [];
    const clamps: { piece: RigPiece; col: number; header: boolean }[] = [];
    const held = new Set<number>();
    let weld = 0;
    let headerY: number | null = null;

    const place = (def: EquipmentDef, geometry: EquipmentGeometry, d: readonly number[], p: THREE.Vector3, yaw: number): RigPiece => ({
      catalogId: def.id, name: def.name, geometry, dims: [d[0], d[1], d[2]], color: def.color,
      position: [p.x, p.y, p.z], rotation: [0, yaw * DEG, 0], ghost: false,
    });
    const addClamp = (run: Run, m: MountPoint, y: number, col: number, chord: THREE.Vector3, header: boolean): void => {
      clamps.push({ piece: clampPiece(clampDef, toWorld(m.pos).setY(y), chord, run.N), col, header });
      held.add(col);
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
      const hits: { m: MountPoint; y: number; col: number }[] = [];
      let welds = 0;
      for (const l of run.lines) {
        if (!onLegChord(l.u, u)) continue;
        for (const m of l.mounts) {
          const y = bottomY + s * m.pos[1];
          const span = chords.find(q => y >= q.footY - 1e-6 && y <= q.footY + q.len + 1e-6);
          if (!span) continue;
          if (clearOfBraceNodes(y - span.footY, span.len, section, jawHalf)) hits.push({ m, y, col: l.col });
          else welds++;
        }
      }
      return { hits, welds };
    };

    const UP = new THREE.Vector3(0, 1, 0);
    let frames = 0;
    if (stack) {
      for (const f of frameLayouts) {
        const run = runs[f.run];
        frames++;
        const blockY = supportY + baseH + stack.rise;
        const chordYs = [blockY + chordR, blockY + section - chordR];
        for (const u of f.legsU) {
          const leg = legAt(run, u, stack.sticks, stack.spacers + 1);
          legs.push({ kind: 'frame', axis: [leg.axis.x, leg.axis.z], rotY: run.yaw * DEG, topY: leg.topY, pieces: leg.pieces, foot: footAt(run, leg.axis) });
          const { hits, welds } = legHits(run, u, leg.chords);
          weld += welds;
          for (const h of hits) addClamp(run, h.m, h.y, h.col, UP, false);
        }
        for (let j = 0; j < f.spans.length; j++) {
          const len = f.spans[j];
          const from = f.legsU[j] + section / 2;
          spans.push(place(stickOf(len), stickOf(len).geometry, [len, section, section], at(run, from + len / 2, blockY, depth), run.yaw));
          for (const l of run.lines) {
            const along = l.u - from;
            if (along <= 0 || along >= len) continue;
            for (const m of l.mounts) {
              const y = bottomY + s * m.pos[1];
              const chordY = chordYs.find(cy => Math.abs(cy - y) < EPS);
              if (chordY === undefined) continue;
              if (!clearOfBraceNodes(along, len, section, jawHalf)) { weld++; continue; }
              addClamp(run, m, y, l.col, run.U, true);
              headerY = Math.max(headerY ?? -Infinity, chordY);
            }
          }
        }
      }
    }

    // Towers behind whatever the frames left hanging: first column first, on its first hole line
    // that keeps the section behind the column, the plate clear of every other leg's -- across a
    // fold too, where two runs' legs crowd the same corner -- and the stack under the top of the
    // column. The stack is whichever takes the most couplers.
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      for (let c = run.start; c <= run.end; c++) {
        if (held.has(c)) continue;
        const top = bottomY + hiddenRise(c);
        if (supportY + shortestLeg > top + EPS) continue;
        const centre = s * (c - run.start) * step;
        for (const l of run.lines) {
          if (l.col !== c) continue;
          const u = l.u - l.side * co;
          if (Math.abs(u - centre) + section / 2 > s * dims.panelW / 2 + EPS) continue;
          const foot = footAt(run, at(run, u, supportY, depth));
          if (legs.some(g => overlaps(g.foot, foot))) continue;
          let pick: { score: number[]; leg: ReturnType<typeof legAt>; got: ReturnType<typeof legHits> } | null = null;
          for (const sticks of stickStacks(stickLens, MAX_LEG_STICKS)) {
            if (supportY + baseH + sum(sticks) > top + EPS) continue;
            const leg = legAt(run, u, sticks, 0);
            const got = legHits(run, u, leg.chords);
            const score = [got.hits.length, -sticks.length, -sum(sticks)];
            if (!pick || rank(score, pick.score) < 0) pick = { score, leg, got };
          }
          if (!pick || !pick.got.hits.length) continue;
          legs.push({ kind: 'tower', axis: [pick.leg.axis.x, pick.leg.axis.z], rotY: run.yaw * DEG, topY: pick.leg.topY, pieces: pick.leg.pieces, foot });
          weld += pick.got.welds;
          for (const h of pick.got.hits) addClamp(run, h.m, h.y, h.col, UP, false);
          break;
        }
      }
    }

    // Stock, in the order the rig goes up: legs, then spans, then couplers -- the first coupler on
    // each column ahead of the rest, so a short box of couplers still bolts every column on.
    const firstPerCol = new Set<number>();
    const lead: RigPiece[] = [], rest: RigPiece[] = [];
    for (const c of [...clamps].sort((a, b) => Number(b.header) - Number(a.header))) {
      if (firstPerCol.has(c.col)) rest.push(c.piece);
      else { firstPerCol.add(c.col); lead.push(c.piece); }
    }
    const left = new Map<string, number>();
    let ghosts = 0;
    for (const p of [...legs.flatMap(g => g.pieces), ...spans, ...lead, ...rest]) {
      if (!left.has(p.catalogId)) left.set(p.catalogId, available(p.catalogId));
      const n = left.get(p.catalogId)!;
      p.ghost = n <= 0;
      if (p.ghost) ghosts++;
      left.set(p.catalogId, n - 1);
    }

    const pieceCount = legs.reduce((a, g) => a + g.pieces.length, 0) + spans.length + clamps.length;
    return {
      shim, bottomY, legs, spans, clamps: clamps.map(c => c.piece), held, weld, headerY,
      frames: stack ? frames : 0, ghosts,
      score: [held.size, -ghosts, headerY ?? -1e9, clamps.length, -pieceCount, -shim],
    };
  };

  let best = build(0, null);
  for (const o of options) {
    const got = build(o.shim, o.stack);
    if (rank(got.score, best.score) < 0) best = got;
  }

  if (!best.legs.length) {
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
    columns: layout.length,
    ghosts: best.ghosts,
    shortfall,
    skipped: { offFace, weld: best.weld },
    warnings,
  };

  // Towers never overlap a plate; two frames meeting at a fold still can.
  plates: for (let i = 0; i < best.legs.length; i++) {
    for (let j = i + 1; j < best.legs.length; j++) {
      if (overlaps(best.legs[i].foot, best.legs[j].foot)) {
        warnings.push('Two base plates overlap on the floor: the fold between their frames is tighter than a plate.');
        break plates;
      }
    }
  }
  if (Math.abs(liftIn) > 1e-6) {
    warnings.push(`The wall ${liftIn > 0 ? 'rises' : 'comes down'} ${Math.abs(liftIn).toFixed(2)} in to sit on the ${base.plateThick.toFixed(2)} in base plates${
      plan.shimIn > 1e-6 ? `, on a ${plan.shimIn.toFixed(2)} in shim so the header chord meets a row of holes` : ''}.`);
  } else if (plan.shimIn > 1e-6) {
    warnings.push(`The wall sits on a ${plan.shimIn.toFixed(2)} in shim on the base plates, so the header chord meets a row of holes.`);
  }
  if (best.weld) {
    warnings.push(`${best.weld} ${best.weld === 1 ? 'hole sits' : 'holes sit'} level with a brace weld, where a coupler cannot close.`);
  }
  if (offFace) {
    warnings.push(`${offFace} ${offFace === 1 ? 'hole is' : 'holes are'} cut away by a mitre.`);
  }
  if (dropAccessories) {
    warnings.push('The floor-stand base plates and back supports come off: they stand where the legs do.');
  }
  const loose = plan.columns - plan.held;
  if (loose > 0) {
    warnings.push(`${loose} ${loose === 1 ? 'column has' : 'columns have'} no coupler and ${loose === 1 ? 'hangs' : 'hang'} off ${loose === 1 ? 'its' : 'their'} neighbours.`);
  }
  for (const f of shortfall) {
    const k = f.need - f.have;
    warnings.push(`${f.name}: ${f.need} needed, ${f.have} available - ${k} drawn as ${k === 1 ? 'a ghost' : 'ghosts'}.`);
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
