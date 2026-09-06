/**
 * Shape tool: edit a wall's custom cell shape directly on the model (v1 2659-2713, 7726-7795).
 * Translucent ghost panels appear at every empty cell adjacent to the shape; clicking a ghost adds
 * the cell, clicking a real panel removes it, dragging paints. Edits keep the shape 4-connected.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Tool, PointerInfo } from './Tool';
import type { LedWallRenderer } from '../entities/LedWallRenderer';
import type { LedWallEntity } from '../document/types';
import { cellKey, classifyShapeEdit, filledCells, ghostCells, isRectWall, normalizeShape, paintShapeCell, panelLocalPosition, parseCell, pruneCorners } from '../ledwall/layout';
import { createWallMaterials, ghostPanelGeometry } from '../ledwall/geometry';
import { rayFromNdc } from '../scene/Picking';

let ghostMats: ReturnType<typeof createWallMaterials> | null = null;

export class ShapeTool implements Tool {
  readonly id = 'shape' as const;
  hint = 'Click a ghost panel to add it · Click a panel to remove it · Drag to paint · Esc when done';
  cursor = 'crosshair';
  private engine: Engine;
  private wallId: string | null = null;
  private ghosts = new THREE.Group();
  private ghostMeshes: THREE.Mesh[] = [];
  private paintMode: 'add' | 'remove' | null = null;
  private painted = new Set<string>();
  private offDoc: (() => void) | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
    this.ghosts.name = 'shape-ghosts';
    this.ghosts.userData.helper = true;
  }

  private wall(): LedWallEntity | null {
    const e = this.wallId ? this.engine.entity<LedWallEntity>(this.wallId) : null;
    return e && e.type === 'led-wall' ? e : null;
  }
  private renderer(): LedWallRenderer | null {
    const r = this.wallId ? this.engine.scene.get(this.wallId) : null;
    return r && (r as LedWallRenderer).pixelAtWorld ? (r as LedWallRenderer) : null;
  }

  onActivate(): void {
    const sel = this.engine.primarySelection;
    if (!sel || sel.type !== 'led-wall') { this.engine.toast('info', 'Select an LED wall to edit its shape'); this.engine.tools.activate('select'); return; }
    this.wallId = sel.id;
    if (isRectWall(sel)) {
      const cells = Array.from(filledCells(sel));
      this.engine.update<LedWallEntity>(sel.id, { shape: { mode: 'custom', cells } }, { label: 'Custom shape' });
    }
    this.offDoc = this.engine.on('document', () => this.rebuildGhosts());
    this.rebuildGhosts();
  }

  onDeactivate(): void {
    this.offDoc?.(); this.offDoc = null;
    this.clearGhosts();
    this.ghosts.removeFromParent();
    this.wallId = null;
    this.paintMode = null;
  }

  private clearGhosts(): void {
    for (const m of this.ghostMeshes) { m.removeFromParent(); }
    this.ghosts.clear();
    this.ghostMeshes = [];
  }

  private rebuildGhosts(): void {
    this.clearGhosts();
    const wall = this.wall(), r = this.renderer();
    if (!wall || !r) return;
    const mats = (ghostMats ??= createWallMaterials());
    const geo = ghostPanelGeometry(r.dims.spec);
    const cells = filledCells(wall);
    for (const key of ghostCells(cells)) {
      const [c, row] = parseCell(key);
      const p = panelLocalPosition(r.dims, r.layout, c, row);
      const mesh = new THREE.Mesh(geo.box, mats.ghost);
      mesh.userData.sharedGeometry = true; mesh.userData.sharedMaterial = true;
      mesh.userData.ghostCell = key;
      mesh.userData.unpickable = true;
      mesh.position.set(p[0], p[1], p[2]);
      const col = r.layout[c] ?? r.layout[Math.max(0, Math.min(r.layout.length - 1, c))];
      mesh.rotation.y = col ? col.rotY : 0;
      const edges = new THREE.LineSegments(geo.edges, mats.ghostEdge);
      edges.userData.sharedGeometry = true; edges.userData.sharedMaterial = true;
      mesh.add(edges);
      this.ghosts.add(mesh);
      this.ghostMeshes.push(mesh);
    }
    // ghosts live in the wall's inner frame (which may be lifted by the base plate thickness)
    const inner = r.root.children[0] ?? r.root;
    inner.add(this.ghosts);
    this.engine.invalidate();
  }

  /** Cell under the pointer: a ghost (add) or a panel (remove). */
  private cellAt(p: PointerInfo): { key: string; kind: 'ghost' | 'panel' } | null {
    const r = this.renderer();
    if (!r) return null;
    const rc = rayFromNdc(p.ndc, this.engine.camera.camera);
    const hits = rc.intersectObjects([...this.ghostMeshes, ...r.selectionMeshes()], false);
    const h = hits[0];
    if (!h) return null;
    if (h.object.userData.ghostCell) return { key: h.object.userData.ghostCell as string, kind: 'ghost' };
    if (h.object.userData.part === 'panel') return { key: cellKey(h.object.userData.col as number, h.object.userData.row as number), kind: 'panel' };
    return null;
  }

  private applyEdit(key: string, mode: 'add' | 'remove', merge: boolean): void {
    const wall = this.wall();
    if (!wall) return;
    const cells = filledCells(wall);
    const kind = classifyShapeEdit(cells, key);
    if (mode === 'add' && kind !== 'add') return;
    if (mode === 'remove') {
      if (kind === 'last-cell') { this.engine.toast('info', 'A wall needs at least one panel'); return; }
      if (kind === 'would-split') { this.engine.toast('info', 'Removing that panel would split the wall'); return; }
      if (kind !== 'remove') return;
    }
    const next = paintShapeCell(cells, key, mode);
    if (!next) return;
    const norm = normalizeShape(next);
    this.engine.update<LedWallEntity>(wall.id, w => ({ ...w, cols: norm.cols, rows: norm.rows, shape: { mode: 'custom', cells: Array.from(norm.cells) }, corners: pruneCorners(norm.cols, w.corners) }), { label: 'Edit shape', mergeKey: merge ? 'shape-paint' : undefined });
  }

  onPointerDown(p: PointerInfo): boolean {
    if (p.button !== 0) return false;
    const c = this.cellAt(p);
    if (!c) return false;
    this.paintMode = c.kind === 'ghost' ? 'add' : 'remove';
    this.painted = new Set([c.key]);
    this.applyEdit(c.key, this.paintMode, true);
    return true;
  }

  onPointerMove(p: PointerInfo): void {
    const c = this.cellAt(p);
    this.engine.tools.setCursor(c ? (c.kind === 'ghost' ? 'copy' : 'not-allowed') : 'crosshair');
    if (!this.paintMode || !c) return;
    // normalisation can re-key cells while painting; use the current key of the cell under the pointer
    if (this.painted.has(c.key)) return;
    if ((this.paintMode === 'add' && c.kind === 'ghost') || (this.paintMode === 'remove' && c.kind === 'panel')) {
      this.painted.add(c.key);
      this.applyEdit(c.key, this.paintMode, true);
    }
  }

  onPointerUp(): void {
    if (this.paintMode) { this.engine.history.commit(); this.paintMode = null; }
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' || e.key === 'Enter') { this.engine.tools.activate('select'); return true; }
    return false;
  }
}
