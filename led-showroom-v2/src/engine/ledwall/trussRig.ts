/**
 * Auto truss: a free-standing vertical rig behind an LED wall, bolted into the cabinets' M10 holes.
 *
 * One tower per cabinet column -- a 36 in raised base with GP sticks stood on it -- placed so that
 * ONE of its front chords lies exactly on that column's line of mount holes. Half couplers then bolt
 * into those holes and close around that chord.
 *
 * Why one tower per column, and why only one of its chords:
 *
 *  - A coupler has a fixed reach (plate face to chord axis), so a chord is either exactly on a line
 *    of holes or nowhere near one. A tower's two front chords are 9.19 in apart; hole columns are
 *    22.81 in apart inside a cabinet and 2.45 in apart across a seam. No pair matches, so a tower
 *    serves exactly one hole column -- and a wall held only at its two ends would leave every
 *    cabinet in between hanging off its neighbours.
 *  - The chord sits INBOARD of its hole column, which puts the whole 11.16 in section behind the
 *    cabinet it carries. Outboard, it would hang about 9 in past the edge of the wall.
 *
 * Clamps go on the vertical main chords only, never the 25 mm diagonals, and never within a jaw's
 * length of a weld -- which is why the brace geometry lives in `catalog/trussMetrics` beside the
 * chord sizes, shared with the builder that draws it. A rig this plans is one you could bolt
 * together.
 *
 * Pure: it reads a document and returns a plan. `applyTrussRig` turns a plan into the next document
 * in a single step, so a whole rig is one undo.
 */
import * as THREE from 'three';
import { parentMatrix, worldMatrix } from '../behaviours';
import { equipmentDef, ownedCount, type EquipmentDef } from '../catalog/equipment';
import {
  BASE_PLATE_THICK_IN, chordOffsetIn, clampMetrics, clearOfBraceNodes, diagonalRadiusIn,
} from '../catalog/trussMetrics';
import { createEquipment, createGroup } from '../document/defaults';
import type { Vec3 } from '../math';
import type {
  Document, Entity, EquipmentEntity, EquipmentGeometry, GroupEntity, LedWallEntity,
} from '../document/types';
import { isStage } from '../document/types';
import {
  columnLocalToWall, computeColumnLayout, filledCells, wallDims, wallMountPoints,
  type ColumnPlacement, type MountPoint,
} from './layout';
import { mountHoles, panelSpec } from './specs';

const DEG = 180 / Math.PI;

const BASE_ID = 'gp-base-36';
/** DT-GP stock. The catalog dims are for a stick lying down; a tower stands them on end. */
const STICK_IDS = ['gp-truss-8ft', 'gp-truss-5ft', 'gp-truss-4ft'] as const;
const CLAMP_ID = 'clamp-8002';

export const RIG_GROUP_NAME = 'Truss rig';

/**
 * How far the wall may be raised, past the minimum, hunting for a height that puts no coupler on a
 * weld, and in what steps.
 *
 * A raise is cheap -- the wall hangs off the truss either way, so its height off the deck is
 * arbitrary -- and a hole half an inch above a splice is unclampable for want of half an inch.
 * The window has to be generous: a four-row wall needs 7.6 in of rise before all eight of its
 * holes stand in clear tube, because every row has to clear at once and two sticks meeting put
 * their end frames back to back -- a 3.2 in dead band, against the 2.24 in it takes to shift one
 * hole off one weld.
 *
 * A bay is the bound. `braceNodesAlong` cuts a stick into bays of `max(section, 12)` in, about
 * 10.7-12 in, and the dead bands repeat with them, so a foot covers every phase of hole against
 * weld there is. Past it the search only comes back round to a band it has already rejected.
 */
const LIFT_SEARCH_IN = 12;
const LIFT_STEP_IN = 0.1;

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
}

export interface RigTower {
  /** Cabinet column this tower carries. */
  col: number;
  /** World XZ of the tower's own axis. */
  axis: [number, number];
  /** Yaw in degrees: square to the wall segment. */
  rotY: number;
  /** World y of the top of the stack. */
  topY: number;
  /** The base first, then sticks upward. */
  pieces: RigPiece[];
}

