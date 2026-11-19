/**
 * Inspector dock: head (entity name or "Inspector") + the routed inspector body.
 * Which SIDE this sits on is base.css's business (`.dock-inspector`), not this component's.
 */
import { PanelLeftClose } from 'lucide-react';
import { usePrimarySelection, useStore } from '@/app/store';
import { IconButton } from '@/app/components/Button';
import { Inspector, TYPE_LABELS } from '@/app/panels/Inspector';

export function InspectorDock() {
  const selection = useStore(s => s.selection);
  const primary = usePrimarySelection();
  const setInspectorOpen = useStore(s => s.setInspectorOpen);
  const title = selection.length > 1 ? `${selection.length} objects` : primary?.name ?? 'Inspector';
  const sub = selection.length === 1 && primary ? TYPE_LABELS[primary.type] : selection.length === 0 ? 'Scene' : null;
  return (
    <>
      <div className="panel-head">
        <span className="panel-title truncate">{title}</span>
        {sub && <span className="label">{sub}</span>}
        <span className="spacer" />
        <IconButton size="sm" tip="Hide inspector" onClick={() => setInspectorOpen(false)}><PanelLeftClose /></IconButton>
      </div>
      <div className="panel-body">
        <Inspector />
      </div>
    </>
  );
}
