interface Props { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label?: string; title?: string }

/** `label` names the control for screen readers; `title` is the hover text and defaults to it. */
export function Toggle({ checked, onChange, disabled, label, title }: Props) {
  return (
    <label className="toggle" title={title ?? label}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} aria-label={label} />
      <span className="track" />
    </label>
  );
}

/**
 * A labelled toggle row for inspector sections. The hint is the row's tooltip AND the switch's own,
 * because the switch is what the pointer lands on — a title on the inner label would otherwise win
 * and show nothing but the side name the user can already read.
 */
export function ToggleRow({ label, checked, onChange, disabled, hint }: Props & { hint?: string }) {
  return (
    <div className="prop" title={hint}>
      <span className="k">{label}</span>
      <span className="v" style={{ justifyContent: 'flex-end' }}>
        <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} title={hint ?? label} />
      </span>
    </div>
  );
}
