/**
 * LED wall inspector (v1 sidebar 1598-1662 and 1954-2046): panel grid, shape, product, stats,
 * corners, display options, brightness and the content windows.
 */
import { Minus, PencilRuler, Plus } from 'lucide-react';
import { useEngine, useStore } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { NumberField } from '@/app/components/NumberField';
import { Prop, Section, Stat } from '@/app/components/Section';
import { Segmented } from '@/app/components/Segmented';
import { Select } from '@/app/components/Select';
import { Slider } from '@/app/components/Slider';
import { ToggleRow } from '@/app/components/Toggle';
import type { LedWallEntity } from '@/engine/document/types';
import { LIMITS, PANEL_SPECS, brightnessToNits } from '@/engine/ledwall/specs';
import { cellKey, filledCells, filledCount, isRectWall, pruneCorners, shapeBBox, wallDims } from '@/engine/ledwall/layout';
import { GRID_THRESHOLD_OPTIONS_IN } from '@/engine/ledwall/pixelGrid';
import { formatDims } from '@/engine/units';
import { walls as docWalls } from '@/engine/document/Document';
import { cmdUpdateEntities } from '@/engine/commands/entity';
import { TransformSection } from '@/app/panels/TransformSection';
import { CornersSection } from '@/app/panels/CornersSection';
import { ShapeEditor } from '@/app/panels/ShapeEditor';
import { ContentPanel } from '@/app/panels/ContentPanel';
import { reclampWindows } from '@/app/panels/contentActions';

interface Props { wall: LedWallEntity }

type ShapeMode = 'rect' | 'custom';

const DISPLAY_KEYS = ['bezels', 'doubleSided', 'accessories', 'pixelGrid', 'showDimensions', 'brightness'] as const;

