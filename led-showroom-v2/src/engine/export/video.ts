/**
 * Record video (v1 8410–8892 + render-loop hook 3776–3837).
 *
 * Every rendered frame (engine 'frame' event) is composited exactly like Save Image — backdrop,
 * WebGL scene (websites as textured planes), locked to the crop rect chosen at start — into a
 * record canvas, then encoded:
 *   • WebCodecs VideoEncoder → mp4-muxer (H.264 → VP9 → VP8 probe order), keyframe every 2 s,
 *     fastStart 'in-memory', firstTimestampBehavior 'offset'; or
 *   • MediaRecorder on `recordCanvas.captureStream(fps)` → WebM when WebCodecs is unavailable.
 *
 * Frame source: at scale 1 the scene is re-rendered into the live WebGL canvas without the gizmo
 * layer and read back (cheap, no reallocation). At other scales `renderToCanvas` renders offscreen
 * and the viewport is repainted afterwards (about twice the GPU cost — fine for short takes).
 *
 * The frame size (and crop) is locked at setup. If the viewport / drawing buffer changes size
 * mid-take (dock toggled, window resized, DPR change) the live canvas no longer matches, so those
 * frames are rendered through `renderToCanvas` at the locked size instead — the file keeps a constant
 * frame size and framing, and the user is told once.
 *
 * A take always contains at least one frame: the first composite is encoded synchronously at the end
 * of setup, so a Record→Stop double-click or a hidden tab (no rAF) still produces a valid file.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Engine } from '../Engine';
import { LAYER_MAIN, LAYER_PIXEL_GRID } from '../scene/Renderer';
import {
  autoCropRect, createWebsiteOverlays, downloadBlob, entityScreenBBox, evenRect, loadBackdropPhoto,
  paintBackdrop, rasterizeIframes, timestampName, type Rect, type WebsiteOverlays,
} from './composite';
import { exportSize } from './image';

export interface RecordVideoOptions {
  /** Auto-stop after this many seconds (max 600). Default: until `stop()` (turntable: one full turn). */
  durationSec?: number;
  fps?: number;            // default 30
  bitrate?: number;        // default 8e6
  /** Frame size relative to the viewport CSS size. Default 1 (the live canvas at device pixel ratio). */
  scale?: number;
  /** Orbit the camera around its target during the take (one full turn per `durationSec`, default 12 s). */
  turntable?: boolean;
  crop?: 'auto' | 'none';
  /** Re-rasterise website iframes during the take (expensive; default off). */
  liveWebsites?: boolean;
  includeGrid?: boolean;
  onProgress?: (elapsedSec: number) => void;
  fileName?: string;
  noDownload?: boolean;
}

export interface Recording {
  /** Stop the take and resolve with the encoded file (same promise as `promise`). */
  stop(): Promise<Blob>;
  promise: Promise<Blob>;
  readonly recording: boolean;
  /** 'mp4' (WebCodecs) or 'webm' (MediaRecorder); null until setup finishes. */
  readonly format: 'mp4' | 'webm' | null;
}

interface CodecCandidate { codec: string; mux: 'avc' | 'vp9'; label: string }

/** Probe order (v1): H.264 High → VP9 → VP8 (muxed as vp09 — non-standard, last resort). */
export const CODEC_CANDIDATES: CodecCandidate[] = [
  { codec: 'avc1.640032', mux: 'avc', label: 'H.264' },
  { codec: 'vp09.00.10.08', mux: 'vp9', label: 'VP9' },
  { codec: 'vp8', mux: 'vp9', label: 'VP8' },
];

export const MAX_RECORD_SEC = 600;
export const KEYFRAME_INTERVAL_US = 2_000_000;
export const MAX_ENCODE_QUEUE = 4;
/** Re-rasterise live websites every N encoded frames. */
export const LIVE_WEBSITE_EVERY_N_FRAMES = 15;

export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function pickCodec(width: number, height: number, bitrate: number, framerate: number): Promise<CodecCandidate | null> {
  if (!hasWebCodecs()) return null;
  for (const cc of CODEC_CANDIDATES) {
    try {
      const res = await VideoEncoder.isConfigSupported({ codec: cc.codec, width, height, bitrate, framerate });
      if (res.supported) return cc;
    } catch { /* try the next one */ }
  }
  return null;
}

/** True when a WebCodecs encoder + MP4 mux path is available in this browser. */
export async function isMp4Supported(): Promise<boolean> {
  return (await pickCodec(1280, 720, 8_000_000, 30)) !== null;
}

