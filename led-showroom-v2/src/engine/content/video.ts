/**
 * Video content pipeline: codec sniffing, decode-path selection, and the two
 * "frame players" that turn a video source into a `<canvas>` the renderer can
 * upload as a texture every frame.
 *
 *  - {@link sniffVideoCodecs} / {@link parseMp4Codecs} / {@link pickDecodePath}
 *    port v1's `sniffVideoCodecs` / `pickVideoDecodePath` (index.html 6046-6126).
 *  - {@link createNativeVideoPlayer} ports the hidden `<video>` -> `<canvas>`
 *    pump from v1 `createContentEl` (5305-5463).
 *  - {@link createHevcPlayer} ports `createHEVCContentEl` (5018-5251) and
 *    `extractHEVCDescription` (5259-5294): MP4Box demux -> WebCodecs
 *    VideoDecoder -> canvas with pts-based presentation.
 *  - {@link registerVideoForGestureResume} / {@link installGestureResume} port
 *    `resumeAllVideos` (4950-4975).
 *  - {@link createSharedPlayer} ports the ref-counted span-mode video
 *    (4939-5007).
 *
 * All DOM / WebCodecs access lives inside functions so the module can be
 * imported in node (the pure helpers are unit-tested there).
 */
import type { MP4BoxFile, MP4BoxBuffer, MP4Sample, MP4TrackInfo, DataStream as MP4DataStream } from 'mp4box';

/* ------------------------------------------------------------------------ */
/* Codec sniffing                                                            */
/* ------------------------------------------------------------------------ */

/** What we learned about a video file before deciding how to decode it. */
export interface CodecInfo {
  /** Container family, detected from the file signature. */
  container: 'mp4' | 'webm' | 'other';
  /**
   * RFC 6381 codec strings found in the file (e.g. 'hvc1.1.6.L93.B0',
   * 'avc1.64001F', 'mp4a'). Empty when nothing could be read.
   */
  codecs: string[];
  /** Contains an H.265 / HEVC video track (hvc1 / hev1). */
  hasHevc: boolean;
  /** Contains an H.264 / AVC video track (avc1 / avc3). */
  hasAvc: boolean;
  /** The browser's `<video>` element reports it can decode this file. */
  canPlayNatively: boolean;
  /** MIME string with codecs parameter, suitable for `canPlayType`. */
  mime: string;
}

/** Bytes we peek from the head (and, for mp4, the tail) of a file when sniffing. v1: 256 KB. */
export const SNIFF_BYTES = 256 * 1024;

/** ISOBMFF boxes we descend into looking for `stsd`. */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** Video sample-entry fourccs we know how to name. */
const HEVC_FOURCC = new Set(['hvc1', 'hev1']);
const AVC_FOURCC = new Set(['avc1', 'avc2', 'avc3', 'avc4']);

/** Sample-entry fourccs the v1 substring scan recognised (6046-6058) plus a few audio ones. */
const SCAN_FOURCC = ['hev1', 'hvc1', 'avc1', 'avc3', 'av01', 'vp09', 'mp4a'];

function fourcc(u8: Uint8Array, off: number): string {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Build the RFC 6381 codec string for an `avcC` payload (`avc1.PPCCLL`).
 * `off` points at configurationVersion. Mirrors mp4box's avc1SampleEntry.getCodec.
 */
function avcCodecString(base: string, u8: Uint8Array, off: number, end: number): string {
  if (off + 4 > end) return base;
  return `${base}.${hex2(u8[off + 1])}${hex2(u8[off + 2])}${hex2(u8[off + 3])}`;
}

/**
 * Build the RFC 6381 codec string for an `hvcC` payload
 * (`hvc1.<space><profile>.<compat>.<tier><level>.<constraints>`), e.g.
 * 'hvc1.1.6.L93.B0'. Mirrors mp4box's hvc1SampleEntry.getCodec; the
 * compatibility flags are bit-reversed and rendered unsigned.
 */
function hevcCodecString(base: string, u8: Uint8Array, off: number, end: number): string {
  // version(1) profile byte(1) compat(4) constraints(6) level(1) = 13 bytes
  if (off + 13 > end) return base;
  const b = u8[off + 1];
  const profileSpace = (b >> 6) & 0x3;
  const tier = (b >> 5) & 0x1;
  const profileIdc = b & 0x1f;
  const compat = ((u8[off + 2] << 24) | (u8[off + 3] << 16) | (u8[off + 4] << 8) | u8[off + 5]) >>> 0;
  let reversed = 0;
  let val = compat;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed | (val & 1)) >>> 0;
    if (i === 31) break;
    reversed = (reversed << 1) >>> 0;
    val >>>= 1;
  }
  const constraints: number[] = [];
  for (let i = 0; i < 6; i++) constraints.push(u8[off + 6 + i]);
  const level = u8[off + 12];
  let s = `${base}.${['', 'A', 'B', 'C'][profileSpace]}${profileIdc}.${reversed.toString(16).toUpperCase()}.${tier === 0 ? 'L' : 'H'}${level}`;
  let hasByte = false;
  let constraintStr = '';
  for (let i = 5; i >= 0; i--) {
    if (constraints[i] || hasByte) {
      constraintStr = `.${constraints[i].toString(16).toUpperCase()}${constraintStr}`;
      hasByte = true;
    }
  }
  return s + constraintStr;
}

/** Size of the fixed VisualSampleEntry fields after the box header (ISO 14496-12 12.1.3). */
const VISUAL_SAMPLE_ENTRY_FIXED = 78;
/** Size of the fixed AudioSampleEntry fields after the box header (12.2.3). */
const AUDIO_SAMPLE_ENTRY_FIXED = 28;

/**
 * Read a box header at `off`. Returns null when the header is malformed or
 * runs past `end`. `payload` is the offset of the first byte after the header;
 * `next` is where the following sibling starts (clamped to `end`).
 */
function readBox(u8: Uint8Array, off: number, end: number): { type: string; payload: number; next: number } | null {
  if (off + 8 > end) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let size = dv.getUint32(off);
  const type = fourcc(u8, off + 4);
  let header = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    // 64-bit largesize; high word must be 0 for anything we can address
    const hi = dv.getUint32(off + 8);
    const lo = dv.getUint32(off + 12);
    if (hi !== 0) return null;
    size = lo;
    header = 16;
  } else if (size === 0) {
    size = end - off; // box extends to end of data
  }
  if (size < header) return null;
  if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
  return { type, payload: off + header, next: Math.min(end, off + size) };
}

