/**
 * Catalog dock: a Catalog / Objects tab strip bound to `store.catalogTab`, with the active panel
 * below. Rendered before the engine attaches, so the body waits for it.
 *
 * Which SIDE this sits on is base.css's business (`.dock-catalog`), not this component's.
 */
import { useStore, type CatalogTab } from '@/app/store';
import { Catalog, useCatalogDropListener } from '@/app/panels/Catalog';
import { Outliner } from '@/app/panels/Outliner';

const TABS: { id: CatalogTab; label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'outliner', label: 'Objects' },
];

export function CatalogDock() {
  const engine = useStore(s => s.engine);
  const doc = useStore(s => s.doc);
  const tab = useStore(s => s.catalogTab);
  const setCatalogTab = useStore(s => s.setCatalogTab);
  const count = doc?.entities.length ?? 0;
  useCatalogDropListener(engine);

  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setCatalogTab(t.id)}>
            {t.label}
            {t.id === 'outliner' && count > 0 && <span className="num" style={{ marginLeft: 6, color: 'var(--fg-3)' }}>{count}</span>}
          </button>
        ))}
      </div>
      {engine && doc && (tab === 'catalog' ? <Catalog /> : <Outliner />)}
    </>
  );
}