/** mp4-muxer needs a colour space on the decoder config; Chrome sometimes leaves it null. */
function withColorSpace(meta: EncodedVideoChunkMetadata | undefined): EncodedVideoChunkMetadata | undefined {
  const dc = meta?.decoderConfig;
  if (!dc) return meta;
  const cs = dc.colorSpace;
  if (cs && cs.primaries) return meta;
  return { ...meta, decoderConfig: { ...dc, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } } };
}

/** Start recording the viewport. Setup is asynchronous; `stop()` waits for it. */
export function recordVideo(engine: Engine, opts: RecordVideoOptions = {}): Recording {
  const fps = Math.max(1, Math.min(60, opts.fps ?? 30));
  const bitrate = opts.bitrate ?? 8_000_000;
  const scale = opts.scale ?? 1;
  const includeGrid = opts.includeGrid ?? true;
  const durationSec = Math.min(MAX_RECORD_SEC, opts.durationSec ?? (opts.turntable ? 12 : MAX_RECORD_SEC));
  const turnSec = opts.durationSec ?? 12;

  let recording = false;
  let stopRequested = false;
  let format: 'mp4' | 'webm' | null = null;
  let resolveBlob!: (b: Blob) => void;
  let rejectBlob!: (e: unknown) => void;
  const promise = new Promise<Blob>((res, rej) => { resolveBlob = res; rejectBlob = rej; });
  promise.catch(() => { /* surfaced through stop()/promise by the caller */ });

  /* ── state filled in by setup ── */
  const renderer = engine.renderer, gl = renderer.gl;
  const camera = () => engine.camera.camera;
  const size = exportSize(renderer.width, renderer.height, scale);
  const useLiveCanvas = Math.abs(scale - 1) < 1e-6;
  // Full frame size the crop is expressed in (live canvas is DPR-scaled).
  let fullW = 0, fullH = 0;
  let crop: Rect = { x: 0, y: 0, w: 2, h: 2 };
  let photo: HTMLImageElement | null = null;
  let overlays: WebsiteOverlays | null = null;
  let recordCanvas: HTMLCanvasElement | null = null;
  let rctx: CanvasRenderingContext2D | null = null;
  let encoder: VideoEncoder | null = null;
  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let mediaChunks: Blob[] = [];
  let mediaMime = 'video/webm';
  let release: (() => void) | null = null;
  let offFrame: (() => void) | null = null;
  let offResize: (() => void) | null = null;
  let startTime = 0, lastEncode = -Infinity, lastKeyUs = -Infinity, frameCount = 0;
  /** Encoded chunks handed to the muxer (mp4-muxer throws on finalize() with none). */
  let chunks = 0;
  let encoderError: Error | null = null;
  let liveInFlight = false;
  let resizeWarned = false;
  const controls = engine.camera.controls;
  const prevAutoRotate = controls.autoRotate, prevAutoSpeed = controls.autoRotateSpeed;
  const prevSelectionVisible = engine.selectionHelper.group.visible;

  const restoreScene = () => {
    if (offFrame) { offFrame(); offFrame = null; }
    if (offResize) { offResize(); offResize = null; }
    if (release) { release(); release = null; }
    if (overlays) { overlays.dispose(); overlays = null; }
    controls.autoRotate = prevAutoRotate;
    controls.autoRotateSpeed = prevAutoSpeed;
    engine.selectionHelper.group.visible = prevSelectionVisible;
    engine.invalidate();
  };

  /** Render the scene (no gizmo layer) and return the canvas holding the full frame. */
  const renderFrame = (): HTMLCanvasElement => {
    const cam = camera();
    engine.env.update(cam);
    // The live buffer is only a valid source while it still has the locked frame size; after a
    // resize / DPR change fall through to an offscreen render at fullW × fullH so the crop stays valid.
    if (useLiveCanvas && gl.domElement.width === fullW && gl.domElement.height === fullH) {
      cam.layers.set(LAYER_MAIN);
      if (includeGrid) cam.layers.enable(LAYER_PIXEL_GRID);
      gl.render(engine.scene.scene, cam);
      cam.layers.set(LAYER_MAIN);
      return gl.domElement;
    }
    const c = renderer.renderToCanvas(engine.scene.scene, cam, fullW, fullH, includeGrid);
    engine.renderNow(); // renderToCanvas resized the live canvas; repaint the viewport
    return c;
  };

  const composite = (): HTMLCanvasElement | null => {
    if (!recordCanvas || !rctx) return null;
    const src = renderFrame();
    const theme = engine.env.theme;
    paintBackdrop(rctx, photo, engine.doc.environment.backdrop.color, fullW, fullH, crop, { top: theme.backdropTop, bottom: theme.backdropBottom });
    rctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    return recordCanvas;
  };

  const refreshLiveWebsites = () => {
    if (liveInFlight || !overlays || overlays.count === 0) return;
    liveInFlight = true;
    rasterizeIframes(engine, { force: true })
      .then(r => { if (recording) overlays?.refresh(r); })
      .catch(() => { /* keep the last raster */ })
      .finally(() => { liveInFlight = false; });
  };

  /** Hand a composited frame to the WebCodecs encoder (no-op on the MediaRecorder path). */
  const encodeFrame = (frame: HTMLCanvasElement, timestampUs: number) => {
    if (!encoder || encoder.state !== 'configured') return;
    const keyFrame = timestampUs - lastKeyUs >= KEYFRAME_INTERVAL_US;
    if (keyFrame) lastKeyUs = timestampUs;
    const vf = new VideoFrame(frame, { timestamp: timestampUs, alpha: 'discard' });
    try { encoder.encode(vf, { keyFrame }); } finally { vf.close(); }
  };

  const onFrame = () => {
    if (!recording || stopRequested) return;
    const now = performance.now();
    const elapsed = (now - startTime) / 1000;
    if (elapsed >= durationSec) { void stop(); return; }
    if (now - lastEncode < (1000 / fps) * 0.9) return; // throttle to the target fps
    if (encoder && encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return; // backpressure
    lastEncode = now;
    const frame = composite();
    if (!frame) return;
    encodeFrame(frame, Math.round((now - startTime) * 1000));
    // MediaRecorder path: captureStream() picks the composite up by itself.
    frameCount++;
    if (opts.liveWebsites && frameCount % LIVE_WEBSITE_EVERY_N_FRAMES === 0) refreshLiveWebsites();
    opts.onProgress?.(elapsed);
  };

  const setup = async (): Promise<void> => {
    fullW = useLiveCanvas ? gl.domElement.width : size.w;
    fullH = useLiveCanvas ? gl.domElement.height : size.h;
    if (fullW < 2 || fullH < 2) throw new Error('Viewport is too small to record');
    const photoUrl = engine.env.photo;
    const [p, rasters] = await Promise.all([loadBackdropPhoto(photoUrl), rasterizeIframes(engine)]);
    photo = p;

    // Crop locked for the whole take so the encoder size is constant (v1: no crop when a venue photo is staged).
    let r: Rect = { x: 0, y: 0, w: fullW, h: fullH };
    if ((opts.crop ?? 'auto') === 'auto' && !photoUrl) {
      const padScale = fullW / Math.max(1, renderer.width);
      r = autoCropRect(entityScreenBBox(engine, undefined, { w: fullW, h: fullH }), fullW, fullH, Math.round(40 * padScale));
    }
    crop = evenRect(r);

    recordCanvas = document.createElement('canvas');
    recordCanvas.width = crop.w; recordCanvas.height = crop.h;
    rctx = recordCanvas.getContext('2d');
    if (!rctx) throw new Error('Could not create the record canvas');

    const cc = await pickCodec(crop.w, crop.h, bitrate, fps);
    if (cc) {
      muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: cc.mux, width: crop.w, height: crop.h },
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
      });
      const m = muxer;
      chunks = 0;
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          try { m.addVideoChunk(chunk, withColorSpace(meta)); chunks++; }
          catch (e) { console.error('[record] mux error', e); }
        },
        error: e => {
          console.error('[record] encoder error', e);
          encoderError = new Error('Video encoder error: ' + e.message);
          engine.toast('error', encoderError.message);
          void stop();
        },
      });
      encoder.configure({ codec: cc.codec, width: crop.w, height: crop.h, bitrate, framerate: fps });
      format = 'mp4';
      console.info('[record] WebCodecs', cc.label, `${crop.w}×${crop.h}@${fps}`);
    } else {
      if (typeof MediaRecorder === 'undefined' || typeof recordCanvas.captureStream !== 'function') throw new Error('Video recording is not supported in this browser');
      mediaStream = recordCanvas.captureStream(fps);
      mediaMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mediaMime, videoBitsPerSecond: bitrate });
      mediaChunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) mediaChunks.push(e.data); };
      format = 'webm';
      console.info('[record] MediaRecorder', mediaMime, `${crop.w}×${crop.h}@${fps}`);
    }

    // Scene state for the take
    overlays = createWebsiteOverlays(engine, rasters);
    engine.selectionHelper.group.visible = false;
    if (opts.turntable) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 60 / Math.max(1, turnSec); // OrbitControls: one turn per 60/speed s
    }
    release = engine.holdContinuous();
    // A viewport resize mid-take is handled by renderFrame (offscreen render at the locked size);
    // just tell the user once why the video keeps the original framing.
    resizeWarned = false;
    offResize = renderer.onResize(() => {
      if (!recording || resizeWarned) return;
      resizeWarned = true;
      engine.toast('info', 'Viewport resized — the recording keeps its original frame size');
    });
    startTime = performance.now();
    lastEncode = startTime; lastKeyUs = -Infinity; frameCount = 0;
    recording = true;
    mediaRecorder?.start(1000);
    // First frame right away (timestamp 0, key frame) so the stream has content and the take is
    // never empty even if stop() lands before the next 'frame' event.
    const first = composite();
    if (first) { encodeFrame(first, 0); frameCount = 1; }
    offFrame = engine.on('frame', onFrame);
    // Wall-clock guard: a hidden tab stops 'frame' events, so end a timed take on time regardless.
    if (Number.isFinite(durationSec)) durationTimer = window.setTimeout(() => { if (recording) void stop(); }, (durationSec + 0.5) * 1000);
    engine.invalidate();
  };

  const finish = async (): Promise<Blob> => {
    let blob: Blob;
    if (encoder && muxer) {
      const enc = encoder, m = muxer;
      encoder = null; muxer = null;
      try {
        if (enc.state === 'configured') await enc.flush();
      } catch (e) {
        console.warn('[record] encoder flush failed', e);
      } finally {
        try { enc.close(); } catch { /* already closed */ }
      }
      // mp4-muxer 5.x dereferences the first chunk's decoder config in finalize(): with no chunk it
      // throws an opaque TypeError, so check first and turn any mux failure into a readable error.
      if (chunks === 0) throw encoderError ?? new Error('No frames were recorded');
      try { m.finalize(); } catch (e) {
        throw new Error('Could not finalise the MP4 file' + (e instanceof Error && e.message ? `: ${e.message}` : ''));
      }
      const buf = m.target.buffer;
      if (!buf || buf.byteLength === 0) throw new Error('No frames were recorded');
      blob = new Blob([buf], { type: 'video/mp4' });
    } else if (mediaRecorder) {
      const mr = mediaRecorder;
      mediaRecorder = null;
      blob = await new Promise<Blob>((resolve, reject) => {
        mr.onstop = () => resolve(new Blob(mediaChunks, { type: mediaMime.split(';')[0] }));
        mr.onerror = () => reject(new Error('MediaRecorder failed'));
        if (mr.state === 'inactive') mr.onstop(new Event('stop')); else mr.stop();
      });
      mediaStream?.getTracks().forEach(t => t.stop());
      mediaStream = null;
      mediaChunks = [];
      if (blob.size === 0) throw new Error('No frames were recorded');
    } else {
      throw new Error('Recording was not started');
    }
    return blob;
  };

  let stopping: Promise<Blob> | null = null;
  let durationTimer: number | null = null;
  const stop = (): Promise<Blob> => {
    if (stopping) return stopping;
    if (durationTimer !== null) { window.clearTimeout(durationTimer); durationTimer = null; }
    stopRequested = true;
    stopping = (async () => {
      await setupDone; // wait for setup (errors already rejected the promise)
      recording = false;
      restoreScene();
      const blob = await finish();
      if (!opts.noDownload) downloadBlob(blob, opts.fileName ?? timestampName(format === 'mp4' ? 'mp4' : 'webm'));
      return blob;
    })();
    stopping.then(resolveBlob, rejectBlob);
    return promise;
  };

  const setupDone = setup().catch(err => {
    recording = false;
    restoreScene();
    try { encoder?.close(); } catch { /* ignore */ }
    encoder = null; muxer = null;
    mediaStream?.getTracks().forEach(t => t.stop());
    mediaRecorder = null; mediaStream = null;
    stopping = Promise.reject(err);
    stopping.catch(() => {});
    rejectBlob(err);
  });

  return {
    stop,
    promise,
    get recording() { return recording; },
    get format() { return format; },
  };
}
