/**
 * Gaussian splat renderer. Wraps @mkkellogg/gaussian-splats-3d's DropInViewer (a THREE.Group
 * that composites with the rest of the scene) under the entity root. The entity transform is
 * applied to the root by the SceneManager; the splat scene itself stays at identity inside the
 * viewer so position/rotation/scale from the document align the arbitrary-scale reconstruction
 * into world inches.
 *
 * Progressive loading: `addSplatScene({ progressiveLoad: true })` resolves as soon as the FIRST
 * 256 KB section is built, not when the download finishes. The renderer therefore keeps
 * watching `splatMesh.getSplatCount()` from `frame()` and re-measures the bounds / pick proxy
 * whenever the mesh grows (throttled, and never while a sort is running). The HUD loading flag
 * stays on until the loader reports `LoaderStatus.Done` for the download (or the viewer stops
 * reporting a load in progress, which is what happens on a mid-stream failure).
 *
 * Continuous rendering: the viewer depth-sorts splats in a worker whenever the camera moves and
 * needs a further render when the sort lands. `frame()` asks for a render while the first
 * section is loading, while a sort is running (and on the frame it finishes), while the
 * progressive reveal fades in, on frames where the mesh grew, and for a short settle window
 * after any camera or entity-transform change. NOTE: `Viewer.isLoadingOrUnloading()` is
 * deliberately NOT consulted — in 0.4.7 it stays true forever for scenes whose first
 * progressive section is also the final one (any file <= 256 KB or a blob URL delivered in a
 * single read), which would force rendering every frame for the life of the entity.
 *
 * Stale sort on transform change: with `dynamicScene: false` the viewer only re-sorts when the
 * CAMERA moves, but the sort bakes in `splatMesh.matrixWorld`. Moving/rotating/scaling the entity
 * with the gizmo would leave the splats blended in the old order until the next orbit, so
 * `frame()` watches `root.matrixWorld` and forces `runSplatSort(true)` when it changes.
 *
 * Picking: splats have no pickable surface, so an invisible box proxy sized to the splat bounds
 * (`userData.pickProxy`) makes the entity clickable. `selectionMeshes()` is empty (no outline);
 * the selection helper's bounding box uses `bounds()`.
 */
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import type { SplatEntity } from '../document/types';
import type { EntityRenderer, RenderContext } from './EntityRenderer';
import { disposeObject, tagRoot } from './EntityRenderer';

const LOADING_KEY = 'splat';
/** Fallback bounds (inches) before/without a loaded splat. */
export const SPLAT_FALLBACK_SIZE_IN = 120;
/** Keep rendering this long (seconds) after a camera / transform change so late sort results are shown. */
const SETTLE_SECONDS = 0.75;
/** Minimum interval (seconds) between bounds re-measurements while sections stream in. */
export const REMEASURE_INTERVAL_SECONDS = 0.25;
/** `LoaderStatus.Done` in @mkkellogg/gaussian-splats-3d 0.4.7 (Downloading 0, Processing 1, Done 2). */
export const LOADER_STATUS_DONE = 2;

export type SplatFormat = SplatEntity['format'];

/** Map the document format to the library's SceneFormat enum. */
export function toSceneFormat(format: SplatFormat): GaussianSplats3D.SceneFormatValue {
  switch (format) {
    case 'ksplat': return GaussianSplats3D.SceneFormat.KSplat;
    case 'splat': return GaussianSplats3D.SceneFormat.Splat;
    default: return GaussianSplats3D.SceneFormat.Ply;
  }
}