export interface TrussRigPlan {
  wallId: string;
  towers: RigTower[];
  clamps: RigPiece[];
  /** World inches the wall rises. 0 when it already clears and sits clear of every weld. */
  liftIn: number;
  /** The same raise in the wall's own frame, which is what its transform takes. */
  liftLocalIn: number;
  /** True when the floor-stand kit has to come off: its back supports stand where the rig does. */
  dropAccessories: boolean;
  /** Mount holes that got no clamp, by reason. */
  skipped: { offFace: number; weld: number; aboveTop: number };
  warnings: string[];
}

/* ───────────────────────────── helpers ───────────────────────────── */

const v3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);

/** Yaw of a pure-Y quaternion, radians. */
const yawOf = (q: THREE.Quaternion): number => new THREE.Euler().setFromQuaternion(q, 'YXZ').y;

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

/** Fewest sticks from stock that cover `needIn`, preferring the smallest sufficient one. */
function stackSticks(needIn: number, lengths: readonly number[]): number[] {
  const desc = [...lengths].sort((a, b) => b - a);
  const asc = [...desc].reverse();
  const out: number[] = [];
  let h = 0;
  // 24 is a backstop against a nonsense height, not a real limit: 24 eight-foot sticks is 192 ft.
  while (h < needIn - 1e-6 && out.length < 24) {
    const pick = asc.find(l => h + l >= needIn - 1e-6) ?? desc[0];
    out.push(pick);
    h += pick;
  }
  return out;
}

/** Chord span of one stacked piece, in world y: where a jaw can grip, and how the welds are spaced. */
function chordSpan(piece: RigPiece): { footY: number; len: number } {
  // `truss-upright` spends its first half inch on the base plate (buildTrussUpright); a stood-up
  // stick is all chord. Both are drawn by the same `trussAlong`, so the weld spacing follows `len`.
  const plate = piece.geometry === 'truss-upright' ? BASE_PLATE_THICK_IN : 0;
  return { footY: piece.position[1] + plate, len: piece.dims[1] - plate };
}

/* ───────────────────────────── planning ───────────────────────────── */

/**
 * Plan a rig for `wall`. Always returns a plan; an empty one carries the reason in `warnings`.
 *
 * Everything resolves to WORLD space, through the wall's composed `parentId` chain, because the rig
 * is hardware standing on the floor rather than part of the wall: it keeps its own real size
 * whatever the wall is nested in or scaled to.
 */