/** Walk one stsd payload, collecting codec strings for each sample entry. */
function readStsd(u8: Uint8Array, payload: number, end: number, out: string[]): void {
  // FullBox: version(1) flags(3) entry_count(4)
  if (payload + 8 > end) return;
  let off = payload + 8;
  while (off < end) {
    const entry = readBox(u8, off, end);
    if (!entry) break;
    const type = entry.type;
    let codec = type;
    const isVideo = HEVC_FOURCC.has(type) || AVC_FOURCC.has(type) || type === 'av01' || type === 'vp09' || type === 'vp08';
    const fixed = isVideo ? VISUAL_SAMPLE_ENTRY_FIXED : (type === 'mp4a' || type === 'ac-3' || type === 'ec-3' || type === 'Opus' || type === 'fLaC' ? AUDIO_SAMPLE_ENTRY_FIXED : -1);
    if (fixed >= 0) {
      // Children (avcC / hvcC / esds / ...) follow the fixed fields.
      let c = entry.payload + fixed;
      while (c < entry.next) {
        const child = readBox(u8, c, entry.next);
        if (!child) break;
        if (child.type === 'avcC' && AVC_FOURCC.has(type)) codec = avcCodecString(type, u8, child.payload, child.next);
        else if (child.type === 'hvcC' && HEVC_FOURCC.has(type)) codec = hevcCodecString(type, u8, child.payload, child.next);
        c = child.next;
      }
    }
    out.push(codec);
    off = entry.next;
  }
}

/** Recursively walk boxes in [off, end) descending into container boxes; returns true when an stsd was found. */
function walkBoxes(u8: Uint8Array, off: number, end: number, out: string[], depth = 0): boolean {
  let found = false;
  while (off < end) {
    const box = readBox(u8, off, end);
    if (!box) break;
    if (box.type === 'stsd') {
      readStsd(u8, box.payload, box.next, out);
      found = true;
    } else if (CONTAINER_BOXES.has(box.type) && depth < 8) {
      if (walkBoxes(u8, box.payload, box.next, out, depth + 1)) found = true;
    }
    if (box.next <= off) break;
    off = box.next;
  }
  return found;
}

/** Latin-1 decode without TextDecoder (works on every runtime, matches v1's 'latin1'). */
function latin1(u8: Uint8Array): string {
  let s = '';
  const CH = 8192;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  }
  return s;
}

/**
 * Pure MP4 codec parser. Walks the ISOBMFF box tree looking for
 * `moov/trak/mdia/minf/stbl/stsd` and reports one codec string per sample
 * entry (full RFC 6381 strings for avcN / hvc1 / hev1, bare fourcc otherwise).
 *
 * The buffer may be any slice of the file: if it does not start at a box
 * boundary (a tail slice, say) every `moov` fourcc in it is tried as a box
 * start. When no `stsd` is reachable at all it falls back to v1's substring
 * scan for known fourccs (index.html 6046-6058), so a truncated moov still
 * yields "has HEVC" / "has AVC" answers.
 *
 * @param buf raw bytes from the file (head, tail, or the whole thing)
 * @returns `codecs` in file order (deduplicated), and `source` saying how they were found
 */
export function parseMp4Codecs(buf: ArrayBuffer): { codecs: string[]; source: 'stsd' | 'scan' | 'none' } {
  const u8 = new Uint8Array(buf);
  const out: string[] = [];
  let found = walkBoxes(u8, 0, u8.length, out);
  if (!found) {
    // Not box-aligned (or moov beyond this slice): try every 'moov' occurrence as a box start.
    for (let i = 4; i + 4 <= u8.length; i++) {
      if (u8[i] === 0x6d && u8[i + 1] === 0x6f && u8[i + 2] === 0x6f && u8[i + 3] === 0x76) {
        const box = readBox(u8, i - 4, u8.length);
        if (box && box.type === 'moov' && walkBoxes(u8, box.payload, box.next, out)) { found = true; break; }
      }
    }
  }
  if (found) return { codecs: dedupe(out), source: 'stsd' };
  const text = latin1(u8);
  const scanned = SCAN_FOURCC.filter(f => text.includes(f));
  return { codecs: scanned, source: scanned.length ? 'scan' : 'none' };
}

function dedupe(list: string[]): string[] {
  return list.filter((v, i, a) => a.indexOf(v) === i);
}

/** Codec ids inside a Matroska/WebM head, mapped to RFC 6381-ish names. */
const WEBM_CODEC_IDS: [string, string][] = [
  ['V_MPEGH/ISO/HEVC', 'hev1'],
  ['V_MPEG4/ISO/AVC', 'avc1'],
  ['V_VP9', 'vp9'],
  ['V_VP8', 'vp8'],
  ['V_AV1', 'av01'],
  ['A_OPUS', 'opus'],
  ['A_VORBIS', 'vorbis'],
];

