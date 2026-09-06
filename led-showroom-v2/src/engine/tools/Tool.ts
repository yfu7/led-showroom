/** Tool contract + pointer dispatch. Tools own the left mouse button; the camera rig gets the rest. */
import * as THREE from 'three';

export type ToolId = 'select' | 'move' | 'rotate' | 'scale' | 'measure' | 'calibrate' | 'content' | 'shape' | 'add' | 'walk';

export interface PointerInfo {
  event: PointerEvent;
  ndc: THREE.Vector2;
  /** CSS pixels inside the viewport. */
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Distance moved since pointer down (px). */
  dragDistance: number;
}

export interface Tool {
  readonly id: ToolId;
  /** Shown in the status bar. */
  readonly hint: string;
  cursor?: string;
  onActivate?(): void;
  onDeactivate?(): void;
  /** Return true to claim the gesture (camera rotate is suppressed until pointer up). */
  onPointerDown?(p: PointerInfo): boolean;
  /**
   * Middle button press. Return true to claim the gesture (camera rotate is suppressed and the
   * browser's autoscroll is prevented until pointer up); the rig keeps the button otherwise.
   * Moves and ups arrive through {@link onPointerMove} / {@link onPointerUp} as usual.
   */
  onMiddlePointerDown?(p: PointerInfo): boolean;
  onPointerMove?(p: PointerInfo): void;
  onPointerUp?(p: PointerInfo): void;
  /**
   * Right-click on the viewport. Return true to consume it (a modal tool that owns the button);
   * otherwise the manager hands the point to its {@link ToolManager.onContextMenu} subscribers,
   * which is how the React overlay puts its context menu up.
   */
  onContextMenu?(p: PointerInfo): boolean;
  onClick?(p: PointerInfo): void;
  onDoubleClick?(p: PointerInfo): void;
  /** Return true if consumed. */
  onKeyDown?(e: KeyboardEvent): boolean;
  onKeyUp?(e: KeyboardEvent): void;
  /** Return true if consumed (camera zoom suppressed). */
  onWheel?(e: WheelEvent): boolean;
  /** Per-frame hook (gizmo helpers, previews). */
  frame?(dt: number): boolean;
}

export interface ToolHost {
  readonly inputEl: HTMLElement;
  readonly camera: THREE.Camera;
  setCameraRotate(on: boolean): void;
  setCameraZoom(on: boolean): void;
  invalidate(): void;
}

/** A right-press that travels further than this is a camera pan, not a click. */
export const CONTEXT_DRAG_PX = 4;

export class ToolManager {
  private tools = new Map<ToolId, Tool>();
  private active: Tool | null = null;
  private previous: ToolId | null = null;
  private host: ToolHost;
  private down: { x: number; y: number; button: number; claimed: boolean; pointerId: number; time: number } | null = null;
  private lastClick = 0;
  private listeners = new Set<(id: ToolId | null) => void>();
  private contextListeners = new Set<(p: PointerInfo) => void>();
  /** Right-button press: where and when, so a right-drag pan does not also open a menu. */
  private rightDown: { x: number; y: number; time: number } | null = null;
  private hover: PointerInfo | null = null;

  constructor(host: ToolHost) {
    this.host = host;
    const el = host.inputEl;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('dblclick', this.onDbl);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('keydown', this.onKeyDown);
    el.addEventListener('keyup', this.onKeyUp);
    el.addEventListener('contextmenu', this.onContext);
  }

  register(tool: Tool): void { this.tools.set(tool.id, tool); }
  get(id: ToolId): Tool | undefined { return this.tools.get(id); }
  get activeId(): ToolId | null { return this.active?.id ?? null; }
  get activeTool(): Tool | null { return this.active; }

  activate(id: ToolId): void {
    const t = this.tools.get(id);
    if (!t || t === this.active) return;
    if (this.active) { this.previous = this.active.id; this.active.onDeactivate?.(); }
    this.active = t;
    t.onActivate?.();
    this.host.inputEl.style.cursor = t.cursor ?? '';
    for (const fn of this.listeners) fn(id);
    this.host.invalidate();
  }

  /** Go back to the previously active tool (Esc from a modal tool). */
  restorePrevious(fallback: ToolId = 'select'): void { this.activate(this.previous ?? fallback); }