export function planTrussRig(doc: Document, wall: LedWallEntity): TrussRigPlan {
  const warnings: string[] = [];
  const empty = (): TrussRigPlan => ({
    wallId: wall.id, towers: [], clamps: [], liftIn: 0, liftLocalIn: 0,
    dropAccessories: false, skipped: { offFace: 0, weld: 0, aboveTop: 0 }, warnings,
  });

  const spec = panelSpec(wall.product);
  const holes = mountHoles(spec);
  if (!holes.length || spec.mount?.face !== 'back') {
    warnings.push('This panel has no mount holes in its back face, so there is nothing to bolt a coupler into.');
    return empty();
  }

  const baseDef = equipmentDef(BASE_ID);
  const clampDef = equipmentDef(CLAMP_ID);
  const stickDefs = STICK_IDS.map(id => equipmentDef(id)).filter((d): d is EquipmentDef => !!d);
  if (!baseDef || !clampDef || !stickDefs.length) {
    warnings.push('The DT-GP truss or the 8002 coupler is missing from the catalog.');
    return empty();
  }

  const section = baseDef.dims[0];
  const co = chordOffsetIn(section);
  const clamp = clampMetrics(clampDef.dims);
  const jawHalf = clampDef.dims[0] / 2;
  /** How far a jaw has to stay clear of a weld, and of the end of the stack. */
  const keepOut = jawHalf + diagonalRadiusIn(section);

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
  const wallYaw = yawOf(wQuat);

  // What the towers stand on: a stage deck if the wall rides one, otherwise the floor.
  const support = wall.attachedTo ? byId.get(wall.attachedTo) : undefined;
  let supportY = 0;
  if (support && isStage(support)) {
    const sp = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
    worldMatrix(support, byId).decompose(sp, sq, ss);
    supportY = sp.y + support.heightIn * ss.y;
  }

  // The floor-stand kit and the rig want the same space: its back supports stand 6.7 in behind the
  // cabinets at x = +/-11.6, straight through a tower section spanning 1.23 to 12.39 behind them. A
  // wall hung off truss does not stand on its own base plates, so the kit comes off -- and with it
  // the quarter inch the renderer lifts the wall by to put those plates on the floor, which is why
  // the hole frame below needs no lift of its own.
  const dropAccessories = wall.accessories === true && !!spec.accessories;

  const dims = wallDims(wall);
  const layout = computeColumnLayout(dims, wall.corners);
  const mounts = wallMountPoints(dims, layout, filledCells(wall), wall.corners);
  const onFace = mounts.filter(m => m.onFace);
  const offFace = mounts.length - onFace.length;
  if (!onFace.length) {
    warnings.push(mounts.length
      ? 'Every mount hole on this wall is cut away by a mitre.'
      : 'This wall has no cabinets with mount holes.');
    return empty();
  }

  const toWorld = (p: Vec3): THREE.Vector3 => v3(p).applyMatrix4(world);

  // One tower per column, on one of that column's two hole lines, with the chord inboard of it.
  const holeX = Math.min(...holes.map(h => h.x));
  const stickLens = stickDefs.map(d => d.dims[0]);

  /** One vertical line of holes: the ones on this column whose local x is `hx`. */
  const lineAt = (col: ColumnPlacement, hx: number): MountPoint[] => {
    const want = columnLocalToWall(col, hx, 0, -dims.panelD / 2);
    return onFace.filter(m => m.col === col.col
      && Math.abs(m.pos[0] - want[0]) < 1e-6 && Math.abs(m.pos[2] - want[2]) < 1e-6);
  };

  /**
   * The line this column's tower follows: its left one, or its right one when a mitre has taken
   * the left.
   *
   * A fold trims the back face out from under the holes on its inside edge, and past about 107
   * degrees it takes them entirely. Without the fallback the cabinet on the far side of a tight
   * corner would get no leg at all, which is exactly the one that most needs holding.
   *
   * `inboard` carries the chord towards the column's centre either way, so the 11.16 in section
   * always lands behind the cabinet it holds rather than 9 in out past the edge of the wall.
   */
  interface HoleLine { col: ColumnPlacement; hx: number; inboard: number; line: MountPoint[] }
  const lineOf = (col: ColumnPlacement): HoleLine | undefined => {
    for (const hx of [holeX, -holeX]) {
      const line = lineAt(col, hx);
      if (line.length) return { col, hx, inboard: hx < 0 ? co : -co, line };
    }
    return undefined;
  };
  const lines = layout.flatMap(col => {
    const got = lineOf(col);
    return got ? [got] : [];
  });
  if (!lines.length) {
    warnings.push('No cabinet column has a usable line of mount holes.');
    return empty();
  }
  if (lines.length < layout.length) {
    const n = layout.length - lines.length;
    warnings.push(`${n} ${n === 1 ? 'column has' : 'columns have'} no line of holes left for a leg - a mitre has cut both away - so ${n === 1 ? 'that cabinet hangs' : 'those cabinets hang'} off their neighbours.`);
  }

  // A jaw at the lowest hole has to clear the plate it stands on; that shortfall is the minimum lift.
  const lowest = Math.min(...onFace.map(m => toWorld(m.pos).y));
  const minLift = Math.max(0, supportY + BASE_PLATE_THICK_IN + jawHalf - lowest);

  /** Lay out every tower and coupler for a given raise. Pure in `lift`. */
  const build = (lift: number) => {
    const towers: RigTower[] = [];
    const clamps: RigPiece[] = [];
    const footprints: { f: Footprint; col: number }[] = [];
    let weld = 0, aboveTop = 0;

    for (const { col, hx, inboard, line } of lines) {
      // Tower axis: behind the gripped chord by the coupler's reach plus the chord's own inset,
      // and inboard along the wall by that same inset, so the section lands behind this cabinet.
      const axis = toWorld(columnLocalToWall(col, hx + inboard, 0, -dims.panelD / 2 - clamp.reachIn - co));
      const yaw = wallYaw + col.rotY;
      const rotYDeg = yaw * DEG;

      const topHole = Math.max(...line.map(m => toWorld(m.pos).y)) + lift;
      const sticks = stackSticks(Math.max(0, topHole + keepOut - (supportY + baseDef.dims[1])), stickLens);

      const pieces: RigPiece[] = [{
        catalogId: baseDef.id, name: baseDef.name, geometry: baseDef.geometry,
        dims: [...baseDef.dims] as Vec3, color: baseDef.color,
        position: [axis.x, supportY, axis.z], rotation: [0, rotYDeg, 0],
      }];
      let y = supportY + baseDef.dims[1];
      for (const len of sticks) {
        const def = stickDefs.find(d => d.dims[0] === len) ?? stickDefs[0];
        pieces.push({
          catalogId: def.id, name: def.name, geometry: 'truss-vertical',
          dims: [section, len, section], color: def.color,
          position: [axis.x, y, axis.z], rotation: [0, rotYDeg, 0],
        });
        y += len;
      }

      towers.push({ col: col.col, axis: [axis.x, axis.z], rotY: rotYDeg, topY: y, pieces });
      footprints.push({ f: { x: axis.x, z: axis.z, size: section, rotY: yaw }, col: col.col });

      // A coupler at every hole on the line that a jaw can actually reach.
      const spans = pieces.map(chordSpan);
      for (const m of line) {
        const hy = toWorld(m.pos).y + lift;
        const i = spans.findIndex(s => hy >= s.footY - 1e-6 && hy <= s.footY + s.len + 1e-6);
        if (i < 0) { aboveTop++; continue; }
        if (!clearOfBraceNodes(hy - spans[i].footY, spans[i].len, section, jawHalf)) { weld++; continue; }
        clamps.push(clampPiece(clampDef, m, hy, wQuat, world));
      }
    }
    return { towers, clamps, footprints, weld, aboveTop };
  };

  // Hunt for a raise that leaves no coupler stranded on a weld. The minimum comes first, so a wall
  // that already clears everything does not move at all.
  let lift = minLift;
  let best = build(minLift);
  for (let extra = LIFT_STEP_IN; best.weld + best.aboveTop > 0 && extra <= LIFT_SEARCH_IN + 1e-9; extra += LIFT_STEP_IN) {
    const got = build(minLift + extra);
    if (got.weld + got.aboveTop < best.weld + best.aboveTop) { best = got; lift = minLift + extra; }
    if (best.weld + best.aboveTop === 0) break;
  }

  const pScale = new THREE.Vector3();
  parentMatrix(wall, byId).decompose(new THREE.Vector3(), new THREE.Quaternion(), pScale);

  const plan: TrussRigPlan = {
    wallId: wall.id,
    towers: best.towers,
    clamps: best.clamps,
    liftIn: lift,
    liftLocalIn: lift / (pScale.y || 1),
    dropAccessories,
    skipped: { offFace, weld: best.weld, aboveTop: best.aboveTop },
    warnings,
  };

  for (let i = 0; i < best.footprints.length; i++) {
    for (let j = i + 1; j < best.footprints.length; j++) {
      if (overlaps(best.footprints[i].f, best.footprints[j].f)) {
        warnings.push(`The legs behind columns ${best.footprints[i].col + 1} and ${best.footprints[j].col + 1} overlap on the floor: the fold between them is tighter than a base plate.`);
      }
    }
  }
  if (plan.liftIn > 1e-6) {
    warnings.push(`The wall rises ${plan.liftIn.toFixed(2)} in: enough for the lowest coupler to clear a base plate, and to keep every jaw off a brace weld.`);
  }
  if (best.weld) {
    warnings.push(`${best.weld} ${best.weld === 1 ? 'hole sits' : 'holes sit'} level with a brace weld, where a coupler cannot close. ${plan.clamps.length} got one.`);
  }
  if (offFace) {
    warnings.push(`${offFace} ${offFace === 1 ? 'hole is' : 'holes are'} cut away by a mitre.`);
  }
  if (dropAccessories) {
    warnings.push('The floor-stand base plates and back supports come off: they stand where the legs do.');
  }

  // Stock. A plan you cannot build today is worth saying out loud, but it is still the right plan.
  const need = new Map<string, number>();
  for (const p of [...plan.towers.flatMap(t => t.pieces), ...plan.clamps]) {
    need.set(p.catalogId, (need.get(p.catalogId) ?? 0) + 1);
  }
  for (const [id, n] of need) {
    const def = equipmentDef(id);
    const owned = ownedCount(def);
    if (owned !== undefined && n > owned) warnings.push(`${def?.name ?? id}: ${n} needed, ${owned} owned.`);
  }

  return plan;
}

