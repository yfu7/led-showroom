/**
 * Engine facade. Owns the document, history, scene, renderer, camera, environment, tools,
 * selection, the render loop and persistence. UI talks only to this object.
 */
import * as THREE from 'three';
import { Emitter, type Listener } from './events';
import { History, type Command } from './commands/History';
import type { DocHost } from './commands/entity';
import { cmdAddEntities, cmdAddEntity, cmdPatchDocument, cmdRemoveEntities, cmdReplaceDocument, cmdUpdateEntity } from './commands/entity';
import { Clipboard } from './clipboard';
import type { Document, Entity, ViewState } from './document/types';
import { createDocument, createLedWall } from './document/defaults';
import { addEntity, getEntity } from './document/Document';
import { Renderer, type GpuPreference, probeGpus } from './scene/Renderer';
import { CameraRig, type ViewPreset } from './scene/CameraRig';
import { Environment, DARK_THEME, LIGHT_THEME, type EnvTheme } from './scene/Environment';
import { SceneManager } from './scene/SceneManager';
import { SelectionHelper, DEFAULT_SELECTION_COLORS, LIGHT_SELECTION_COLORS } from './scene/Selection';
import type { RenderContext } from './entities/EntityRenderer';
import { ToolManager, type ToolId } from './tools/Tool';
import { hiddenEntityIds } from './tools/BoxSelect';
import { pickEntity, type Hit } from './scene/Picking';
import { assets, AssetStore, collectAssetIds } from './persistence/AssetStore';
import { migrateDocument } from './persistence/sceneFile';
import { readV1Preferences, type V1Preferences } from './persistence/v1import';
import { cloneJson, type Vec3 } from './math';

export interface EngineEvents extends Record<string, unknown> {
  document: Document;
  selection: string[];
  hover: string | null;
  tool: ToolId | null;
  history: void;
  view: void;
  loading: Map<string, Set<string>>;
  frame: number;
  theme: 'dark' | 'light';
  toast: { kind: 'info' | 'error' | 'success'; message: string };
}

export interface EngineSettings {
  gpu: GpuPreference;
  qualityScale: number;
  liveWebsiteInRecordings: boolean;
  theme: 'dark' | 'light';
  navigation: 'orbit' | 'pan';
}

/** Trailing-throttle interval of the autosave (ms). */
const AUTOSAVE_MS = 500;
const SETTINGS_KEY = 'showroom-v2:settings';
const DOC_KEY = 'showroom-v2:doc';
/** An autosaved document that could not be read is parked here instead of being left in `DOC_KEY`. */
const DOC_BAD_KEY = 'showroom-v2:doc.bad';
const VIEW_KEY = 'showroom-v2:view';

export class Engine extends Emitter<EngineEvents> implements DocHost {
  doc: Document;
  readonly history = new History();
  readonly renderer: Renderer;
  readonly camera: CameraRig;
  readonly env: Environment;
  readonly scene: SceneManager;
  readonly selectionHelper: SelectionHelper;
  readonly tools: ToolManager;
  readonly assets: AssetStore = assets;
  /** Internal entity clipboard (never the system one) — see `copy` / `cut` / `paste`. */
  readonly clipboard = new Clipboard();
  readonly settings: EngineSettings;
  readonly gpuProbe = probeGpus();

  selection: string[] = [];
  hovered: string | null = null;
  /**
   * True when the constructor restored a camera pose from the previous session (v1's `userView`,
   * Alg A33). Boot must then keep that viewpoint instead of auto-framing over it; an explicit
   * frame / home view clears it again.
   */
  restoredView = false;
  /** Content window selected per wall (UI state, not persisted in the document). */
  selectedWindow = new Map<string, string | null>();

  private ctx: RenderContext;
  private dirty = true;
  private continuous = 0;
  private raf = 0;
  private last = 0;
  private loading = new Map<string, Set<string>>();
  private autosaveTimer: number | null = null;
  private disposed = false;
  /** Toasts raised before the UI subscribed (boot-time restore failures); flushed on first listener. */
  private pendingToasts: EngineEvents['toast'][] = [];
  private toastReady = false;
  /** Callbacks run after each document change, before the render (attachment sync etc.). */
  private postChange: ((doc: Document, prev: Document) => Document | void)[] = [];

