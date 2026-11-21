/**
 * The truss builder: a rig put up by hand behind an LED wall, a piece at a time.
 *
 * Every piece has PORTS, the faces another piece bolts to: a base plate's top; a stick's two ends; a
 * 6-way block's six faces. A new piece goes on an open port and runs on in that port's direction, so
 * a stick on a block's top face stands up, and one on its side face runs along the wall. Two open
 * ports that meet face to face join, so a run of sticks closes on the block it reaches.
 *
 * What the builder keeps to is what Auto truss keeps to, from the same `rigContext`:
 *
 *  - Nothing shows from the front. A piece stands behind its run of cabinets and inside them, in
 *    every column it crosses within a band of cabinets that covers its height; a band on the
 *    bottom row runs on down to the floor. Round a fold, it keeps out of view past the other runs.
 *    Only a base plate reaches out, on the floor, and never into a doorway.
 *  - The wall sits ON the base plates, on a shim of at most `SHIM_MAX_IN`, picked to put the most
 *    columns on couplers while keeping every piece hidden.
 *  - A coupler goes into every hole a stick's front chord meets, clear of a weld, never on a block.
 *    Pieces are not given couplers; the rig is re-coupled whole after every change.
 *
 * Stock decides what is drawn, not what may be built: a piece past what we own (less what the rest
 * of the scene stands up) is a ghost, and so is every 3 ft stick, which we have to buy.
 *
 * Auto truss puts its rig up through here too (`autoTrussRig`): the planner says where the legs stand
 * and how tall, and each piece then goes up as one put up by hand would, the gaps between frame
 * legs closed as F closes them. So an Auto truss rig is one the builder lets you build, piece by
 * piece, and edit from there.
 */
import * as THREE from 'three';
import { parentMatrix, worldMatrix } from '../behaviours';
import { equipmentDef, ownedCount, type EquipmentDef } from '../catalog/equipment';
import { createEquipment, createGroup } from '../document/defaults';
import type { Document, EquipmentEntity, EquipmentGeometry, GroupEntity, LedWallEntity } from '../document/types';
import type { Vec3 } from '../math';
import type { MountPoint } from './layout';
import {
  BUY_STICK_IDS, CLAMP_ID, RIG_GROUP_NAME, SHIM_MAX_IN, SPAN_TABLE_IN, STICK_IDS,
  buyPrice, clampPiece, costNote, forgivenNote, inches, planTrussRig, rigContext, rigEntityIds,
  type ChordSpan, type RigContext, type RigLeg, type RigPiece, type Run, type TrussRigPlan,
} from './trussRig';

const EPS = 1e-4;
/** How near two ports must meet to join, in inches. */
const JOIN_IN = 0.01;
/** Slack allowed where two pieces touch, so faces that meet are not read as overlapping. */
const TOUCH_IN = 1e-3;
const DEG = 180 / Math.PI;
const UP = new THREE.Vector3(0, 1, 0);
/** Most sticks a gap is filled with. */
const FILL_MAX_STICKS = 8;

export type BuildKind = 'base' | 'stick' | 'block';

/** One piece of a hand-built rig, in world space. */
export interface BuildPiece {
  /** The entity it is in the document; none until it is first applied. */
  id?: string;
  catalogId: string;
  kind: BuildKind;
  /** A stick's length; a base's or a block's height. */
  len: number;
  /** A stick stood on end. Bases and blocks are always upright. */
  vertical: boolean;
  /** Bottom centre, world inches. */
  position: Vec3;
  /** Yaw, radians. */
  yaw: number;
}

/** A face a piece can bolt to: where, and which way out of the piece. */
export interface Port { piece: number; point: THREE.Vector3; dir: THREE.Vector3 }

/** One thing to build with, and the stock of it. */
export interface PaletteItem {
  catalogId: string;
  kind: BuildKind;
  /** A stick's length; a base's or a block's height. */
  len: number;
  name: string;
  /** What the palette calls it. */
  label: string;
  /** What we own; Infinity where the catalog keeps no count. */
  owned: number;
  /** Stood up by the rest of the scene. */
  elsewhere: number;
  /** One we hold none of: every one is drawn as a ghost, to buy. */
  buy: boolean;
  /** What one more past the stock costs to buy, US dollars. */
  price: number;
}

/** A wall to build behind, measured, with the rig it has now. */
export interface Builder {
  ctx: RigContext;
  wall: LedWallEntity;
  /** The rig group the wall has, if any. */
  group: GroupEntity | null;
  /** That rig was put up by hand, not by Auto truss. */
  hand: boolean;
  /** Its pieces, couplers aside, in the order they went up. */
  pieces: BuildPiece[];
  palette: PaletteItem[];
  /** What the rest of the scene stands up, by catalog id. */
  elsewhere: Map<string, number>;
  /** The wall's height on the plates, before any change: its bottom, world y. */
  currentBottom: number;
}

/** Why a piece cannot go where it was put; empty when it can. */
export type Verdict = string[];

/** A coupler the rig takes, with what it holds. */
export interface BuildClamp { piece: RigPiece; col: number; side: number; header: boolean; by: number }

/** The rig coupled to the wall: at what shim, which couplers, which columns they hold. */
export interface Coupling {
  shim: number;
  bottomY: number;
  clamps: BuildClamp[];
  held: Set<number>;
  supported: Set<number>;
  welds: number;
  /** Pieces that show from the front at this shim, by index, with why: none in a rig that can stand. */
  bared: Map<number, string>;
}

/* ───────────────────────────── reading ───────────────────────────── */

const isStickId = (id: string): boolean =>
  (STICK_IDS as readonly string[]).includes(id) || (BUY_STICK_IDS as readonly string[]).includes(id);

/** A rig part as a piece, from where it stands in the world; null for anything but a plate, stick or block. */
function partAsPiece(catalogId: string, geometry: EquipmentGeometry, dims: Vec3, pos: THREE.Vector3, quat: THREE.Quaternion): BuildPiece | null {
  const kind: BuildKind | null = geometry === 'truss-base' ? 'base' : geometry === 'truss-block' ? 'block'
    : geometry === 'truss' || geometry === 'truss-vertical' ? 'stick' : null;
  if (!kind) return null;
  const vertical = kind !== 'stick' || geometry === 'truss-vertical';
  return {
    catalogId, kind, vertical,
    len: kind === 'stick' && !vertical ? dims[0] : dims[1],
    position: [pos.x, pos.y, pos.z],
    yaw: new THREE.Euler().setFromQuaternion(quat, 'YXZ').y,
  };
}