/**
 * Place one coupler: its bolt in the hole, its jaw round the chord behind it.
 *
 * `buildClamp` draws the part with its plate at the back, its jaw forward at +Z and the chord it
 * grips running along its local X. So local +Z is the hole's outward normal and local +X is the
 * chord -- straight up, for a vertical tower -- and the bolt sits at local (0, h/2, -d/2). The basis
 * goes through a matrix rather than hand-rolled angles because that bolt has to land IN the hole,
 * and a sign slipped in an Euler is invisible until a coupler is floating in mid air.
 */
function clampPiece(
  def: EquipmentDef, m: MountPoint, holeWorldY: number,
  wQuat: THREE.Quaternion, world: THREE.Matrix4,
): RigPiece {
  const [, h, d] = def.dims;
  const hole = v3(m.pos).applyMatrix4(world);
  hole.y = holeWorldY;                                                       // the raise, applied

  const xAxis = new THREE.Vector3(0, 1, 0);                                  // the chord: vertical
  const zAxis = v3(m.normal).applyQuaternion(wQuat).setY(0).normalize();     // out of the cabinet
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const e = new THREE.Euler().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis), 'YXZ',
  );

  // Put local (0, h/2, -d/2) -- the bolt, on the back face of the plate -- exactly on the hole.
  const pos = hole.clone().addScaledVector(yAxis, -h / 2).addScaledVector(zAxis, d / 2);

  return {
    catalogId: def.id, name: def.name, geometry: def.geometry,
    dims: [...def.dims] as Vec3, color: def.color,
    position: [pos.x, pos.y, pos.z],
    rotation: [e.x * DEG, e.y * DEG, e.z * DEG],
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
 * raised and its floor-stand kit dropped.
 *
 * One function so one `cmdPatchDocument` covers the lot and a whole rig is a single undo. The
 * group's transform stays identity because its children carry world coordinates.
 */
export function applyTrussRig(doc: Document, wall: LedWallEntity, plan: TrussRigPlan): Document {
  const stale = rigEntityIds(doc, wall.id);
  const group: GroupEntity = { ...createGroup(RIG_GROUP_NAME), rigFor: wall.id };

  const parts: EquipmentEntity[] = [...plan.towers.flatMap(t => t.pieces), ...plan.clamps].map(p => {
    const e = createEquipment(
      { id: p.catalogId, name: p.name, geometry: p.geometry, dims: p.dims, color: p.color },
      [...p.position] as Vec3,
    );
    e.transform.rotation = [...p.rotation] as Vec3;
    e.parentId = group.id;
    return e;
  });

  const entities = doc.entities
    .filter(e => !stale.has(e.id))
    .map(e => {
      if (e.id !== wall.id) return e;
      const next = { ...e } as LedWallEntity;
      if (plan.liftLocalIn > 1e-6) {
        const [x, y, z] = next.transform.position;
        next.transform = { ...next.transform, position: [x, y + plan.liftLocalIn, z] };
      }
      if (plan.dropAccessories) next.accessories = false;
      return next;
    });

  return { ...doc, entities: [...entities, group, ...parts] };
}