/** Detect the container from the file signature (pure). */
export function detectContainer(head: ArrayBuffer): CodecInfo['container'] {
  const u8 = new Uint8Array(head);
  if (u8.length >= 12 && fourcc(u8, 4) === 'ftyp') return 'mp4';
  if (u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'webm';
  // Some MP4s (rare) start with a non-ftyp box such as 'free' or 'moov'.
  if (u8.length >= 8) {
    const t = fourcc(u8, 4);
    if (t === 'moov' || t === 'free' || t === 'skip' || t === 'mdat' || t === 'wide') return 'mp4';
  }
  return 'other';
}

/** Scan a WebM head for codec ids (pure). */
export function parseWebmCodecs(head: ArrayBuffer): string[] {
  const text = latin1(new Uint8Array(head));
  return WEBM_CODEC_IDS.filter(([id]) => text.includes(id)).map(([, name]) => name);
}

const isHevcCodec = (c: string): boolean => /^(hvc1|hev1)/.test(c);
const isAvcCodec = (c: string): boolean => /^avc[1-4]/.test(c);
/** Any video sample-entry we recognise (HEVC, AVC, AV1, VP9, VP8). */
const isVideoCodec = (c: string): boolean => isHevcCodec(c) || isAvcCodec(c) || /^(av01|vp09|vp08)/.test(c);

/**
 * True when a parse result is conclusive: an `stsd` was walked and it named
 * at least one video track. A head slice can contain a moov whose audio trak
 * is complete but whose video trak is cut off — that is an `stsd` result with
 * only 'mp4a' in it, and the tail must still be read (pure).
 */
export function hasVideoSampleEntry(parsed: { codecs: string[]; source: 'stsd' | 'scan' | 'none' }): boolean {
  return parsed.source === 'stsd' && parsed.codecs.some(isVideoCodec);
}

/**
 * Assemble a {@link CodecInfo} from container + codecs (pure apart from the
 * native-playability probe, which uses `document` when available).
 */
export function buildCodecInfo(container: CodecInfo['container'], codecs: string[]): CodecInfo {
  const hasHevc = codecs.some(isHevcCodec);
  const hasAvc = codecs.some(isAvcCodec);
  const mimeBase = container === 'webm' ? 'video/webm' : 'video/mp4';
  const mime = codecs.length ? `${mimeBase}; codecs="${codecs.join(', ')}"` : mimeBase;
  return { container, codecs, hasHevc, hasAvc, canPlayNatively: probeNativeSupport(hasHevc), mime };
}

/**
 * Ask the `<video>` element whether it can decode the file.
 *
 * v1 fidelity (6068-6078): only HEVC is probed — via the two exact strings
 * `hvc1.1.6.L93.B0` / `hev1.1.6.L93.B0` — and everything else is assumed
 * playable and routed to `<video>`. Without a DOM (node) HEVC is assumed
 * unplayable, everything else playable.
 */
export function probeNativeSupport(hasHevc: boolean): boolean {
  if (!hasHevc) return true;
  if (typeof document === 'undefined') return false;
  try {
    const v = document.createElement('video');
    return !!(v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')
      || v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'));
  } catch {
    return false;
  }
}

/**
 * Sniff a video file's container and codecs. Reads the first
 * {@link SNIFF_BYTES}; for mp4 files whose `moov` sits at the end
 * (non-faststart) it also reads the last {@link SNIFF_BYTES}, and finally
 * falls back to v1's substring scan. Never throws — a broken file yields an
 * empty codec list that {@link pickDecodePath} routes to `<video>`.
 *
 * Port of v1 `sniffVideoCodecs` (index.html 6046-6058), upgraded from a
 * substring scan to a real box walk so the codec strings are usable for
 * `canPlayType` and `VideoDecoder.isConfigSupported`.
 */
export async function sniffVideoCodecs(file: File | Blob): Promise<CodecInfo> {
  try {
    const head = await file.slice(0, SNIFF_BYTES).arrayBuffer();
    const container = detectContainer(head);
    if (container === 'webm') return buildCodecInfo('webm', parseWebmCodecs(head));
    let parsed = parseMp4Codecs(head);
    // Read the tail unless the head already named a video track: a truncated
    // moov can yield a complete audio stsd ('mp4a') before the video trak is
    // cut off, and that must not be mistaken for "no HEVC here".
    if (!hasVideoSampleEntry(parsed) && file.size > SNIFF_BYTES) {
      const tail = await file.slice(Math.max(0, file.size - SNIFF_BYTES), file.size).arrayBuffer();
      const tailParsed = parseMp4Codecs(tail);
      if (tailParsed.source === 'stsd') {
        // Merge: keep whatever real sample entries the head found, add the tail's.
        const headCodecs = parsed.source === 'stsd' ? parsed.codecs : [];
        parsed = { codecs: dedupe([...headCodecs, ...tailParsed.codecs]), source: 'stsd' };
      } else if (tailParsed.source === 'scan' && parsed.source === 'none') {
        parsed = tailParsed;
      }
    }
    return buildCodecInfo(container, parsed.codecs);
  } catch {
    return buildCodecInfo('other', []);
  }
}

/**
 * Decide how to play a file given its codecs (port of v1 `pickVideoDecodePath`, 6065-6078):
 *  - `'native'`: the `<video>` element (everything the browser supports — and,
 *    as in v1, anything we could not identify, so the browser gets a chance);
 *  - `'webcodecs-hevc'`: HEVC the `<video>` element refuses but WebCodecs
 *    `VideoDecoder` exists (still needs an OS/hardware decoder at runtime);
 *  - `'unsupported'`: HEVC with neither path available.
 */
export function pickDecodePath(info: CodecInfo): 'native' | 'webcodecs-hevc' | 'unsupported' {
  if (info.canPlayNatively) return 'native';
  if (info.hasHevc) {
    return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined' ? 'webcodecs-hevc' : 'unsupported';
  }
  return 'native';
}

/* ------------------------------------------------------------------------ */
/* Frame players                                                             */
/* ------------------------------------------------------------------------ */

/**
 * A decoded-video source. `canvas` always holds the latest presented frame,
 * scaled to fit the GL texture cap; the renderer uploads it as a texture and
 * `onFrame` fires whenever the canvas content changed (v1 `markDirty()`).
 */
export interface FramePlayer {
  /** Canvas holding the most recent frame. */
  canvas: HTMLCanvasElement;
  /** Current canvas width in px (<= maxTextureSize). */
  readonly width: number;
  /** Current canvas height in px (<= maxTextureSize). */
  readonly height: number;
  /** Start / resume playback (safe to call repeatedly; autoplay failures are swallowed). */
  play(): void;
  /** Pause playback; the canvas keeps the last frame. */
  pause(): void;
  /** Seek to `t` seconds. */
  seek(t: number): void;
  /** Presentation time of the frame on the canvas, in seconds. */
  readonly currentTime: number;
  /** Media duration in seconds (0 until known). */
  readonly duration: number;
  /** True while paused. */
  readonly paused: boolean;
  /** Resolves when the first frame is decodable; rejects when the source cannot be played. */
  readonly ready: Promise<void>;
  /** Stop decoding, release the media, remove listeners. Idempotent. */
  dispose(): void;
  /** Called after every canvas update — hook the renderer's dirty flag here. */
  onFrame?: () => void;
}

/** Options shared by both players. */
export interface FramePlayerOptions {
  /** GL MAX_TEXTURE_SIZE; the canvas is uniformly scaled so neither side exceeds it. Default 4096 (v1 default). */
  maxTextureSize?: number;
  /** Loop playback. Default true. */
  loop?: boolean;
  /** Mute the native element (required for autoplay). Default true. HEVC output is always silent. */
  muted?: boolean;
  /** Load progress 0-100, for the loading overlay. */
  onProgress?: (pct: number, label: string) => void;
}

/** Default GL texture cap when the caller does not know the real one (v1 `gpuMaxTextureSize` initial value). */
export const DEFAULT_MAX_TEXTURE_SIZE = 4096;

/**
 * Uniformly scale (w, h) so neither side exceeds `max` (pure).
 * v1 sizeCanvas / HEVC onReady, 5068-5075 and 5352-5363.
 */
export function fitToMax(w: number, h: number, max: number): { width: number; height: number } {
  if (w > max || h > max) {
    const scale = Math.min(max / w, max / h);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }
  return { width: w, height: h };
}

/** Delays (ms) at which v1 re-tried `startDrawing(); tryPlay()` after load (5432-5435). */
const AUTOPLAY_RETRY_MS = [100, 500, 2000, 8000] as const;
/** Watchdog interval (ms) that redraws and retries play() when the element stalls (5410-5417). */
const WATCHDOG_MS = 250;

/**
 * Build a hidden, muted, looping `<video>` element configured for autoplay
 * (v1 4977-4989 / 5317-5330). Cross-origin URLs get `crossOrigin='anonymous'`
 * so the canvas stays untainted; blob: URLs are left alone.
 */
export function createHiddenVideoElement(src: string, opts: { loop?: boolean; muted?: boolean } = {}): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = opts.muted ?? true;
  v.loop = opts.loop ?? true;
  v.playsInline = true;
  v.preload = 'auto';
  if (v.muted) v.setAttribute('muted', '');
  v.setAttribute('autoplay', '');
  if (v.loop) v.setAttribute('loop', '');
  v.setAttribute('playsinline', '');
  v.setAttribute('preload', 'auto');
  if (!src.startsWith('blob:')) v.crossOrigin = 'anonymous';
  return v;
}

/**
 * The regular video path: a hidden `<video>` is decoded by the browser and
 * every new frame is drawn into a `<canvas>` (capped to `maxTextureSize`
 * with uniform scaling). Uses `requestVideoFrameCallback` when available
 * (falls back to rAF), plus a 250 ms watchdog that redraws and retries
 * `play()` when the element is paused/throttled, and the staggered autoplay
 * retries v1 used to get past loading-timing races.
 *
 * Port of v1 `createContentEl` video branch (index.html 5305-5463) minus the
 * loading overlay (reported through `opts.onProgress` instead) and the
 * `_vid` shim (exposed as {@link FramePlayer} fields).
 *
 * The element is automatically registered for gesture-resume
 * ({@link installGestureResume}) until disposed.
 */
export function createNativeVideoPlayer(src: string, opts: FramePlayerOptions = {}): FramePlayer {
  const maxDim = opts.maxTextureSize ?? DEFAULT_MAX_TEXTURE_SIZE;
  const vid = createHiddenVideoElement(src, opts);
  const canvas = document.createElement('canvas');
  // desynchronized hint for GPU direct presentation (ignored if unsupported); Firefox fallback
  const ctx2d = (canvas.getContext('2d', { desynchronized: true, willReadFrequently: false })
    || canvas.getContext('2d')) as CanvasRenderingContext2D;

  let stopped = false;
  let drawing = false;
  let userPaused = false; // explicit pause() from the app; the watchdog must not fight it
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let rvfcHandle = 0;
  let rafHandle = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const hasRVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => { /* consumers may not await; avoid unhandled rejection */ });
  const settle = () => {
    if (settled) return;
    settled = true;
    opts.onProgress?.(100, 'Loading video… 100%');
    resolveReady();
  };

  const player: FramePlayer = {
    canvas,
    get width() { return canvas.width; },
    get height() { return canvas.height; },
    get currentTime() { return vid.currentTime; },
    get duration() { return Number.isFinite(vid.duration) ? vid.duration : 0; },
    get paused() { return vid.paused; },
    ready,
    play() {
      userPaused = false;
      setVideoUserPaused(vid, false);
      if (!stopped) { startDrawing(); tryPlay(); }
    },
    pause() {
      // Also exclude the element from gesture-resume, otherwise the next
      // click anywhere would silently undo this pause.
      userPaused = true;
      setVideoUserPaused(vid, true);
      vid.pause();
    },
    seek(t: number) { try { vid.currentTime = t; } catch { /* not seekable yet */ } },
    dispose,
  };

  // Progress tracking with numeric bar (5344-5354)
  const onProgress = () => {
    if (settled) return;
    try {
      if (vid.buffered.length > 0 && vid.duration > 0) {
        const pct = Math.round(vid.buffered.end(vid.buffered.length - 1) / vid.duration * 100);
        opts.onProgress?.(pct, `Loading video… ${pct}%`);
      }
    } catch { /* buffered may throw while empty */ }
  };
  vid.addEventListener('progress', onProgress);

  function sizeCanvas(): void {
    if (vid.videoWidth === 0) return;
    const { width, height } = fitToMax(vid.videoWidth, vid.videoHeight, maxDim);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function drawFrame(): void {
    if (stopped) return;
    if (vid.readyState >= 2 && vid.videoWidth > 0) {
      sizeCanvas();
      ctx2d.drawImage(vid, 0, 0, canvas.width, canvas.height);
      player.onFrame?.();
    }
  }

  // requestVideoFrameCallback fires exactly when a new decoded frame is ready,
  // avoiding redundant redraws and letting the GPU drive the timing.
  function videoFrameLoop(): void {
    if (stopped) return;
    drawFrame();
    rvfcHandle = vid.requestVideoFrameCallback(videoFrameLoop);
  }

  // rAF fallback for browsers without requestVideoFrameCallback
  function rafLoop(): void {
    if (stopped) return;
    drawFrame();
    rafHandle = requestAnimationFrame(rafLoop);
  }

  function startDrawing(): void {
    if (drawing || stopped) return;
    drawing = true;
    if (hasRVFC) rvfcHandle = vid.requestVideoFrameCallback(videoFrameLoop);
    else rafLoop();
    // setInterval fallback: catches paused/throttled states, retries play
    intervalId = setInterval(() => {
      if (stopped) { if (intervalId) clearInterval(intervalId); return; }
      drawFrame();
      if (vid.paused && vid.readyState >= 2 && !userPaused) {
        vid.play().catch(() => {});
      }
    }, WATCHDOG_MS);
  }

  const tryPlay = () => {
    if (stopped || userPaused) return;
    vid.play().catch(err => {
      console.warn('Video play attempt failed:', (err as Error)?.message);
      timers.push(setTimeout(() => { if (!stopped && !userPaused) vid.play().catch(() => {}); }, 1000));
    });
  };

  vid.addEventListener('loadedmetadata', () => { startDrawing(); tryPlay(); }, { once: true });
  vid.addEventListener('loadeddata', () => { settle(); startDrawing(); }, { once: true });
  vid.addEventListener('canplay', () => { settle(); startDrawing(); tryPlay(); }, { once: true });
  vid.addEventListener('playing', () => { settle(); startDrawing(); }, { once: true });
  vid.addEventListener('error', () => {
    if (!settled) {
      settled = true;
      const msg = vid.error?.message || 'unknown';
      console.warn('Video load error:', msg);
      rejectReady(new Error('Video load error: ' + msg));
    }
  }, { once: true });

  vid.src = src;
  vid.load();

  // Aggressive start: try at multiple intervals to handle any loading timing
  for (const ms of AUTOPLAY_RETRY_MS) {
    timers.push(setTimeout(() => {
      if (stopped) return;
      if (ms === 8000 && !settled) settle();
      startDrawing();
      tryPlay();
    }, ms));
  }

  const unregister = registerVideoForGestureResume(vid);

  function dispose(): void {
    if (stopped) return;
    stopped = true;
    unregister();
    if (intervalId) clearInterval(intervalId);
    for (const t of timers) clearTimeout(t);
    if (rvfcHandle && 'cancelVideoFrameCallback' in vid) vid.cancelVideoFrameCallback(rvfcHandle);
    if (rafHandle) cancelAnimationFrame(rafHandle);
    vid.removeEventListener('progress', onProgress);
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    if (!settled) { settled = true; rejectReady(new Error('disposed')); }
  }

  return player;
}

/* ------------------------------------------------------------------------ */
/* HEVC via MP4Box + WebCodecs                                               */
/* ------------------------------------------------------------------------ */

/** Chunk size used to stream the file into MP4Box (v1 5172). */
const HEVC_APPEND_CHUNK = 4 * 1024 * 1024;
/** Samples per onSamples batch (v1 5153). */
const HEVC_BATCH_SAMPLES = 30;
/** Frames whose pts is within this many µs of "now" are presented (v1 5220). */
const PRESENT_SLACK_US = 16_000;
/** Restart the loop this many µs before the end (v1 5237). */
const LOOP_TAIL_US = 200_000;

/**
 * Pull the `hvcC` / `avcC` sample-entry config box out of an MP4Box file and
 * serialise its payload (without the 8-byte box header) for
 * `VideoDecoder.configure({ description })`.
 *
 * Port of v1 `extractHEVCDescription` (index.html 5259-5294). v1 hunted for the
 * DataStream class on `window`/`MP4Box` because the library was script-tag
 * loaded; here it is passed in from the module import.
 */
export function extractDecoderDescription(
  mp4file: MP4BoxFile,
  trackId: number,
  DS: typeof MP4DataStream,
): Uint8Array {
  const trak = mp4file.getTrackById(trackId);
  if (!trak) throw new Error('Track not found');
  // Walk the box hierarchy: trak.mdia.minf.stbl.stsd.entries[N]
  const entries = trak.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || !entries.length) throw new Error('No sample entries');
  let cfgBox = null as (typeof entries)[number]['hvcC'] | null;
  for (const e of entries) {
    if (e.hvcC) { cfgBox = e.hvcC; break; }
    if (e.avcC) { cfgBox = e.avcC; break; }
  }
  if (!cfgBox) throw new Error('No hvcC/avcC config box in sample entry');
  if (typeof cfgBox.write !== 'function') throw new Error('Config box has no write() method (MP4Box build mismatch)');
  // Serialize the config box using MP4Box's DataStream writer.
  const ds = new DS(undefined, 0, DS.BIG_ENDIAN);
  cfgBox.write(ds);
  // The first 8 bytes are the box header (size + type); the description
  // VideoDecoder wants is the payload without the box header.
  return new Uint8Array(ds.buffer).slice(8);
}

