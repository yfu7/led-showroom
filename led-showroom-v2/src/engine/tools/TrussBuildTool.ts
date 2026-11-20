/**
 * Truss build tool: put a wall's rig up by hand, one DT-GP piece at a time. The pointer finds the
 * nearest open face of a piece already up (or, for a base plate, the floor behind the cabinets);
 * the piece picked from the palette shows there, green where it can go and red where it cannot,
 * and a click puts it up with its couplers as one undoable step.
 *
 * The document is the only state: the builder is read again from it on every change, so undo,
 * redo and edits made anywhere else need no bookkeeping here.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { PointerInfo, Tool } from './Tool';
import type { Entity, LedWallEntity } from '../document/types';
import { cmdPatchDocument } from '../commands/entity';
import { rayFromNdc, type Hit } from '../scene/Picking';
import { buildEquipment, disposeEquipmentBuild, type EquipmentBuild } from '../entities/equipmentGeometry';
import { rigEntityIds } from '../ledwall/trussRig';
import {
  applyBuild, attach, baseAt, check, fillGap, gapFrom, openBuilder, openPorts, pieceEntity, pieceName, removePiece,
  summarize, type BuildPiece, type BuildSummary, type Builder, type Port, type Verdict,
} from '../ledwall/trussBuilder';

/** How near the pointer has to come to an open face, in screen pixels, for a piece to go on it. */
const PORT_PX = 40;
const OK_COLOR = '#2ea043';
const BAD_COLOR = '#e5534b';
/** Bolder than a stock ghost (0.22) so the piece in hand stands out from the rig drawn behind it. */
const PREVIEW_OPACITY = 0.55;

/** Where the piece in hand would go, and whether it can. */
export interface TrussHover {
  cand: BuildPiece;
  /** The face it goes on; null for a plate on the floor. */
  port: Port | null;
  why: Verdict;
}

export interface TrussBuildState {
  wallId: string | null;
  builder: Builder | null;
  summary: BuildSummary | null;
  /** Palette index of the piece in hand. */
  sel: number;
  hover: TrussHover | null;
  /** The open side face nearest the pointer with a face across from it, and the gap between them. */
  gap: { port: Port; len: number } | null;
  /** Why nothing shows under the pointer. */
  note: string | null;
}

export const EMPTY_TRUSS_STATE: TrussBuildState = { wallId: null, builder: null, summary: null, sel: 0, hover: null, gap: null, note: null };

const keyOf = (p: BuildPiece): string => `${p.catalogId}|${p.position.map(v => v.toFixed(4)).join(',')}|${p.yaw.toFixed(4)}`;