  constructor(host: HTMLElement, initial?: Document) {
    super();
    const stored = loadJson<Partial<EngineSettings>>(SETTINGS_KEY);
    // First run only: carry the legacy per-machine preferences across (inventory item 64). Once
    // any of them is adopted the settings record is written, so this never runs twice.
    const legacy: V1Preferences = stored ? {} : readV1Preferences(safeStorage());
    const { pixelGridDistIn, ...legacySettings } = legacy;
    this.settings = { gpu: 'default', qualityScale: 1, liveWebsiteInRecordings: false, theme: 'dark', navigation: 'orbit', ...legacySettings, ...stored };
    const restored = initial ?? this.restoreDoc();
    this.doc = restored ?? createDocument();
    // the v1 pixel-grid distance lives in the document, so it only seeds a brand-new one
    if (!restored && pixelGridDistIn !== undefined) this.doc = { ...this.doc, settings: { ...this.doc.settings, pixelGridDistIn } };
    if (Object.keys(legacy).length) this.saveSettings();

    this.renderer = new Renderer(host, { gpu: this.settings.gpu, qualityScale: this.settings.qualityScale, shadows: this.doc.environment.lighting.shadows });
    this.camera = new CameraRig(this.renderer.inputEl, this.renderer.aspect);
    this.camera.setScheme(this.settings.navigation);
    this.env = new Environment(this.renderer.backdropEl);
    this.scene = new SceneManager();
    this.scene.scene.add(this.env.group);
    this.selectionHelper = new SelectionHelper();
    this.scene.scene.add(this.selectionHelper.group);
    this.setTheme(this.settings.theme, false);

    this.ctx = {
      doc: this.doc,
      assets: this.assets,
      camera: this.camera.camera,
      invalidate: () => this.invalidate(),
      setLoading: (id, key, on) => this.setLoading(id, key, on),
      unit: this.doc.settings.units,
      needs: { css3d: false, pixelGrid: false },
      maxTextureSize: this.renderer.maxTextureSize,
    };

    this.tools = new ToolManager({
      inputEl: this.renderer.inputEl,
      get camera() { return self.camera.camera; },
      setCameraRotate: on => this.camera.setRotateEnabled(on),
      setCameraZoom: on => this.camera.setZoomEnabled(on),
      invalidate: () => this.invalidate(),
    });
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.tools.onChange(id => this.emit('tool', id));

    this.renderer.onResize((w, h) => { this.camera.setAspect(w / h); this.invalidate(); });
    this.camera.on('change', () => { this.invalidate(); this.emit('view', undefined); this.scheduleAutosave(); });
    this.camera.on('projection', () => { this.ctx.camera = this.camera.camera; this.invalidate(); this.emit('view', undefined); });
    this.history.subscribe(() => this.emit('history', undefined));

    const view = loadJson<Partial<ViewState>>(VIEW_KEY);
    if (view) this.camera.setState(view); else this.camera.setState(this.doc.view);
    // a stored pose is the user's own viewpoint; a bare default is not
    this.restoredView = !!(view && view.position && view.target);
    this.camera.userMoved = this.restoredView;

    this.env.apply(this.doc.environment);
    this.resolveBackdropPhoto();
    this.start();
  }

  /* ───────────── document ───────────── */

  setDoc(doc: Document, meta: { silent?: boolean } = {}): void {
    const prev = this.doc;
    let next = doc;
    for (const fn of this.postChange) { const r = fn(next, prev); if (r) next = r; }
    this.doc = next.updatedAt === prev.updatedAt && next !== prev ? { ...next, updatedAt: Date.now() } : next;
    this.ctx.doc = this.doc;
    this.ctx.unit = this.doc.settings.units;
    if (prev.environment !== this.doc.environment) {
      this.env.apply(this.doc.environment);
      if (prev.environment.lighting.shadows !== this.doc.environment.lighting.shadows) this.renderer.setShadows(this.doc.environment.lighting.shadows);
      if (prev.environment.backdrop.photo?.assetId !== this.doc.environment.backdrop.photo?.assetId) this.resolveBackdropPhoto();
    }
    this.syncScene();
    // drop selection of removed entities
    const ids = new Set(this.doc.entities.map(e => e.id));
    const sel = this.selection.filter(id => ids.has(id));
    if (sel.length !== this.selection.length) this.select(sel);
    if (!meta.silent) this.emit('document', this.doc);
    this.scheduleAutosave();
    this.invalidate();
  }

