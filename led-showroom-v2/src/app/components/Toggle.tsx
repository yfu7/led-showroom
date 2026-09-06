interface Props { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label?: string }

export function Toggle({ checked, onChange, disabled, label }: Props) {
  return (
    <label className="toggle" title={label}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} aria-label={label} />
      <span className="track" />
    </label>
  );
}

/** A labelled toggle row for inspector sections. */
export function ToggleRow({ label, checked, onChange, disabled, hint }: Props & { hint?: string }) {
  return (
    <div className="prop" title={hint}>
      <span className="k">{label}</span>
      <span className="v" style={{ justifyContent: 'flex-end' }}><Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} /></span>
    </div>
  );
}