/**
 * Codec strings to try, in order, for `VideoDecoder.isConfigSupported`.
 * Some files carry unusual tier/level values and Chrome is strict about the
 * exact match, so v1 (5085-5093) tried the file's own string, both
 * hvc1/hev1 spellings, then Main and Main 10 defaults.
 */
export function hevcCodecCandidates(trackCodec: string | undefined): string[] {
  return dedupe([
    trackCodec,                           // e.g. 'hvc1.1.6.L93.B0'
    trackCodec?.replace('hev1', 'hvc1'),
    trackCodec?.replace('hvc1', 'hev1'),
    'hvc1.1.6.L93.B0',                    // Main profile, Main tier, level 3.1
    'hvc1.2.4.L120.B0',                   // Main 10 profile
    'hev1.1.6.L93.B0',
  ].filter((v): v is string => !!v));
}

/**
 * HEVC playback via WebCodecs + MP4Box. Used when the browser's `<video>`
 * cannot decode H.265 (Chrome on Windows without the Microsoft HEVC Video
 * Extensions) but the system does have a hardware decoder `VideoDecoder`
 * can drive.
 *
 * The file is streamed into MP4Box in 4 MB chunks; every extracted sample
 * becomes an `EncodedVideoChunk`; decoded `VideoFrame`s are queued and
 * presented on a rAF loop at their pts relative to the first frame's
 * wall-clock arrival, dropping frames that run late so playback never
 * drifts. At the end the demuxer is re-positioned on the first RAP and
 * extraction restarts (loop).
 *
 * Port of v1 `createHEVCContentEl` (index.html 5018-5251). Deviations:
 *  - v1's loop did `mp4file.stop(); mp4file.start()`, which does NOT rewind
 *    MP4Box's `nextSample` cursor, so the video silently froze on its last
 *    frame. Here the loop (and `seek`) go through `mp4file.seek(t, true)`,
 *    which does reset the cursor, and the decoder is reset so the next key
 *    frame starts a clean GOP.
 *  - `pause()` / `play()` freeze and resume the presentation clock (v1's shim
 *    only flipped a `paused` flag). With `loop: false` the player pauses at
 *    the end and `play()` restarts it from 0; `seek()` while paused presents
 *    the sought frame immediately.
 *  - the decoder is `flush()`ed after the track's last sample so frames held
 *    back for reordering (B-frames, deep hardware pipelines) reach the canvas
 *    (v1 5156-5185 never flushed, so its final frames were lost and the
 *    200 ms loop window could be missed). A finished flush also counts as
 *    end-of-clip, so the loop no longer depends solely on that window.
 *  - the end-of-clip check is armed only once a frame from the current run
 *    has been drawn (`awaitingFrame`). v1's condition stayed true until the
 *    first re-decoded frame arrived; with a real restart that would reset the
 *    decoder on every rAF tick and freeze the picture.
 *  - the loading overlay is reported through `opts.onProgress`, and errors
 *    reject `ready` instead of showing a toast.
 */