export function LedWallInspector({ wall }: Props) {
  const engine = useEngine();
  const doc = useStore(s => s.doc);
  const tool = useStore(s => s.tool);
  const unit = doc?.settings.units ?? 'in';
  const pixelGridDistIn = doc?.settings.pixelGridDistIn ?? 72;
  const wallCount = doc ? docWalls(doc).length : 1;
  const rect = isRectWall(wall);
  const dims = wallDims(wall);
  const bbox = rect ? { cols: wall.cols, rows: wall.rows } : shapeBBox(filledCells(wall));
  const editingShape = tool === 'shape' && !rect;

  /** Resize the grid: prune corners past the last joint (v1 5955-5984) and re-clamp windows. */
  const setGrid = (cols: number, rows: number) => {
    const c = Math.max(1, Math.min(LIMITS.maxCols, Math.round(cols)));
    const r = Math.max(1, Math.min(LIMITS.maxRows, Math.round(rows)));
    if (c === wall.cols && r === wall.rows) return;
    engine.update<LedWallEntity>(wall.id, w => {
      const next: LedWallEntity = { ...w, cols: c, rows: r, corners: pruneCorners(c, w.corners) };
      return { ...next, contentWindows: reclampWindows(w.contentWindows, wallDims(next)) };
    }, { label: c !== wall.cols ? 'Change columns' : 'Change rows' });
  };

  /**
   * Rect → custom seeds every cell; custom → rect keeps the bounding box (v1 switchWallMode
   * 2309-2348). The collapse is destructive — every carved hole or notch is filled back in — so
   * it is announced with the panel count and a pointer at undo (checklist item 10, "warn").
   */
  const setShapeMode = (mode: ShapeMode) => {
    if ((mode === 'rect') === rect) return;
    if (mode === 'rect' && tool === 'shape') engine.tools.activate('select');
    const refilled = mode === 'rect' ? Math.max(0, bbox.cols * bbox.rows - filledCount(wall)) : 0;
    engine.update<LedWallEntity>(wall.id, w => {
      if (mode === 'custom') {
        const cells: string[] = [];
        for (let c = 0; c < w.cols; c++) for (let r = 0; r < w.rows; r++) cells.push(cellKey(c, r));
        return { ...w, shape: { mode: 'custom', cells } };
      }
      const b = shapeBBox(filledCells(w));
      const cols = Math.max(1, b.cols);
      const next: LedWallEntity = { ...w, cols, rows: Math.max(1, b.rows), shape: { mode: 'rect' }, corners: pruneCorners(cols, w.corners) };
      return { ...next, contentWindows: reclampWindows(w.contentWindows, wallDims(next)) };
    }, { label: mode === 'custom' ? 'Custom shape' : 'Rectangular shape' });
    if (refilled > 0) {
      engine.toast('info', `Rectangle mode filled ${refilled} panel${refilled === 1 ? '' : 's'} back in — undo to keep the custom shape`);
    }
  };

  const setProduct = (product: string) => engine.update<LedWallEntity>(wall.id, w => {
    const next: LedWallEntity = { ...w, product };
    return { ...next, contentWindows: reclampWindows(w.contentWindows, wallDims(next)) };
  }, { label: 'Change product' });

  const patch = (p: Partial<LedWallEntity>, label: string, mergeKey?: string) => engine.update<LedWallEntity>(wall.id, p, { label, mergeKey });

  const applyDisplayToAll = () => {
    if (!doc) return;
    const others = docWalls(doc).filter(w => w.id !== wall.id);
    if (!others.length) return;
    const p: Partial<LedWallEntity> = {};
    for (const k of DISPLAY_KEYS) (p as Record<string, unknown>)[k] = wall[k];
    engine.run(cmdUpdateEntities(engine, others.map(w => ({ id: w.id, patch: isRectWall(w) ? p : { ...p, accessories: w.accessories } })), { label: 'Apply display settings to all walls' }));
    engine.toast('success', `Display settings applied to ${others.length} wall${others.length > 1 ? 's' : ''}`);
  };

  const products = Object.values(PANEL_SPECS).map(s => ({ value: s.id, label: s.name }));
  const gridOptions = GRID_THRESHOLD_OPTIONS_IN.map(v => ({ value: v, label: `${v / 12} ft` }));
  const nits = brightnessToNits(wall.brightness, dims.spec);

  const stepper = (label: string, value: number, max: number, set: (v: number) => void) => (
    <Prop label={label}>
      <IconButton size="sm" tip={`Fewer ${label.toLowerCase()}`} disabled={value <= 1} onClick={() => set(value - 1)}><Minus /></IconButton>
      <NumberField value={value} min={1} max={max} step={1} decimals={0} className="grow" onChange={set} />
      <IconButton size="sm" tip={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + 1)}><Plus /></IconButton>
    </Prop>
  );

  return (
    <>
      <TransformSection ids={[wall.id]} />

      <Section title="Panels" id="wall-panels">
        <Prop label="Shape">
          <Segmented<ShapeMode> block className="grow" value={rect ? 'rect' : 'custom'} onChange={setShapeMode}
            options={[{ value: 'rect', label: 'Rectangle' }, { value: 'custom', label: 'Custom shape' }]} />
        </Prop>
        {rect ? (
          <>
            {stepper('Columns', wall.cols, LIMITS.maxCols, v => setGrid(v, wall.rows))}
            {stepper('Rows', wall.rows, LIMITS.maxRows, v => setGrid(wall.cols, v))}
          </>
        ) : (
          <>
            <Stat label="Bounding box" value={`${bbox.cols} × ${bbox.rows} panels`} />
            {!editingShape && (
              <Button block size="sm" icon={<PencilRuler size={14} strokeWidth={1.5} />} onClick={() => engine.tools.activate('shape')} active={tool === 'shape'}>
                Edit shape
              </Button>
            )}
            {editingShape && <ShapeEditor wall={wall} />}
          </>
        )}
        <Prop label="Product">
          <Select value={wall.product} options={products} onChange={setProduct} className="grow" />
        </Prop>
        <div className="divider" />
        <Stat label="Total panels" value={filledCount(wall)} />
        <Stat label="Resolution" value={`${dims.wallWPx} × ${dims.wallHPx} px`} />
        <Stat label="Physical size" value={formatDims([dims.totalW, dims.totalH], unit)} />
        {unit !== 'ft' && <Stat label="Size (ft)" value={formatDims([dims.totalW, dims.totalH], 'ft')} />}
        <Stat label="Pixel pitch" value={dims.spec.pitchMm ? `${dims.spec.pitchMm} mm` : `${(dims.inPerPxX * 25.4).toFixed(2)} mm`} />
      </Section>

      <CornersSection wall={wall} />

      <Section title="Display" id="wall-display">
        <ToggleRow label="Bezels" checked={wall.bezels} onChange={v => patch({ bezels: v }, v ? 'Show bezels' : 'Hide bezels')} hint="Show the seam between panels" />
        <ToggleRow label="Double-sided" checked={wall.doubleSided} onChange={v => patch({ doubleSided: v }, 'Double-sided')} hint="Mirror the content onto the back face" />
        <ToggleRow label="Show base" checked={rect && wall.accessories} disabled={!rect} onChange={v => patch({ accessories: v }, 'Show base')} hint={rect ? 'Floor base plate and back supports, one set per panel column' : 'The base fits rectangular walls only'} />
        <ToggleRow label="Pixel grid" checked={wall.pixelGrid} onChange={v => patch({ pixelGrid: v }, 'Pixel grid')} hint="LED pixel structure, visible up close" />
        {wall.pixelGrid && (
          <Prop label="Appears within" title="Camera distance inside which the pixel grid fades in">
            <Select value={pixelGridDistIn} options={gridOptions} onChange={v => engine.patchSettings({ pixelGridDistIn: v }, 'Pixel grid distance')} className="grow" />
          </Prop>
        )}
        <ToggleRow label="Dimensions" checked={wall.showDimensions} onChange={v => patch({ showDimensions: v }, 'Dimensions')} hint="Engineering-style size annotations" />
        <div className="prop wide" style={{ marginTop: 4 }}>
          <div className="row">
            <span className="k" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-1)' }}>Brightness</span>
            <span className="spacer" />
            <span className="num" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-0)' }}>{Math.round(wall.brightness)} % · {nits} nits</span>
          </div>
          <Slider value={wall.brightness} min={0} max={100} step={1}
            onChange={v => patch({ brightness: v }, 'Brightness', `brightness:${wall.id}`)} onCommit={() => engine.history.commit()} />
        </div>
        <Button block size="sm" onClick={applyDisplayToAll} disabled={wallCount < 2}>Apply display settings to all walls</Button>
      </Section>

      <ContentPanel wall={wall} />
    </>
  );
}
