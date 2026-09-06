export interface SelectOption<T extends string | number> { value: T; label: string }

interface Props<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange(v: T): void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

export function Select<T extends string | number>({ value, options, onChange, disabled, className = '', title }: Props<T>) {
  const numeric = typeof value === 'number';
  return (
    <div className={`field select ${className}`} title={title}>
      <select value={String(value)} disabled={disabled} onChange={e => onChange((numeric ? Number(e.target.value) : e.target.value) as T)}>
        {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </div>
  );
}
