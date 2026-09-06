/**
 * Content drag tool: grab a content window on an LED wall and slide it across the panels
 * (v1 "Drag Content" mode, index.html 7953-8090). Fill/scaled windows are promoted to a
 * custom rect on first drag so they have room to move.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Tool, PointerInfo } from './Tool';
import { pickEntity } from '../scene/Picking';
import type { LedWallRenderer } from '../entities/LedWallRenderer';
import type { ContentWindow, LedWallEntity, PxRect } from '../document/types';
import { dragRect, promoteToCustomRect } from '../ledwall/contentWindows';

const WALL_ONLY = new Set(['led-wall']);

export class ContentDragTool implements Tool {
  readonly id = 'content' as const;
  hint = 'Drag a content window across the wall · Click a wall to select it · Esc to leave';
  cursor = 'default';
  private engine: Engine;
  private drag: { wallId: string; windowId: string; startPx: { px: number; py: number }; startRect: PxRect; renderer: LedWallRenderer } | null = null;

  constructor(engine: Engine) { this.engine = engine; }

  private wallRenderer(id: string): LedWallRenderer | null {
    const r = this.engine.scene.get(id);
    return r && (r as LedWallRenderer).pixelAtWorld ? (r as LedWallRenderer) : null;
  }

  private hitWindow(p: PointerInfo): { wallId: string; renderer: LedWallRenderer; px: { px: number; py: number }; win: ContentWindow | null } | null {
    const hit = pickEntity(p.ndc, this.engine.camera.camera, this.engine.scene.world, { onlyTypes: WALL_ONLY });
    if (!hit) return null;
    const renderer = this.wallRenderer(hit.entityId);
    if (!renderer) return null;
    const px = renderer.pixelAtWorld(hit.point);
    if (!px) return null;
    return { wallId: hit.entityId, renderer, px, win: renderer.windowAt(px.px, px.py) };
  }

  onActivate(): void { this.engine.tools.setCursor('default'); }
  onDeactivate(): void { this.drag = null; }

  onPointerMove(p: PointerInfo): void {
    if (this.drag) {
      const { renderer, wallId, windowId, startPx, startRect } = this.drag;
      const hit = pickEntity(p.ndc, this.engine.camera.camera, this.engine.scene.world, { onlyTypes: WALL_ONLY });
      let px: { px: number; py: number } | null = null;
      if (hit && hit.entityId === wallId) px = renderer.pixelAtWorld(hit.point);
      if (!px) {
        // pointer left the wall: project onto the wall's screen plane through the start point
        const plane = new THREE.Plane();
        const n = new THREE.Vector3(0, 0, 1).applyQuaternion(renderer.root.getWorldQuaternion(new THREE.Quaternion()));
        plane.setFromNormalAndCoplanarPoint(n, renderer.pixelToWorld(startPx.px, startPx.py));
        const rc = new THREE.Raycaster();
        rc.setFromCamera(p.ndc, this.engine.camera.camera);
        const pt = new THREE.Vector3();
        if (rc.ray.intersectPlane(plane, pt)) px = renderer.pixelAtWorld(pt);
      }
      if (!px) return;
      const dx = px.px - startPx.px, dy = px.py - startPx.py;
      const rect = dragRect(startRect, dx, dy, renderer.dims);
      this.engine.update<LedWallEntity>(wallId, w => ({ ...w, contentWindows: w.contentWindows.map(cw => (cw.id === windowId ? { ...cw, mode: 'custom', rect } : cw)) }), { label: 'Move content window', mergeKey: `cwdrag:${windowId}` });
      return;
    }
    const h = this.hitWindow(p);
    this.engine.setHover(h ? h.wallId : null);
    this.engine.tools.setCursor(h?.win ? 'grab' : 'default');
  }

  onPointerDown(p: PointerInfo): boolean {
    if (p.button !== 0) return false;
    const h = this.hitWindow(p);
    if (!h) return false;
    if (!this.engine.isSelected(h.wallId)) this.engine.select([h.wallId]);
    if (!h.win) return true; // claimed: selecting the wall, no orbit
    this.engine.selectedWindow.set(h.wallId, h.win.id);
    let win = h.win;
    if (win.mode !== 'custom') {
      const promoted = promoteToCustomRect(win, h.renderer.dims);
      this.engine.update<LedWallEntity>(h.wallId, w => ({ ...w, contentWindows: w.contentWindows.map(cw => (cw.id === win.id ? promoted : cw)) }), { label: 'Move content window', mergeKey: `cwdrag:${win.id}` });
      win = promoted;
    }
    this.drag = { wallId: h.wallId, windowId: win.id, startPx: h.px, startRect: { ...win.rect }, renderer: h.renderer };
    this.engine.tools.setCursor('grabbing');
    return true;
  }

  onPointerUp(): void {
    if (this.drag) { this.engine.history.commit(); this.drag = null; this.engine.tools.setCursor('grab'); }
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') { this.engine.tools.activate('select'); return true; }
    return false;
  }
}