/** Open the builder on `wall`: its measures, its rig, and the stock to build with. */
export function openBuilder(doc: Document, wall: LedWallEntity): Builder | { fail: string } {
  const ctx = rigContext(doc, wall);
  if (ctx.fail !== undefined) return { fail: ctx.fail };
  const byId = ctx.byId;
  const group = doc.entities.find((e): e is GroupEntity => e.type === 'group' && e.rigFor === wall.id) ?? null;
  const mine = rigEntityIds(doc, wall.id);

  const pieces: BuildPiece[] = [];
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  for (const e of doc.entities) {
    if (e.type !== 'equipment' || !mine.has(e.id) || e.catalogId === CLAMP_ID) continue;
    worldMatrix(e, byId).decompose(pos, quat, scale);
    const p = partAsPiece(e.catalogId, e.geometry, e.dims, pos, quat);
    if (p) pieces.push({ id: e.id, ...p });
  }

  const elsewhere = new Map<string, number>();
  for (const e of doc.entities) {
    if (e.type !== 'equipment' || mine.has(e.id) || e.ghost) continue;
    elsewhere.set(e.catalogId, (elsewhere.get(e.catalogId) ?? 0) + 1);
  }
  const item = (def: EquipmentDef, kind: BuildKind, len: number, label: string): PaletteItem => {
    const owned = ownedCount(def);
    return {
      catalogId: def.id, kind, len, name: def.name, label,
      owned: owned ?? Infinity, elsewhere: elsewhere.get(def.id) ?? 0,
      buy: (BUY_STICK_IDS as readonly string[]).includes(def.id),
      price: buyPrice(def.id),
    };
  };
  const sticks = [...STICK_IDS, ...BUY_STICK_IDS]
    .map(id => equipmentDef(id))
    .filter((d): d is EquipmentDef => !!d && d.dims[1] === ctx.section)
    .sort((a, b) => a.dims[0] - b.dims[0]);
  const palette = [
    ...sticks.map(d => item(d, 'stick', d.dims[0], `${+(d.dims[0] / 12).toFixed(2)} ft`)),
    item(ctx.blockDef, 'block', ctx.blockH, 'Block'),
    item(ctx.baseDef, 'base', ctx.baseH, 'Base'),
  ];

  return {
    ctx, wall, group, hand: group?.rigHand === true, pieces, palette, elsewhere, currentBottom: ctx.currentBottom,
  };
}

/* ───────────────────────────── geometry ───────────────────────────── */

const v3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);
/** A piece's own axes on the floor: X along it, Z across it. */
const axesOf = (yaw: number) => ({
  X: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
  Z: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)),
});

/** A piece's size along its own X, Y and Z. */
function sizeOf(b: Builder, p: BuildPiece): Vec3 {
  const { ctx } = b;
  if (p.kind === 'base') return [...ctx.baseDef.dims] as Vec3;
  if (p.kind === 'block') return [...ctx.blockDef.dims] as Vec3;
  return p.vertical ? [ctx.section, p.len, ctx.section] : [p.len, ctx.section, ctx.section];
}

/** The faces of piece `i` another piece can bolt to. */
export function portsOf(b: Builder, p: BuildPiece, i: number): Port[] {
  const O = v3(p.position);
  const [sx, sy, sz] = sizeOf(b, p);
  const { X, Z } = axesOf(p.yaw);
  const port = (point: THREE.Vector3, dir: THREE.Vector3): Port => ({ piece: i, point, dir });
  if (p.kind === 'base') return [port(O.clone().addScaledVector(UP, sy), UP.clone())];
  if (p.kind === 'stick' && p.vertical) {
    return [port(O.clone(), UP.clone().negate()), port(O.clone().addScaledVector(UP, sy), UP.clone())];
  }
  const C = O.clone().addScaledVector(UP, sy / 2);
  if (p.kind === 'stick') {
    return [port(C.clone().addScaledVector(X, -sx / 2), X.clone().negate()), port(C.clone().addScaledVector(X, sx / 2), X.clone())];
  }
  return ([[X, sx], [UP, sy], [Z, sz]] as const).flatMap(([d, n]) => [
    port(C.clone().addScaledVector(d, n / 2), d.clone()),
    port(C.clone().addScaledVector(d, -n / 2), d.clone().negate()),
  ]);
}

const meets = (a: Port, b: Port): boolean => a.point.distanceTo(b.point) < JOIN_IN && a.dir.dot(b.dir) < -0.999;

/** Every port no other piece is bolted to. */
export function openPorts(b: Builder, pieces: readonly BuildPiece[]): Port[] {
  const all = pieces.flatMap((p, i) => portsOf(b, p, i));
  return all.filter(a => !all.some(c => c.piece !== a.piece && meets(a, c)));
}

/** The yaw of `want`, turned by half turns to sit nearest `near`: a stick reads the same either way round. */
function nearestYaw(want: number, near: number): number {
  let y = want;
  while (y - near > Math.PI / 2 + 1e-9) y -= Math.PI;
  while (near - y > Math.PI / 2 + 1e-9) y += Math.PI;
  return y;
}

/** The piece `item` makes on `port`, running on in the port's direction; null where it cannot go on it. */
export function attach(b: Builder, pieces: readonly BuildPiece[], port: Port, item: PaletteItem): BuildPiece | null {
  const A = pieces[port.piece];
  const d = port.dir, p = port.point;
  const upright = Math.abs(d.y) > 0.5;
  const make = (O: THREE.Vector3, yaw: number, vertical: boolean): BuildPiece => ({
    catalogId: item.catalogId, kind: item.kind, len: item.len, vertical, position: [O.x, O.y, O.z], yaw,
  });
  if (item.kind === 'base') {
    // A plate goes only under a stick's foot.
    if (d.y > -0.5 || A.kind !== 'stick') return null;
    return make(p.clone().addScaledVector(UP, -b.ctx.baseH), A.yaw, true);
  }
  if (item.kind === 'block') {
    const { X, Z } = axesOf(A.yaw);
    const [sx, sy, sz] = b.ctx.blockDef.dims;
    const reach = Math.abs(d.dot(X)) * sx + Math.abs(d.y) * sy + Math.abs(d.dot(Z)) * sz;
    const C = p.clone().addScaledVector(d, reach / 2);
    return make(C.addScaledVector(UP, -sy / 2), A.yaw, true);
  }
  if (upright) return make(d.y > 0 ? p.clone() : p.clone().addScaledVector(UP, -item.len), A.yaw, true);
  const C = p.clone().addScaledVector(d, item.len / 2);
  return make(C.addScaledVector(UP, -b.ctx.section / 2), nearestYaw(Math.atan2(-d.z, d.x), A.yaw), false);
}