  /**
   * A venue photo is persisted by asset id; its blob URL is session-only. Re-mint the URL from the
   * asset store and hand it to the environment (and keep it in the document for this session).
   */
  resolveBackdropPhoto(): void {
    const photo = this.doc.environment.backdrop.photo;
    if (!photo?.assetId) return;
    const id = photo.assetId;
    void this.assets.getUrl(id).then(url => {
      if (!url) return;
      const cur = this.doc.environment.backdrop.photo;
      if (!cur || cur.assetId !== id) return;
      if (cur.url !== url) this.doc = { ...this.doc, environment: { ...this.doc.environment, backdrop: { ...this.doc.environment.backdrop, photo: { ...cur, url } } } };
      this.ctx.doc = this.doc;
      this.env.setBackdrop({ color: this.doc.environment.backdrop.color, photoUrl: url });
      this.env.apply(this.doc.environment);
      this.emit('document', this.doc);
      this.invalidate();
    });
  }

  /** Re-run the scene sync (after registering renderers, or when a factory changed). */
  resync(): void {
    this.scene.sync(this.doc, this.ctx, true);
    this.refreshSelectionHelper();
    this.env.fitShadows(this.scene.bounds());
    this.collectNeeds();
    this.invalidate();
  }

  /** Register a document post-processor (e.g. keep attached objects riding their stage). */
  addPostChange(fn: (doc: Document, prev: Document) => Document | void): () => void {
    this.postChange.push(fn);
    return () => { this.postChange = this.postChange.filter(f => f !== fn); };
  }

  run(cmd: Command): void { this.history.run(cmd); }
  undo(): void { const l = this.history.undo(); if (l) this.toast('info', `Undo ${l}`); }
  redo(): void { const l = this.history.redo(); if (l) this.toast('info', `Redo ${l}`); }

  entity<T extends Entity = Entity>(id: string | null | undefined): T | undefined { return getEntity(this.doc, id) as T | undefined; }

  add(entity: Entity, select = true): void {
    this.run(cmdAddEntity(this, entity, { select: select ? ids => this.select(ids) : undefined }));
  }
  remove(ids: string[]): void { if (ids.length) this.run(cmdRemoveEntities(this, ids)); }
  update(id: string, patch: Partial<Entity>, opts?: { label?: string; mergeKey?: string }): void;
  update<T extends Entity>(id: string, patch: Partial<T> | ((e: T) => T), opts?: { label?: string; mergeKey?: string }): void;
  update<T extends Entity>(id: string, patch: Partial<T> | Partial<Entity> | ((e: T) => T), opts: { label?: string; mergeKey?: string } = {}): void {
    this.run(cmdUpdateEntity<T>(this, id, patch as Partial<T> | ((e: T) => T), opts));
  }
  patchDocument(patch: Partial<Document> | ((d: Document) => Document), opts: { label?: string; mergeKey?: string } = {}): void {
    this.run(cmdPatchDocument(this, patch, opts));
  }
  patchSettings(patch: Partial<Document['settings']>, label = 'Change settings'): void {
    this.patchDocument(d => ({ ...d, settings: { ...d.settings, ...patch } }), { label, mergeKey: 'settings:' + Object.keys(patch).join(',') });
  }
  patchEnvironment(patch: Partial<Document['environment']> | ((e: Document['environment']) => Document['environment']), label = 'Change environment', mergeKey?: string): void {
    this.patchDocument(d => ({ ...d, environment: typeof patch === 'function' ? patch(d.environment) : { ...d.environment, ...patch } }), { label, mergeKey });
  }
  loadDocument(doc: Document, label = 'Load scene'): void {
    this.run(cmdReplaceDocument(this, cloneJson(doc), label));
    this.history.clear();
    this.select([]);
    this.camera.setState(this.doc.view);
    this.frameAll(false);
  }
  newDocument(): void {
    this.loadDocument(createDocument(), 'New scene');
  }
  /** First-run scene: one 5×5 wall standing at the origin. */
  seedDefaultScene(): void {
    const wall = createLedWall({ name: 'LED Wall', cols: 5, rows: 5 });
    this.setDoc(addEntity(this.doc, wall), { silent: false });
    this.history.clear();
    this.select([wall.id]);
    // a brand-new scene always frames, even if a stale view sits in storage
    this.clearUserView();
  }

  /* ───────────── clipboard ───────────── */

