import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './Button';

/* ───────── open-modal registry (global shortcuts consult this) ───────── */

let openCount = 0;
const watchers = new Set<(open: boolean) => void>();

/** True while any Modal is mounted. Global shortcuts stay quiet while a modal is up. */
export const isModalOpen = (): boolean => openCount > 0;

/** Subscribe to modal open/close (returns an unsubscribe). */
export function onModalChange(fn: (open: boolean) => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Text-entry controls handle Escape themselves (revert + blur); the dialog must not also close on it. */
const isTextEntry = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
};

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title?: ReactNode;
  children: ReactNode;
  /** Extra content at the right of the head (before the close button). */
  head?: ReactNode;
  /** Override the dialog width (default: min(680px, 92vw) from CSS). */
  width?: number | string;
  className?: string;
  /** Hide the close button. */
  noClose?: boolean;
}

/**
 * Scrim + docked-feeling dialog. Escape and a scrim click close it; focus is kept inside
 * (light trap: Tab wraps, initial focus lands on the first focusable control).
 */
export function Modal({ open, onClose, title, children, head, width, className = '', noClose }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    openCount++;
    for (const fn of watchers) fn(true);
    restore.current = document.activeElement;
    // initial focus: first control inside the body, else the panel itself
    const t = window.setTimeout(() => {
      const el = panel.current;
      if (!el) return;
      const body = el.querySelector('.modal-body');
      const first = (body ?? el).querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus({ preventScroll: true });
    }, 0);
    return () => {
      window.clearTimeout(t);
      openCount--;
      for (const fn of watchers) fn(openCount > 0);
      const r = restore.current as HTMLElement | null;
      if (r && typeof r.focus === 'function' && document.contains(r)) r.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The modal owns every key while it is up — nothing reaches the viewport shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      // Escape typed inside a field cancels that edit only. The field has already blurred itself by the
      // time the event bubbles here, so park focus on the panel: a second Escape then closes the dialog.
      if (isTextEntry(e.target)) { panel.current?.focus({ preventScroll: true }); return; }
      onClose(); return;
    }
    if (e.key === 'Tab') {
      const el = panel.current;
      if (!el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(n => n.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  };

  return createPortal(
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel} className={`modal ${className}`.trim()} role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={title ? titleId : undefined}
        style={width !== undefined ? { width } : undefined}
        onKeyDown={onKeyDown}
        onMouseDown={e => e.stopPropagation()}
      >
        {(title || head || !noClose) && (
          <div className="modal-head">
            {title && <div className="modal-title" id={titleId}>{title}</div>}
            <span className="spacer" />
            {head}
            {!noClose && <IconButton tip="Close" kbd="Esc" onClick={onClose}><X /></IconButton>}
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