/** A run's frame for a piece: where it stands along and back from the run, and whether it is square to it. */
function inRun(run: Run, p: BuildPiece): { u: number; n: number; along: boolean; square: boolean } {
  const rel = v3(p.position).sub(run.origin).setY(0);
  const d = p.yaw - run.yaw;
  const c = Math.cos(d), s = Math.sin(d);
  return { u: rel.dot(run.U), n: rel.dot(run.N), along: Math.abs(s) < 1e-6, square: Math.abs(s) < 1e-6 || Math.abs(c) < 1e-6 };
}

/**
 * The run a piece stands behind: square to it, its middle within the run's ends and not in front of
 * it. Behind an outside corner a piece is behind both runs at once; it goes with the one it stands
 * nearest a coupler's reach behind, as {@link baseAt} picks a plate's run, the first on a tie.
 */
function runOf(b: Builder, p: BuildPiece): { ri: number; u: number; n: number; hu: number; hn: number; along: boolean } | null {
  const { ctx } = b;
  const [sx, , sz] = sizeOf(b, p);
  let best: { ri: number; u: number; n: number; hu: number; hn: number; along: boolean } | null = null;
  let off = Infinity;
  for (let ri = 0; ri < ctx.runs.length; ri++) {
    const run = ctx.runs[ri];
    const f = inRun(run, p);
    if (!f.square) continue;
    const [e0, e1] = ctx.extentOf(run, run.start, run.end);
    if (f.u < e0 - EPS || f.u > e1 + EPS || f.n < -EPS) continue;
    const d = Math.abs(f.n - ctx.depth);
    if (d >= off - EPS) continue;
    off = d;
    best = { ri, u: f.u, n: f.n, hu: (f.along ? sx : sz) / 2, hn: (f.along ? sz : sx) / 2, along: f.along };
  }
  return best;
}

/** Corners of a piece's footprint on the floor, in order. */
function footprint(b: Builder, p: BuildPiece, shrink: number): THREE.Vector3[] {
  const [sx, , sz] = sizeOf(b, p);
  const { X, Z } = axesOf(p.yaw);
  const O = v3(p.position);
  const hx = sx / 2 - shrink, hz = sz / 2 - shrink;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => O.clone().addScaledVector(X, a * hx).addScaledVector(Z, c * hz));
}