  get canPaste(): boolean { return this.clipboard.canPaste; }

  /** Copy `ids` (default: the selection) into the internal clipboard. Returns how many were taken. */
  copy(ids: string[] = this.selection): number {
    const n = this.clipboard.copy(this.doc, ids);
    if (n) this.toast('info', n === 1 ? 'Copied 1 object' : `Copied ${n} objects`);
    return n;
  }

  /** Copy then delete, as one undo entry (the delete). Locked entities are left alone. */
  cut(ids: string[] = this.selection): number {
    const cuttable = ids.filter(id => !this.entity(id)?.locked);
    const n = this.clipboard.copy(this.doc, cuttable);
    if (!n) return 0;
    this.run(cmdRemoveEntities(this, cuttable, cuttable.length === 1 ? `Cut ${this.entity(cuttable[0])?.name ?? 'object'}` : `Cut ${cuttable.length} objects`));
    this.toast('info', n === 1 ? 'Cut 1 object' : `Cut ${n} objects`);
    return n;
  }

  /**
   * Paste the clipboard as one undo entry and select the result. With `at` (a floor point from
   * the viewport context menu) the copied set lands centred on it, keeping its internal offsets;
   * without one it steps to the right of the previous paste. Returns the new entity ids.
   */
  paste(at?: Vec3): string[] {
    const { clones, idMap } = this.clipboard.paste(this.doc, at);
    if (!clones.length) return [];
    this.run(cmdAddEntities(this, clones, clones.length === 1 ? `Paste ${clones[0].name}` : `Paste ${clones.length} objects`));
    const ids = new Set(clones.map(c => c.id));
    const tops = clones.filter(c => !c.parentId || !ids.has(c.parentId)).map(c => c.id);
    this.select(tops.length ? tops : Array.from(idMap.values()));
    this.history.commit();
    return clones.map(c => c.id);
  }

  /* ───────────── selection ───────────── */

