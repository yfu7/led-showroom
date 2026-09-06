/** Right dock: inspector head (entity name or "Inspector") + the routed inspector body. */
import { PanelRightClose } from 'lucide-react';
import { usePrimarySelection, useStore } from '@/app/store';
import { IconButton } from '@/app/components/Button';
import { Inspector, TYPE_LABELS } from '@/app/panels/Inspector';

export function RightDock() {
  const selection = useStore(s => s.selection);
  const primary = usePrimarySelection();
  const setRightOpen = useStore(s => s.setRightOpen);
  const title = selection.length > 1 ? `${selection.length} objects` : primary?.name ?? 'Inspector';
  const sub = selection.length === 1 && primary ? TYPE_LABELS[primary.type] : selection.length === 0 ? 'Scene' : null;
  return (
    <>
      <div className="panel-head">
        <span className="panel-title truncate">{title}</span>
        {sub && <span className="label">{sub}</span>}
        <span className="spacer" />
        <IconButton size="sm" tip="Hide inspector" onClick={() => setRightOpen(false)}><PanelRightClose /></IconButton>
      </div>
      <div className="panel-body">
        <Inspector />
      </div>
    </>
  );
}