/** Separating-axis test for two convex outlines on the floor. */
function outlinesOverlap(a: readonly THREE.Vector3[], c: readonly THREE.Vector3[]): boolean {
  for (const poly of [a, c]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const ax = (p.z - q.z) / len, az = (q.x - p.x) / len;
      const pa = a.map(v => v.x * ax + v.z * az), pc = c.map(v => v.x * ax + v.z * az);
      if (Math.max(...pa) <= Math.min(...pc) || Math.max(...pc) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

/** Whether two pieces share any space; faces that touch do not. */
function collide(b: Builder, p: BuildPiece, q: BuildPiece): boolean {
  const py0 = p.position[1], py1 = py0 + sizeOf(b, p)[1];
  const qy0 = q.position[1], qy1 = qy0 + sizeOf(b, q)[1];
  if (Math.min(py1, qy1) - Math.max(py0, qy0) <= TOUCH_IN) return false;
  return outlinesOverlap(footprint(b, p, TOUCH_IN), footprint(b, q, TOUCH_IN));
}

/**
 * Why piece `p` would show from the front with the wall's bottom at `bottomY`; null when it is hidden.
 * A base plate is the floor's, held to the doorways instead.
 */
function bared(b: Builder, p: BuildPiece, bottomY: number): string | null {
  if (p.kind === 'base') return null;
  const { ctx } = b;
  const r = runOf(b, p);
  if (!r) {
    const square = ctx.runs.filter(run => inRun(run, p).square);
    if (!square.length) return 'It would stand askew to the wall; a piece stands square to it.';
    const into = square.some(run => {
      const f = inRun(run, p);
      const [e0, e1] = ctx.extentOf(run, run.start, run.end);
      return f.u >= e0 - EPS && f.u <= e1 + EPS;
    });
    return into ? 'It would reach into the cabinets.' : 'It would stand past the end of the wall.';
  }
  const run = ctx.runs[r.ri];
  const [e0, e1] = ctx.extentOf(run, run.start, run.end);
  if (r.n - r.hn < -TOUCH_IN) return 'It would reach into the cabinets.';
  if (r.u - r.hu < e0 - TOUCH_IN || r.u + r.hu > e1 + TOUCH_IN) return 'It would show past the end of the wall.';
  const lo = p.position[1] - bottomY, hi = lo + sizeOf(b, p)[1];
  const half = ctx.s * ctx.step / 2;
  for (let c = run.start; c <= run.end; c++) {
    const mid = ctx.s * (c - run.start) * ctx.step;
    if (mid + half <= r.u - r.hu + TOUCH_IN || mid - half >= r.u + r.hu - TOUCH_IN) continue;
    const covered = ctx.bands[c].some(([a, z]) => (a <= EPS ? -Infinity : a) <= lo + TOUCH_IN && hi <= z + TOUCH_IN);
    if (!covered) {
      return ctx.bands[c].length
        ? `It would show ${hi > (ctx.bands[c].at(-1)?.[1] ?? 0) ? 'above' : 'past'} the cabinets in column ${c + 1}.`
        : `Column ${c + 1} has no cabinets to hide it.`;
    }
  }
  if (ctx.folded && ctx.anyIn(ctx.exposed(r.ri, r.u - r.hu, r.u + r.hu, r.n - r.hn, r.n + r.hn, false), ctx.ivRange(lo, hi))) {
    return 'It would show round the fold.';
  }
  return null;
}

/* ───────────────────────────── couplers ───────────────────────────── */

/** Every coupler the rig takes with the wall's bottom at `bottomY`. */
function clampsAt(b: Builder, pieces: readonly BuildPiece[], bottomY: number): { clamps: BuildClamp[]; welds: number } {
  const { ctx } = b;
  const seen = new Set<MountPoint>();
  const clamps: BuildClamp[] = [];
  let welds = 0;
  const add = (run: Run, i: number, m: MountPoint, y: number, col: number, side: number, chord: THREE.Vector3, header: boolean): void => {
    if (seen.has(m)) return;
    seen.add(m);
    clamps.push({ piece: clampPiece(ctx.clampDef, ctx.toWorld(m.pos).setY(y), chord, run.N), col, side, header, by: i });
  };
  pieces.forEach((p, i) => {
    const chords: ChordSpan[] = [];
    if (p.kind === 'base' && ctx.base.riserLen > EPS) chords.push({ footY: p.position[1] + ctx.base.plateThick, len: ctx.base.riserLen });
    if (p.kind === 'stick' && p.vertical) chords.push({ footY: p.position[1], len: p.len });
    const horizontal = p.kind === 'stick' && !p.vertical;
    if (!chords.length && !horizontal) return;
    ctx.runs.forEach(run => {
      const f = inRun(run, p);
      if (Math.abs(f.n - ctx.depth) > EPS) return;
      if (chords.length && f.square) {
        const got = ctx.legHitsAt(bottomY, run, f.u, chords);
        welds += got.welds;
        for (const h of got.hits) add(run, i, h.m, h.y, h.col, h.side, UP, false);
      }
      if (horizontal && f.along) {
        const y0 = p.position[1];
        const got = ctx.spanHitsAt(bottomY, run, f.u - p.len / 2, [p.len], [y0 + ctx.chordR, y0 + ctx.section - ctx.chordR]);
        welds += got.welds;
        for (const h of got.hits) add(run, i, h.m, h.y, h.col, h.side, run.U, true);
      }
    });
  });
  return { clamps, welds };
}

/**
 * Couple the rig to the wall. The wall sits on the plates at no shim, or at one that puts a
 * horizontal stick's front chord on a row of holes; of those that keep every piece hidden, the one
 * that holds the most columns, then puts the most columns on couplers of their own, then the most
 * couplers, then the lowest.
 */
export function couple(b: Builder, pieces: readonly BuildPiece[]): Coupling {
  const { ctx } = b;
  const shims = new Set<number>([0]);
  const heights = ctx.headerHeights;
  for (const p of pieces) {
    if (p.kind !== 'stick' || p.vertical) continue;
    for (const cy of [p.position[1] + ctx.chordR, p.position[1] + ctx.section - ctx.chordR]) {
      for (const hh of heights) {
        const sh = cy - ctx.plateTop - hh;
        if (sh >= -EPS && sh <= SHIM_MAX_IN + EPS) shims.add(Math.round(Math.min(Math.max(sh, 0), SHIM_MAX_IN) * 1e9) / 1e9);
      }
    }
  }
  let best: { score: number[]; c: Coupling } | null = null;
  for (const shim of [...shims].sort((a, z) => a - z)) {
    const bottomY = ctx.plateTop + shim;
    const bare = new Map<number, string>();
    pieces.forEach((p, i) => { const why = bared(b, p, bottomY); if (why) bare.set(i, why); });
    const { clamps, welds } = clampsAt(b, pieces, bottomY);
    const held = new Set<number>(), supported = new Set<number>();
    for (const c of clamps) {
      held.add(c.col);
      for (const k of ctx.holdsOf(c.col, c.side)) supported.add(k);
    }
    const score = [-bare.size, supported.size, held.size, clamps.length, -shim];
    if (!best || rankDesc(score, best.score) < 0) best = { score, c: { shim, bottomY, clamps, held, supported, welds, bared: bare } };
  }
  return best!.c;
}

/** Lexicographic, larger first: negative when `a` ranks ahead of `b`. */
function rankDesc(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

/* ───────────────────────────── checking ───────────────────────────── */

/** Why `cand` cannot join `pieces`; empty when it can. */
export function check(b: Builder, pieces: readonly BuildPiece[], cand: BuildPiece): Verdict {
  const { ctx } = b;
  const why: string[] = [];
  if (cand.position[1] < ctx.supportY - EPS) why.push('It would go through the floor.');
  if (cand.kind === 'base') {
    const r = runOf(b, cand);
    if (Math.abs(cand.position[1] - ctx.supportY) > EPS) why.push('A base plate stands on the floor.');
    if (!r || Math.abs(r.n - ctx.depth) > EPS) why.push('A base plate stands a coupler’s reach behind the cabinets.');
    else if (!ctx.plateClear(ctx.runs[r.ri], r.u)) why.push('The plate would reach into a doorway.');
  }
  const hit = pieces.findIndex(q => collide(b, cand, q));
  if (hit >= 0) why.push(`It would run into the ${pieceName(pieces[hit])}.`);
  if (!why.length) {
    const c = couple(b, [...pieces, cand]);
    const mine = c.bared.get(pieces.length);
    if (mine) why.push(mine);
    else if (c.bared.size) {
      // Which pieces show, not how many: a new shim can hide one and bare another.
      const before = couple(b, pieces).bared;
      if ([...c.bared.keys()].some(k => !before.has(k))) why.push('It would move the wall on its shim, and another piece would show.');
    }
  }
  return why;
}

/** What a piece is called in a message. */
export function pieceName(p: BuildPiece): string {
  if (p.kind === 'base') return 'base plate';
  if (p.kind === 'block') return 'block';
  return `${+(p.len / 12).toFixed(2)} ft stick`;
}

/* ───────────────────────────── placing on the floor ───────────────────────────── */

/**
 * A base plate where the floor point `at` is, at a leg's spot: a coupler's reach behind the run it
 * is behind, slid along it to the nearest place that puts a front chord on a line of holes, or a
 * whole number of sticks block face to block face from a leg already standing behind that run.
 * Within `snapIn`, the stick spacing wins over the holes (the span has to close); with neither in
 * reach it goes to the nearest quarter inch.
 */
export function baseAt(b: Builder, pieces: readonly BuildPiece[], at: THREE.Vector3, snapIn = 4): BuildPiece | null {
  const { ctx } = b;
  let pick: { ri: number; u: number; d: number } | null = null;
  ctx.runs.forEach((run, ri) => {
    const rel = at.clone().sub(run.origin).setY(0);
    const u = rel.dot(run.U), n = rel.dot(run.N);
    const [e0, e1] = ctx.extentOf(run, run.start, run.end);
    if (u < e0 - ctx.plateSize / 2 || u > e1 + ctx.plateSize / 2 || n < -ctx.plateSize) return;
    const d = Math.abs(n - ctx.depth);
    if (!pick || d < pick.d) pick = { ri, u, d };
  });
  if (!pick) return null;
  const { ri, u } = pick as { ri: number; u: number; d: number };
  const run = ctx.runs[ri];
  // Whole-stick spacing from a leg already behind this run wins over a line of holes: a hole line
  // can sit a few hundredths off it, and then no run of sticks closes the span between the two.
  const stickLens = b.palette.filter(i => i.kind === 'stick').map(i => i.len);
  const spans = reach(stickLens, FILL_MAX_STICKS);
  const spaced: number[] = [];
  for (const p of pieces) {
    if (p.kind !== 'base') continue;
    const f = inRun(run, p);
    if (!f.square || Math.abs(f.n - ctx.depth) > EPS) continue;
    for (const len of spans) spaced.push(f.u + ctx.section + len, f.u - ctx.section - len);
  }
  const holes: number[] = [];
  for (const l of run.lines) holes.push(l.u - ctx.co, l.u + ctx.co);
  const nearest = (marks: readonly number[]): number | null => {
    let best: number | null = null, d = snapIn;
    for (const m of marks) if (Math.abs(m - u) < d) { d = Math.abs(m - u); best = m; }
    return best;
  };
  const snapped = nearest(spaced) ?? nearest(holes) ?? Math.round(u / 0.25) * 0.25;
  const O = run.origin.clone().addScaledVector(run.U, snapped).addScaledVector(run.N, ctx.depth).setY(ctx.supportY);
  const base = b.palette.find(i => i.kind === 'base')!;
  return { catalogId: base.catalogId, kind: 'base', len: base.len, vertical: true, position: [O.x, O.y, O.z], yaw: run.yaw };
}

/** Every length up to `max` sticks of `lens` splice to, shortest first. */
function reach(lens: readonly number[], max: number): number[] {
  let level = new Set<number>([0]);
  const all = new Set<number>();
  for (let n = 1; n <= max; n++) {
    const next = new Set<number>();
    for (const a of level) for (const l of lens) next.add(a + l);
    for (const x of next) all.add(x);
    level = next;
  }
  return [...all].sort((a, z) => a - z);
}

/* ───────────────────────────── filling a gap ───────────────────────────── */

/** The open port straight across from `port`, facing it, and how far off: what a run of sticks could close. */
export function gapFrom(b: Builder, pieces: readonly BuildPiece[], port: Port): { to: Port; len: number } | null {
  if (Math.abs(port.dir.y) > 0.5) return null;
  let best: { to: Port; len: number } | null = null;
  for (const q of openPorts(b, pieces)) {
    if (q.piece === port.piece || q.dir.dot(port.dir) > -0.999) continue;
    const off = q.point.clone().sub(port.point);
    const len = off.dot(port.dir);
    if (len <= JOIN_IN || off.addScaledVector(port.dir, -len).length() > JOIN_IN) continue;
    if (!best || len < best.len) best = { to: q, len };
  }
  return best;
}

/**
 * Sticks that close the gap from `port` to the port across from it exactly, end to end. The rule is
 * Auto truss's for a spliced span, so a span filled by hand comes out as Auto truss would lay it: any
 * mix of no more than two sticks past the fewest that splice to its length, in any order worth
 * trying, best by columns held up, sticks we have left, couplers, then fewest sticks; which columns
 * have couplers of their own, Auto truss does not weigh, and neither does this. Fewest first
 * would spend ghosts where stock on hand closes the gap: two 8 ft to buy over six 5 ft on the rack.
 * Null with why where none can.
 */
export function fillGap(b: Builder, pieces: readonly BuildPiece[], port: Port): { add: BuildPiece[] } | { fail: string } {
  const gap = gapFrom(b, pieces, port);
  if (!gap) return { fail: 'No open face across from this one to close on.' };
  const sticks = b.palette.filter(i => i.kind === 'stick');
  const target = Math.round(gap.len * 1e4) / 1e4;
  // Every multiset of stick lengths that splices to the gap.
  const found: PaletteItem[][] = [];
  const walk = (from: number, left: number, acc: PaletteItem[]): void => {
    if (Math.abs(left) < 1e-3) { found.push(acc); return; }
    if (acc.length >= FILL_MAX_STICKS || left < 0) return;
    for (let i = from; i < sticks.length; i++) walk(i, left - sticks[i].len, [...acc, sticks[i]]);
  };
  walk(0, target, []);
  if (!found.length) {
    return { fail: `The gap is ${gap.len.toFixed(2)} in, which no splice of our sticks makes.` };
  }
  const fewest = Math.min(...found.map(f => f.length));
  const used = usedCounts(pieces);
  const lack = (mix: readonly PaletteItem[]): number => {
    const n = new Map<string, number>();
    for (const i of mix) n.set(i.catalogId, (n.get(i.catalogId) ?? 0) + 1);
    let k = 0;
    for (const [id, c] of n) {
      const i = sticks.find(s => s.catalogId === id)!;
      k += Math.max(0, c - Math.max(0, i.owned - i.elsewhere - (used.get(id) ?? 0))) * i.price;
    }
    return k;
  };
  let pick: { score: number[]; add: BuildPiece[] } | null = null;
  for (const mix of found.filter(f => f.length <= fewest + 2)) {
    const short = lack(mix);
    for (const order of orders(mix)) {
      const add: BuildPiece[] = [];
      let at: Port = port;
      let ok = true;
      for (const item of order) {
        const all = [...pieces, ...add];
        const next = attach(b, all, at, item);
        if (!next || check(b, all, next).length) { ok = false; break; }
        add.push(next);
        at = portsOf(b, next, all.length).find(q => q.dir.dot(port.dir) > 0.999)!;
      }
      if (!ok) continue;
      const c = couple(b, [...pieces, ...add]);
      const score = [c.supported.size, -short, c.clamps.length, -order.length];
      if (!pick || rankDesc(score, pick.score) < 0) pick = { score, add };
    }
  }
  return pick ? { add: pick.add } : { fail: 'Every run of sticks that closes the gap would show from the front.' };
}

/**
 * Each distinct order of a handful of sticks; past four, the three Auto truss tries: longest first,
 * its reverse, and longest in the middle.
 */
function orders(mix: readonly PaletteItem[]): PaletteItem[][] {
  const seen = new Set<string>();
  if (mix.length > 4) {
    const desc = [...mix].sort((a, z) => z.len - a.len);
    const middleOut: PaletteItem[] = [];
    desc.forEach((it, i) => (i % 2 ? middleOut.push(it) : middleOut.unshift(it)));
    return [desc, [...desc].reverse(), middleOut].filter(o => {
      const k = o.map(i => i.catalogId).join(',');
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }
  const out: PaletteItem[][] = [];
  const walk = (left: PaletteItem[], acc: PaletteItem[]): void => {
    if (!left.length) {
      const k = acc.map(i => i.catalogId).join(',');
      if (!seen.has(k)) { seen.add(k); out.push(acc); }
      return;
    }
    left.forEach((it, i) => walk([...left.slice(0, i), ...left.slice(i + 1)], [...acc, it]));
  };
  walk([...mix], []);
  return out;
}

/* ───────────────────────────── removing ───────────────────────────── */

/** `pieces` without piece `i`, and without whatever stood on the floor only through it. */
export function removePiece(b: Builder, pieces: readonly BuildPiece[], i: number): BuildPiece[] {
  const left = pieces.filter((_, k) => k !== i);
  const ports = left.map((p, k) => portsOf(b, p, k));
  const keep = new Set<number>();
  const queue = left.flatMap((p, k) => (p.kind === 'base' ? [k] : []));
  for (const k of queue) keep.add(k);
  while (queue.length) {
    const k = queue.pop()!;
    for (let j = 0; j < left.length; j++) {
      if (keep.has(j)) continue;
      if (ports[k].some(a => ports[j].some(c => meets(a, c)))) { keep.add(j); queue.push(j); }
    }
  }
  return left.filter((_, k) => keep.has(k));
}

/* ───────────────────────────── stock and applying ───────────────────────────── */

/** How many of each part the rig stands up. */
function usedCounts(pieces: readonly BuildPiece[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const p of pieces) n.set(p.catalogId, (n.get(p.catalogId) ?? 0) + 1);
  return n;
}

/** What the rig comes to: its couplers, which pieces are ghosts, and what it holds. */
export interface BuildSummary {
  coupling: Coupling;
  /** Per piece, then per coupler in `coupling.clamps` order: drawn as a ghost. */
  pieceGhosts: boolean[];
  clampGhosts: boolean[];
  ghosts: number;
  shortfall: { catalogId: string; name: string; need: number; have: number }[];
  /** What the ghosts cost to buy, US dollars. */
  buyUsd: number;
  /** Columns with any cabinets in them. */
  columns: number;
  /** Lengths of straight runs of horizontal sticks spliced end to end past the span table. */
  long: number[];
  warnings: string[];
}

/** Couple `pieces` and give each its ghost: in the order they went up, then the couplers, the first on each column ahead. */
export function summarize(b: Builder, pieces: readonly BuildPiece[]): BuildSummary {
  const { ctx } = b;
  const coupling = couple(b, pieces);
  const avail = (id: string): number => {
    const own = ownedCount(equipmentDef(id));
    return own === undefined ? Infinity : Math.max(0, own - (b.elsewhere.get(id) ?? 0));
  };
  const left = new Map<string, number>();
  let ghosts = 0;
  const need = new Map<string, { name: string; n: number; ghosts: number }>();
  const take = (id: string, name: string): boolean => {
    if (!left.has(id)) left.set(id, avail(id));
    const n = left.get(id)!;
    left.set(id, n - 1);
    const g = n <= 0;
    if (g) ghosts++;
    const row = need.get(id) ?? { name, n: 0, ghosts: 0 };
    row.n++;
    if (g) row.ghosts++;
    need.set(id, row);
    return g;
  };
  const pieceGhosts = pieces.map(p => take(p.catalogId, equipmentDef(p.catalogId)?.name ?? p.catalogId));
  const clampGhosts = new Array<boolean>(coupling.clamps.length).fill(false);
  const firstPerCol = new Set<number>();
  const lead: number[] = [], rest: number[] = [];
  [...coupling.clamps.keys()].sort((a, z) => Number(coupling.clamps[z].header) - Number(coupling.clamps[a].header)).forEach(k => {
    const col = coupling.clamps[k].col;
    if (firstPerCol.has(col)) rest.push(k);
    else { firstPerCol.add(col); lead.push(k); }
  });
  for (const k of [...lead, ...rest]) clampGhosts[k] = take(ctx.clampDef.id, ctx.clampDef.name);
  const shortfall = [...need].filter(([, r]) => r.ghosts > 0)
    .map(([catalogId, r]) => ({ catalogId, name: r.name, need: r.n, have: r.n - r.ghosts }));

  // Straight runs of horizontal sticks spliced end to end.
  const long: number[] = [];
  const ports = pieces.map((p, i) => portsOf(b, p, i));
  const seen = new Set<number>();
  pieces.forEach((p, i) => {
    if (seen.has(i) || p.kind !== 'stick' || p.vertical) return;
    let total = 0;
    const stack = [i];
    seen.add(i);
    while (stack.length) {
      const k = stack.pop()!;
      total += pieces[k].len;
      pieces.forEach((q, j) => {
        if (seen.has(j) || q.kind !== 'stick' || q.vertical) return;
        if (ports[k].some(a => ports[j].some(c => meets(a, c)))) { seen.add(j); stack.push(j); }
      });
    }
    if (total > SPAN_TABLE_IN + EPS) long.push(total);
  });

  const columns = ctx.bands.filter(x => x.length).length;
  const warnings: string[] = [];
  for (const [i, why] of coupling.bared) warnings.push(`The ${pieceName(pieces[i])} shows from the front: ${why}`);
  if (coupling.welds) {
    warnings.push(`${coupling.welds} ${coupling.welds === 1 ? 'hole sits' : 'holes sit'} level with a brace weld, where a coupler cannot close.`);
  }
  if (long.length) {
    const n = long.length;
    warnings.push(`${n} ${n === 1 ? 'span runs' : 'spans run'} past ${SPAN_TABLE_IN / 12} ft, where the DT-GP span table stops `
      + `(the longest is ${+(Math.max(...long) / 12).toFixed(1)} ft): have ${n === 1 ? 'it' : 'them'} checked before ${n === 1 ? 'it carries' : 'they carry'} the wall.`);
  }
  for (const f of shortfall) {
    const k = f.need - f.have;
    warnings.push((BUY_STICK_IDS as readonly string[]).includes(f.catalogId)
        ? `${f.name}: ${k} to buy, drawn as ${k === 1 ? 'a ghost' : 'ghosts'}.`
        : `${f.name}: ${f.need} needed, ${f.have} available - ${k} drawn as ${k === 1 ? 'a ghost' : 'ghosts'}.`);
  }
  const buyUsd = Math.round(shortfall.reduce((a, f) => a + (f.need - f.have) * buyPrice(f.catalogId), 0) * 100) / 100;
  const cost = costNote(buyUsd, shortfall);
  if (cost) warnings.push(cost);
  return { coupling, pieceGhosts, clampGhosts, ghosts, shortfall, buyUsd, columns, long, warnings };
}

/** The entity a piece is drawn as: the rig's, or, with no `parentId`, a preview's. */
export function pieceEntity(b: Builder, p: BuildPiece, ghost: boolean, parentId?: string): EquipmentEntity {
  const def = equipmentDef(p.catalogId);
  const name = def?.name ?? p.catalogId;
  const geometry: EquipmentGeometry = p.kind === 'stick' ? (p.vertical ? 'truss-vertical' : 'truss') : (def?.geometry ?? 'box');
  const e = createEquipment(
    { id: p.catalogId, name: ghost ? `${name} (not owned)` : name, geometry, dims: sizeOf(b, p), color: def?.color ?? '#17181b' },
    [...p.position] as Vec3,
  );
  if (p.id) e.id = p.id;
  e.transform.rotation = [0, p.yaw * DEG, 0];
  if (parentId) e.parentId = parentId;
  if (ghost) e.ghost = true;
  return e;
}

/**
 * The next document with the rig built from `pieces`: the wall's old rig out, this one in under a
 * group marked as built by hand (unless `hand` is false: Auto truss's), coupled whole, and the wall
 * set down on its plates. One function, so one `cmdPatchDocument` covers a placement and it is a
 * single undo. With no pieces left, the rig goes and the wall stays where it is.
 */
export function applyBuild(doc: Document, b: Builder, pieces: readonly BuildPiece[], hand = true): Document {
  const wall = (doc.entities.find(e => e.id === b.wall.id) as LedWallEntity | undefined) ?? b.wall;
  const stale = rigEntityIds(doc, wall.id);
  if (!pieces.length) return { ...doc, entities: doc.entities.filter(e => !stale.has(e.id)) };
  const sum = summarize(b, pieces);
  const fresh = createGroup(RIG_GROUP_NAME);
  const group: GroupEntity = {
    ...fresh, id: b.group?.id ?? fresh.id, name: b.group?.name ?? RIG_GROUP_NAME, rigFor: wall.id, ...(hand ? { rigHand: true } : {}),
  };
  const parts = [
    ...pieces.map((p, i) => pieceEntity(b, p, sum.pieceGhosts[i], group.id)),
    ...sum.coupling.clamps.map((c, k) => {
      const p = c.piece;
      const ghost = sum.clampGhosts[k];
      const e = createEquipment(
        { id: p.catalogId, name: ghost ? `${p.name} (not owned)` : p.name, geometry: p.geometry, dims: p.dims, color: p.color },
        [...p.position] as Vec3,
      );
      e.transform.rotation = [...p.rotation] as Vec3;
      e.parentId = group.id;
      if (ghost) e.ghost = true;
      return e;
    }),
  ];
  // The wall as it stands in `doc`, which may not be where it stood when the builder was opened.
  const byId = new Map(doc.entities.map(e => [e.id, e]));
  const nowBottom = new THREE.Vector3().applyMatrix4(worldMatrix(wall, byId)).y;
  const pScale = new THREE.Vector3();
  parentMatrix(wall, byId).decompose(new THREE.Vector3(), new THREE.Quaternion(), pScale);
  const liftLocal = (sum.coupling.bottomY - nowBottom) / (pScale.y || 1);
  const entities = doc.entities
    .filter(e => !stale.has(e.id))
    .map(e => {
      if (e.id !== wall.id) return e;
      const next = { ...e } as LedWallEntity;
      if (Math.abs(liftLocal) > 1e-6) {
        const [x, y, z] = next.transform.position;
        next.transform = { ...next.transform, position: [x, y + liftLocal, z] };
      }
      if (b.ctx.dropAccessories) next.accessories = false;
      return next;
    });
  return { ...doc, entities: [...entities, group, ...parts] };
}

/** Stock left of `item` for this rig, given what it already stands up: negative where it runs into ghosts. */
export function stockLeft(item: PaletteItem, pieces: readonly BuildPiece[]): number {
  const used = pieces.filter(p => p.catalogId === item.catalogId).length;
  return item.owned - item.elsewhere - used;
}

/* ───────────────────────────── Auto truss ───────────────────────────── */

/** What Auto truss put up through the builder, and what of its plan would not go up. */
export interface AutoBuild {
  pieces: BuildPiece[];
  /** Gaps between frame legs closed as F closes one. */
  filled: number;
  /** Planned span sticks put up as planned, in gaps F found no run of sticks for. */
  kept: number;
  /** Planned pieces that would not go up, with why: none where planner and builder agree. */
  refused: { piece: BuildPiece; why: Verdict }[];
}

/** A planned part as a piece. */
function planned(p: RigPiece): BuildPiece | null {
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rotation[0] / DEG, p.rotation[1] / DEG, p.rotation[2] / DEG, 'YXZ'));
  return partAsPiece(p.catalogId, p.geometry, p.dims, v3(p.position), quat);
}

/** Whether horizontal stick `s` lies on the line from `a` to `z`, between them. */
function liesBetween(b: Builder, s: BuildPiece, a: THREE.Vector3, z: THREE.Vector3): boolean {
  if (s.kind !== 'stick' || s.vertical) return false;
  const C = v3(s.position).addScaledVector(UP, b.ctx.section / 2);
  const line = z.clone().sub(a);
  const len = line.length();
  const t = C.clone().sub(a).dot(line.divideScalar(len));
  return t > 0 && t < len && C.sub(a).addScaledVector(line, -t).length() < b.ctx.section / 2;
}

/**
 * Put `plan` up through the builder, as it would be put up by hand. Each leg goes up from its plate
 * where the planner stands it, a piece at a time, only onto a face of the piece below and only
 * where `check` passes: the frames, then the towers. Then each gap between frame tops that the plan
 * spans is closed as F closes it (`fillGap`: columns held, then the stock on hand), with every leg
 * already counted out of the stock, as the planner counts it. A planned span stick in a gap F
 * cannot close goes up as planned where it bolts on and passes; whatever does not go up is
 * `refused`, with why. The pieces come back in the planner's order, frames, spans, towers.
 *
 * F's sticks need not be the planner's: where the plan would close a gap with a stick past the
 * stock, F closes it from the sticks on hand where they reach, so the rig can take more, shorter
 * sticks and draw fewer ghosts (a flat 30 x 7: 9 sticks, 12 ghosts, against the plan's 7 and 14).
 * The legs, the couplers and the shim come out the planner's.
 */
export function autoBuild(b: Builder, plan: TrussRigPlan): AutoBuild {
  const pieces: BuildPiece[] = [];
  const refused: AutoBuild['refused'] = [];
  const bolts = (p: BuildPiece): boolean => {
    const mine = portsOf(b, p, pieces.length);
    return openPorts(b, pieces).some(q => mine.some(m => meets(q, m)));
  };
  const verdict = (p: BuildPiece): Verdict => (p.kind === 'base' || bolts(p) ? check(b, pieces, p) : ['Nothing is up for it to bolt onto.']);
  /** The leg's pieces bottom up; the index of its top, or -1 where it stopped short. */
  const putLeg = (leg: RigLeg): number => {
    const parts = leg.pieces.map(planned).filter((p): p is BuildPiece => !!p);
    for (let k = 0; k < parts.length; k++) {
      const why = verdict(parts[k]);
      if (why.length) {
        refused.push({ piece: parts[k], why });
        for (const p of parts.slice(k + 1)) refused.push({ piece: p, why: ['What it stands on would not go up.'] });
        return -1;
      }
      pieces.push(parts[k]);
    }
    return parts.length ? pieces.length - 1 : -1;
  };

  const tops = plan.legs.filter(l => l.kind === 'frame').map(putLeg).filter(t => t >= 0);
  const frames = pieces.length;
  plan.legs.filter(l => l.kind === 'tower').forEach(putLeg);
  const legs = pieces.length;
  let spans = plan.spans.map(planned).filter((p): p is BuildPiece => !!p);
  let filled = 0;
  for (const t of tops) {
    for (const port of openPorts(b, pieces)) {
      if (port.piece !== t || Math.abs(port.dir.y) > 0.5) continue;
      const gap = gapFrom(b, pieces, port);
      if (!gap) continue;
      // Only a gap the plan spans: one it leaves open, it leaves open for a reason.
      const mine = spans.filter(s => liesBetween(b, s, port.point, gap.to.point));
      if (!mine.length) continue;
      const fill = fillGap(b, pieces, port);
      if (!('add' in fill)) continue;
      pieces.push(...fill.add);
      spans = spans.filter(s => !mine.includes(s));
      filled++;
    }
  }
  let kept = 0;
  for (let more = true; more && spans.length;) {
    more = false;
    for (const s of [...spans]) {
      if (!bolts(s)) continue;
      spans = spans.filter(x => x !== s);
      more = true;
      const why = check(b, pieces, s);
      if (why.length) refused.push({ piece: s, why });
      else { pieces.push(s); kept++; }
    }
  }
  for (const s of spans) refused.push({ piece: s, why: ['Nothing is up for it to bolt onto.'] });
  return { pieces: [...pieces.slice(0, frames), ...pieces.slice(legs), ...pieces.slice(frames, legs)], filled, kept, refused };
}

/** Auto truss on `wall`: the next document, and what it came to. */
export interface AutoTruss {
  next: Document;
  plan: TrussRigPlan;
  auto: AutoBuild;
  summary: BuildSummary;
  /** Legs (plates) and horizontal sticks put up. */
  legs: number;
  spans: number;
  /** For the person who asked: what moved, what is short, what would not go up. */
  notes: string[];
}

/**
 * Auto truss: plan the rig behind `wall` and put it up through the builder, replacing the rig it
 * has. Null `next` with why where nothing can go up. The rig is written as Auto truss's, not as
 * one built by hand, so Auto truss replaces it again without asking.
 */
const MITRE = /cut away by a mitre/;
const FOLD = /beside a fold/;

export function autoTrussRig(doc: Document, wall: LedWallEntity): AutoTruss | { fail: string } {
  const plan = planTrussRig(doc, wall);
  if (!plan.legs.length) return { fail: plan.warnings[0] ?? 'There is nothing on this wall to bolt a coupler into.' };
  const b = openBuilder(doc, wall);
  if ('fail' in b) return b;
  const auto = autoBuild(b, plan);
  if (!auto.pieces.length) return { fail: auto.refused[0]?.why[0] ?? 'No piece of the plan would go up.' };
  const summary = summarize(b, auto.pieces);
  const c = summary.coupling;
  const notes: string[] = [];
  const lift = c.bottomY - b.currentBottom;
  const plate = b.ctx.base.plateThick;
  if (Math.abs(lift) > 1e-6) {
    notes.push(`The wall ${lift > 0 ? 'rises' : 'comes down'} ${Math.abs(lift).toFixed(2)} in to sit on the ${plate.toFixed(2)} in base plates${
      c.shim > 1e-6 ? `, on a ${inches(c.shim)} in shim so the header chord meets a row of holes` : ''}.`);
  } else if (c.shim > 1e-6) {
    notes.push(`The wall sits on a ${inches(c.shim)} in shim on the base plates, so the header chord meets a row of holes.`);
  }
  if (b.ctx.dropAccessories) notes.push('The floor-stand base plates and back supports come off: they stand where the legs do.');
  const carried = c.supported.size - c.held.size;
  if (carried > 0) {
    notes.push(`${carried} ${carried === 1 ? 'column has' : 'columns have'} no coupler of ${carried === 1 ? 'its' : 'their'} own: `
      + `${carried === 1 ? 'it is' : 'each is'} held by a coupled column beside it.`);
  }
  // A column the plan leaves unheld under a span, by choice, is not a fault: say what it saves.
  const spared = plan.forgiven.filter(k => !c.supported.has(k));
  const sparedNote = forgivenNote(spared, plan.savedUsd);
  if (sparedNote) notes.push(sparedNote);
  const loose = summary.columns - c.supported.size - spared.length;
  if (loose > 0) notes.push(`${loose} ${loose === 1 ? 'column is' : 'columns are'} out of reach of every coupler, and nothing holds ${loose === 1 ? 'it' : 'them'}.`);
  // Why, which only the planner can say: the holes a mitre cuts away, and the columns a fold keeps
  // every piece from. The builder couples the same columns, so its loose ones are the plan's.
  // The fold line follows the loose one: its "It" / "They" is those columns.
  if (loose > 0) notes.push(...plan.warnings.filter(w => FOLD.test(w)));
  notes.push(...plan.warnings.filter(w => MITRE.test(w)));
  if (auto.refused.length) {
    const n = auto.refused.length;
    const [first] = auto.refused;
    notes.push(`${n} planned ${n === 1 ? 'piece' : 'pieces'} would not go up. The first, a ${pieceName(first.piece)}: ${first.why[0]}`);
  }
  notes.push(...summary.warnings);
  return {
    next: applyBuild(doc, b, auto.pieces, false),
    plan, auto, summary,
    legs: auto.pieces.filter(p => p.kind === 'base').length,
    spans: auto.pieces.filter(p => p.kind === 'stick' && !p.vertical).length,
    notes,
  };
}
