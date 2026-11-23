/**
 * A yes-or-no dialog any action can put up with {@link requestConfirm}, for a step that throws
 * work away. It is mounted once by the TopBar, as ClearSceneDialog is, so a menu that closes
 * before the answer comes does not take the question with it.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/app/components/Button';
import { Modal } from '@/app/components/Modal';

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  /** The confirm button's label: what happens, not "OK". */
  confirm: string;
  danger?: boolean;
  onConfirm(): void;
  /** Runs on a no: the dialog closed any way but the confirm button. */
  onCancel?(): void;
}

const listeners = new Set<(r: ConfirmRequest) => void>();

/** Ask; `onConfirm` runs only on a yes. Does nothing until a {@link ConfirmDialog} is mounted. */
export function requestConfirm(r: ConfirmRequest): void {
  for (const fn of listeners) fn(r);
}

/** Mounted once, by the TopBar. Renders nothing until {@link requestConfirm} is called. */
export function ConfirmDialog() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    const fn = (r: ConfirmRequest) => setReq(r);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const close = () => setReq(null);
  const no = () => {
    const r = req;
    close();
    r?.onCancel?.();
  };
  const yes = () => {
    const r = req;
    close();
    r?.onConfirm();
  };

  return (
    <Modal open={!!req} title={req?.title} onClose={no} width="min(420px, 92vw)">
      <div className="hint" style={{ fontSize: 'var(--fs-sm)' }}>{req?.body}</div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="ghost" onClick={no}>Cancel</Button>
        <Button variant={req?.danger ? 'danger' : 'primary'} onClick={yes}>{req?.confirm}</Button>
      </div>
    </Modal>
  );
}
