/**
 * The wall's truss: Auto truss and a way into the builder, and while the builder is on, its panel.
 * The panel is the stock to build with, what the piece in hand would do where the pointer is, and
 * what the rig comes to, with Auto truss to plan it whole and go on by hand from there. The
 * engine's TrussBuildTool does the work; this only reads its state.
 */
import { useSyncExternalStore, type MouseEvent } from 'react';
import { Check, Construction, Hammer, MoveHorizontal } from 'lucide-react';
import { useEngine, useStore } from '@/app/store';
import { Button } from '@/app/components/Button';
import { Section } from '@/app/components/Section';
import { GodOnly, Raw } from '@/app/shell/GodMode';
import type { LedWallEntity } from '@/engine/document/types';
import { pieceName, stockLeft } from '@/engine/ledwall/trussBuilder';
import { EMPTY_TRUSS_STATE, type TrussBuildTool } from '@/engine/tools/TrussBuildTool';
import { autoTruss, autoTrussLabel, autoTrussReport } from '@/app/panels/trussActions';

interface Props { wall: LedWallEntity }

const noSubscribe = () => () => {};
const emptyState = () => EMPTY_TRUSS_STATE;
/** Buttons here must not take the focus: the builder's keys only reach it from the viewport. */
const keepFocus = (e: MouseEvent) => e.preventDefault();
const f3 = (v: number): string => v.toFixed(3);
const xyz = (v: readonly number[]): string => v.map(f3).join(', ');
const AUTO_TIP = 'Plan the whole rig from the DT-GP stock and put it up piece by piece, to go on with by hand';

export function TrussSection({ wall }: Props) {
  const engine = useEngine();
  const tool = useStore(s => s.tool);
  return (
    <Section title="Truss" id="wall-truss">
      {tool === 'truss' ? <TrussBuilder wall={wall} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <Button block size="sm" icon={<Construction size={14} strokeWidth={1.5} />} tip={AUTO_TIP} onClick={() => autoTruss(engine, wall)}>
            {autoTrussLabel(engine, wall)}
          </Button>
          <Button block size="sm" icon={<Hammer size={14} strokeWidth={1.5} />} kbd="Shift+T"
            tip="Put the rig up piece by piece from the DT-GP stock" onClick={() => engine.tools.activate('truss')}>
            Build truss
          </Button>
        </div>
      )}
      <GodOnly><AutoTrussRaw wall={wall} /></GodOnly>
    </Section>
  );
}

/** The last Auto truss on this wall, planned against put up. */
function AutoTrussRaw({ wall }: Props) {
  const r = useSyncExternalStore(autoTrussReport.subscribe, autoTrussReport.get);
  if (!r || r.wallId !== wall.id) return <Raw label="auto truss" value="not run on this wall" />;
  if (r.fail) return <Raw label="auto truss" value={`failed in ${r.ms.toFixed(0)} ms: ${r.fail}`} />;
  return <>
    <Raw label="auto legs / spans / clamps" value={`plan ${r.planned.join(' / ')} → up ${r.built.join(' / ')} (${r.ms.toFixed(0)} ms)`} />
    <Raw label="auto shim / held / supported" value={`plan ${f3(r.shim[0])} / ${r.held[0]} / ${r.supported[0]} → up ${f3(r.shim[1])} / ${r.held[1]} / ${r.supported[1]} of ${r.columns}`} />
    <Raw label="auto F-filled / kept / refused" value={`${r.filled} / ${r.kept} / ${r.refused.length}`} />
    {r.refused.map(x => <Raw key={x} label="refused" value={x} />)}
  </>;
}

