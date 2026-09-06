/**
 * Content windows for one LED wall (v1 1662-1803, 5473-5740, 6035-6398): the window list,
 * the source picker (image / video / website / pattern), the layout controls (fit mode,
 * custom rect in px / panels / %, aspect lock, quick align) and the per-window opacity.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Film, Globe, Grid2x2, Image, Loader, Lock, LockOpen, Palette, Plus, SquareDashed, X } from 'lucide-react';
import { isWindowLoading, useEngine, useStore } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { useContextMenu } from '@/app/components/ContextMenu';
import { RENAME_WINDOW_EVENT, buildWindowMenu, type RenameWindowDetail } from '@/app/menus/entityMenu';
import { DropZone } from '@/app/components/DropZone';
import { NumberField } from '@/app/components/NumberField';
import { Prop, Section, Stat } from '@/app/components/Section';
import { Segmented } from '@/app/components/Segmented';
import { Select } from '@/app/components/Select';
import { Slider } from '@/app/components/Slider';
import { ToggleRow } from '@/app/components/Toggle';
import type { ContentFitMode, ContentSource, LedWallEntity, PxRect } from '@/engine/document/types';
import { LIMITS } from '@/engine/ledwall/specs';
import { filledCount, wallDims } from '@/engine/ledwall/layout';
import {
  ALIGN_KEYS, activeAlign, lockedAspectRatio, pxToUnit, rectCoverage, rectInches, spanInfo, unitStep, unitToPx, type AlignKey, type CwUnit,
} from '@/engine/ledwall/contentWindows';
import { PATTERNS, type PatternKind } from '@/engine/content/generators';
import { formatDims } from '@/engine/units';
import { walls as docWalls } from '@/engine/document/Document';
import {
  addWindow, alignWindow, clearWindowSource, removeWindow, renameWindow, setPatternSource, setWebsiteSource, setWindowAspectLock,
  setWindowMode, setWindowOpacity, setWindowRectField, setWindowSource, setWindowVisible,
} from '@/app/panels/contentActions';

interface Props { wall: LedWallEntity }

type SourceTab = 'image' | 'video' | 'website' | 'pattern';

const V1_SOLID_DEFAULT = '#3b82f6';
const IMAGE_ACCEPT = 'image/*';
const VIDEO_ACCEPT = 'video/mp4,video/webm,video/ogg,.mp4,.webm,.ogv,.mov';

const ALIGN_LABELS: Record<AlignKey, string> = {
  tl: 'Align top left', tc: 'Align top centre', tr: 'Align top right',
  ml: 'Align middle left', mc: 'Align centre', mr: 'Align middle right',
  bl: 'Align bottom left', bc: 'Align bottom centre', br: 'Align bottom right',
};

const tabForSource = (s: ContentSource | null): SourceTab | null =>
  !s ? null : s.type === 'color' || s.type === 'test-pattern' ? 'pattern' : s.type;

function SourceIcon({ source }: { source: ContentSource | null }) {
  const p = { className: 'icon', size: 14, strokeWidth: 1.5 };
  switch (source?.type) {
    case 'image': return <Image {...p} />;
    case 'video': return <Film {...p} />;
    case 'website': return <Globe {...p} />;
    case 'color': return <Palette {...p} />;
    case 'test-pattern': return <Grid2x2 {...p} />;
    default: return <SquareDashed {...p} />;
  }
}

const sourceLabel = (s: ContentSource | null): string => {
  if (!s) return 'No content';
  if (s.type === 'color') return `Solid ${s.color ?? ''}`.trim();
  if (s.type === 'test-pattern') return PATTERNS.find(p => p.id === s.name)?.name ?? 'Test pattern';
  return s.name ?? s.url ?? s.type;
};

export function ContentPanel({ wall }: Props) {
  const engine = useEngine();
  const doc = useStore(s => s.doc);
  const loading = useStore(s => s.loading);
  const selectedId = useStore(s => s.selectedWindowByWall[wall.id] ?? null);
  const selectWindow = useStore(s => s.selectWindow);

  const unit = doc?.settings.units ?? 'in';
  const dims = wallDims(wall);
  const windows = wall.contentWindows;
  const win = windows.find(w => w.id === selectedId) ?? windows[0];
  const allWalls = doc ? docWalls(doc) : [wall];
  const spanContent = doc?.settings.spanContent ?? false;

  /* ── UI state ── */
  const [tab, setTab] = useState<SourceTab>('image');
  const [url, setUrl] = useState('');
  const [pattern, setPattern] = useState<PatternKind>('test');
  const [color, setColor] = useState(V1_SOLID_DEFAULT);
  const [cwUnit, setCwUnit] = useState<CwUnit>('px');
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  /** Escape unmounts the input, which fires blur; this flag stops that blur committing the draft. */
  const cancelRename = useRef(false);
  /**
   * Ratio frozen while a window's aspect lock is on. Only `aspectLock` is persisted, so the
   * ratio is seeded lazily from the rect the first time a locked window is edited (remount,
   * reload, preset load, undo) and dropped as soon as the lock is off.
   */
  const lockedRatio = useRef(new Map<string, number>());

  const sourceKey = win ? `${win.id}:${win.source?.type ?? ''}:${win.source?.name ?? ''}` : '';
  useEffect(() => {
    if (!win) return;
    const t = tabForSource(win.source);
    if (t) setTab(t);
    if (win.source?.type === 'website') setUrl(win.source.url ?? '');
    if (win.source?.type === 'test-pattern' || win.source?.type === 'color') {
      setPattern((win.source.name as PatternKind) ?? 'test');
      if (win.source.color) setColor(win.source.color);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  /* ── actions ── */
  const add = () => { const w = addWindow(engine, wall); if (w) selectWindow(wall.id, w.id); };
  const remove = (id: string) => {
    removeWindow(engine, wall.id, id);
    if (selectedId === id) selectWindow(wall.id, windows.find(w => w.id !== id)?.id ?? null);
  };
  const commit = () => engine.history.commit();

  /* ── right-click on a window row (the same menu the viewport shows over its pixels) ── */
  const menu = useContextMenu();
  const openRowMenu = (ev: ReactMouseEvent, id: string, rowName: string) => {
    menu.open(ev, buildWindowMenu(engine, wall, id, {
      onRename: () => setRenaming({ id, text: rowName }),
      onRemoved: removedId => { if (selectedId === removedId) selectWindow(wall.id, windows.find(w => w.id !== removedId)?.id ?? null); },
    }));
  };

  // A rename asked for from the viewport's content menu opens this panel's inline input.
  useEffect(() => {
    const onRename = (ev: Event) => {
      const d = (ev as CustomEvent<RenameWindowDetail>).detail;
      if (!d || d.wallId !== wall.id) return;
      const w = wall.contentWindows.find(x => x.id === d.windowId);
      if (w) setRenaming({ id: w.id, text: w.name });
    };
    window.addEventListener(RENAME_WINDOW_EVENT, onRename);
    return () => window.removeEventListener(RENAME_WINDOW_EVENT, onRename);
  }, [wall]);

  const finishRename = (id: string) => {
    if (!cancelRename.current && renaming?.id === id) renameWindow(engine, wall.id, id, renaming.text);
    cancelRename.current = false;
    setRenaming(null);
  };

  /** The ratio to hold for this window's rect edits, seeded from the rect when the lock is on. */
  const frozenRatio = (): number | undefined => {
    if (!win) return undefined;
    if (!win.aspectLock) { lockedRatio.current.delete(win.id); return undefined; }
    let r = lockedRatio.current.get(win.id);
    if (r === undefined) { r = lockedAspectRatio(win.rect); lockedRatio.current.set(win.id, r); }
    return r;
  };

  const rectField = (field: keyof PxRect, axis: 'x' | 'y') => {
    if (!win) return null;
    const decimals = cwUnit === 'px' ? 0 : cwUnit === 'panels' ? 2 : 1;
    const label = field.toUpperCase();
    return (
      <NumberField value={pxToUnit(win.rect[field], axis, cwUnit, dims)} step={unitStep(cwUnit)} decimals={decimals} min={0}
        scrub={label} unit={cwUnit === 'pct' ? '%' : cwUnit === 'panels' ? 'panels' : 'px'}
        onChange={v => setWindowRectField(engine, wall, win.id, field, unitToPx(v, axis, cwUnit, dims), frozenRatio(), `cw:${win.id}:${field}`)}
        onCommit={commit} />
    );
  };

  const toggleLock = () => {
    if (!win) return;
    const on = !win.aspectLock;
    const ratio = setWindowAspectLock(engine, wall.id, win, on);
    if (on) lockedRatio.current.set(win.id, ratio); else lockedRatio.current.delete(win.id);
  };

  /** Pattern and colour apply directly, as in v1: choosing one replaces the window's source. */
  const applyPattern = (kind: PatternKind, c: string, mergeKey?: string) => { if (win) setPatternSource(engine, wall.id, win.id, kind, c, mergeKey); };

  const inches = win ? rectInches(win.rect, dims) : null;
  const align = win ? activeAlign(win.rect, dims) : null;
  const span = spanContent && allWalls.length >= 2 ? spanInfo(allWalls.map(w => ({ id: w.id, dims: wallDims(w) }))) : null;

  return (
    <>
      <Section title="Content windows" id="content-windows" right={
        <Button size="sm" variant="ghost" icon={<Plus size={14} strokeWidth={1.5} />} onClick={add} disabled={windows.length >= LIMITS.maxContentWindows}>Add window</Button>
      }>
        {windows.length === 0 && <div className="hint">No content windows. Add one to put an image, video, website or test pattern on the wall.</div>}
        <div className="list">
          {windows.map(w => {
            const selected = w.id === win?.id;
            return (
              <div key={w.id} className={`list-row${selected ? ' selected' : ''}${w.visible ? '' : ' muted'}`}
                role="button" tabIndex={0} aria-pressed={selected} aria-label={`${w.name}, ${sourceLabel(w.source)}`}
                onClick={() => selectWindow(wall.id, w.id)} onDoubleClick={() => setRenaming({ id: w.id, text: w.name })}
                onContextMenu={ev => openRowMenu(ev, w.id, w.name)}
                onKeyDown={e => {
                  if (renaming?.id === w.id) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); selectWindow(wall.id, w.id); }
                  else if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); setRenaming({ id: w.id, text: w.name }); }
                }}
                title={sourceLabel(w.source)}>
                <SourceIcon source={w.source} />
                {renaming?.id === w.id ? (
                  <input className="rename" autoFocus value={renaming.text} maxLength={30} aria-label="Window name"
                    onChange={e => setRenaming({ id: w.id, text: e.target.value })}
                    onBlur={() => finishRename(w.id)}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') { cancelRename.current = true; setRenaming(null); }
                    }}
                    onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} />
                ) : <span className="name">{w.name}</span>}
                {isWindowLoading(loading, wall.id, w.id) && w.source && (w.source.type === 'image' || w.source.type === 'video') && <Loader className="icon spin" aria-label="Loading" />}
                <span className="meta">{w.rect.w}×{w.rect.h} px</span>
                <span className="actions">
                  <IconButton size="sm" tip="Remove window" onClick={e => { e.stopPropagation(); remove(w.id); }}><X /></IconButton>
                </span>
              </div>
            );
          })}
        </div>
        {windows.length > 1 && <div className="hint">Later windows are drawn on top.</div>}
        {allWalls.length >= 2 && (
          <>
            <div className="divider" />
            <ToggleRow label="Span content across all walls" checked={spanContent} onChange={v => engine.patchSettings({ spanContent: v }, v ? 'Span content' : 'Stop spanning content')}
              hint="Treat every wall as one contiguous canvas, left to right" />
            {span && (
              <>
                <Stat label="Total panels" value={allWalls.reduce((n, w) => n + filledCount(w), 0)} />
                <Stat label="Resolution" value={`${span.totalWPx} × ${span.maxHPx} px`} />
                <Stat label="Physical size" value={formatDims([allWalls.reduce((n, w) => n + wallDims(w).totalW, 0), Math.max(...allWalls.map(w => wallDims(w).totalH))], unit)} />
                {unit !== 'ft' && <Stat label="Size (ft)" value={formatDims([allWalls.reduce((n, w) => n + wallDims(w).totalW, 0), Math.max(...allWalls.map(w => wallDims(w).totalH))], 'ft')} />}
              </>
            )}
          </>
        )}
      </Section>

      {win && (
        <>
          <Section title="Source" id="content-source">
            <Segmented<SourceTab> block value={tab} onChange={setTab} options={[
              { value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }, { value: 'website', label: 'Website' }, { value: 'pattern', label: 'Pattern' },
            ]} />

            {tab === 'image' && (
              <DropZone accept={IMAGE_ACCEPT} icon={<Image />} label={<>Drop image or <b>browse</b></>} hint="JPG, PNG, WebP, GIF, SVG"
                onFiles={files => void setWindowSource(engine, wall.id, win.id, files[0])} />
            )}
            {tab === 'video' && (
              <DropZone accept={VIDEO_ACCEPT} icon={<Film />} label={<>Drop video or <b>browse</b></>} hint="MP4, WebM, OGG"
                onFiles={files => void setWindowSource(engine, wall.id, win.id, files[0])} />
            )}
            {tab === 'website' && (
              <>
                <div className="row">
                  <div className="field text grow">
                    <input type="url" placeholder="https://example.com" value={url} onChange={e => setUrl(e.target.value)}
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') setWebsiteSource(engine, wall.id, win.id, url); }} />
                  </div>
                  <Button size="sm" onClick={() => setWebsiteSource(engine, wall.id, win.id, url)} disabled={!url.trim()}>Load</Button>
                </div>
                <div className="hint">External sites are loaded via proxy to bypass iframe restrictions.</div>
              </>
            )}
            {tab === 'pattern' && (
              <>
                <Prop label="Pattern">
                  <Select value={pattern} options={PATTERNS.map(p => ({ value: p.id, label: p.name }))} className="grow"
                    onChange={k => { setPattern(k); applyPattern(k, color); }} />
                </Prop>
                {pattern === 'solid' && (
                  <Prop label="Colour">
                    <div className="field color grow">
                      <input type="color" value={color} aria-label="Solid colour"
                        onChange={e => { setColor(e.target.value); applyPattern('solid', e.target.value, `cw:${win.id}:color`); }}
                        onBlur={commit} />
                      <span className="mono" style={{ fontSize: 'var(--fs-xs)' }}>{color}</span>
                    </div>
                  </Prop>
                )}
                <div className="hint">{PATTERNS.find(p => p.id === pattern)?.description}</div>
              </>
            )}

            {win.source && (
              <div className="row" style={{ marginTop: 2 }}>
                <SourceIcon source={win.source} />
                <span className="hint truncate grow" style={{ color: 'var(--fg-1)' }} title={sourceLabel(win.source)}>{sourceLabel(win.source)}</span>
                <Button size="sm" variant="ghost" onClick={() => clearWindowSource(engine, wall.id, win.id)}>Clear</Button>
              </div>
            )}
          </Section>

          <Section title="Layout" id="content-layout">
            <Segmented<ContentFitMode> block value={win.mode} onChange={m => setWindowMode(engine, wall, win.id, m)} options={[
              { value: 'fill', label: 'Stretch fill', title: 'Stretch to the whole wall' },
              { value: 'scaled', label: 'Scaled fill', title: 'Fit inside the wall, keeping the aspect ratio' },
              { value: 'custom', label: 'Custom size', title: 'Free rectangle on the wall' },
            ]} />

            {win.mode === 'custom' && (
              <>
                <Prop label="Units">
                  <Segmented<CwUnit> block className="grow" value={cwUnit} onChange={setCwUnit} options={[
                    { value: 'px', label: 'px' }, { value: 'panels', label: 'Panels' }, { value: 'pct', label: '%' },
                  ]} />
                </Prop>
                {/* The two fields are direct children of the row: the equal-columns rule for a row
                    of numeric fields keys off that adjacency, so a wrapper div would opt out. */}
                <div className="row">
                  {rectField('w', 'x')}
                  <IconButton size="sm" active={win.aspectLock} tip={win.aspectLock ? 'Unlock aspect ratio' : 'Lock aspect ratio'} onClick={toggleLock}>
                    {win.aspectLock ? <Lock /> : <LockOpen />}
                  </IconButton>
                  {rectField('h', 'y')}
                </div>
                <div className="grid-2">
                  {rectField('x', 'x')}
                  {rectField('y', 'y')}
                </div>
                <Prop label="Quick align">
                  <div className="align-grid">
                    {ALIGN_KEYS.map(k => (
                      <button key={k} type="button" data-a={k} className={align === k ? 'on' : ''} aria-label={ALIGN_LABELS[k]} title={ALIGN_LABELS[k]} aria-pressed={align === k}
                        onClick={() => alignWindow(engine, wall, win.id, k)} />
                    ))}
                  </div>
                </Prop>
                <div className="divider" />
                <Stat label="Window px" value={`${win.rect.w} × ${win.rect.h} px`} />
                <Stat label="Physical" value={inches ? formatDims([inches.w, inches.h], unit) : '—'} />
                <Stat label="Coverage" value={`${(rectCoverage(win.rect, dims) * 100).toFixed(1)} %`} />
              </>
            )}

            <div className="divider" />
            <ToggleRow label="Visible" checked={win.visible} onChange={v => setWindowVisible(engine, wall.id, win.id, v)} />
            <div className="prop wide">
              <div className="row">
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-1)' }}>Opacity</span>
                <span className="spacer" />
                <span className="num" style={{ fontSize: 'var(--fs-xs)' }}>{Math.round(win.opacity * 100)} %</span>
              </div>
              <Slider value={Math.round(win.opacity * 100)} min={0} max={100} step={1}
                onChange={v => setWindowOpacity(engine, wall.id, win.id, v)} onCommit={commit} />
            </div>
          </Section>
        </>
      )}
      {menu.node}
    </>
  );
}
