/**
 * The one menu surface in the app: item list, highlight, keyboard navigation and nested submenus.
 * Both the anchored dropdown ({@link Menu}) and the point-anchored context menu
 * ({@link useContextMenu}) render one of these, so there is a single item shape, a single set of
 * behaviours and a single place where the `.menu` / `.menu-item` styling is applied.
 *
 * The owner decides *where* the panel goes by passing `place`, which is called with the measured
 * panel size — that is what lets a dropdown hang off a trigger and a context menu flip around the
 * window edges without two implementations.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  onSelect?(): void;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a check mark at the left (option lists). */
  checked?: boolean;
  /** Item belongs to an exclusive option group (role=menuitemradio instead of menuitemcheckbox). */
  radio?: boolean;
  /** Non-interactive tracked-uppercase group label. */
  header?: boolean;
  /** Nested items. Opens to the side on hover, click, Enter or ArrowRight. */
  submenu?: MenuItem[];
}

export type MenuItem = MenuAction | 'sep';

export const isMenuAction = (it: MenuItem): it is MenuAction => it !== 'sep';
export const isSelectableItem = (it: MenuItem | undefined): boolean => !!it && isMenuAction(it) && !it.header && !it.disabled;
const submenuOf = (it: MenuItem | undefined): MenuItem[] | null => (it && isMenuAction(it) && it.submenu?.length ? it.submenu : null);

/**
 * Fired when any menu opens — the anchored dropdown as well as a context menu. Every other open
 * menu closes itself on it, so at most one menu tree is ever up and the global `mounted` registry
 * below only ever describes that one tree.
 */
export const MENU_OPEN_EVENT = 'showroom:context-menu';

let menuSeq = 0;
/** A fresh identity for a menu instance, so it can ignore its own {@link MENU_OPEN_EVENT}. */
export const nextMenuToken = (): string => `menu-${++menuSeq}`;
export function announceMenuOpen(token: string): void {
  window.dispatchEvent(new CustomEvent<string>(MENU_OPEN_EVENT, { detail: token }));
}

/** Every mounted panel, so an outside-click check counts a submenu as inside its own menu. */
const mounted = new Set<HTMLElement>();

/** True when `node` sits inside any open menu panel (root or submenu). */
export function isInsideMenuPanel(node: Node | null): boolean {
  if (!node) return false;
  for (const p of mounted) if (p === node || p.contains(node)) return true;
  return false;
}

export interface PanelPlacement { left: number; top: number }

export interface MenuPanelProps {
  items: MenuItem[];
  /** Fixed-viewport position, computed from the measured panel size (flip / clamp lives here). */
  place(size: { w: number; h: number }): PanelPlacement;
  /** Dismiss the whole menu tree — a selection was made, Escape at the root, an outside click. */
  onClose(): void;
  /** Dismiss only this panel and hand focus back to its parent (Escape / ArrowLeft in a submenu). */
  onCloseSelf?(): void;
  /** Take DOM focus on mount (false for a submenu opened by hover, which must not steal focus). */
  autoFocus?: boolean;
  minWidth?: number;
  /** Index highlighted on mount (-1 = nothing). */
  initialIndex?: number;
  ariaLabel?: string;
}