export function createHevcPlayer(file: Blob, opts: FramePlayerOptions = {}): FramePlayer {
  const maxDim = opts.maxTextureSize ?? DEFAULT_MAX_TEXTURE_SIZE;
  const loop = opts.loop ?? true;
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const ctx2d = canvas.getContext('2d') as CanvasRenderingContext2D;

  let decoder: VideoDecoder | null = null;
  let decoderConfig: VideoDecoderConfig | null = null;
  let mp4file: MP4BoxFile | null = null;
  let trackInfo: MP4TrackInfo | null = null;
  // For fragmented MP4 (samples in moof boxes) MP4Box's nb_samples snapshot is 0 or partial, so the
  // "last sample" guard below would fire on every batch and flush the decoder mid-clip. Only the
  // post-append flush fallback is used for those files.
  let lastSampleKnown = false;
  let stopped = false;
  let frameQueue: VideoFrame[] = [];
  let clockStart = 0;       // performance.now() when the current run's first frame was shown
  let clockPtsUs = 0;       // pts of that frame
  let pausedAt = 0;         // performance.now() at pause(), 0 while playing
  let paused = false;
  let ended = false;        // reached the end with loop=false; play() restarts from 0
  let awaitingFrame = true; // no frame from the current run has been drawn yet (gates the end-of-clip check)
  let presentOnce = false;  // draw the next decoded frame even while paused (seek while paused)
  let drained = false;      // decoder.flush() for the current run resolved: every frame has been emitted
  let run = 0;              // incremented by restartAt(); stale flush results are ignored
  let durationUs = 0;
  let currentTime = 0;
  let raf = 0;
  let settled = false;

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => { /* see createNativeVideoPlayer */ });

  const settle = () => {
    if (settled) return;
    settled = true;
    opts.onProgress?.(100, 'Decoding HEVC… 100%');
    resolveReady();
  };
  const fail = (msg: string) => {
    if (!settled) { settled = true; rejectReady(new Error('HEVC playback failed: ' + msg)); }
    else console.warn('HEVC playback failed:', msg);
  };

  const player: FramePlayer = {
    canvas,
    get width() { return canvas.width; },
    get height() { return canvas.height; },
    get currentTime() { return currentTime; },
    get duration() { return durationUs / 1_000_000; },
    get paused() { return paused; },
    ready,
    play() {
      if (stopped || !paused) return;
      paused = false;
      if (ended) {
        // Non-loop clip that ran to its end: start over (restartAt arms the loop).
        ended = false;
        pausedAt = 0;
        restartAt(0);
        return;
      }
      if (clockStart && pausedAt) clockStart += performance.now() - pausedAt;
      pausedAt = 0;
      if (!raf) raf = requestAnimationFrame(displayLoop);
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      pausedAt = performance.now();
      // Nothing runs while paused; a seek's first frame or play() re-arms it.
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    seek(t: number) { restartAt(t); },
    dispose,
  };
  opts.onProgress?.(0, 'Decoding HEVC… 0%');

  (async () => {
    if (typeof VideoDecoder === 'undefined') {
      fail('VideoDecoder not available in this browser.');
      return;
    }
    let MP4Box: typeof import('mp4box').default;
    try {
      const mod = await import('mp4box');
      MP4Box = (mod.default ?? mod) as typeof import('mp4box').default;
    } catch (e) {
      fail('MP4Box failed to load: ' + ((e as Error)?.message || e));
      return;
    }
    if (stopped) return;

    const f = MP4Box.createFile();
    mp4file = f;
    f.onError = e => fail('MP4 parse error: ' + e);
    f.onReady = async (info) => {
      const track = info.videoTracks[0];
      if (!track) { fail('No video track found in file.'); return; }
      trackInfo = track;
      lastSampleKnown = !info.isFragmented && (track.nb_samples ?? 0) > 0;
      durationUs = (info.duration / info.timescale) * 1_000_000;
      const vw = track.video?.width ?? track.track_width;
      const vh = track.video?.height ?? track.track_height;
      // Cap canvas at the GPU's max texture size — same as the regular video
      // path. drawImage in displayLoop scales frames to fit.
      const { width, height } = fitToMax(vw, vh, maxDim);
      canvas.width = width;
      canvas.height = height;

      // Build VideoDecoder description from the avcC/hvcC sample entry box.
      let desc: Uint8Array;
      try { desc = extractDecoderDescription(f, track.id, MP4Box.DataStream); }
      catch (e) {
        fail('Could not read codec config from this MP4: ' + ((e as Error)?.message || e) +
          '. The file may be HEVC but malformed; re-encoding to H.264 should fix it.');
        return;
      }

      let chosenCodec: string | null = null;
      for (const codecStr of hevcCodecCandidates(track.codec)) {
        try {
          const sup = await VideoDecoder.isConfigSupported({ codec: codecStr, description: desc });
          if (sup.supported) { chosenCodec = codecStr; break; }
        } catch { /* try next */ }
      }
      if (stopped) return;
      if (!chosenCodec) {
        fail('No HEVC hardware decoder available for this file. On Chrome this usually means the OS ' +
          'doesn\'t expose an HEVC decoder. Either install the Microsoft HEVC Video Extensions or ' +
          're-encode the file to H.264.');
        return;
      }

      decoderConfig = { codec: chosenCodec, description: desc };
      decoder = new VideoDecoder({
        output: onDecoderFrame,
        error: e => fail('Decoder error: ' + (e?.message || e) + ' (codec=' + chosenCodec + ')'),
      });
      try {
        decoder.configure(decoderConfig);
      } catch (e) {
        fail('Decoder configure failed: ' + ((e as Error)?.message || e));
        return;
      }

      f.setExtractionOptions(track.id, null, { nbSamples: HEVC_BATCH_SAMPLES });
      f.start();
    };
    f.onSamples = (_id: number, _user: unknown, samples: MP4Sample[]) => {
      if (!decoder || stopped) return;
      let sawLast = false;
      for (const s of samples) {
        if (stopped) return;
        try {
          const chunk = new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration: (s.duration * 1_000_000) / s.timescale,
            data: s.data,
          });
          decoder.decode(chunk);
        } catch { /* skip bad sample */ }
        if (lastSampleKnown && trackInfo && s.number >= trackInfo.nb_samples - 1) sawLast = true;
      }
      // The last sample is in: flush so reorder-buffered tail frames emerge.
      if (sawLast) flushDecoder();
    };

    // Stream the file into MP4Box in chunks
    const totalBytes = file.size;
    let offset = 0;
    try {
      while (offset < totalBytes && !stopped) {
        const buf = await file.slice(offset, offset + HEVC_APPEND_CHUNK).arrayBuffer() as MP4BoxBuffer;
        buf.fileStart = offset;
        f.appendBuffer(buf);
        offset += HEVC_APPEND_CHUNK;
        const pct = Math.min(99, Math.round((offset / totalBytes) * 100));
        if (!settled) opts.onProgress?.(pct, `Decoding HEVC… ${pct}%`);
      }
      if (!stopped) {
        f.flush();
        // Fallback for files whose sample count MP4Box could not report: once
        // the whole file is demuxed, everything queued so far is the clip.
        // Only for the load-time run — a seek during loading must not have
        // its fresh queue declared complete.
        if (decoder && run === 0) flushDecoder();
      }
    } catch (e) {
      fail('Could not read file: ' + ((e as Error)?.message || e));
    }
  })();

  /**
   * Ask the decoder to emit everything it is holding. When the flush belongs
   * to the current run (no restart in between) mark the run as drained, which
   * displayLoop treats as end-of-clip once the queue is empty.
   */
  function flushDecoder(): void {
    if (!decoder || stopped || decoder.state !== 'configured') return;
    const myRun = run;
    decoder.flush().then(
      () => { if (!stopped && myRun === run) drained = true; },
      () => { /* reset() during a restart rejects the pending flush; ignore */ },
    );
  }

  function onDecoderFrame(frame: VideoFrame): void {
    if (stopped) { frame.close(); return; }
    if (!settled) settle();
    // Display frames at their pts relative to start. Drop frames that run too
    // late so we don't drift forever.
    if (clockStart === 0) {
      clockStart = performance.now();
      clockPtsUs = frame.timestamp;
      if (paused) pausedAt = clockStart;
    }
    frameQueue.push(frame);
    if (!raf) raf = requestAnimationFrame(displayLoop);
  }

  /** Draw one frame onto the canvas, update currentTime, notify the renderer. */
  function present(frame: VideoFrame): void {
    try {
      ctx2d.drawImage(frame, 0, 0, canvas.width, canvas.height);
      currentTime = frame.timestamp / 1_000_000;
      awaitingFrame = false;
      player.onFrame?.();
    } catch { /* frame may have been closed by the decoder */ }
    frame.close();
  }

  function displayLoop(): void {
    raf = 0;
    if (stopped) return;
    if (paused) {
      // Seek while paused: show the sought frame, then wait for play().
      if (presentOnce && frameQueue.length > 0) {
        presentOnce = false;
        present(frameQueue.shift()!);
      }
      return; // play() re-arms the loop
    }
    const now = performance.now();
    // Wall-clock time since we started displaying, in microseconds
    const elapsedUs = (now - clockStart) * 1000;
    // Pop and draw the latest frame whose pts has already arrived; drop older
    // ones to stay synced
    let drewOne: VideoFrame | null = null;
    while (frameQueue.length > 0) {
      const f = frameQueue[0];
      const fpts = f.timestamp - clockPtsUs;
      if (fpts <= elapsedUs + PRESENT_SLACK_US) {
        if (drewOne) drewOne.close();
        drewOne = frameQueue.shift()!;
      } else break;
    }
    if (drewOne) present(drewOne);
    // End of clip: nothing queued, a frame from this run has been shown, and
    // either we are inside the loop-tail window or the decoder has been
    // drained. `awaitingFrame` keeps this from re-firing on every tick
    // between a restart and its first decoded frame (that re-fire reset the
    // decoder forever and froze the picture).
    const nearEnd = durationUs > 0 && currentTime * 1_000_000 >= durationUs - LOOP_TAIL_US;
    if (!awaitingFrame && frameQueue.length === 0 && (nearEnd || drained)) {
      if (loop) {
        restartAt(0); // re-arms the rAF itself; returning keeps a single chain
      } else {
        ended = true;
        paused = true;
        pausedAt = now;
      }
      return;
    }
    raf = requestAnimationFrame(displayLoop);
  }

  /**
   * Re-position extraction on the RAP at/before `t` seconds and re-anchor the
   * clock. Starts a new "run": the end-of-clip check stays disarmed until the
   * first re-decoded frame is drawn, and any flush still pending from the
   * previous run is ignored.
   */
  function restartAt(t: number): void {
    if (stopped || !mp4file || !trackInfo || !decoder || !decoderConfig) return;
    for (const f of frameQueue) { try { f.close(); } catch { /* already closed */ } }
    frameQueue = [];
    clockStart = 0; clockPtsUs = 0;
    currentTime = Math.max(0, t);
    run++;
    awaitingFrame = true;
    drained = false;
    ended = false;
    if (paused) presentOnce = true;
    try {
      mp4file.stop();
      if (decoder.state === 'configured') decoder.reset();
      if (decoder.state !== 'closed') decoder.configure(decoderConfig);
      mp4file.seek(Math.max(0, t), true);
      mp4file.start();
    } catch (e) {
      console.warn('HEVC restart failed:', (e as Error)?.message || e);
    }
    if (!raf && !paused) raf = requestAnimationFrame(displayLoop);
  }

  function dispose(): void {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    for (const f of frameQueue) { try { f.close(); } catch { /* ignore */ } }
    frameQueue = [];
    try { decoder?.close(); } catch { /* ignore */ }
    try { mp4file?.stop(); } catch { /* ignore */ }
    if (!settled) { settled = true; rejectReady(new Error('disposed')); }
  }

  return player;
}

