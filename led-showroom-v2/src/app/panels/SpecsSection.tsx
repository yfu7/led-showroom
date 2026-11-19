/**
 * The "Specifications" block that closes every inspector.
 *
 * Inspector order is a contract, not a style choice: **editable fields at the top, computed specs
 * at the bottom**. You change an item where you look at it, and the numbers that follow from the
 * change sit together underneath instead of being scattered between the controls.
 *
 * The rows come from the engine (`entitySpecs` / `sceneSpecs`), so every item type renders the
 * same way and nothing here knows how a number was arrived at.
 */
import { useDoc } from '@/app/store';
import { Section, Stat } from '@/app/components/Section';
import type { Entity } from '@/engine/document/types';
import { entitySpecs, sceneSpecs, type SpecExtras, type SpecRow } from '@/engine/document/specs';

function Rows({ rows }: { rows: SpecRow[] }) {
  if (!rows.length) return <div className="hint">Nothing to report for this object yet.</div>;
  return (
    <>
      {rows.map((r, i) => (
        // Index keys: a catalog item's published `specs` can repeat a label we emit ourselves.
        <Stat key={i} label={r.label}
          value={r.mono ? <span className="mono" style={{ fontSize: 'var(--fs-2xs)' }}>{r.value}</span> : r.value} />
      ))}
    </>
  );
}

/** One item's computed specs. Render this LAST in a type inspector. */
export function SpecsSection({ entity, extras }: { entity: Entity; extras?: SpecExtras }) {
  const doc = useDoc();
  return (
    <Section title="Specifications" id="specs">
      <Rows rows={entitySpecs(entity, doc, doc.settings.units, extras)} />
    </Section>
  );
}

/** The show canvas's own computed specs — what is on it and what the walls add up to. */
export function SceneSpecsSection() {
  const doc = useDoc();
  return (
    <Section title="Specifications" id="scene-specs">
      {doc.entities.length === 0 && <div className="hint">The scene is empty. Drag items in from the catalog to begin.</div>}
      <Rows rows={sceneSpecs(doc, doc.settings.units)} />
    </Section>
  );
}
