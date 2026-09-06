/**
 * The one confirm dialog for clearing the scene.
 *
 * `Engine.newDocument()` replaces the document *and* clears the undo history, so there is no way
 * back from it — it is the only action in the app that is not undoable. Every entry point (the
 * File menu, the scene inspector, the empty-viewport menu) therefore calls `requestClearScene()`
 * and lands here, instead of each shipping its own modal or, worse, none at all.
 *
 * The dialog is mounted once by the {@link TopBar} (always mounted, and its `Modal` portals to
 * `<body>`, so the confirm still appears when the header is hidden in presentation mode).
 */
import { useEffect, useState } from 'react';
import { Eraser } from 'lucide-react';
import { Button } from '@/app/components/Button';
import { Modal } from '@/app/components/Modal';
import { useDoc, useEngine } from '@/app/store';

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Ask for the clear-scene confirmation. Safe to call from anywhere in the UI; it does nothing
 * until a {@link ClearSceneDialog} is mounted.
 */
export function requestClearScene(): void {
  for (const fn of listeners) fn();
}

/** Mounted once, by the TopBar. Renders nothing until {@link requestClearScene} is called. */
export function ClearSceneDialog() {
  const engine = useEngine();
  const doc = useDoc();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const fn = () => setOpen(true);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const total = doc.entities.length;
  const close = () => setOpen(false);
  const clear = () => {
    close();
    engine.newDocument();
    engine.toast('info', 'Scene cleared');
  };

  return (
    <Modal open={open} title="Clear scene" onClose={close} width="min(420px, 92vw)">
      <div className="hint" style={{ fontSize: 'var(--fs-sm)' }}>
        {total > 0
          ? `This removes all ${total} ${total === 1 ? 'object' : 'objects'} and resets the venue, floor, lighting and scene name, leaving an empty floor.`
          : 'This resets the venue, floor, lighting and scene name, leaving an empty floor.'}
        {' '}Your display units and snapping settings are kept. It also clears the undo history, so
        it cannot be undone. Save the scene as a preset or a .showroom.json file first if you want
        to come back to it.
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="danger" icon={<Eraser size={14} strokeWidth={1.5} />} onClick={clear}>Clear scene</Button>
      </div>
    </Modal>
  );
}
