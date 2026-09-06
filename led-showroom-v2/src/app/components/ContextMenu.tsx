/**
 * Right-click menus. `useContextMenu()` returns `open(event, items)` / `close()` and the `node`
 * the consumer renders; the panel itself is {@link MenuPanel}, the same surface the anchored
 * dropdown uses, portalled to document.body at an arbitrary viewport point.
 *
 * Dismissal: Escape, an outside pointerdown, a scroll, window blur, and any other context menu
 * opening (they announce themselves on the `CONTEXT_MENU_OPEN` window event, so only one is ever
 * up). Keyboard navigation, submenus and item styling all come from MenuPanel.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MENU_OPEN_EVENT, MenuPanel, announceMenuOpen, isInsideMenuPanel, nextMenuToken, type MenuItem, type PanelPlacement } from './MenuPanel';

export type { MenuAction, MenuItem } from './MenuPanel';

/** Fired when any menu opens; every other open one closes itself. Lives in MenuPanel now. */
export const CONTEXT_MENU_OPEN = MENU_OPEN_EVENT;

/** Anything with viewport coordinates: a React or DOM mouse/pointer event, or a bare point. */
export interface ContextMenuOrigin {
  clientX: number;
  clientY: number;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export interface ContextMenuApi {
  /** Open at the event's point with `items`. Prevents the browser menu and closes any other one. */
  open(origin: ContextMenuOrigin, items: MenuItem[]): void;
  close(): void;
  /** True while this menu is showing. */
  isOpen: boolean;
  /** Render this somewhere in the consumer's tree (it portals to document.body itself). */
  node: ReactNode;
}

interface State { x: number; y: number; items: MenuItem[] }

/** Keeps the whole tree on screen: prefer down-right of the point, flip up / left at the edges. */
export function placeAtPoint(x: number, y: number, size: { w: number; h: number }, win = { w: window.innerWidth, h: window.innerHeight }, pad = 6): PanelPlacement {
  let left = x;
  if (left + size.w > win.w - pad) left = x - size.w;
  left = Math.max(pad, Math.min(left, Math.max(pad, win.w - size.w - pad)));
  let top = y;
  if (top + size.h > win.h - pad) top = y - size.h;
  top = Math.max(pad, Math.min(top, Math.max(pad, win.h - size.h - pad)));
  return { left, top };
}

export function useContextMenu(): ContextMenuApi {
  const [state, setState] = useState<State | null>(null);
  /** Identity of this hook instance, so it ignores its own "a menu opened" announcement. */
  const token = useRef('');
  if (!token.current) token.current = nextMenuToken();
  /** Whatever had focus when the menu opened — the viewport, usually, which owns tool keys. */
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setState(null);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  }, []);

  const open = useCallback((origin: ContextMenuOrigin, items: MenuItem[]) => {
    origin.preventDefault?.();
    origin.stopPropagation?.();
    if (!items.length) return;
    const active = document.activeElement;
    if (!returnFocus.current && active instanceof HTMLElement && active !== document.body) returnFocus.current = active;
    announceMenuOpen(token.current);
    setState({ x: origin.clientX, y: origin.clientY, items });
  }, []);

  useEffect(() => {
    if (!state) return;
    // The dismissing *left* press is swallowed (capture phase, before the canvas sees it):
    // backing out of a menu must not also clear the selection the menu was acting on. A right
    // press still gets through, so right-clicking somewhere else moves the menu there in one
    // gesture rather than two.
    const onDown = (e: PointerEvent) => {
      if (isInsideMenuPanel(e.target as Node)) return;
      if (e.button === 0) { e.preventDefault(); e.stopPropagation(); }
      close();
    };
    // The panel scrolls itself when it is taller than the window; only scrolling *outside* it
    // (the page moving under the menu) invalidates the point the menu is anchored to.
    const onScroll = (e: Event) => { if (!isInsideMenuPanel(e.target as Node)) close(); };
    const onBlur = () => close();
    const onOther = (e: Event) => { if ((e as CustomEvent<string>).detail !== token.current) close(); };
    // capture, so a menu opened over a stopPropagation-happy panel still closes
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener(CONTEXT_MENU_OPEN, onOther);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener(CONTEXT_MENU_OPEN, onOther);
    };
  }, [state, close]);

  const place = useCallback(
    (size: { w: number; h: number }) => placeAtPoint(state?.x ?? 0, state?.y ?? 0, size),
    [state?.x, state?.y],
  );

  const node = state ? <MenuPanel items={state.items} place={place} onClose={close} ariaLabel="Context menu" /> : null;
  return { open, close, isOpen: !!state, node };
}
