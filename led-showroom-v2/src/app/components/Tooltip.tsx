import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

interface TipProps { label: string; kbd?: string; children: ReactElement<any>; delay?: number }

/** Hover tooltip rendered in a portal, positioned under (or above) the trigger. */
export function Tip({ label, kbd, children, delay = 450 }: TipProps) {
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const anchor = useRef<HTMLElement | null>(null);

  const show = (el: HTMLElement) => {
    anchor.current = el;
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const above = r.bottom + 40 > window.innerHeight;
      setPos({ x: r.left + r.width / 2, y: above ? r.top - 6 : r.bottom + 6, above });
    }, delay);
  };
  const hide = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; setPos(null); };
  useEffect(() => hide, []);

  const child = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { children.props.onMouseEnter?.(e); show(e.currentTarget); },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { children.props.onMouseLeave?.(e); hide(); },
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => { children.props.onMouseDown?.(e); hide(); },
  });

  return (
    <>
      {child}
      {pos && createPortal(
        <div className="tooltip" style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.above ? '-100%' : '0'})` }}>
          {label}{kbd && <kbd>{kbd}</kbd>}
        </div>,
        document.body,
      )}
    </>
  );
}