/* ------------------------------------------------------------------------ */
/* Gesture resume                                                            */
/* ------------------------------------------------------------------------ */

const gestureVideos = new Set<HTMLVideoElement>();
/** Elements the app paused on purpose; gesture-resume must leave these alone. */
const userPausedVideos = new WeakSet<HTMLVideoElement>();

/**
 * Track a `<video>` so {@link installGestureResume} can retry `play()` on the
 * next user gesture. Returns an unregister function (called automatically by
 * {@link createNativeVideoPlayer}'s dispose).
 */
export function registerVideoForGestureResume(video: HTMLVideoElement): () => void {
  gestureVideos.add(video);
  return () => { gestureVideos.delete(video); userPausedVideos.delete(video); };
}

/**
 * Mark a registered element as paused by the app (`true`) or playable again
 * (`false`). {@link resumeAllVideos} skips user-paused elements so an explicit
 * `FramePlayer.pause()` survives the next click/touch. Called by
 * {@link createNativeVideoPlayer}'s `pause()` / `play()`; exposed for apps that
 * manage their own elements.
 */
export function setVideoUserPaused(video: HTMLVideoElement, paused: boolean): void {
  if (paused) userPausedVideos.add(video);
  else userPausedVideos.delete(video);
}

/**
 * Retry `play()` on every registered element that is paused but has data
 * (port of v1 `resumeAllVideos`, index.html 4950-4961), skipping elements the
 * app paused deliberately via {@link setVideoUserPaused}. Exposed so an app
 * can call it from its own gesture handling.
 */
