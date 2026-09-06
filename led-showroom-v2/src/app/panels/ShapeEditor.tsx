/**
 * 2D custom-shape editor (v1 2350-2920, 2113-2128): a cell grid sized to the bounding box plus
 * one cell of padding on every side. Click toggles, drag paints (mode fixed at drag start),
 * and every edit is normalised before it is written. The on-model ghost panels come from the
 * engine's ShapeTool.
 */
import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useEngine } from '@/app/store';
import { Button } from '@/app/components/Button';
import type { LedWallEntity } from '@/engine/document/types';
import {
  cellKey, classifyShapeEdit, filledCells, ghostCells, normalizeShape, paintShapeCell, pruneCorners, shapeBBox, toggleShapeCell, wallDims,
} from '@/engine/ledwall/layout';
import { reclampWindows } from '@/app/panels/contentActions';

interface Props { wall: LedWallEntity }

const PAD = 1;

export function ShapeEditor({ wall }: Props) {
  const engine = useEngine();
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<'add' | 'remove' | null>(null);

  useEffect(() => {
    const up = () => { if (drag.current) { drag.current = null; engine.history.commit(); } };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [engine]);

  const cells = filledCells(wall);
  const bbox = shapeBBox(cells);
  const ghosts = new Set(ghostCells(cells));
  const gridCols = Math.max(1, bbox.cols) + 2 * PAD;
  const gridRows = Math.max(1, bbox.rows) + 2 * PAD;

  /** Write a new cell set: normalise, update cols/rows, prune corners, re-clamp content windows. */
  const commitCells = (next: Set<string>, merge: boolean) => {
    const n = normalizeShape(next);
    engine.update<LedWallEntity>(wall.id, w => {
      const patched: LedWallEntity = { ...w, shape: { mode: 'custom', cells: Array.from(n.cells) }, cols: n.cols, rows: n.rows, corners: pruneCorners(n.cols, w.corners) };
      return { ...patched, contentWindows: reclampWindows(w.contentWindows, wallDims(patched)) };
    }, { label: 'Edit shape', mergeKey: merge ? `shape:${wall.id}` : undefined });
  };

  /** Always read the live cell set: several paint events can land before React re-renders. */
  const liveCells = () => { const w = engine.entity<LedWallEntity>(wall.id); return w ? filledCells(w) : cells; };

  const onDown = (key: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const cur = liveCells();
    const action = classifyShapeEdit(cur, key);
    drag.current = action === 'add' || action === 'remove' ? action : null;
    const next = toggleShapeCell(cur, key);
    if (next) commitCells(next, true);
  };
  const onEnter = (key: string) => (e: React.PointerEvent) => {
    setHover(key);
    if (!drag.current || !(e.buttons & 1)) return;
    const next = paintShapeCell(liveCells(), key, drag.current);
    if (next) commitCells(next, true);
  };
  /** Keyboard toggle (Enter / Space): a discrete edit, one undo entry. */
  const onKey = (key: string) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    const next = toggleShapeCell(liveCells(), key);
    if (next) commitCells(next, false);
  };

  const rows: React.ReactNode[] = [];
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const col = c - PAD;
      const row = r - PAD;
      const key = cellKey(col, row);
      const on = cells.has(key);
      const ghost = !on && ghosts.has(key);
      let cls = 'shape-cell';
      if (on) cls += ' on';
      else if (ghost) cls += ' ghost';
      if (hover === key) {
        const action = classifyShapeEdit(cells, key);
        if (action !== 'add' && action !== 'remove') cls += ' bad';
      }
      rows.push(
        <div key={key} className={cls} data-cell={key}
          role="button" tabIndex={on || ghost ? 0 : -1} aria-pressed={on}
          aria-label={`Panel column ${col + 1}, row ${row + 1}`}
          onPointerDown={onDown(key)} onPointerEnter={onEnter(key)} onPointerLeave={() => setHover(h => (h === key ? null : h))}
          onFocus={() => setHover(key)} onBlur={() => setHover(h => (h === key ? null : h))} onKeyDown={onKey(key)} />,
      );
    }
  }

  const hoverAction = hover ? classifyShapeEdit(cells, hover) : null;
  const hoverHint = hoverAction === 'add' ? 'Add panel'
    : hoverAction === 'remove' ? 'Remove panel'
      : hoverAction === 'no-adjacent' ? 'Panels must touch the wall'
        : hoverAction === 'would-split' ? 'Removing this would split the wall'
          : hoverAction === 'last-cell' ? 'A wall needs at least one panel'
            : 'Click to add or remove · drag to paint';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="shape-grid" style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)`, touchAction: 'none' }} onPointerLeave={() => setHover(null)}>
        {rows}
      </div>
      <div className="row">
        <span className="hint num grow">{bbox.cols} × {bbox.rows} bounding box · {cells.size} panel{cells.size === 1 ? '' : 's'}</span>
        <Button size="sm" icon={<Check size={14} strokeWidth={1.5} />} onClick={() => engine.tools.activate('select')}>Done</Button>
      </div>
      <div className="hint">{hoverHint}</div>
    </div>
  );
}