export function MenuPanel({ items, place, onClose, onCloseSelf, autoFocus = true, minWidth, initialIndex = -1, ariaLabel }: MenuPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const itemEls = useRef<(HTMLButtonElement | null)[]>([]);
  const placeRef = useRef(place);
  placeRef.current = place;
  const [pos, setPos] = useState<PanelPlacement | null>(null);
  const [hi, setHi] = useState(initialIndex);
  /** Open submenu: which item, and whether it should hold focus (keyboard / click vs hover). */
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const menuId = useId();

  // `items` is often built inline by the owner, so measuring on every render is normal — write
  // state only when the placement actually moved, otherwise the layout effect loops forever.
  const measure = useCallback(() => {
    const p = panel.current;
    if (!p) return;
    const next = placeRef.current({ w: p.offsetWidth, h: p.offsetHeight });
    setPos(prev => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, []);

  useLayoutEffect(() => { measure(); }, [measure, items]);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    mounted.add(el);
    return () => { mounted.delete(el); };
  }, []);

  useEffect(() => { if (autoFocus) panel.current?.focus({ preventScroll: true }); }, [autoFocus]);

  useEffect(() => {
    const onReflow = () => measure();
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [measure]);

  /**
   * Drop the open submenu unless it belongs to item `keep`. A submenu opened by keyboard holds
   * DOM focus, so focus has to come back to this panel first — otherwise it lands on <body> and
   * the whole menu stops answering the keyboard while still being visible.
   */
  const closeSub = (keep = -1) => {
    if (!sub || sub.index === keep) return;
    if (sub.focus) panel.current?.focus({ preventScroll: true });
    setSub(null);
  };

  /**
   * Highlight item `i` and scroll it into view — the panel is a scroller once it is taller than
   * the window, so arrowing past the fold has to bring the row with it.
   */
  const focusItem = (i: number) => {
    setHi(i);
    itemEls.current[i]?.scrollIntoView?.({ block: 'nearest' });
    closeSub(i);
  };

  const move = (dir: 1 | -1) => {
    const n = items.length;
    if (!n) return;
    let i = hi;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (isSelectableItem(items[i])) { focusItem(i); return; }
    }
  };

  const select = (i: number) => {
    const it = items[i];
    if (!isSelectableItem(it)) return;
    if (submenuOf(it)) { setSub({ index: i, focus: true }); return; }
    onClose();
    (it as MenuAction).onSelect?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case 'Escape': e.preventDefault(); (onCloseSelf ?? onClose)(); break;
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'ArrowRight': if (submenuOf(items[hi])) { e.preventDefault(); setSub({ index: hi, focus: true }); } break;
      case 'ArrowLeft': if (onCloseSelf) { e.preventDefault(); onCloseSelf(); } break;
      case 'Home': { e.preventDefault(); const i = items.findIndex(isSelectableItem); if (i >= 0) focusItem(i); break; }
      case 'End': { e.preventDefault(); for (let i = items.length - 1; i >= 0; i--) if (isSelectableItem(items[i])) { focusItem(i); break; } break; }
      case 'Enter': case ' ': e.preventDefault(); if (hi >= 0) select(hi); break;
      case 'Tab': e.preventDefault(); onClose(); break;
    }
  };

  /** Place a submenu beside its parent item, flipping to the left when it would overflow. */
  const placeSub = (index: number) => (size: { w: number; h: number }): PanelPlacement => {
    const pr = panel.current?.getBoundingClientRect();
    const ir = itemEls.current[index]?.getBoundingClientRect();
    const right = (pr?.right ?? 0) - 4;
    const left = right + size.w > window.innerWidth - 6 ? Math.max(6, (pr?.left ?? 0) - size.w + 4) : right;
    let top = (ir?.top ?? pr?.top ?? 6) - 6;
    if (top + size.h > window.innerHeight - 6) top = Math.max(6, window.innerHeight - 6 - size.h);
    return { left, top };
  };

  const subItems = sub ? submenuOf(items[sub.index]) : null;

  return createPortal(
    <>
      <div
        ref={panel} className="menu" role="menu" tabIndex={-1} aria-label={ariaLabel}
        aria-activedescendant={isSelectableItem(items[hi]) ? `${menuId}-${hi}` : undefined}
        // hidden by opacity, never by `visibility` — a visibility:hidden element cannot take
        // focus, and the panel is focused in the same commit as its first measurement
        style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth, opacity: pos ? undefined : 0, pointerEvents: pos ? undefined : 'none' }}
        onKeyDown={onKeyDown}
        onContextMenu={e => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it === 'sep') return <div key={`sep-${i}`} className="sep" role="separator" />;
          if (it.header) return <div key={`h-${i}`} className="menu-label label">{it.label}</div>;
          const nested = !!it.submenu?.length;
          const cls = ['menu-item', it.danger ? 'danger' : '', hi === i ? 'hi' : ''].filter(Boolean).join(' ');
          return (
            <button
              key={`${it.label}-${i}`} id={`${menuId}-${i}`} type="button"
              ref={el => { itemEls.current[i] = el; }}
              role={nested || it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox'}
              aria-checked={nested ? undefined : it.checked}
              aria-haspopup={nested ? 'menu' : undefined}
              aria-expanded={nested ? sub?.index === i : undefined}
              aria-disabled={it.disabled || undefined} disabled={it.disabled}
              className={cls} tabIndex={-1}
              style={{ ...(hi === i ? { background: 'var(--bg-3)', color: it.danger ? 'var(--danger)' : 'var(--fg-0)' } : null), ...(it.disabled ? { opacity: 0.38, pointerEvents: 'none' } : null) }}
              onMouseEnter={() => {
                setHi(i);
                // Never tear a keyboard-focused submenu down without taking its focus back.
                closeSub(nested ? i : -1);
                if (nested && sub?.index !== i) setSub({ index: i, focus: false });
              }}
              onClick={() => select(i)}
            >
              {it.checked !== undefined && !nested
                ? <span style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-text)' }}>{it.checked ? <Check /> : null}</span>
                : it.icon ?? null}
              <span className="grow truncate">{it.label}</span>
              {it.kbd && !nested && <span className="kbd">{it.kbd}</span>}
              {nested && <ChevronRight style={{ marginLeft: 'auto', color: 'var(--fg-2)' }} />}
            </button>
          );
        })}
      </div>
      {sub && subItems && (
        <MenuPanel
          items={subItems}
          place={placeSub(sub.index)}
          onClose={onClose}
          onCloseSelf={() => { setSub(null); panel.current?.focus({ preventScroll: true }); }}
          autoFocus={sub.focus}
          ariaLabel={(items[sub.index] as MenuAction).label}
        />
      )}
    </>,
    document.body,
  );
}