function TrussBuilder({ wall }: Props) {
  const engine = useEngine();
  const t = engine.tools.get('truss') as TrussBuildTool | undefined;
  const st = useSyncExternalStore(t?.subscribe ?? noSubscribe, t?.getState ?? emptyState);
  const b = st.builder, sum = st.summary;
  if (!t || !b || !sum || st.wallId !== wall.id) return <div className="hint">Opening the builder…</div>;

  const item = b.palette[st.sel];
  const h = st.hover;
  const c = sum.coupling;
  const left = (i: typeof item) => stockLeft(i, b.pieces);
  const status = h
    ? h.why.length
      ? { color: 'var(--danger)', text: h.why[0] }
      : {
        color: 'var(--success)',
        text: `Click to put up the ${pieceName(h.cand)}${item.buy ? ', drawn as a ghost: it is to buy' : left(item) <= 0 ? ', drawn as a ghost: none left' : ''}.`,
      }
    : { color: 'var(--fg-2)', text: st.note ?? 'Point at the rig, or at the floor behind the cabinets.' };

  return (
    <>
      <div role="radiogroup" aria-label="Piece in hand" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {b.palette.map((it, i) => {
          const n = left(it);
          const count = it.buy ? 'to buy' : Number.isFinite(it.owned) ? (n > 0 ? `${n} left` : 'none left') : '';
          const short = it.buy || n <= 0;
          return (
            <Button key={it.catalogId} size="sm" role="radio" aria-checked={st.sel === i} active={st.sel === i}
              tip={it.name} kbd={String(i + 1)} onMouseDown={keepFocus} onClick={() => t.choose(i)}>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.2 }}>
                <span>{it.label}</span>
                {count && <span style={{ fontSize: 'var(--fs-2xs)', color: short ? 'var(--warn)' : 'var(--fg-2)' }}>{count}</span>}
              </span>
            </Button>
          );
        })}
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: status.color, margin: '8px 0 4px' }} aria-live="polite">{status.text}</div>

      {st.gap && (
        <Button block size="sm" icon={<MoveHorizontal size={14} strokeWidth={1.5} />} kbd="F" tip="Sticks that close it exactly, from the stock on hand first"
          onMouseDown={keepFocus} onClick={() => t.fill()}>
          Fill the {+(st.gap.len / 12).toFixed(2)} ft gap
        </Button>
      )}

      <div className="hint" style={{ marginTop: 6 }}>
        {b.pieces.length
          ? `${b.pieces.length} ${b.pieces.length === 1 ? 'piece' : 'pieces'} · ${c.clamps.length} couplers · ${c.supported.size} of ${sum.columns} columns held`
          : 'No rig yet.'}
        {c.shim > 1e-6 && ` · wall on a ${c.shim.toFixed(3)} in shim`}
      </div>
      {sum.warnings.map(w => <div className="hint" key={w} style={{ color: 'var(--warn)' }}>{w}</div>)}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 8 }}>
        <Button block size="sm" icon={<Construction size={14} strokeWidth={1.5} />} tip={AUTO_TIP}
          onMouseDown={keepFocus} onClick={() => autoTruss(engine, b.wall)}>
          {autoTrussLabel(engine, wall)}
        </Button>
        <Button block size="sm" icon={<Check size={14} strokeWidth={1.5} />} kbd="Esc" onClick={() => engine.tools.activate('select')}>
          Done
        </Button>
      </div>

      <GodOnly>
        <Raw label="rig" value={`${b.group?.id ?? 'none'} · ${b.hand ? 'by hand' : b.group ? 'Auto truss' : 'new'}`} />
        <Raw label="depth / co / section" value={`${f3(b.ctx.depth)} / ${f3(b.ctx.co)} / ${f3(b.ctx.section)} in`} />
        <Raw label="supportY / plateTop" value={`${f3(b.ctx.supportY)} / ${f3(b.ctx.plateTop)}`} />
        <Raw label="bottom now → coupled" value={`${f3(b.currentBottom)} → ${f3(c.bottomY)} (shim ${f3(c.shim)})`} />
        <Raw label="held / supported" value={`${c.held.size} / ${c.supported.size} of ${sum.columns}`} />
        <Raw label="clamps / welds / ghosts" value={`${c.clamps.length} / ${c.welds} / ${sum.ghosts}`} />
        <Raw label="bared" value={c.bared.size ? [...c.bared].map(([i, why]) => `#${i} ${why}`).join(' · ') : 'none'} />
        <Raw label="stock" value={b.palette.map(i => `${i.label} ${Number.isFinite(i.owned) ? i.owned : '∞'}-${i.elsewhere}-${b.pieces.filter(p => p.catalogId === i.catalogId).length}`).join(' · ')} />
        <Raw label="long spans" value={sum.long.length ? sum.long.map(l => `${f3(l)} in`).join(', ') : 'none'} />
        {h && <>
          <Raw label="cand" value={`${h.cand.catalogId} ${h.cand.vertical ? 'upright' : 'along'} @ ${xyz(h.cand.position)} yaw ${f3(h.cand.yaw * 180 / Math.PI)}°`} />
          <Raw label="port" value={h.port ? `#${h.port.piece} ${xyz(h.port.point.toArray())} dir ${xyz(h.port.dir.toArray())}` : 'floor'} />
          <Raw label="verdict" value={h.why.length ? h.why.join(' · ') : 'ok'} />
        </>}
        {st.gap && <Raw label="gap" value={`#${st.gap.port.piece} ${f3(st.gap.len)} in`} />}
      </GodOnly>
    </>
  );
}
