interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(v: number): void;
  onCommit?(): void;
  disabled?: boolean;
  className?: string;
}

export function Slider({ value, min, max, step = 1, onChange, onCommit, disabled, className = '' }: Props) {
  return (
    <input
      type="range" className={`slider ${className}`} value={value} min={min} max={max} step={step} disabled={disabled}
      onChange={e => onChange(Number(e.target.value))}
      onPointerUp={() => onCommit?.()}
      onKeyUp={() => onCommit?.()}
    />
  );
}