export function resumeAllVideos(): void {
  gestureVideos.forEach(v => {
    if (userPausedVideos.has(v)) return;
    if (v.paused && v.readyState >= 2) v.play().catch(() => {});
  });
}

/**
 * Firefox (and some browser configs) block even muted autoplay until user
 * interaction. Installs document-level click/touchstart listeners that call
 * {@link resumeAllVideos} (v1 4962-4963). Returns an uninstall function.
 */
export function installGestureResume(target: Document | HTMLElement | null = typeof document !== 'undefined' ? document : null): () => void {
  if (!target) return () => {};
  target.addEventListener('click', resumeAllVideos);
  target.addEventListener('touchstart', resumeAllVideos, { passive: true });
  return () => {
    target.removeEventListener('click', resumeAllVideos);
    target.removeEventListener('touchstart', resumeAllVideos);
  };
}

/* ------------------------------------------------------------------------ */
/* Shared (span-mode) players                                                */
/* ------------------------------------------------------------------------ */

interface SharedEntry {
  player: FramePlayer;
  refs: number;
  /** Every consumer's `onFrame`, fanned out from the one hook on the real player. */
  listeners: Set<() => void>;
}

const sharedPlayers = new Map<string, SharedEntry>();

/**
 * Get or create a {@link FramePlayer} shared by every consumer that asks for
 * the same `key` (the source URL in span mode), so many walls showing one
 * video drive a single decoder. Reference counted: each call must be paired
 * with `release()`; the player is disposed when the last reference goes.
 *
 * The returned `player` is a per-consumer handle onto the shared player: all
 * state and controls pass straight through, but its `onFrame` is private to
 * that consumer — every handle's callback fires on each new frame, and
 * clearing one does not silence the others (v1 gave every wall its own
 * canvas pump calling the global markDirty, 5376-5383). `dispose()` on a
 * handle is the same as `release()`.
 *
 * Port of v1 `getSharedSpanVideo` / `releaseSharedSpanVideo` (index.html
 * 4939-5007). v1 held a single slot and tore the previous video down when a
 * different URL was requested; here any number of keys coexist, which is a
 * superset of that behaviour.
 */
