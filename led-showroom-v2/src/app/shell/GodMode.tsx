/**
 * Admin / diagnostic view: the PIN prompt that unlocks it, and the one block every diagnostic
 * panel is built from.
 *
 * The rule this file exists to keep: the standard view renders none of it. Each caller guards on
 * `godMode` itself and renders nothing when it is off, so the normal inspector is byte-for-byte
 * what it was before this view existed. Everything here reports raw state — ids, stored arrays,
 * layout numbers, timings — with no rounding or prettifying, because the point of the view is to
 * see what the engine actually holds rather than what the normal UI chooses to show.
 *
 * See `checkGodPin` in the store for what the PIN is and is not worth.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/app/components/Button';
import { Modal } from '@/app/components/Modal';
import { TextField } from '@/app/components/TextField';
import { useStore } from '@/app/store';

/** One `label → raw value` row. Values are monospaced and wrap: cell arrays get long. */
export function Raw({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat" style={{ alignItems: 'start' }}>
      <span className="k">{label}</span>
      <span className="v mono" style={{ fontSize: 'var(--fs-2xs)', textAlign: 'right', wordBreak: 'break-all', whiteSpace: 'normal' }}>{value}</span>
    </div>
  );
}

/**
 * Wrapper that marks a region as diagnostic-only. Renders nothing unless God mode is on, so a
 * caller can drop it in without its own conditional.
 */
export function GodOnly({ children }: { children: ReactNode }) {
  const god = useStore(s => s.godMode);
  if (!god) return null;
  return <>{children}</>;
}

/** Mounted once, by the TopBar, beside the other dialogs. */
export function GodPinDialog() {
  const open = useStore(s => s.godPinOpen);
  const setOpen = useStore(s => s.setGodPinOpen);
  const tryPin = useStore(s => s.tryGodPin);
  const [pin, setPin] = useState('');
  const [bad, setBad] = useState(false);

  // Never leave a typed PIN behind for the next open.
  useEffect(() => { if (!open) { setPin(''); setBad(false); } }, [open]);

  const submit = () => {
    if (tryPin(pin)) return;
    setBad(true);
    setPin('');
  };

  return (
    <Modal open={open} title="Diagnostic view" onClose={() => setOpen(false)} width="min(380px, 92vw)">
      <div className="hint" style={{ fontSize: 'var(--fs-sm)' }}>
        Adds raw engine state to the inspector and the render dialog: ids, stored shape and corner
        arrays, sheet layout numbers and compose timings. It changes nothing in the scene, and it
        is dropped on reload.
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <TextField
          value={pin} onChange={v => { setPin(v); setBad(false); }} onCommit={submit} invalid={bad}
          type="password" inputMode="numeric" autoComplete="off" placeholder="PIN"
          aria-label="Diagnostic view PIN" style={{ ['--field-chars' as string]: 10 }}
        />
      </div>
      {bad && <div className="hint" style={{ color: 'var(--danger)', marginTop: 8 }}>That PIN does not match.</div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" icon={<ShieldCheck size={14} strokeWidth={1.5} />} onClick={submit}>Unlock</Button>
      </div>
    </Modal>
  );
}