/** Splat format from a file name extension (defaults to ply). */
export function splatFormatFromFileName(fileName: string): SplatFormat {
  const lower = fileName.split(/[?#]/)[0].toLowerCase();
  if (lower.endsWith('.ksplat')) return 'ksplat';
  if (lower.endsWith('.splat')) return 'splat';
  return 'ply';
}

/** Inputs to the per-frame render decision (pure, see `splatNeedsRender`). */
export interface SplatFrameState {
  /** First progressive section not built yet. */
  loading: boolean;
  /** Sort worker busy this frame. */
  sorting: boolean;
  /** Sort worker was busy last frame (a finished sort needs one more render). */
  wasSorting: boolean;
  /** Progressive reveal (fade-in) still animating. */
  fading: boolean;
  /** `Viewer.splatRenderReady` — false until the first sort after a build. */
  renderReady: boolean;
  /** Splat count changed this frame (a later section landed). */
  grew: boolean;
  /** Remaining settle window (seconds) after a camera / transform change. */
  settle: number;
}

/** Whether a splat entity needs the scene re-rendered this frame. */
export function splatNeedsRender(s: SplatFrameState): boolean {
  if (s.loading) return true;
  const finishedSort = s.wasSorting && !s.sorting;
  return s.sorting || finishedSort || s.fading || !s.renderReady || s.grew || s.settle > 0;
}

/**
 * Whether to re-measure the splat bounds: the count changed, no sort is in flight (the mesh's
 * splat buffers are stable between sorts) and the throttle window has elapsed.
 */
export function shouldRemeasure(count: number, measuredCount: number, sortRunning: boolean, cooldown: number): boolean {
  return count > 0 && count !== measuredCount && !sortRunning && cooldown <= 0;
}

/** The library's abortable thenable ignores rejection handlers in `then`; unwrap to a real promise. */
function asPromise<T>(p: GaussianSplats3D.AbortablePromise<T> | Promise<T>): Promise<T> {
  const ap = p as { promise?: Promise<T> };
  return ap.promise instanceof Promise ? ap.promise : (p as Promise<T>);
}

export class SplatRenderer implements EntityRenderer<SplatEntity> {
  entity: SplatEntity;
  readonly root = new THREE.Group();

  private ctx: RenderContext;
  private viewer: GaussianSplats3D.DropInViewer | null = null;
  private proxy: THREE.Mesh;
  private proxyMat: THREE.MeshBasicMaterial;
  /** Local-space bounds of the splat centres (root frame), null until loaded. */
  private localBounds: THREE.Box3 | null = null;
  private sourceKey = '';
  private loadToken = 0;
  private disposed = false;
  /** True from load() start until the first progressive section is built (or the load fails). */
  private loading = false;
  /** True while later progressive sections may still be streaming in (HUD flag stays on). */
  private streaming = false;
  private downloadDone = false;
  /** Splat count the current `localBounds` was measured from. */
  private measuredCount = 0;
  private remeasureCooldown = 0;
  private wasSorting = false;
  private settle = 0;
  private lastCamPos = new THREE.Vector3(NaN, NaN, NaN);
  private lastCamQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
  private lastRootMatrix = new THREE.Matrix4().set(NaN, 0, 0, 0, 0, NaN, 0, 0, 0, 0, NaN, 0, 0, 0, 0, NaN);

  constructor(entity: SplatEntity, ctx: RenderContext) {
    this.entity = entity;
    this.ctx = ctx;
    tagRoot(this.root, entity);
    this.proxyMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    this.proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.proxyMat);
    this.proxy.name = 'pickProxy';
    this.proxy.userData.pickProxy = true;
    this.proxy.visible = true;
    this.proxy.renderOrder = -1;
    this.root.add(this.proxy);
    this.sizeProxy(this.fallbackBox());
    this.update(entity, ctx);
  }

  /* ───────────────────────── update / load ───────────────────────── */

  update(entity: SplatEntity, ctx: RenderContext): void {
    this.entity = entity;
    this.ctx = ctx;
    const key = JSON.stringify([entity.url ?? null, entity.assetId ?? null, entity.format]);
    if (key !== this.sourceKey) {
      this.sourceKey = key;
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const e = this.entity;
    const ctx = this.ctx;
    this.destroyViewer();
    this.localBounds = null;
    this.measuredCount = 0;
    this.remeasureCooldown = 0;
    this.downloadDone = false;
    this.streaming = false;
    this.sizeProxy(this.fallbackBox());
    this.loading = true;
    ctx.setLoading(e.id, LOADING_KEY, true);
    let failed = false;
    try {
      let url: string | null = null;
      if (e.assetId) url = await ctx.assets.getUrl(e.assetId);
      if (!url && e.url) url = e.url;
      if (token !== this.loadToken || this.disposed) return;
      if (!url) throw new Error(`Splat "${e.fileName}" has no readable source`);

      const viewer = new GaussianSplats3D.DropInViewer({
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false, // avoids COOP/COEP header requirements
        dynamicScene: false,
        freeIntermediateSplatData: true,
      });
      viewer.name = 'splatViewer';
      this.markUnpickable(viewer);
      this.viewer = viewer;
      this.root.add(viewer);

      // Resolves after the FIRST section is built; later sections are picked up in frame().
      await asPromise(viewer.addSplatScene(url, {
        format: toSceneFormat(e.format),
        showLoadingUI: false,
        splatAlphaRemovalThreshold: 5,
        progressiveLoad: true,
        onProgress: (_percent, _label, status) => {
          if (token !== this.loadToken || this.disposed) return;
          if (status === LOADER_STATUS_DONE) { this.downloadDone = true; ctx.invalidate(); }
        },
      }));
      if (token !== this.loadToken || this.disposed) return;
      this.markUnpickable(viewer);
      this.measure(viewer);
    } catch (err) {
      if (token !== this.loadToken || this.disposed) return;
      failed = true;
      console.warn(`[splat] failed to load ${e.fileName}:`, err);
      this.destroyViewer();
    } finally {
      if (token === this.loadToken && !this.disposed) {
        this.loading = false;
        // Keep the HUD flag on while the rest of the file streams in (cleared from frame()).
        this.streaming = !failed && !this.downloadDone;
        if (!this.streaming) ctx.setLoading(e.id, LOADING_KEY, false);
      }
      this.settle = SETTLE_SECONDS;
      ctx.invalidate();
    }
  }

  /** The viewer's meshes must never be raycast (no surface) nor outlined. */
  private markUnpickable(viewer: THREE.Object3D): void {
    viewer.traverse(o => {
      o.userData.unpickable = true;
      if ((o as THREE.Mesh).isMesh) {
        o.raycast = () => { /* not pickable */ };
        // the viewer owns these; its dispose() frees them
        o.userData.sharedGeometry = true;
        o.userData.sharedMaterial = true;
      }
    });
  }

  /** Re-measure the bounds from the splats built so far and resize the pick proxy. */
  private measure(viewer: GaussianSplats3D.DropInViewer): void {
    const mesh = viewer.splatMesh ?? viewer.viewer.splatMesh;
    this.measuredCount = mesh?.getSplatCount() ?? 0;
    this.remeasureCooldown = REMEASURE_INTERVAL_SECONDS;
    const b = mesh ? this.computeLocalBounds(mesh) : null;
    if (b) this.localBounds = b;
    this.sizeProxy(this.localBounds ?? this.fallbackBox());
  }

  /**
   * Axis-aligned box of the splat centres in mesh-local space. `computeBoundingBox` is the only
   * real source of bounds (`SplatMesh.boundingBox` is never populated by the library).
   */
  private computeLocalBounds(mesh: GaussianSplats3D.SplatMesh): THREE.Box3 | null {
    try {
      if (typeof mesh.computeBoundingBox === 'function' && mesh.getSplatCount() > 0) {
        const b = mesh.computeBoundingBox(true);
        if (b && !b.isEmpty()) return b.clone();
      }
    } catch (err) {
      console.warn('[splat] bounds unavailable:', err);
    }
    return null;
  }

  private fallbackBox(): THREE.Box3 {
    const h = SPLAT_FALLBACK_SIZE_IN / 2;
    return new THREE.Box3(new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, SPLAT_FALLBACK_SIZE_IN, h));
  }

  private sizeProxy(local: THREE.Box3): void {
    const size = local.getSize(new THREE.Vector3());
    const c = local.getCenter(new THREE.Vector3());
    this.proxy.scale.set(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3));
    this.proxy.position.copy(c);
    this.proxy.updateMatrixWorld(true);
  }

  private destroyViewer(): void {
    const v = this.viewer;
    if (!v) return;
    this.viewer = null;
    v.removeFromParent();
    try { void v.dispose().catch(() => { /* already disposing */ }); }
    catch { /* ignore */ }
    this.wasSorting = false;
  }

  private finishStreaming(): void {
    if (!this.streaming) return;
    this.streaming = false;
    this.ctx.setLoading(this.entity.id, LOADING_KEY, false);
  }

  /* ───────────────────────── per frame ───────────────────────── */

  frame(dt: number, ctx: RenderContext): boolean {
    if (!this.root.visible) return false;
    if (this.loading) return true;
    const v = this.viewer;
    if (!v) return false;
    const inner = v.viewer;
    if (inner.isDisposingOrDisposed()) return false;

    // Camera moved → the viewer will re-sort on its own; keep rendering until it lands.
    const cam = ctx.camera;
    if (!cam.position.equals(this.lastCamPos) || !cam.quaternion.equals(this.lastCamQuat)) {
      this.lastCamPos.copy(cam.position);
      this.lastCamQuat.copy(cam.quaternion);
      this.settle = SETTLE_SECONDS;
    }

    // Entity transform changed → the viewer would NOT re-sort (dynamicScene: false); force it.
    this.root.updateWorldMatrix(true, false);
    if (!this.root.matrixWorld.equals(this.lastRootMatrix)) {
      this.lastRootMatrix.copy(this.root.matrixWorld);
      if (inner.initialized && inner.splatRenderReady && !inner.sortRunning) {
        try { void inner.runSplatSort(true); } catch (err) { console.warn('[splat] forced sort failed:', err); }
      }
      this.settle = SETTLE_SECONDS;
    }

    const sorting = !!inner.sortRunning;
    const wasSorting = this.wasSorting;
    this.wasSorting = sorting;
    const fading = !!v.splatMesh?.visibleRegionChanging;
    const renderReady = !!inner.splatRenderReady;

    // Later progressive sections: re-measure bounds / pick proxy as the mesh grows.
    let grew = false;
    if (this.remeasureCooldown > 0) this.remeasureCooldown = Math.max(0, this.remeasureCooldown - dt);
    const count = (v.splatMesh ?? inner.splatMesh)?.getSplatCount() ?? 0;
    if (shouldRemeasure(count, this.measuredCount, sorting, this.remeasureCooldown)) {
      this.measure(v);
      grew = true;
    }
    if (this.streaming && (this.downloadDone || !inner.isLoadingOrUnloading()) && count === this.measuredCount) {
      this.finishStreaming();
    }

    if (this.settle > 0) this.settle = Math.max(0, this.settle - dt);
    return splatNeedsRender({ loading: false, sorting, wasSorting, fading, renderReady, grew, settle: this.settle });
  }

  /* ───────────────────────── contract ───────────────────────── */

  bounds(out = new THREE.Box3()): THREE.Box3 {
    this.root.updateMatrixWorld(true);
    const local = this.localBounds ?? this.fallbackBox();
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  /** No edge outline for splats (the proxy is invisible and the splat mesh has no surface). */
  selectionMeshes(): THREE.Mesh[] { return []; }

  /** Invisible box used by the picker so the entity can be clicked. */
  get pickProxy(): THREE.Mesh { return this.proxy; }

  dispose(): void {
    this.disposed = true;
    this.loadToken++;
    if (this.loading || this.streaming) {
      this.loading = false;
      this.streaming = false;
      this.ctx.setLoading(this.entity.id, LOADING_KEY, false);
    }
    this.destroyViewer();
    disposeObject(this.root);
  }
}

export const createSplatRenderer = (entity: SplatEntity, ctx: RenderContext): SplatRenderer => new SplatRenderer(entity, ctx);
