/**
 * Left dock: a Catalog / Objects tab strip bound to `store.leftTab`, with the active panel below.
 * Rendered before the engine attaches, so the body waits for it.
 */
import { useStore, type LeftTab } from '@/app/store';
import { Catalog, useCatalogDropListener } from '@/app/panels/Catalog';
import { Outliner } from '@/app/panels/Outliner';

const TABS: { id: LeftTab; label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'outliner', label: 'Objects' },
];

export function LeftDock() {
  const engine = useStore(s => s.engine);
  const doc = useStore(s => s.doc);
  const tab = useStore(s => s.leftTab);
  const setLeftTab = useStore(s => s.setLeftTab);
  const count = doc?.entities.length ?? 0;
  useCatalogDropListener(engine);

  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setLeftTab(t.id)}>
            {t.label}
            {t.id === 'outliner' && count > 0 && <span className="num" style={{ marginLeft: 6, color: 'var(--fg-3)' }}>{count}</span>}
          </button>
        ))}
      </div>
      {engine && doc && (tab === 'catalog' ? <Catalog /> : <Outliner />)}
    </>
  );
}
