import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react';
import { MENU_OPEN_EVENT, MenuPanel, announceMenuOpen, isInsideMenuPanel, isSelectableItem, nextMenuToken, type MenuItem, type PanelPlacement } from './MenuPanel';

export { isMenuAction, isSelectableItem } from './MenuPanel';
export type { MenuAction, MenuItem } from './MenuPanel';

export interface MenuProps {
  /** Any element accepting onClick / aria props (IconButton, Button, …). */
  trigger: ReactElement<any>;
  items: MenuItem[];
  align?: 'left' | 'right';
  /** Called whenever the menu opens (rebuild dynamic items). */
  onOpen?(): void;
  minWidth?: number;
}

/**
 * Anchored dropdown. The panel, its keyboard handling and its submenus are {@link MenuPanel} —
 * the same surface right-click menus use; this component only owns the trigger, the open state
 * and where the panel hangs off the trigger.
 *
 * It dismisses on the same terms as a context menu — outside pointerdown, an outside scroll,
 * window blur and any other menu opening — and announces itself on {@link MENU_OPEN_EVENT} when
 * it opens. That is what keeps at most one menu tree up at a time, which in turn is what makes
 * the global `isInsideMenuPanel` registry a safe outside-click test for both of them.
 */
export function Menu({ trigger, items, align = 'left', onOpen, minWidth }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [initialIndex, setInitialIndex] = useState(-1);
  const anchor = useRef<HTMLElement | null>(null);
  /** Identity of this dropdown, so it ignores its own "a menu opened" announcement. */
  const token = useRef('');
  if (!token.current) token.current = nextMenuToken();

  const close = () => { setOpen(false); setInitialIndex(-1); anchor.current?.focus({ preventScroll: true }); };
  /** Dismissed from outside: no focus hand-back, the user is already somewhere else. */
  const dismiss = () => { setOpen(false); setInitialIndex(-1); };
  const openWith = (index: number) => { onOpen?.(); announceMenuOpen(token.current); setOpen(true); setInitialIndex(index); };

  const place = (size: { w: number; h: number }): PanelPlacement => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return { left: -9999, top: -9999 };
    let left = align === 'right' ? r.right - size.w : r.left;
    left = Math.max(6, Math.min(left, window.innerWidth - size.w - 6));
    let top = r.bottom + 6;
    if (top + size.h > window.innerHeight - 6) top = Math.max(6, r.top - size.h - 6);
    return { left, top };
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (isInsideMenuPanel(t) || anchor.current?.contains(t)) return;
      dismiss();
    };
    // The panel scrolls itself when it outgrows the window; only a scroll outside it moves the
    // trigger the panel is anchored to.
    const onScroll = (e: Event) => { if (!isInsideMenuPanel(e.target as Node)) dismiss(); };
    const onBlur = () => dismiss();
    const onOther = (e: Event) => { if ((e as CustomEvent<string>).detail !== token.current) dismiss(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener(MENU_OPEN_EVENT, onOther);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener(MENU_OPEN_EVENT, onOther);
    };
  }, [open]);

  const trig = cloneElement(trigger, {
    ref: (el: HTMLElement | null) => {
      anchor.current = el;
      const r = trigger.props.ref as ((el: HTMLElement | null) => void) | { current: HTMLElement | null } | undefined;
      if (typeof r === 'function') r(el); else if (r && typeof r === 'object') r.current = el;
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    active: open || trigger.props.active,
    onClick: (e: React.MouseEvent) => {
      trigger.props.onClick?.(e);
      if (open) { dismiss(); return; }
      openWith(-1);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      trigger.props.onKeyDown?.(e);
      if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openWith(items.findIndex(isSelectableItem)); }
    },
  });

  return (
    <>
      {trig}
      {open && <MenuPanel items={items} place={place} onClose={close} minWidth={minWidth} initialIndex={initialIndex} />}
    </>
  );
}
