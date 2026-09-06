/**
 * Zustand store mirroring engine state for React. The engine is the source of truth; the store
 * is a read model plus UI-only state (panel layout, active inspector tab, dialogs).
 */
import { create } from 'zustand';
import type { Document, Entity } from '@/engine/document/types';
import type { Engine } from '@/engine/Engine';
import type { ToolId } from '@/engine/tools/Tool';
import type { Projection } from '@/engine/scene/CameraRig';

export type LeftTab = 'catalog' | 'outliner';
export type Theme = 'dark' | 'light';
/**
 * The open export dialog. Held in the store, not in a panel, so a running video take survives the
 * Export panel unmounting (selecting an object swaps the inspector) — the app stays live while
 * recording, so that happens constantly.
 */
export type ExportDialog = 'image' | 'video' | 'gltf' | null;

export interface Toast { id: number; kind: 'info' | 'error' | 'success'; message: string }

export interface UiState {
  engine: Engine | null;
  doc: Document | null;
  selection: string[];
  hovered: string | null;
  tool: ToolId | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  projection: Projection;
  flyMode: boolean;
  viewLocked: boolean;
  /** Mirror of `Engine.loading`: entity id → the set of in-flight load keys for that entity. */
  loading: ReadonlyMap<string, ReadonlySet<string>>;
  theme: Theme;
  toasts: Toast[];
  /** UI-only */
  leftTab: LeftTab;
  leftOpen: boolean;
  rightOpen: boolean;
  presentation: boolean;
  shortcutsOpen: boolean;
  exportDialog: ExportDialog;
  catalogQuery: string;
  selectedWindowByWall: Record<string, string | null>;
  /** Camera distance to the primary selection's front face (in), updated per frame. */
  distanceToSelection: number | null;
  fps: number;

  attach(engine: Engine): () => void;
  setLeftTab(t: LeftTab): void;
  setLeftOpen(v: boolean): void;
  setRightOpen(v: boolean): void;
  setPresentation(v: boolean): void;
  setShortcutsOpen(v: boolean): void;
  setExportDialog(d: ExportDialog): void;
  setCatalogQuery(q: string): void;
  selectWindow(wallId: string, windowId: string | null): void;
  dismissToast(id: number): void;
  setDistance(d: number | null): void;
  setFps(f: number): void;
}

let toastSeq = 1;

export const useStore = create<UiState>((set, get) => ({
  engine: null,
  doc: null,
  selection: [],
  hovered: null,
  tool: null,
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  projection: 'perspective',
  flyMode: false,
  viewLocked: false,
  loading: new Map(),
  theme: 'dark',
  toasts: [],
  leftTab: 'catalog',
  leftOpen: true,
  rightOpen: true,
  presentation: false,
  shortcutsOpen: false,
  exportDialog: null,
  catalogQuery: '',
  selectedWindowByWall: {},
  distanceToSelection: null,
  fps: 0,

  attach(engine) {
    set({
      engine, doc: engine.doc, selection: engine.selection, tool: engine.tools.activeId, theme: engine.settings.theme,
      projection: engine.camera.projection, flyMode: engine.camera.flyMode, viewLocked: engine.camera.locked,
      canUndo: engine.history.canUndo, canRedo: engine.history.canRedo,
    });
    const offs = [
      engine.on('document', doc => set({ doc })),
      engine.on('selection', selection => set({ selection })),
      engine.on('hover', hovered => set({ hovered })),
      engine.on('tool', tool => set({ tool })),
      engine.on('history', () => set({ canUndo: engine.history.canUndo, canRedo: engine.history.canRedo, undoLabel: engine.history.undoLabel, redoLabel: engine.history.redoLabel })),
      engine.on('theme', theme => set({ theme })),
      engine.on('loading', m => set({ loading: new Map([...m].map(([id, keys]) => [id, new Set(keys)])) })),
      engine.on('toast', t => {
        const id = toastSeq++;
        set(s => ({ toasts: [...s.toasts, { id, ...t }].slice(-4) }));
        window.setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 8000 : 3200);
      }),
      engine.camera.on('projection', projection => set({ projection })),
      engine.camera.on('flyMode', flyMode => set({ flyMode })),
      engine.camera.on('lock', viewLocked => set({ viewLocked })),
    ];
    return () => offs.forEach(f => f());
  },
  setLeftTab: leftTab => set({ leftTab, leftOpen: true }),
  setLeftOpen: leftOpen => set({ leftOpen }),
  setRightOpen: rightOpen => set({ rightOpen }),
  setPresentation: presentation => set({ presentation }),
  setShortcutsOpen: shortcutsOpen => set({ shortcutsOpen }),
  setExportDialog: exportDialog => set({ exportDialog }),
  setCatalogQuery: catalogQuery => set({ catalogQuery }),
  selectWindow: (wallId, windowId) => {
    const engine = get().engine;
    engine?.selectedWindow.set(wallId, windowId);
    set(s => ({ selectedWindowByWall: { ...s.selectedWindowByWall, [wallId]: windowId } }));
  },
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  setDistance: distanceToSelection => set({ distanceToSelection }),
  setFps: fps => set({ fps }),
}));

/* ───────── selectors ───────── */

export const useEngine = (): Engine => {
  const e = useStore(s => s.engine);
  if (!e) throw new Error('Engine not attached');
  return e;
};

export const useDoc = (): Document => {
  const d = useStore(s => s.doc);
  if (!d) throw new Error('No document');
  return d;
};

export function useEntity<T extends Entity = Entity>(id: string | null | undefined): T | undefined {
  return useStore(s => (id ? (s.doc?.entities.find(e => e.id === id) as T | undefined) : undefined));
}

/**
 * True while that one content window is loading. `LedWallRenderer.loadMedia` keys the wall's
 * loading set by the window id; `contentActions.setWindowSource` uses `upload:<id>` for the
 * asset-store write that precedes it.
 */
export function isWindowLoading(loading: UiState['loading'], wallId: string, windowId: string): boolean {
  const keys = loading.get(wallId);
  return !!keys && (keys.has(windowId) || keys.has(`upload:${windowId}`));
}

export const usePrimarySelection = (): Entity | undefined =>
  useStore(s => { const id = s.selection[s.selection.length - 1]; return id ? s.doc?.entities.find(e => e.id === id) : undefined; });
