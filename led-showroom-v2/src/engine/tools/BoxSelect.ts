/**
 * Marquee (box) selection: a DOM rectangle drawn over the viewport's input layer plus the pure
 * rect maths and the "which entities fall inside" query used by the Select tool.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { worldToScreen } from '../scene/Picking';

/** Axis-aligned rectangle in CSS pixels of the viewport. */
export interface ScreenRect { x: number; y: number; w: number; h: number }

/** Normalise two corners into a rect with non-negative size. */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): ScreenRect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function rectContains(r: ScreenRect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * Ids of every hidden entity plus everything below a hidden group (`parentId` chain): the scene
 * hides a group by hiding its root, so its children are invisible even when their own `visible`
 * flag is true. Cycles and dangling parent ids stop the walk.
 */
export function hiddenEntityIds(entities: readonly { id: string; visible: boolean; parentId?: string | null }[]): Set<string> {
  const out = new Set<string>();
  const byId = new Map(entities.map(e => [e.id, e]));
  for (const e of entities) {
    if (!e.visible) { out.add(e.id); continue; }
    const seen = new Set<string>([e.id]);
    for (let p = e.parentId ? byId.get(e.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      if (!p.visible) { out.add(e.id); break; }
    }
  }
  return out;
}

/**
 * Ids of visible entities whose projected bounds centre lies inside `rect`. Entities behind the
 * camera (perspective), hidden entities and the children of hidden groups are ignored. `filter`
 * can exclude e.g. locked entities.
 */
export function entitiesInRect(engine: Engine, rect: ScreenRect, filter: (id: string) => boolean = () => true): string[] {
  const camera = engine.camera.camera;
  const el = engine.renderer.inputEl;
  const out: string[] = [];
  const c = new THREE.Vector3();
  const b = new THREE.Box3();
  const s = new THREE.Vector2();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  camera.getWorldDirection(camDir);
  const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
  const hidden = hiddenEntityIds(engine.doc.entities);
  for (const e of engine.doc.entities) {
    if (hidden.has(e.id) || !filter(e.id)) continue;
    engine.scene.bounds([e.id], b);
    if (b.isEmpty()) c.set(e.transform.position[0], e.transform.position[1], e.transform.position[2]);
    else b.getCenter(c);
    if (persp && c.clone().sub(camPos).dot(camDir) <= 0) continue; // behind the camera
    worldToScreen(c, camera, el, s);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    if (rectContains(rect, s.x, s.y)) out.push(e.id);
  }
  return out;
}

/**
 * The marquee overlay. `begin` anchors it, `update` stretches it to the pointer, `end` removes it
 * and returns the final rect (or null if nothing was started). The element never receives pointer
 * events so the drag keeps flowing to the input layer underneath.
 */
export class BoxSelect {
  private host: HTMLElement;
  private el: HTMLDivElement | null = null;
  private x0 = 0;
  private y0 = 0;
  private rect: ScreenRect | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  get active(): boolean { return this.rect !== null; }
  get current(): ScreenRect | null { return this.rect; }

  begin(x: number, y: number): void {
    this.x0 = x; this.y0 = y;
    this.rect = { x, y, w: 0, h: 0 };
    if (!this.el) {
      const d = document.createElement('div');
      d.className = 'sr-marquee';
      Object.assign(d.style, {
        position: 'absolute',
        left: '0px', top: '0px', width: '0px', height: '0px',
        border: '1px solid var(--accent, #28ace3)',
        background: 'color-mix(in srgb, var(--accent, #28ace3) 14%, transparent)',
        borderRadius: '2px',
        pointerEvents: 'none',
        zIndex: '10',
        boxSizing: 'border-box',
      } as Partial<CSSStyleDeclaration>);
      this.el = d;
    }
    this.host.appendChild(this.el);
    this.apply();
  }

  update(x: number, y: number): ScreenRect {
    if (!this.rect) this.begin(x, y);
    this.rect = normalizeRect(this.x0, this.y0, x, y);
    this.apply();
    return this.rect;
  }

  /** Remove the overlay and return the final rect. */
  end(): ScreenRect | null {
    const r = this.rect;
    this.rect = null;
    this.el?.remove();
    return r;
  }

  private apply(): void {
    if (!this.el || !this.rect) return;
    const r = this.rect;
    this.el.style.left = `${r.x}px`;
    this.el.style.top = `${r.y}px`;
    this.el.style.width = `${r.w}px`;
    this.el.style.height = `${r.h}px`;
  }

  dispose(): void {
    this.end();
    this.el = null;
  }
}
