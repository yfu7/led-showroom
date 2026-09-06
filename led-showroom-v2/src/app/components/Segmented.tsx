import type { ReactNode } from 'react';

export interface SegOption<T extends string> { value: T; label?: ReactNode; icon?: ReactNode; title?: string }

interface Props<T extends string> {
  value: T;
  options: SegOption<T>[];
  onChange(v: T): void;
  block?: boolean;
  accent?: boolean;
  className?: string;
}

export function Segmented<T extends string>({ value, options, onChange, block, accent, className = '' }: Props<T>) {
  return (
    <div className={`seg${block ? ' block' : ''}${accent ? ' accent' : ''} ${className}`} role="radiogroup">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
