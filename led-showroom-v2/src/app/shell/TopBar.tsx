import { useEffect, useRef, useState } from 'react';
import {
  Box, ChevronDown, FilePlus, FolderOpen, Image, Import, Maximize, Moon, PanelLeft, PanelRight,
  CircleQuestionMark, Redo2, Save, Settings2, Sun, Undo2, Video,
} from 'lucide-react';
import { useStore } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { Menu, type MenuItem } from '@/app/components/Menu';
import { Select } from '@/app/components/Select';
import { ExportGltfDialog, RecordVideoDialog, SaveImageDialog } from '@/app/panels/exportDialogs';
import { UNITS, type Unit } from '@/engine/units';
import type { Engine } from '@/engine/Engine';
import { importV1Presets } from '@/engine/persistence/presets';
import { exportSceneFile, importSceneFile, downloadBlob, sceneFileName } from '@/engine/persistence/sceneFile';


/** Application header: brand, file menu, scene name, history, units, theme, layout and settings. */
export function TopBar() {
  const engine = useStore(s => s.engine);
  const doc = useStore(s => s.doc);
  const canUndo = useStore(s => s.canUndo);
  const canRedo = useStore(s => s.canRedo);
  const undoLabel = useStore(s => s.undoLabel);
  const redoLabel = useStore(s => s.redoLabel);
  const theme = useStore(s => s.theme);
  const leftOpen = useStore(s => s.leftOpen);
  const rightOpen = useStore(s => s.rightOpen);
  const setLeftOpen = useStore(s => s.setLeftOpen);
  const setRightOpen = useStore(s => s.setRightOpen);
  const setPresentation = useStore(s => s.setPresentation);
  const setShortcutsOpen = useStore(s => s.setShortcutsOpen);
  // Kept in the store so a running take is not tied to this header's lifetime.
  const dialog = useStore(s => s.exportDialog);
  const setDialog = useStore(s => s.setExportDialog);
  const [, bump] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeDialog = () => setDialog(null);

  if (!engine || !doc) return <header className="topbar"><Brand /></header>;

  /* ───── file actions ───── */
  const newScene = () => { engine.newDocument(); engine.toast('info', 'New scene'); };
  const openScene = () => fileInput.current?.click();
  const onFile = async (file: File) => {
    try {
      const { doc: loaded, missing } = await importSceneFile(file, engine.assets);
      engine.loadDocument(loaded);
      if (missing.length) engine.toast('error', `Opened with ${missing.length} missing asset${missing.length === 1 ? '' : 's'}`);
      else engine.toast('success', `Opened ${loaded.name}`);
    } catch (err) {
      engine.toast('error', `Could not open file: ${(err as Error).message ?? err}`);
    }
  };
  const saveScene = async () => {
    try {
      const snap = engine.snapshot();
      const blob = await exportSceneFile(snap, engine.assets);
      downloadBlob(blob, sceneFileName(snap));
    } catch (err) {
      engine.toast('error', `Could not save: ${(err as Error).message ?? err}`);
    }
  };
  const importPresets = () => {
    const n = importV1Presets(undefined, true);
    engine.toast(n ? 'success' : 'info', n ? `Imported ${n} preset${n === 1 ? '' : 's'} from v1` : 'No v1 presets found');
  };

  const fileItems: MenuItem[] = [
    { label: 'New scene', icon: <FilePlus />, onSelect: newScene },
    { label: 'Open .showroom.json…', icon: <FolderOpen />, onSelect: openScene },
    { label: 'Save .showroom.json', icon: <Save />, onSelect: saveScene },
    'sep',
    { label: 'Import v1 presets', icon: <Import />, onSelect: importPresets },
    'sep',
    { label: 'Save image…', icon: <Image />, onSelect: () => setDialog('image') },
    { label: 'Record video…', icon: <Video />, onSelect: () => setDialog('video') },
    { label: 'Export glTF…', icon: <Box />, onSelect: () => setDialog('gltf') },
  ];

  /* ───── settings ───── */
  const s = engine.settings;
  const set = (fn: () => void) => () => { fn(); bump(t => t + 1); };
  const settingsItems: MenuItem[] = [
    ...(engine.gpuProbe.dualGpu ? [
      { label: 'GPU', header: true } as MenuItem,
      { label: 'Integrated', radio: true, checked: s.gpu === 'low-power', onSelect: set(() => engine.setGpu('low-power')) } as MenuItem,
      { label: 'Discrete', radio: true, checked: s.gpu === 'high-performance', onSelect: set(() => engine.setGpu('high-performance')) } as MenuItem,
      'sep' as MenuItem,
    ] : []),
    { label: 'Render quality', header: true },
    { label: '1×', radio: true, checked: s.qualityScale === 1, onSelect: set(() => engine.setQuality(1)) },
    { label: '1.5×', radio: true, checked: s.qualityScale === 1.5, onSelect: set(() => engine.setQuality(1.5)) },
    { label: '2×', radio: true, checked: s.qualityScale === 2, onSelect: set(() => engine.setQuality(2)) },
    'sep',
    { label: 'Navigation', header: true },
    { label: 'Orbit-first', radio: true, checked: s.navigation === 'orbit', onSelect: set(() => engine.setNavigation('orbit')) },
    { label: 'Pan-first', radio: true, checked: s.navigation === 'pan', onSelect: set(() => engine.setNavigation('pan')) },
    'sep',
    { label: 'Live websites in recordings', checked: s.liveWebsiteInRecordings, onSelect: set(() => engine.setLiveWebsite(!s.liveWebsiteInRecordings)) },
  ];

  return (
    <header className="topbar">
      <Brand />
      <Menu
        align="left"
        trigger={<Button variant="ghost" size="sm" icon={<ChevronDown style={{ width: 12, height: 12, order: 2 }} />}>File</Button>}
        items={fileItems}
      />
      <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
      <SceneName engine={engine} name={doc.name} />
      <IconButton tip={undoLabel ? `Undo ${undoLabel}` : 'Undo'} kbd="Ctrl+Z" disabled={!canUndo} onClick={() => engine.undo()}><Undo2 /></IconButton>
      <IconButton tip={redoLabel ? `Redo ${redoLabel}` : 'Redo'} kbd="Ctrl+Shift+Z" disabled={!canRedo} onClick={() => engine.redo()}><Redo2 /></IconButton>

      <span className="spacer" />

      <Select<Unit>
        value={doc.settings.units}
        options={UNITS.map(u => ({ value: u.id, label: u.label }))}
        onChange={units => engine.patchSettings({ units }, 'Change units')}
        title="Display units" className="units-select"
      />
      <IconButton tip={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => engine.setTheme(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun /> : <Moon />}
      </IconButton>
      <span style={{ width: 1, height: 18, background: 'var(--line-strong)', margin: '0 2px' }} />
      <IconButton tip="Left panel" kbd="Tab" active={leftOpen} onClick={() => setLeftOpen(!leftOpen)}><PanelLeft /></IconButton>
      <IconButton tip="Right panel" kbd="Tab" active={rightOpen} onClick={() => setRightOpen(!rightOpen)}><PanelRight /></IconButton>
      <IconButton tip="Presentation mode" kbd="Ctrl+\" onClick={() => setPresentation(true)}><Maximize /></IconButton>
      <IconButton tip="Keyboard shortcuts" kbd="?" onClick={() => setShortcutsOpen(true)}><CircleQuestionMark /></IconButton>
      <Menu
        align="right"
        trigger={<IconButton tip="Settings"><Settings2 /></IconButton>}
        items={settingsItems}
        onOpen={() => bump(t => t + 1)}
        minWidth={220}
      />

      {dialog === 'image' && <SaveImageDialog onClose={closeDialog} />}
      {dialog === 'video' && <RecordVideoDialog onClose={closeDialog} />}
      {dialog === 'gltf' && <ExportGltfDialog onClose={closeDialog} />}
    </header>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="wordmark">Veloxity <i>Showroom</i></span>
      <span className="ver">v2</span>
    </div>
  );
}

/* ───────── scene name ───────── */

function SceneName({ engine, name }: { engine: Engine; name: string }) {
  const [text, setText] = useState(name);
  const [editing, setEditing] = useState(false);
  // Escape blurs synchronously, so the blur commit would still see the edited `text`; flag the cancel first.
  const cancelled = useRef(false);
  useEffect(() => { if (!editing) setText(name); }, [name, editing]);
  const commit = () => {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; setText(name); return; }
    const next = text.trim();
    if (!next) { setText(name); return; }
    if (next !== name) engine.patchDocument({ name: next }, { label: 'Rename scene' });
  };
  return (
    <div className="scene-name">
      <input
        value={text} spellCheck={false} aria-label="Scene name" title="Scene name"
        onFocus={e => { setEditing(true); e.target.select(); }}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') { cancelled.current = true; (e.target as HTMLInputElement).blur(); }
        }}
      />
    </div>
  );
}
