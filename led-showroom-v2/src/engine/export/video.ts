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
 *
 * A codec the browser says it supports can still put nothing in the file: a hardware encoder that
 * returns no chunks, or chunks the muxer will not take. So each candidate first encodes the first
 * frame into a throwaway muxer and is only used if that comes out as a file; otherwise the next one
 * is tried, then MediaRecorder, and the person is told which it fell back to and why.
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
/** The quickest a turntable turns: one full turn in this many seconds (12 degrees a second). */
export const TURNTABLE_TURN_SEC = 30;
export const KEYFRAME_INTERVAL_US = 2_000_000;
export const MAX_ENCODE_QUEUE = 4;
/** Re-rasterise live websites every N encoded frames. */
export const LIVE_WEBSITE_EVERY_N_FRAMES = 15;

export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/** A codec the browser says it cannot encode at the size: the usual fall-through, not worth a word. */
export const NOT_SUPPORTED = 'not supported at this size';

/** Why a candidate would not do, or null where it puts a frame in a file. */
export type EncoderProbe = (cc: CodecCandidate) => Promise<string | null>;

/**
 * The first of `candidates` that `probe` finds puts a frame in a file, with why each one before it
 * would not; null where none does.
 */
export async function pickWorkingCodec(candidates: readonly CodecCandidate[], probe: EncoderProbe): Promise<{ cc: CodecCandidate | null; failed: string[] }> {
  const failed: string[] = [];
  for (const cc of candidates) {
    let why: string | null;
    try { why = await probe(cc); } catch (e) { why = e instanceof Error ? e.message || e.name : String(e); }
    if (why === null) return { cc, failed };
    failed.push(`${cc.label}: ${why}`);
  }
  return { cc: null, failed };
}

/**
 * Encode `frame` with `cc` into a throwaway MP4 and finalise it: null where that works, else why.
 * Nothing of it is kept; the take opens its own encoder and muxer once a codec is known to work.
 */
export async function probeEncoder(cc: CodecCandidate, frame: CanvasImageSource, width: number, height: number, bitrate: number, framerate: number): Promise<string | null> {
  // A browser that does not know the codec string may reject rather than answer: the same as no.
  const supported = await VideoEncoder.isConfigSupported({ codec: cc.codec, width, height, bitrate, framerate })
    .then(s => !!s.supported, () => false);
  if (!supported) return NOT_SUPPORTED;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: cc.mux, width, height },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let chunks = 0;
  let fault: string | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try { muxer.addVideoChunk(chunk, withColorSpace(meta)); chunks++; }
      catch (e) { fault ??= `the MP4 writer refused a frame (${e instanceof Error ? e.message : String(e)})`; }
    },
    error: e => { fault ??= `encoder error (${e.message})`; },
  });
  try {
    encoder.configure({ codec: cc.codec, width, height, bitrate, framerate });
    const vf = new VideoFrame(frame, { timestamp: 0, alpha: 'discard' });
    try { encoder.encode(vf, { keyFrame: true }); } finally { vf.close(); }
    // An encoder that never settles the flush would hold the take's setup, and stop(), forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>(res => { timer = setTimeout(() => res('late'), PROBE_TIMEOUT_MS); });
    const flushed = encoder.flush().then(() => 'done' as const);
    flushed.catch(() => { /* closed below once late: that rejection is expected */ });
    const done = await Promise.race([flushed, late]).finally(() => clearTimeout(timer));
    if (done === 'late') fault ??= `the encoder did not finish a test frame in ${PROBE_TIMEOUT_MS / 1000} s`;
  } catch (e) {
    fault ??= e instanceof Error ? e.message || e.name : String(e);
  } finally {
    try { encoder.close(); } catch { /* already closed */ }
  }
  if (fault) return fault;
  if (chunks === 0) return 'the encoder returned no frames';
  try { muxer.finalize(); } catch (e) { return `the MP4 file would not close (${e instanceof Error ? e.message : String(e)})`; }
  return muxer.target.buffer.byteLength ? null : 'the MP4 file came out empty';
}

/** How long a codec probe waits for its one frame. */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * The codec a take would record MP4 with, by the same probe the take runs (on a blank 1280x720
 * frame), or null where it would fall back to WebM. The take probes again at its own size.
 */
export async function previewMp4Codec(): Promise<string | null> {
  if (!hasWebCodecs() || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  if (g) { g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); }
  const { cc } = await pickWorkingCodec(CODEC_CANDIDATES, x => probeEncoder(x, c, c.width, c.height, 8_000_000, 30));
  return cc?.label ?? null;
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
  const durationSec = Math.min(MAX_RECORD_SEC, opts.durationSec ?? (opts.turntable ? TURNTABLE_TURN_SEC : MAX_RECORD_SEC));
  // A take of its own length turns once over that length, but never quicker than the slowest turn:
  // a short take shows part of the turn rather than whipping round.
  const turnSec = Math.max(TURNTABLE_TURN_SEC, opts.durationSec ?? TURNTABLE_TURN_SEC);

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
  /** The first chunk the muxer refused, so a take with none says why rather than "no frames". */
  let muxError: Error | null = null;
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

    const probeFrame = composite();
    const { cc, failed } = hasWebCodecs() && probeFrame
      ? await pickWorkingCodec(CODEC_CANDIDATES, c => probeEncoder(c, probeFrame, crop.w, crop.h, bitrate, fps))
      : { cc: null, failed: [] as string[] };
    // Only a codec the browser offered and then could not record with is worth telling about.
    const broke = failed.filter(f => !f.endsWith(`: ${NOT_SUPPORTED}`));
    if (failed.length) console.info('[record] codecs passed over:', failed);
    if (broke.length) engine.toast('info', `Recording as ${cc ? `${cc.label} (MP4)` : 'WebM'}: ${broke.join('; ')}`);
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
          catch (e) { console.error('[record] mux error', e); muxError ??= e instanceof Error ? e : new Error(String(e)); }
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
      /*
       * Frame first, so the turn is around the BUILD.
       *
       * OrbitControls spins about `controls.target`, and that is left wherever the last pan, focus
       * or double-click put it. A turntable from there sweeps the room while the build drifts
       * across the frame, or out of it. Framing puts the target on the build and the camera at a
       * distance that fits it, which is what "a 360 of the build" means.
       *
       * With something selected it frames THAT instead (frameSelection falls back to everything
       * when nothing is selected) - a turn around one wall rather than the whole floor. The camera
       * is left where the take put it rather than restored: that is the view the video is of, and
       * it is the same state the Frame control gives, so there is nothing surprising to undo.
       */
      engine.frameSelection(false);
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
      if (chunks === 0) {
        throw encoderError
          ?? (muxError ? new Error(`The MP4 writer refused every frame: ${muxError.message}`) : new Error('No frames were recorded: the encoder returned none'));
      }
      // Frames refused after some went in: the file holds what came before, so say it stops early.
      if (muxError && !encoderError) engine.toast('error', `The video stops early: the MP4 writer refused a frame after ${chunks} (${muxError.message})`);
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