  onChange(fn: (id: ToolId | null) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /**
   * Subscribe to viewport right-clicks. The browser menu is always suppressed; subscribers are
   * called from the right-button *pointerup*, and only for a right *click* (the pointer moved
   * less than {@link CONTEXT_DRAG_PX} since the press, so a right-drag camera pan is never
   * interrupted by a menu) and only when the active tool did not consume the event through
   * `Tool.onContextMenu`.
   */
  onContextMenu(fn: (p: PointerInfo) => void): () => void { this.contextListeners.add(fn); return () => this.contextListeners.delete(fn); }

  setCursor(c: string | null): void { this.host.inputEl.style.cursor = c ?? this.active?.cursor ?? ''; }

  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const r = this.host.inputEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const ndc = new THREE.Vector2((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
    const dd = this.down ? Math.hypot(x - this.down.x, y - this.down.y) : 0;
    return { event: e as PointerEvent, ndc, x, y, button: (e as PointerEvent).button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, dragDistance: dd };
  }

  private onDown = (e: PointerEvent): void => {
    this.host.inputEl.focus({ preventScroll: true });
    const p = this.info(e);
    this.down = { x: p.x, y: p.y, button: e.button, claimed: false, pointerId: e.pointerId, time: performance.now() };
    if (e.button === 2) this.rightDown = { x: p.x, y: p.y, time: performance.now() };
    if (e.button === 0 && this.active?.onPointerDown) {
      if (this.active.onPointerDown(p)) this.claimPress(e);
    } else if (e.button === 1 && this.active?.onMiddlePointerDown) {
      // preventDefault also suppresses Windows' middle-click autoscroll (v1 did the same)
      if (this.active.onMiddlePointerDown(p)) { this.claimPress(e); e.preventDefault(); }
    }
  };

  private claimPress(e: PointerEvent): void {
    if (this.down) this.down.claimed = true;
    this.host.setCameraRotate(false);
    try { this.host.inputEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.stopPropagation();
  }

  private onMove = (e: PointerEvent): void => {
    const p = this.info(e);
    this.hover = p;
    this.active?.onPointerMove?.(p);
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.info(e);
    const d = this.down;
    this.down = null;
    if (d?.claimed) {
      this.host.setCameraRotate(true);
      try { this.host.inputEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    }
    this.active?.onPointerUp?.(p);
    if (d && e.button === 0 && p.dragDistance < 4 && performance.now() - d.time < 600) {
      this.active?.onClick?.(p);
    }
    if (e.button === 2 || e.type === 'pointercancel') {
      const rd = this.rightDown;
      this.rightDown = null;
      if (e.type !== 'pointercancel' && rd && Math.hypot(p.x - rd.x, p.y - rd.y) <= CONTEXT_DRAG_PX) {
        this.raiseContextMenu(p);
      }
    }
  };

  /**
   * The browser menu never shows on the viewport — that is all this handler does.
   *
   * The click-vs-drag decision cannot be made here: `contextmenu` is dispatched at button
   * *release* only on Windows; Chrome and Firefox on macOS and Linux dispatch it on button
   * *press*, in the same task as the pointerdown, where the pointer has by definition not moved
   * yet. Measuring there would open a menu at the start of every right-drag pan. `pointerup`
   * fires at release on all three platforms, so the menu is raised from {@link onUp} instead.
   */
  private onContext = (e: MouseEvent): void => { e.preventDefault(); };

  /** A right *click* (not a right-drag pan): the active tool gets it first, then the subscribers. */
  private raiseContextMenu(p: PointerInfo): void {
    if (this.active?.onContextMenu?.(p)) return;
    for (const fn of this.contextListeners) fn(p);
  }

  private onDbl = (e: MouseEvent): void => {
    const now = performance.now();
    if (now - this.lastClick < 50) return;
    this.lastClick = now;
    this.active?.onDoubleClick?.(this.info(e));
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.active?.onWheel?.(e)) { e.preventDefault(); e.stopPropagation(); }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.active?.onKeyDown?.(e)) { e.preventDefault(); e.stopPropagation(); }
  };
  private onKeyUp = (e: KeyboardEvent): void => { this.active?.onKeyUp?.(e); };

  frame(dt: number): boolean { return this.active?.frame?.(dt) ?? false; }

  get lastPointer(): PointerInfo | null { return this.hover; }

  dispose(): void {
    const el = this.host.inputEl;
    el.removeEventListener('contextmenu', this.onContext);
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('dblclick', this.onDbl);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('keydown', this.onKeyDown);
    el.removeEventListener('keyup', this.onKeyUp);
  }
}