export function createSharedPlayer(key: string, factory: () => FramePlayer): { player: FramePlayer; release: () => void } {
  let entry = sharedPlayers.get(key);
  if (!entry) {
    const listeners = new Set<() => void>();
    const player = factory();
    player.onFrame = () => { listeners.forEach(fn => fn()); };
    entry = { player, refs: 0, listeners };
    sharedPlayers.set(key, entry);
  }
  entry.refs++;
  const held = entry;
  const real = held.player;
  let released = false;
  let mine: (() => void) | undefined;

  const release = () => {
    if (released) return;
    released = true;
    if (mine) held.listeners.delete(mine);
    mine = undefined;
    held.refs = Math.max(0, held.refs - 1);
    if (held.refs === 0 && sharedPlayers.get(key) === held) {
      sharedPlayers.delete(key);
      real.onFrame = undefined;
      real.dispose();
    }
  };

  const handle: FramePlayer = {
    get canvas() { return real.canvas; },
    get width() { return real.width; },
    get height() { return real.height; },
    get currentTime() { return real.currentTime; },
    get duration() { return real.duration; },
    get paused() { return real.paused; },
    ready: real.ready,
    play() { real.play(); },
    pause() { real.pause(); },
    seek(t: number) { real.seek(t); },
    dispose: release,
    get onFrame() { return mine; },
    set onFrame(fn: (() => void) | undefined) {
      if (mine) held.listeners.delete(mine);
      mine = fn;
      if (fn && !released) held.listeners.add(fn);
    },
  };

  return { player: handle, release };
}

/** Number of live references for a shared key (0 when none) — for tests and diagnostics. */
export function sharedPlayerRefCount(key: string): number {
  return sharedPlayers.get(key)?.refs ?? 0;
}
