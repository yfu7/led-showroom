/**
 * Corners: folds between columns (v1 5905-6032). One corner per joint, angle −270…90° in 5°
 * steps. Rectangular walls only — custom shapes cannot fold.
 */
import { Plus, X } from 'lucide-react';
import { useEngine } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { NumberField } from '@/app/components/NumberField';
import { Section } from '@/app/components/Section';
import { Select } from '@/app/components/Select';
import type { Corner, LedWallEntity } from '@/engine/document/types';
import { isRectWall } from '@/engine/ledwall/layout';

interface Props { wall: LedWallEntity }

export function CornersSection({ wall }: Props) {
  const engine = useEngine();
  const rect = isRectWall(wall);
  const joints = Math.max(0, wall.cols - 1);
  const used = new Set(wall.corners.map(c => c.afterCol));
  let free = 0;
  while (used.has(free) && free < joints) free++;
  const canAdd = rect && free < joints;

  const write = (corners: Corner[], label: string, mergeKey?: string) => engine.update<LedWallEntity>(wall.id, { corners }, { label, mergeKey });

  const add = () => {
    if (!canAdd) return;
    write([...wall.corners, { afterCol: free, angle: 90 }], 'Add corner');
  };
  const setCol = (idx: number, afterCol: number) => {
    if (wall.corners.some((c, i) => i !== idx && c.afterCol === afterCol)) return;
    write(wall.corners.map((c, i) => (i === idx ? { ...c, afterCol } : c)), 'Move corner');
  };
  const setAngle = (idx: number, angle: number) => {
    const a = Math.max(-270, Math.min(90, angle));
    write(wall.corners.map((c, i) => (i === idx ? { ...c, angle: a } : c)), 'Change corner angle', `corner:${wall.id}:${idx}`);
  };
  const remove = (idx: number) => write(wall.corners.filter((_, i) => i !== idx), 'Remove corner');

  const sorted = wall.corners.map((c, i) => ({ c, i })).sort((a, b) => a.c.afterCol - b.c.afterCol);

  return (
    <Section title="Corners" id="corners" right={
      <Button size="sm" variant="ghost" icon={<Plus size={14} strokeWidth={1.5} />} onClick={add} disabled={!canAdd}>Add corner</Button>
    }>
      {!rect && <div className="hint">Corners are available for rectangular walls. Switch the shape back to Rectangle to fold this wall.</div>}
      {rect && joints === 0 && <div className="hint">Add a second column to fold the wall.</div>}
      {rect && wall.corners.length === 0 && joints > 0 && <div className="hint">A flat wall. Add a corner to fold it between two columns.</div>}
      {rect && sorted.map(({ c, i }) => {
        const options = [];
        for (let j = 0; j < joints; j++) if (!used.has(j) || j === c.afterCol) options.push({ value: j, label: String(j + 1) });
        return (
          <div className="row" key={i}>
            <span className="hint" style={{ whiteSpace: 'nowrap' }}>After column</span>
            <Select value={c.afterCol} options={options} onChange={v => setCol(i, v)} className="grow" title="Fold after this column" />
            <NumberField value={c.angle} min={-270} max={90} step={5} decimals={0} unit="°" scrub="∠" className="grow"
              onChange={v => setAngle(i, v)} onCommit={() => engine.history.commit()} title="Positive folds forward (convex), negative folds back" />
            <IconButton size="sm" tip="Remove corner" onClick={() => remove(i)}><X /></IconButton>
          </div>
        );
      })}
    </Section>
  );
}