  select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    let next: string[];
    if (mode === 'replace') next = ids.slice();
    else if (mode === 'add') next = Array.from(new Set([...this.selection, ...ids]));
    else { const s = new Set(this.selection); for (const id of ids) { if (s.has(id)) s.delete(id); else s.add(id); } next = Array.from(s); }
    next = next.filter(id => !!getEntity(this.doc, id));
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.refreshSelectionHelper();
    this.emit('selection', next);
    this.invalidate();
  }
  isSelected(id: string): boolean { return this.selection.includes(id); }
  get primarySelection(): Entity | undefined { return this.entity(this.selection[this.selection.length - 1]); }
  selectedEntities(): Entity[] { return this.selection.map(id => this.entity(id)).filter(Boolean) as Entity[]; }

  setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    const r = id && !this.isSelected(id) ? this.scene.get(id) : undefined;
    this.selectionHelper.setHover(r ? r.selectionMeshes() : []);
    this.emit('hover', id);
    this.invalidate();
  }

  /**
   * The entity under `ndc`, ignoring hidden entities and the children of hidden groups.
   *
   * three's raycaster does not honour `visible`: the scene hides an entity by clearing
   * `visible` on its *root*, and `intersectObject` still returns the leaf meshes below it with
   * their own `visible` still true. Every pick that is meant to feel like "what the user can
   * see" — the Select tool, the right-click menu — must go through here, or a hidden object
   * keeps swallowing clicks where it stands (which is exactly what Isolate leaves behind).
   */
  pickAt(ndc: THREE.Vector2): Hit | null {
    const hidden = hiddenEntityIds(this.doc.entities);
    return pickEntity(ndc, this.camera.camera, this.scene.world, hidden.size ? { exclude: hidden } : {});
  }

  refreshSelectionHelper(): void {
    const items = this.selection.map(id => { const r = this.scene.get(id); return r ? { id, meshes: r.selectionMeshes() } : null; }).filter(Boolean) as { id: string; meshes: THREE.Mesh[] }[];
    this.selectionHelper.setSelected(items);
    this.selectionHelper.setBounds(this.selection.length ? this.scene.bounds(this.selection) : null);
  }

  /* ───────────── camera helpers ───────────── */

  boundsOf(ids?: Iterable<string>): THREE.Box3 { return this.scene.bounds(ids); }
  /** Automatic framing replaces a hand-set viewpoint, so the user-view guard is cleared (v1: reset clears it). */
  frameAll(animate = true): void { this.clearUserView(); this.camera.frame(this.scene.bounds(), animate); this.env.fitShadows(this.scene.bounds()); }
  frameSelection(animate = true): void { if (this.selection.length) this.camera.frame(this.scene.bounds(this.selection), animate); else this.frameAll(animate); }
  focusSelection(): void { if (this.selection.length) this.camera.focus(this.scene.bounds(this.selection)); }
  setView(preset: ViewPreset): void {
    const b = this.selection.length ? this.scene.bounds(this.selection) : this.scene.bounds();
    if (preset === 'home') this.clearUserView();
    this.camera.setView(preset, b);
  }
  /** Forget that the camera was placed by hand / restored from the last session. */
  private clearUserView(): void { this.restoredView = false; this.camera.userMoved = false; }

  /* ───────────── settings / theme ───────────── */

  setTheme(theme: 'dark' | 'light', persist = true): void {
    this.settings.theme = theme;
    const t: EnvTheme = theme === 'dark' ? DARK_THEME : LIGHT_THEME;
    this.env.setTheme(t);
    this.selectionHelper.setColors(theme === 'dark' ? DEFAULT_SELECTION_COLORS : LIGHT_SELECTION_COLORS);
    document.documentElement.dataset.theme = theme;
    if (persist) this.saveSettings();
    this.emit('theme', theme);
    this.invalidate();
  }

  setGpu(gpu: GpuPreference): void {
    this.settings.gpu = gpu;
    this.renderer.rebuild({ gpu });
    this.ctx.maxTextureSize = this.renderer.maxTextureSize;
    this.scene.sync(this.doc, this.ctx, true);
    this.refreshSelectionHelper();
    this.saveSettings();
    this.invalidate();
  }
  setQuality(scale: number): void { this.settings.qualityScale = scale; this.renderer.setQuality(scale); this.saveSettings(); this.invalidate(); }
  setNavigation(scheme: 'orbit' | 'pan'): void { this.settings.navigation = scheme; this.camera.setScheme(scheme); this.saveSettings(); }
  setLiveWebsite(on: boolean): void { this.settings.liveWebsiteInRecordings = on; this.saveSettings(); }
  private saveSettings(): void { saveJson(SETTINGS_KEY, this.settings); }

  /* ───────────── loading / toasts ───────────── */

  setLoading(entityId: string, key: string, on: boolean): void {
    let set = this.loading.get(entityId);
    if (on) { if (!set) { set = new Set(); this.loading.set(entityId, set); } set.add(key); }
    else if (set) { set.delete(key); if (!set.size) this.loading.delete(entityId); }
    this.emit('loading', this.loading);
    this.invalidate();
  }
  isLoading(entityId?: string): boolean { return entityId ? this.loading.has(entityId) : this.loading.size > 0; }
  /**
   * The constructor can already have something to say (a corrupt autosave), and the UI only
   * subscribes once the engine exists, so a toast raised before then is queued rather than lost.
   */
  toast(kind: 'info' | 'error' | 'success', message: string): void {
    if (!this.toastReady) { if (this.pendingToasts.length < 8) this.pendingToasts.push({ kind, message }); return; }
    this.emit('toast', { kind, message });
  }

  override on<K extends keyof EngineEvents>(event: K, fn: Listener<EngineEvents[K]>): () => void {
    const off = super.on(event, fn);
    if (event === 'toast' && !this.toastReady) {
      this.toastReady = true;
      const queued = this.pendingToasts;
      this.pendingToasts = [];
      for (const t of queued) this.emit('toast', t);
    }
    return off;
  }

  /* ───────────── render loop ───────────── */

  invalidate(): void { this.dirty = true; }
  /** Hold continuous rendering (video, recording, auto-rotate). Returns a release function. */
  holdContinuous(): () => void { this.continuous++; let released = false; return () => { if (!released) { released = true; this.continuous--; } }; }

  private syncScene(): void {
    const res = this.scene.sync(this.doc, this.ctx);
    if (res.created.length || res.updated.length || res.removed.length) {
      this.refreshSelectionHelper();
      this.env.fitShadows(this.scene.bounds());
    }
    this.collectNeeds();
  }

  /** Aggregate renderer flags into the layered renderer's pass switches. */
  private collectNeeds(): void {
    let css3d = false, grid = false;
    for (const r of this.scene.all()) { if (r.needsCss3d) css3d = true; if (r.needsPixelGrid) grid = true; }
    this.ctx.needs.css3d = css3d;
    this.ctx.needs.pixelGrid = grid;
    this.renderer.css3dNeeded = css3d;
    this.renderer.overlayNeeded = grid;
  }

  private start(): void {
    this.syncScene();
    this.last = performance.now();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      let need = this.dirty || this.continuous > 0;
      if (this.camera.update(dt)) need = true;
      if (this.doc.settings.autoRotate) need = true;
      if (this.scene.frame(dt, this.ctx)) need = true;
      if (this.tools.frame(dt)) need = true;
      if (!need) return;
      this.dirty = false;
      this.env.update(this.camera.camera);
      this.selectionHelper.syncMatrices();
      this.renderer.css3dNeeded = this.ctx.needs.css3d;
      this.renderer.overlayNeeded = this.ctx.needs.pixelGrid;
      this.renderer.render(this.scene.scene, this.camera.camera);
      this.emit('frame', dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Force a synchronous render (exports). */
  renderNow(): void {
    this.env.update(this.camera.camera);
    this.selectionHelper.syncMatrices();
    this.renderer.render(this.scene.scene, this.camera.camera);
  }

  /* ───────────── persistence ───────────── */

  /**
   * Restore the autosaved document (inventory item 63). The blob can have been written by an
   * older schema or truncated by a partial write, so it goes through the same `migrateDocument`
   * gate as an imported scene file — missing fields get their defaults, unrepairable entities are
   * dropped, transforms are clamped to the sanity envelope — instead of being cast to `Document`
   * and handed to the renderers. A blob that is not a document at all is parked under
   * `DOC_BAD_KEY` and cleared: left in place it would crash the same way on every reload, with no
   * in-app way back. Returns null when there is nothing usable to restore.
   */
  private restoreDoc(): Document | null {
    let raw: string | null = null;
    try { raw = localStorage.getItem(DOC_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      return migrateDocument(JSON.parse(raw));
    } catch (err) {
      console.warn('[persist] the autosaved scene could not be read', err);
      try { localStorage.setItem(DOC_BAD_KEY, raw); } catch { /* too large to park - dropping it is still better than looping */ }
      try { localStorage.removeItem(DOC_KEY); } catch { /* ignore */ }
      this.toast('error', 'The saved scene could not be read, so this session starts fresh');
      return null;
    }
  }

  /**
   * Trailing throttle, not a debounce: the first change arms a save `AUTOSAVE_MS` later and
   * further changes while the timer is pending keep it (never re-arm it). A stream of changes
   * (turntable, fly mode, a long drag, camera 'change' every frame) therefore saves every
   * `AUTOSAVE_MS` instead of starving persistence until the stream stops.
   */
  private scheduleAutosave(): void {
    if (this.autosaveTimer) return;
    this.autosaveTimer = window.setTimeout(() => { this.autosaveTimer = null; this.autosave(); }, AUTOSAVE_MS);
  }
  autosave(): void {
    if (this.autosaveTimer) { window.clearTimeout(this.autosaveTimer); this.autosaveTimer = null; }
    const view = this.camera.getState();
    this.doc = { ...this.doc, view: { ...this.doc.view, ...view } };
    saveJson(DOC_KEY, this.doc);
    saveJson(VIEW_KEY, view);
    // v1 item 35: give back the object URL (and memory copy) of every asset the document no
    // longer references, so replacing or clearing content does not pin the file for the life of
    // the page. Non-destructive - the stored asset stays, so undo re-mints its URL.
    this.assets.releaseUnused(collectAssetIds(this.doc));
  }
  /** The document with the live camera merged in (for exports/presets). */
  snapshot(): Document { return cloneJson({ ...this.doc, view: { ...this.doc.view, ...this.camera.getState() } }); }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.autosave();
    this.tools.dispose();
    this.camera.dispose();
    this.scene.dispose();
    this.env.dispose();
    this.selectionHelper.dispose();
    this.renderer.dispose();
  }
}

/** A `getItem` source that never throws, for readers that take a storage (privacy mode, no DOM). */
function safeStorage(): Pick<Storage, 'getItem'> {
  return {
    getItem(key: string): string | null {
      try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
    },
  };
}

function loadJson<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function saveJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { console.warn('[persist] failed', key, e); }
}
