/**
 * Layered renderer. Bottom to top inside one host element:
 *   1. backdrop   — DOM layer (venue photo / colour) painted by Environment
 *   2. webgl      — main scene (panels, equipment, content textures, grid, gizmos)
 *   3. css3d      — CSS3DRenderer for live website iframes (pointer-events: none)
 *   4. overlay    — transparent WebGL canvas drawing only layer 1 (pixel-grid) so it sits above CSS3D content
 *   5. input      — transparent div receiving all pointer events (tools + camera controls attach here)
 *
 * three.js bakes `powerPreference` into the context, so switching GPU means rebuilding the WebGL renderers.
 */
import * as THREE from 'three';
import { CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

export const LAYER_MAIN = 0;
export const LAYER_PIXEL_GRID = 1;
export const LAYER_GIZMO = 2;

export type GpuPreference = 'high-performance' | 'low-power' | 'default';

export interface RendererOptions {
  gpu?: GpuPreference;
  /** Extra supersampling on top of devicePixelRatio (v1 "1.5x render quality"). */
  qualityScale?: number;
  shadows?: boolean;
}

export interface GpuProbe {
  dualGpu: boolean;
  highPerf: string | null;
  lowPower: string | null;
}

/** Detect switchable dual-GPU laptops by comparing UNMASKED_RENDERER for both power preferences. */
export function probeGpus(): GpuProbe {
  const name = (pref: 'high-performance' | 'low-power'): string | null => {
    try {
      const c = document.createElement('canvas');
      const gl = (c.getContext('webgl2', { powerPreference: pref }) || c.getContext('webgl', { powerPreference: pref })) as WebGLRenderingContext | null;
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return r || null;
    } catch { return null; }
  };
  const hi = name('high-performance');
  const lo = name('low-power');
  return { dualGpu: !!hi && !!lo && hi !== lo, highPerf: hi, lowPower: lo };
}

export class Renderer {
  readonly host: HTMLElement;
  readonly backdropEl: HTMLDivElement;
  readonly webglEl: HTMLDivElement;
  readonly css3dEl: HTMLDivElement;
  readonly overlayEl: HTMLDivElement;
  readonly inputEl: HTMLDivElement;

  gl!: THREE.WebGLRenderer;
  overlay!: THREE.WebGLRenderer;
  css3d: CSS3DRenderer;

  width = 1;
  height = 1;
  maxTextureSize = 4096;
  gpu: GpuPreference;
  qualityScale: number;
  shadows: boolean;
  /** Set by the scene when any pixel grid is visible; skips the overlay pass otherwise. */
  overlayNeeded = false;
  /** Set when CSS3D objects exist; skips the DOM pass otherwise. */
  css3dNeeded = false;

  private ro: ResizeObserver;
  private listeners = new Set<(w: number, h: number) => void>();

  constructor(host: HTMLElement, opts: RendererOptions = {}) {
    this.host = host;
    this.gpu = opts.gpu ?? 'default';
    this.qualityScale = opts.qualityScale ?? 1;
    this.shadows = opts.shadows ?? true;
    host.classList.add('sr-viewport');
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.style.overflow = 'hidden';

    const layer = (cls: string, z: number, pointer: boolean) => {
      const el = document.createElement('div');
      el.className = `sr-layer ${cls}`;
      Object.assign(el.style, { position: 'absolute', inset: '0', zIndex: String(z), pointerEvents: pointer ? 'auto' : 'none' });
      host.appendChild(el);
      return el;
    };
    this.backdropEl = layer('sr-backdrop', 0, false);
    this.webglEl = layer('sr-webgl', 1, false);
    this.css3dEl = layer('sr-css3d', 2, false);
    this.overlayEl = layer('sr-overlay', 3, false);
    this.inputEl = layer('sr-input', 4, true);
    this.inputEl.tabIndex = 0;
    this.inputEl.style.outline = 'none';
    this.inputEl.style.touchAction = 'none';

    this.css3d = new CSS3DRenderer();
    this.css3dEl.appendChild(this.css3d.domElement);
    this.css3d.domElement.style.pointerEvents = 'none';

    this.createGl();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  private createGl(): void {
    const pref = this.gpu === 'default' ? undefined : this.gpu;
    this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: pref, stencil: false });
    this.gl.setClearColor(0x000000, 0);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.enabled = this.shadows;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.domElement.style.display = 'block';
    this.webglEl.appendChild(this.gl.domElement);

    this.overlay = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: pref, stencil: false, depth: false });
    this.overlay.setClearColor(0x000000, 0);
    this.overlay.outputColorSpace = THREE.SRGBColorSpace;
    this.overlay.toneMapping = THREE.NoToneMapping;
    this.overlay.domElement.style.display = 'block';
    this.overlayEl.appendChild(this.overlay.domElement);

    const ctx = this.gl.getContext();
    this.maxTextureSize = (ctx.getParameter(ctx.MAX_TEXTURE_SIZE) as number) || 4096;
    this.applyPixelRatio();
  }

  private applyPixelRatio(): void {
    const pr = Math.min(3, (window.devicePixelRatio || 1) * this.qualityScale);
    this.gl.setPixelRatio(pr);
    this.overlay.setPixelRatio(pr);
  }

  /** Rebuild the WebGL renderers (GPU preference / quality change). Scene + camera are re-rendered by the caller. */
  rebuild(opts: Partial<RendererOptions>): void {
    if (opts.gpu !== undefined) this.gpu = opts.gpu;
    if (opts.qualityScale !== undefined) this.qualityScale = opts.qualityScale;
    if (opts.shadows !== undefined) this.shadows = opts.shadows;
    this.gl.dispose();
    this.gl.forceContextLoss();
    this.gl.domElement.remove();
    this.overlay.dispose();
    this.overlay.forceContextLoss();
    this.overlay.domElement.remove();
    this.createGl();
    this.resize();
  }

  setQuality(scale: number): void {
    this.qualityScale = scale;
    this.applyPixelRatio();
    this.resize();
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.gl.shadowMap.enabled = on;
    // materials need a recompile when shadow maps toggle
    this.gl.shadowMap.needsUpdate = true;
  }

  resize(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    if (w === this.width && h === this.height && this.gl.domElement.width) return;
    this.width = w; this.height = h;
    this.gl.setSize(w, h, true);
    this.overlay.setSize(w, h, true);
    this.css3d.setSize(w, h);
    for (const fn of this.listeners) fn(w, h);
  }

  onResize(fn: (w: number, h: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get aspect(): number { return this.width / Math.max(1, this.height); }

  /** Render all layers. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    camera.layers.set(LAYER_MAIN);
    camera.layers.enable(LAYER_GIZMO);
    this.gl.render(scene, camera);
    if (this.css3dNeeded) this.css3d.render(scene, camera);
    if (this.overlayNeeded) {
      camera.layers.set(LAYER_PIXEL_GRID);
      this.overlay.render(scene, camera);
      camera.layers.set(LAYER_MAIN);
      camera.layers.enable(LAYER_GIZMO);
      this.overlayEl.style.visibility = 'visible';
    } else {
      this.overlayEl.style.visibility = 'hidden';
    }
  }

  /** Render the main + overlay layers into an offscreen canvas at an arbitrary size (exports). */
  renderToCanvas(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, includeGrid = true): HTMLCanvasElement {
    const prevSize = new THREE.Vector2();
    this.gl.getSize(prevSize);
    const prevPr = this.gl.getPixelRatio();
    const target = document.createElement('canvas');
    target.width = width; target.height = height;
    const ctx2d = target.getContext('2d')!;
    const isPersp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    const prevAspect = isPersp ? (camera as THREE.PerspectiveCamera).aspect : 0;
    if (isPersp) { (camera as THREE.PerspectiveCamera).aspect = width / height; (camera as THREE.PerspectiveCamera).updateProjectionMatrix(); }
    this.gl.setPixelRatio(1);
    this.gl.setSize(width, height, false);
    camera.layers.set(LAYER_MAIN);
    if (includeGrid) camera.layers.enable(LAYER_PIXEL_GRID);
    this.gl.render(scene, camera);
    ctx2d.drawImage(this.gl.domElement, 0, 0);
    camera.layers.set(LAYER_MAIN);
    camera.layers.enable(LAYER_GIZMO);
    this.gl.setPixelRatio(prevPr);
    this.gl.setSize(prevSize.x, prevSize.y, false);
    if (isPersp) { (camera as THREE.PerspectiveCamera).aspect = prevAspect; (camera as THREE.PerspectiveCamera).updateProjectionMatrix(); }
    return target;
  }

  dispose(): void {
    this.ro.disconnect();
    this.gl.dispose();
    this.overlay.dispose();
    this.host.replaceChildren();
  }
}
