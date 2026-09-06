import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

interface Props { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode; id?: string }

const openState = new Map<string, boolean>();

/** Collapsible inspector section with a tracked uppercase label. Open state persists per id for the session. */
export function Section({ title, children, defaultOpen = true, right, id }: Props) {
  const key = id ?? title;
  const [open, setOpen] = useState(openState.get(key) ?? defaultOpen);
  const toggle = () => { openState.set(key, !open); setOpen(!open); };
  return (
    <div className={`section${open ? ' open' : ''}`}>
      <div className="section-head" onClick={toggle} role="button" aria-expanded={open}>
        <ChevronRight className="chev" />
        <span className="label">{title}</span>
        {right && <span onClick={e => e.stopPropagation()}>{right}</span>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Prop({ label, children, wide, title }: { label: string; children: ReactNode; wide?: boolean; title?: string }) {
  return (
    <div className={`prop${wide ? ' wide' : ''}`} title={title}>
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="stat"><span className="k">{label}</span><span className="v">{value}</span></div>;
}
