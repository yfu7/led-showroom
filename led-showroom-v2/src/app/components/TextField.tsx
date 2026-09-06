import { useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange(v: string): void;
  /** Leading 14 px lucide icon. */
  icon?: ReactNode;
  /** Show a clear button when there is text. */
  clearable?: boolean;
  /** Enter commits; Escape reverts + blurs. */
  onCommit?(v: string): void;
  invalid?: boolean;
  className?: string;
}

/** Plain text input in the shared "field" chrome, with optional leading icon and clear button. */
export function TextField({ value, onChange, icon, clearable, onCommit, invalid, className = '', onKeyDown, ...rest }: TextFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const cls = ['field', 'text', invalid ? 'invalid' : '', className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      {icon && <span className="field-icon" style={{ display: 'inline-flex', paddingLeft: 8, color: 'var(--fg-2)' }}>{icon}</span>}
      <input
        ref={ref} type="text" value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          onKeyDown?.(e);
          if (e.key === 'Enter') { onCommit?.(value); ref.current?.blur(); }
          else if (e.key === 'Escape') { ref.current?.blur(); }
        }}
        {...rest}
      />
      {clearable && value && (
        <button type="button" className="iconbtn sm" aria-label="Clear" tabIndex={-1} style={{ marginRight: 2 }}
          onMouseDown={e => e.preventDefault()}
          onClick={() => { onChange(''); ref.current?.focus(); }}>
          <X style={{ width: 12, height: 12 }} />
        </button>
      )}
    </div>
  );
}
