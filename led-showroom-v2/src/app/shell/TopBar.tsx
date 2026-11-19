import { useEffect, useRef, useState } from 'react';
import {
  Box, ChevronDown, Eraser, FolderOpen, HardDrive, Image, Import, Maximize, Moon, PanelLeft, PanelRight,
  CircleQuestionMark, Redo2, Ruler, Save, Settings2, ShieldCheck, Sun, Undo2, Video,
} from 'lucide-react';
import { useStore } from '@/app/store';
import { Button, IconButton } from '@/app/components/Button';
import { Menu, type MenuItem } from '@/app/components/Menu';
import { Select } from '@/app/components/Select';
import { ExportGltfDialog, GenerateDrawingDialog, RecordVideoDialog, SaveImageDialog } from '@/app/panels/exportDialogs';
import { SavedBuildsDialog } from '@/app/panels/SavedBuildsDialog';
import { UNITS, type Unit } from '@/engine/units';
import type { Engine } from '@/engine/Engine';
import { importV1Presets } from '@/engine/persistence/presets';
import { exportSceneFile, importSceneFile, downloadBlob, sceneFileName } from '@/engine/persistence/sceneFile';
import { listStoredScenes } from '@/engine/persistence/sceneStore';
import { ClearSceneDialog, requestClearScene } from './ClearSceneDialog';
import { GodPinDialog } from './GodMode';


/** Application header: brand, file menu, scene name, history, units, theme, layout and settings. */
export function TopBar() {
  const engine = useStore(s => s.engine);
  const doc = useStore(s => s.doc);
  const canUndo = useStore(s => s.canUndo);
  const canRedo = useStore(s => s.canRedo);
  const undoLabel = useStore(s => s.undoLabel);
  const redoLabel = useStore(s => s.redoLabel);
  const theme = useStore(s => s.theme);
  const catalogOpen = useStore(s => s.catalogOpen);
  const inspectorOpen = useStore(s => s.inspectorOpen);
  const setCatalogOpen = useStore(s => s.setCatalogOpen);
  const setInspectorOpen = useStore(s => s.setInspectorOpen);
  const setPresentation = useStore(s => s.setPresentation);
  const setShortcutsOpen = useStore(s => s.setShortcutsOpen);
  const godMode = useStore(s => s.godMode);
  const setGodMode = useStore(s => s.setGodMode);
  const setGodPinOpen = useStore(s => s.setGodPinOpen);
  // Kept in the store so a running take is not tied to this header's lifetime.
  const dialog = useStore(s => s.exportDialog);
  const setDialog = useStore(s => s.setExportDialog);
  const [, bump] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeDialog = () => setDialog(null);
  /*
   * The folder the local server saves builds into, or null where there is no such server - on the
   * deploy there is not, and the menu entry hides itself rather than offering a save with nowhere
   * to go. Only a SUCCESS is remembered: the dev server is a separate process, so a page opened
   * before it is up must be able to find it later, which the File menu's onOpen re-probe does.
   */
  const [storeDir, setStoreDir] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void listStoredScenes(ac.signal).then(l => { if (l) setStoreDir(l.dir); });
    return () => ac.abort();
  }, []);
  const probeStore = () => { if (!storeDir) void listStoredScenes().then(l => { if (l) setStoreDir(l.dir); }); };

  if (!engine || !doc) return <header className="topbar"><Brand /></header>;

  /* ───── file actions ───── */
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
    { label: 'Open .showroom.json…', icon: <FolderOpen />, onSelect: openScene },
    { label: 'Save .showroom.json', icon: <Save />, onSelect: saveScene },
    // Only where the local server is running. On the deploy these files have nowhere to live, and
    // an entry that cannot work is worse than no entry at all.
    ...(storeDir ? [{ label: 'Builds on this computer…', icon: <HardDrive />, onSelect: () => setDialog('builds') } as MenuItem] : []),
    'sep',
    { label: 'Import v1 presets', icon: <Import />, onSelect: importPresets },
    'sep',
    { label: 'Save image…', icon: <Image />, onSelect: () => setDialog('image') },
    // Also in the Export panel, but that panel only renders with nothing selected, and a drawing is
    // most often wanted right after laying an item out.
    { label: 'Generate render…', icon: <Ruler />, onSelect: () => setDialog('drawing') },
    { label: 'Record video…', icon: <Video />, onSelect: () => setDialog('video') },
    { label: 'Export glTF…', icon: <Box />, onSelect: () => setDialog('gltf') },
    'sep',
    // Last, behind a separator and its confirm: it used to sit first, one slip above "Open", and
    // wiped the scene with no way back.
    { label: 'Clear scene', icon: <Eraser />, danger: true, onSelect: requestClearScene },
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
    'sep',
    // The only way in or out of the admin view. Leaving needs no PIN: locking someone out of
    // their own standard view would be the wrong way round.
    {
      label: 'Diagnostic view', icon: <ShieldCheck />, checked: godMode,
      onSelect: () => (godMode ? setGodMode(false) : setGodPinOpen(true)),
    },
  ];

  return (
    <header className="topbar">
      <Brand />
      <Menu
        align="left"
        trigger={<Button variant="ghost" size="sm" icon={<ChevronDown style={{ width: 12, height: 12, order: 2 }} />}>File</Button>}
        items={fileItems}
        onOpen={probeStore}
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
      <IconButton tip="Inspector (left)" kbd="Tab" active={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}><PanelLeft /></IconButton>
      <IconButton tip="Catalog (right)" kbd="Tab" active={catalogOpen} onClick={() => setCatalogOpen(!catalogOpen)}><PanelRight /></IconButton>
      <IconButton tip="Presentation mode" kbd="Ctrl+\" onClick={() => setPresentation(true)}><Maximize /></IconButton>
      <IconButton tip="Keyboard shortcuts" kbd="?" onClick={() => setShortcutsOpen(true)}><CircleQuestionMark /></IconButton>
      <Menu
        align="right"
        trigger={<IconButton tip="Settings"><Settings2 /></IconButton>}
        items={settingsItems}
        onOpen={() => bump(t => t + 1)}
        minWidth={220}
      />

      <ClearSceneDialog />
      <GodPinDialog />
      {dialog === 'image' && <SaveImageDialog onClose={closeDialog} />}
      {dialog === 'video' && <RecordVideoDialog onClose={closeDialog} />}
      {dialog === 'gltf' && <ExportGltfDialog onClose={closeDialog} />}
      {dialog === 'drawing' && <GenerateDrawingDialog onClose={closeDialog} />}
      {dialog === 'builds' && <SavedBuildsDialog onClose={closeDialog} />}
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
