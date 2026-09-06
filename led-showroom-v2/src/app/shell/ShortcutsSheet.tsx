import { Modal } from '@/app/components/Modal';
import { useStore } from '@/app/store';
import { SHORTCUTS, SHORTCUT_GROUPS } from '@/app/hooks/useGlobalShortcuts';

/** Keyboard reference. Content is generated from the same table the handler runs on. */
export function ShortcutsSheet() {
  const open = useStore(s => s.shortcutsOpen);
  const setOpen = useStore(s => s.setShortcutsOpen);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <div className="hint" style={{ marginBottom: 16 }}>Shortcuts apply while the viewport has focus. Inside a text field they type as usual.</div>
      <div className="kbd-grid" style={{ alignItems: 'start' }}>
        {SHORTCUT_GROUPS.map(g => (
          <div key={g} className="kbd-group">
            <div className="label" style={{ padding: '0 0 6px' }}>{g}</div>
            {SHORTCUTS.filter(s => s.group === g).map(s => (
              <div key={s.label} className="kbd-row">
                <span>{s.label}</span>
                <span style={{ whiteSpace: 'nowrap' }}>{s.keys.map(k => <kbd key={k}>{k}</kbd>)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
