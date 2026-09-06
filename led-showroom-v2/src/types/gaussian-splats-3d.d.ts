/**
 * Minimal typings for `@mkkellogg/gaussian-splats-3d` (0.4.7 ships no .d.ts). Only the surface
 * used by src/engine/entities/SplatRenderer.ts is declared: the drop-in viewer (a THREE.Group
 * that composites with a normal three.js scene), its inner Viewer state flags, the splat mesh
 * and the scene-format enum. Everything else is left untyped.
 */
declare module '@mkkellogg/gaussian-splats-3d' {
  import * as THREE from 'three';

  export const SceneFormat: { readonly Splat: 0; readonly KSplat: 1; readonly Ply: 2; readonly Spz: 3 };
  export type SceneFormatValue = 0 | 1 | 2 | 3;

  export const SceneRevealMode: { readonly Default: 0; readonly Gradual: 1; readonly Instant: 2 };
  export const RenderMode: { readonly Always: 0; readonly OnChange: 1; readonly Never: 2 };
  export const LogLevel: { readonly None: 0; readonly Error: 1; readonly Warning: 2; readonly Info: 3; readonly Debug: 4 };
  export const SplatRenderMode: { readonly ThreeD: 0; readonly TwoD: 1 };
  /** Third argument of `SplatSceneOptions.onProgress`. `Done` fires once the download completes (also with progressiveLoad). */
  export const LoaderStatus: { readonly Downloading: 0; readonly Processing: 1; readonly Done: 2 };
  export type LoaderStatusValue = 0 | 1 | 2;

  export interface ViewerOptions {
    /** Sort on the GPU (needs WebGL2 float render targets); default false. */
    gpuAcceleratedSort?: boolean;
    /** Use SharedArrayBuffer for the sort worker (requires COOP/COEP headers); default true. */
    sharedMemoryForWorkers?: boolean;
    /** Splat scenes can be transformed independently after load; default false. */
    dynamicScene?: boolean;
    /** Release CPU copies of splat data once uploaded to the GPU. */
    freeIntermediateSplatData?: boolean;
    integerBasedSort?: boolean;
    antialiased?: boolean;
    sceneRevealMode?: number;
    renderMode?: number;
    logLevel?: number;
    splatRenderMode?: number;
    sphericalHarmonicsDegree?: number;
    halfPrecisionCovariancesOnGPU?: boolean;
    enableOptionalEffects?: boolean;
    /** Ignored in drop-in mode (the host scene renders). */
    selfDrivenMode?: boolean;
    useBuiltInControls?: boolean;
    [key: string]: unknown;
  }

  export interface SplatSceneOptions {
    format?: SceneFormatValue;
    /** Ignore splats with alpha below this (0–255); default 1. */
    splatAlphaRemovalThreshold?: number;
    showLoadingUI?: boolean;
    /**
     * Stream the file in 256 KB sections. NOTE: `addSplatScene` then resolves after the FIRST
     * section is built, not when the download finishes — poll `SplatMesh.getSplatCount()`.
     */
    progressiveLoad?: boolean;
    position?: [number, number, number];
    /** Quaternion. */
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    onProgress?: (percent: number, percentLabel: string, status: LoaderStatusValue) => void;
    headers?: Record<string, string>;
  }

  /**
   * The library's abortable thenable. NOTE: `then(onResolve)` ignores a rejection callback, so
   * `await` on it directly can hang on failure — always await `.promise`.
   */
  export class AbortablePromise<T = unknown> {
    readonly id: number;
    promise: Promise<T>;
    then(onResolve: (value: T) => unknown): AbortablePromise<unknown>;
    catch(onReject: (reason: unknown) => unknown): AbortablePromise<unknown>;
    abort(reason?: unknown): void;
  }

  export class SplatMesh extends THREE.Mesh {
    /** Always empty in 0.4.7 (only ever reset, never expanded) — do not rely on it; use computeBoundingBox(). */
    boundingBox: THREE.Box3;
    calculatedSceneCenter: THREE.Vector3;
    /** True while the progressive reveal (fade-in) is still animating. */
    visibleRegionChanging: boolean;
    dynamicMode: boolean;
    /** Splats in the last completed build (grows per section with progressiveLoad). */
    getSplatCount(includeSinceLastBuild?: boolean): number;
    /** Axis-aligned box of the splat centres in mesh-local space (O(n); the only real source of bounds). */
    computeBoundingBox(applySceneTransforms?: boolean, sceneIndex?: number): THREE.Box3;
    dispose(): void;
  }

  export class Viewer {
    constructor(options?: ViewerOptions);
    splatMesh: SplatMesh | null;
    initialized: boolean;
    /** True while the sort worker is busy with a depth sort. */
    sortRunning: boolean;
    /** False until the first sort after a load finishes. */
    splatRenderReady: boolean;
    /**
     * Library bug in 0.4.7: stays true forever when a progressive load's first section is also
     * its final one (files <= 256 KB / blob URLs read in one chunk). Do not key rendering on it.
     */
    isLoadingOrUnloading(): boolean;
    isDisposingOrDisposed(): boolean;
    addSplatScene(path: string, options?: SplatSceneOptions): AbortablePromise<void>;
    /**
     * Depth-sort the splats for the current camera. Without `force` it is a no-op unless the
     * camera moved (dynamicScene: false) — pass `force = true` after changing the mesh's
     * world transform. Resolves false when nothing was sorted, true when a sort ran or is running.
     */
    runSplatSort(force?: boolean, forceSortAll?: boolean): Promise<boolean>;
    getSceneCount(): number;
    getSplatScene(index: number): unknown;
    onSplatMeshChanged(callback: () => void): void;
    forceRenderNextFrame(): void;
    update(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
    dispose(): Promise<void>;
  }

  /** A THREE.Group wrapping a Viewer; add it to any scene and render normally. */
  export class DropInViewer extends THREE.Group {
    constructor(options?: ViewerOptions);
    readonly viewer: Viewer;
    splatMesh: SplatMesh | null;
    /** Tiny hidden mesh whose onBeforeRender drives the viewer update. */
    callbackMesh: THREE.Mesh;
    addSplatScene(path: string, options?: SplatSceneOptions): AbortablePromise<void>;
    addSplatScenes(scenes: Array<SplatSceneOptions & { path: string }>, showLoadingUI?: boolean): AbortablePromise<void>;
    getSplatScene(index: number): unknown;
    removeSplatScene(index: number, showLoadingUI?: boolean): Promise<void>;
    getSceneCount(): number;
    setActiveSphericalHarmonicsDegrees(degrees: number): void;
    dispose(): Promise<void>;
  }
}
