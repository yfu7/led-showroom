/**
 * Build list: what the scene asks the warehouse to pull.
 *
 * The arithmetic is all in `engine/build/buildList` — this file only lays it out. Two views, per
 * the house rule: the standard one is the pull sheet (cabinets, crates, hardware, and the notes
 * that stop someone trusting a number further than it goes), and God mode adds the per-column
 * working the counts come from, including the panel figure the standard view deliberately omits.
 */
import { useMemo, useState } from 'react';
import { ClipboardCheck, Copy } from 'lucide-react';
import { useDoc, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import { Modal } from '@/app/components/Modal';
import { Prop, Section } from '@/app/components/Section';
import { GodOnly, Raw } from '@/app/shell/GodMode';
import {
  CABINET_PANELS, CABINETS_PER_CRATE, CUT_LABELS, CUT_ORDER, PLATES_PER_SET, SUPPORTS_PER_SET,
  buildList, buildListText, type CutKind,
} from '@/engine/build/buildList';
import { formatDims } from '@/engine/units';

export function BuildListDialog({ onClose }: { onClose(): void }) {
  const doc = useDoc();
  const unit = doc.settings.units;
  const engine = useStore(s => s.engine);
  const [copied, setCopied] = useState(false);

  const list = useMemo(() => buildList(doc), [doc]);
  const text = useMemo(() => buildListText(list, unit, doc.name || undefined), [list, unit, doc.name]);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
      () => engine?.toast('error', 'The browser would not give the clipboard — select the text and copy it.'),
    );
  };

  const cuts = CUT_ORDER.filter(k => list.byCut[k].powered + list.byCut[k].regular > 0);
  const empty = !list.cabinets && !list.equipment.length;

  return (
    <Modal open title="Build list" onClose={onClose} width="min(560px, 94vw)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {empty && <div className="hint">Nothing in the scene to pull. Add a wall or some hardware and open this again.</div>}

        {!!list.cabinets && (
          <Section title="Cabinets" id="bl-cabinets">
            <Prop label="Total">{list.cabinets}</Prop>
            <Prop label="Powered" title="One per column, of that column's own cut.">{list.powered}</Prop>
            <Prop label="Regular">{list.regular}</Prop>
            {cuts.length > 1 && cuts.map(k => (
              <Prop key={k} label={CUT_LABELS[k as CutKind]}>
                {list.byCut[k].powered + list.byCut[k].regular}
                <span className="muted"> ({list.byCut[k].powered} powered)</span>
              </Prop>
            ))}
            {!!list.fleetCabinets && (
              <Prop label="Crates" title={`${CABINETS_PER_CRATE} cabinets to a crate, pooled over the whole scene.`}>
                {list.crates}
              </Prop>
            )}
            {!!list.accessorySets && (
              <Prop label="Accessories">
                {list.accessorySets * PLATES_PER_SET} base plates, {list.accessorySets * SUPPORTS_PER_SET} back supports
              </Prop>
            )}
            <GodOnly>
              <Raw label="LED panels" value={`${list.panels} (${CABINET_PANELS} to a cabinet — pull cabinets, not panels)`} />
            </GodOnly>
          </Section>
        )}

        {list.walls.length > 0 && (
          <Section title={list.walls.length === 1 ? 'Wall' : `Walls (${list.walls.length})`} id="bl-walls">
            {list.walls.map(w => (
              <div key={w.id}>
                <Prop label={w.name} wide>
                  {w.cols} × {w.rows}{w.sides === 2 ? ', double-sided' : ''} — {w.cabinets} cabinets
                  <span className="muted"> ({w.total.powered} powered + {w.total.regular} regular)</span>
                </Prop>
                <GodOnly>
                  <Raw
                    label="columns"
                    value={w.columns.map(c => {
                      const ang = [c.leftDeg, c.rightDeg].filter(d => d !== null).map(d => `${d}°`).join('/');
                      return `${c.col}:${c.cells}${c.cut === 'flat' ? '' : ` ${c.cut}${ang ? ` ${ang}` : ''}`}`;
                    }).join('  ')}
                  />
                  <Raw label="product" value={`${w.product} — ${w.productName}${w.fleet ? '' : ' (not the fleet cabinet)'}`} />
                </GodOnly>
              </div>
            ))}
          </Section>
        )}

        {list.equipment.length > 0 && (
          <Section title="Hardware" id="bl-hardware">
            {list.equipment.map(e => (
              <Prop key={`${e.catalogId}-${e.dims.join()}`} label={`${e.qty} × ${e.name}`} wide>
                <span className="muted">{formatDims(e.dims, unit)}</span>
                {e.short > 0 && <strong style={{ color: 'var(--warn)' }}> — {e.short} more than we own ({e.owned} owned)</strong>}
              </Prop>
            ))}
          </Section>
        )}

        {list.notes.length > 0 && (
          <Section title={list.notes.length === 1 ? 'Note' : `Notes (${list.notes.length})`} id="bl-notes">
            {list.notes.map(n => <div className="hint" key={n}>{n}</div>)}
          </Section>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 8 }}>
          {!empty && (
            <Button
              icon={copied ? <ClipboardCheck size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy as text'}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