export class TrussBuildTool implements Tool {
  readonly id = 'truss' as const;
  hint = 'Pick a piece · Click to put it up · Right-click a piece to take it down · Esc when done';
  cursor = 'crosshair';
  private engine: Engine;
  private state: TrussBuildState = EMPTY_TRUSS_STATE;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  /** Verdicts for this builder, by candidate: the pointer crosses the same spots over and over. */
  private verdicts = new Map<string, Verdict>();
  private readonly root = new THREE.Group();
  private preview: { key: string; build: EquipmentBuild } | null = null;
  private readonly marker: THREE.Mesh;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root.name = 'truss-build-preview';
    this.root.userData.helper = true;
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshBasicMaterial({ color: OK_COLOR }));
    this.marker.userData.unpickable = true;
    this.marker.visible = false;
    this.root.add(this.marker);
  }

  /* ───── state for the panel ───── */

  readonly getState = (): TrussBuildState => this.state;
  readonly subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<TrussBuildState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /* ───── lifecycle ───── */

  /** The wall `e` is, or whose rig it is part of. */
  private wallOf(e: Entity | undefined): LedWallEntity | null {
    let cur = e;
    for (let guard = 0; cur && guard < 64; guard++) {
      if (cur.type === 'led-wall') return cur;
      if (cur.type === 'group' && cur.rigFor) {
        const w = this.engine.entity(cur.rigFor);
        return w?.type === 'led-wall' ? w : null;
      }
      cur = cur.parentId ? this.engine.entity(cur.parentId) : undefined;
    }
    return null;
  }

  /** Back to the select tool, after the tool switch under way has finished. */
  private leave(): void { queueMicrotask(() => { if (this.engine.tools.activeId === this.id) this.engine.tools.activate('select'); }); }

  onActivate(): void {
    const wall = this.wallOf(this.engine.primarySelection);
    if (!wall) { this.engine.toast('info', 'Select an LED wall to build its truss'); this.leave(); return; }
    if (this.engine.selection.length !== 1 || !this.engine.isSelected(wall.id)) this.engine.select([wall.id]);
    this.engine.scene.scene.add(this.root);
    this.offs = [
      this.engine.on('document', () => this.reopen()),
      this.engine.on('selection', ids => {
        const w = this.wallOf(this.engine.entity(ids[ids.length - 1]));
        if (!w) this.leave();
        else if (w.id !== this.state.wallId) { this.set({ wallId: w.id }); this.reopen(); }
      }),
    ];
    this.set({ ...EMPTY_TRUSS_STATE, wallId: wall.id });
    this.reopen();
    const b = this.state.builder;
    // A bare wall starts at the floor: a plate in hand.
    if (b && !b.pieces.length) this.choose(b.palette.findIndex(i => i.kind === 'base'));
    // Keys go to the viewport, not to whatever button opened the tool.
    queueMicrotask(() => this.engine.renderer.inputEl.focus({ preventScroll: true }));
  }

  onDeactivate(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.clearPreview();
    this.root.removeFromParent();
    this.verdicts.clear();
    this.set(EMPTY_TRUSS_STATE);
    this.engine.invalidate();
  }

  /** Read the builder from the document again, and what the pointer is over with it. */
  private reopen(): void {
    const wall = this.state.wallId ? this.engine.entity<LedWallEntity>(this.state.wallId) : undefined;
    if (!wall || wall.type !== 'led-wall') { this.leave(); return; }
    const b = openBuilder(this.engine.doc, wall);
    if ('fail' in b) { this.engine.toast('error', b.fail); this.leave(); return; }
    this.verdicts.clear();
    this.set({ builder: b, summary: summarize(b, b.pieces), sel: Math.min(this.state.sel, b.palette.length - 1) });
    this.hoverAt(this.engine.tools.lastPointer);
  }

  /* ───── the piece in hand ───── */

  /** Pick palette item `i` as the piece in hand. */
  choose(i: number): void {
    const b = this.state.builder;
    if (!b || i < 0 || i >= b.palette.length) return;
    this.set({ sel: i });
    this.hoverAt(this.engine.tools.lastPointer);
  }

  private verdict(b: Builder, cand: BuildPiece): Verdict {
    const k = keyOf(cand);
    let v = this.verdicts.get(k);
    if (!v) { v = check(b, b.pieces, cand); this.verdicts.set(k, v); }
    return v;
  }

  /**
   * What goes where the pointer is: the open face nearest it on screen that the piece in hand fits,
   * one it can stand on ahead of one it cannot; a plate also goes on the floor under the pointer.
   */
  private hoverAt(p: PointerInfo | null): void {
    const b = this.state.builder;
    if (!b || !p) { this.set({ hover: null, gap: null, note: null }); this.drawPreview(); return; }
    const item = b.palette[this.state.sel];
    const cam = this.engine.camera.camera;
    const rect = this.engine.renderer.inputEl.getBoundingClientRect();
    const v = new THREE.Vector3();
    const options: (TrussHover & { px: number })[] = [];
    let gap: TrussBuildState['gap'] = null;
    let gapPx = PORT_PX;
    for (const port of openPorts(b, b.pieces)) {
      v.copy(port.point).project(cam);
      if (v.z < -1 || v.z > 1) continue;
      const px = Math.hypot(((v.x + 1) / 2) * rect.width - p.x, ((1 - v.y) / 2) * rect.height - p.y);
      if (px > PORT_PX) continue;
      if (Math.abs(port.dir.y) < 0.5 && px < gapPx) {
        const g = gapFrom(b, b.pieces, port);
        if (g) { gap = { port, len: g.len }; gapPx = px; }
      }
      const cand = attach(b, b.pieces, port, item);
      if (cand) options.push({ cand, port, why: this.verdict(b, cand), px });
    }
    if (item.kind === 'base') {
      const at = rayFromNdc(p.ndc, cam).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -b.ctx.supportY), new THREE.Vector3());
      const cand = at ? baseAt(b, b.pieces, at) : null;
      if (cand) options.push({ cand, port: null, why: this.verdict(b, cand), px: PORT_PX });
    }
    options.sort((a, z) => Number(a.why.length > 0) - Number(z.why.length > 0) || a.px - z.px);
    const best = options[0];
    const note = best ? null
      : !b.pieces.length ? 'Start with a base plate on the floor behind the cabinets.'
        : item.kind === 'base' ? 'A base plate goes on the floor behind the cabinets.'
          : 'Point at an open face of a piece that is up.';
    this.set({ hover: best ? { cand: best.cand, port: best.port, why: best.why } : null, gap, note });
    this.drawPreview();
  }

  private clearPreview(): void {
    if (this.preview) { disposeEquipmentBuild(this.preview.build); this.preview = null; }
    this.marker.visible = false;
  }

  private drawPreview(): void {
    const b = this.state.builder, h = this.state.hover;
    const ok = !!h && !h.why.length;
    const key = h ? `${keyOf(h.cand)}|${ok}` : '';
    if (this.preview?.key !== key) {
      if (this.preview) { disposeEquipmentBuild(this.preview.build); this.preview = null; }
      if (b && h) {
        const build = buildEquipment(pieceEntity(b, h.cand, true));
        // A tint, not a model: plates and couplers draw in fixed hardware materials that ignore the
        // entity colour, so every material takes the verdict colour, lit from within to read in the dark.
        const tint = new THREE.Color(ok ? OK_COLOR : BAD_COLOR);
        for (const m of build.materials) {
          if (!(m instanceof THREE.MeshStandardMaterial)) continue;
          m.color.copy(tint);
          m.emissive.copy(tint).multiplyScalar(0.45);
          m.opacity = PREVIEW_OPACITY;
        }
        build.group.position.set(h.cand.position[0], h.cand.position[1], h.cand.position[2]);
        build.group.rotation.y = h.cand.yaw;
        build.group.traverse(o => { o.userData.unpickable = true; });
        this.root.add(build.group);
        this.preview = { key, build };
      }
    }
    this.marker.visible = !!h?.port;
    if (h?.port) {
      this.marker.position.copy(h.port.point);
      (this.marker.material as THREE.MeshBasicMaterial).color.set(ok ? OK_COLOR : BAD_COLOR);
    }
    this.engine.invalidate();
  }

  /* ───── putting up and taking down ───── */

  private commit(pieces: readonly BuildPiece[], label: string): void {
    const b = this.state.builder;
    if (!b) return;
    const next = applyBuild(this.engine.doc, b, pieces);
    this.engine.run(cmdPatchDocument(this.engine, { entities: next.entities }, { label }));
  }

  /** Put up the piece in hand where it shows. */
  place(): void {
    const b = this.state.builder, h = this.state.hover;
    if (!b || !h) { if (this.state.note) this.engine.toast('info', this.state.note); return; }
    if (h.why.length) { this.engine.toast('info', h.why[0]); return; }
    this.commit([...b.pieces, h.cand], `Add ${pieceName(h.cand)}`);
  }

  /** Close the gap off the side face nearest the pointer with the fewest sticks that splice to it. */
  fill(): void {
    const b = this.state.builder, g = this.state.gap;
    if (!b || !g) { this.engine.toast('info', 'Point at the side of a block with another across from it to fill the gap.'); return; }
    const got = fillGap(b, b.pieces, g.port);
    if ('fail' in got) { this.engine.toast('info', got.fail); return; }
    this.commit([...b.pieces, ...got.add], `Fill ${+(g.len / 12).toFixed(2)} ft span`);
  }

  onClick(p: PointerInfo): void {
    if (p.button !== 0) return;
    this.hoverAt(p);
    this.place();
  }

  onPointerMove(p: PointerInfo): void {
    // Not while a drag moves the camera: the spot under the pointer is sliding away.
    if (p.event.buttons) return;
    this.hoverAt(p);
  }

  /** Right-click a piece to take it down, with anything that stood on the floor only through it. */
  /**
   * The piece under the pointer, and what the pick met first. A box truss is an open lattice, so a
   * ray through the middle of a stick runs between its tubes to the wall behind: a piece is taken by
   * its solid box, the nearest the ray enters before the first surface it meets.
   */
  private pieceAt(ndc: THREE.Vector2, b: Builder): { i: number; hit: Hit | null } {
    const hit = this.engine.pickAt(ndc);
    const exact = hit ? b.pieces.findIndex(q => q.id === hit.entityId) : -1;
    if (exact >= 0) return { i: exact, hit };
    const ray = rayFromNdc(ndc, this.engine.camera.camera).ray;
    const local = new THREE.Ray(), inv = new THREE.Matrix4(), at = new THREE.Vector3();
    let best = -1, near = hit?.distance ?? Infinity;
    b.pieces.forEach((q, i) => {
      for (const m of (q.id && this.engine.scene.get(q.id)?.selectionMeshes()) || []) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        local.copy(ray).applyMatrix4(inv.copy(m.matrixWorld).invert());
        if (!local.intersectBox(m.geometry.boundingBox!, at)) continue;
        const d = at.applyMatrix4(m.matrixWorld).distanceTo(ray.origin);
        if (d < near) { near = d; best = i; }
      }
    });
    return { i: best, hit };
  }

  onContextMenu(p: PointerInfo): boolean {
    const b = this.state.builder;
    if (!b) return false;
    const { i, hit } = this.pieceAt(p.ndc, b);
    if (i < 0) {
      if (!hit || !rigEntityIds(this.engine.doc, b.wall.id).has(hit.entityId)) return false;
      this.engine.toast('info', 'Couplers come and go with the pieces they hold.');
      return true;
    }
    const rest = removePiece(b, b.pieces, i);
    const gone = b.pieces.length - rest.length;
    this.commit(rest, gone > 1 ? `Remove ${gone} truss pieces` : `Remove ${pieceName(b.pieces[i])}`);
    if (gone > 1) this.engine.toast('info', `Took down ${gone} pieces: the rest of them stood only on the ${pieceName(b.pieces[i])}.`);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const b = this.state.builder;
    if (e.key === 'Escape') { this.engine.tools.activate('select'); return true; }
    if (e.key === 'Enter') { this.place(); return true; }
    if (!e.shiftKey && e.key.toLowerCase() === 'f') { this.fill(); return true; }
    if (b && /^[1-9]$/.test(e.key) && Number(e.key) <= b.palette.length) { this.choose(Number(e.key) - 1); return true; }
    return false;
  }
}
