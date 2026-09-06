import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseMp4Codecs,
  detectContainer,
  parseWebmCodecs,
  buildCodecInfo,
  pickDecodePath,
  fitToMax,
  hevcCodecCandidates,
  hasVideoSampleEntry,
  sniffVideoCodecs,
  SNIFF_BYTES,
  createSharedPlayer,
  sharedPlayerRefCount,
  registerVideoForGestureResume,
  setVideoUserPaused,
  resumeAllVideos,
  createHevcPlayer,
  type CodecInfo,
  type FramePlayer,
} from './video';

/* ---------- fake mp4box (the module imports it dynamically) ---------- */

const mp4boxFakes = vi.hoisted(() => {
  class FakeDataStream {
    static BIG_ENDIAN = false;
    static LITTLE_ENDIAN = true;
    buffer = new ArrayBuffer(0);
    byteLength = 0;
  }
  class FakeMp4File {
    onReady?: (info: unknown) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: unknown[]) => void;
    starts = 0;
    stops = 0;
    flushes = 0;
    seeks: number[] = [];
    appendBuffer(): number { return 0; }
    start(): void { this.starts++; }
    stop(): void { this.stops++; }
    flush(): void { this.flushes++; }
    seek(t: number): { offset: number; time: number } { this.seeks.push(t); return { offset: 0, time: t }; }
    setExtractionOptions(): void {}
    getTrackById(): unknown {
      return { mdia: { minf: { stbl: { stsd: { entries: [{ hvcC: { write(ds: FakeDataStream) { ds.buffer = new ArrayBuffer(20); } } }] } } } } };
    }
  }
  const files: FakeMp4File[] = [];
  return { FakeDataStream, FakeMp4File, files };
});

vi.mock('mp4box', () => ({
  default: {
    createFile: () => { const f = new mp4boxFakes.FakeMp4File(); mp4boxFakes.files.push(f); return f; },
    DataStream: mp4boxFakes.FakeDataStream,
  },
}));

/* ---------- tiny ISOBMFF builder ---------- */

function ascii(s: string): number[] {
  return Array.from(s, c => c.charCodeAt(0));
}
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
/** Box = size(4) type(4) payload. */
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}
/** Visual sample entry: 78 fixed bytes then child boxes. */
function visualEntry(type: string, w: number, h: number, ...children: number[][]): number[] {
  const fixed: number[] = [];
  fixed.push(0, 0, 0, 0, 0, 0, 0, 1);         // reserved(6) + data_reference_index(2)
  fixed.push(...new Array(16).fill(0));        // pre_defined / reserved
  fixed.push((w >> 8) & 0xff, w & 0xff, (h >> 8) & 0xff, h & 0xff);
  fixed.push(...u32(0x00480000), ...u32(0x00480000)); // 72 dpi
  fixed.push(...u32(0));                       // reserved
  fixed.push(0, 1);                            // frame_count
  fixed.push(...new Array(32).fill(0));        // compressorname
  fixed.push(0, 0x18, 0xff, 0xff);             // depth, pre_defined
  if (fixed.length !== 78) throw new Error('bad fixed length ' + fixed.length);
  return box(type, fixed, ...children);
}
/** hvcC payload: version, profile byte, compat(4), constraints(6), level, then junk. */
function hvcC(opts: { space?: number; tier?: number; profile: number; compat: number; constraints: number[]; level: number }): number[] {
  const b = ((opts.space ?? 0) << 6) | ((opts.tier ?? 0) << 5) | (opts.profile & 0x1f);
  return box('hvcC', [1, b, ...u32(opts.compat), ...opts.constraints, opts.level, 0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f]);
}
function avcC(profile: number, compat: number, level: number): number[] {
  return box('avcC', [1, profile, compat, level, 0xff, 0xe1, 0, 0]);
}
function stsd(...entries: number[][]): number[] {
  return box('stsd', [0, 0, 0, 0], u32(entries.length), ...entries);
}
function moovWith(...entries: number[][]): number[] {
  return box('moov',
    box('mvhd', new Array(100).fill(0)),
    box('trak', box('tkhd', new Array(84).fill(0)), box('mdia', box('mdhd', new Array(24).fill(0)), box('minf', box('stbl', stsd(...entries))))),
  );
}
function ftyp(): number[] {
  return box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('mp41'));
}
function toBuf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

const HEVC_MAIN = hvcC({ profile: 1, compat: 0x60000000, constraints: [0x90, 0, 0, 0, 0, 0], level: 93 });

/* ---------- tests ---------- */

describe('parseMp4Codecs', () => {
  it('finds an hvc1 entry with a full RFC 6381 string from hvcC', () => {
    const buf = toBuf([...ftyp(), ...moovWith(visualEntry('hvc1', 1920, 1080, HEVC_MAIN))]);
    const r = parseMp4Codecs(buf);
    expect(r.source).toBe('stsd');
    expect(r.codecs).toEqual(['hvc1.1.6.L93.90']);
  });

  it('builds the hvc1.1.6.L93.B0 string used by v1 for the common Main-profile files', () => {
    const cfg = hvcC({ profile: 1, compat: 0x60000000, constraints: [0xb0, 0, 0, 0, 0, 0], level: 93 });
    const r = parseMp4Codecs(toBuf(moovWith(visualEntry('hvc1', 640, 480, cfg))));
    expect(r.codecs).toEqual(['hvc1.1.6.L93.B0']);
  });

  it('renders profile space, high tier and trailing constraint bytes', () => {
    const cfg = hvcC({ space: 1, tier: 1, profile: 2, compat: 0x20000000, constraints: [0x90, 0, 0, 0, 0, 0x01], level: 120 });
    const r = parseMp4Codecs(toBuf(moovWith(visualEntry('hev1', 640, 480, cfg))));
    expect(r.codecs).toEqual(['hev1.A2.4.H120.90.0.0.0.0.1']);
  });

  it('finds avc1 with profile/compat/level hex from avcC and keeps audio entries', () => {
    const buf = toBuf([...ftyp(), ...moovWith(visualEntry('avc1', 1280, 720, avcC(0x64, 0x00, 0x1f)), box('mp4a', new Array(28).fill(0)))]);
    const r = parseMp4Codecs(buf);
    expect(r.codecs).toEqual(['avc1.64001F', 'mp4a']);
  });

  it('reports the bare fourcc when the config box is missing', () => {
    const r = parseMp4Codecs(toBuf(moovWith(visualEntry('av01', 100, 100))));
    expect(r.codecs).toEqual(['av01']);
  });

  it('handles a tail slice that starts mid-box by locating the moov fourcc', () => {
    const junk = new Array(37).fill(0xaa);
    const r = parseMp4Codecs(toBuf([...junk, ...moovWith(visualEntry('hvc1', 640, 480, HEVC_MAIN))]));
    expect(r.source).toBe('stsd');
    expect(r.codecs).toEqual(['hvc1.1.6.L93.90']);
  });

  it('falls back to the v1 substring scan when no stsd is reachable', () => {
    const bytes = [...ftyp(), ...box('mdat', ascii('....hev1....avc1....'))];
    const r = parseMp4Codecs(toBuf(bytes));
    expect(r.source).toBe('scan');
    expect(r.codecs).toEqual(['hev1', 'avc1']);
  });

  it('returns nothing for garbage without throwing', () => {
    expect(parseMp4Codecs(toBuf([1, 2, 3]))).toEqual({ codecs: [], source: 'none' });
    expect(parseMp4Codecs(new ArrayBuffer(0))).toEqual({ codecs: [], source: 'none' });
    // A box claiming a size larger than the buffer must be clamped, not crash.
    const r = parseMp4Codecs(toBuf([...u32(0xffffff), ...ascii('moov'), 0, 0]));
    expect(r.codecs).toEqual([]);
  });

  it('understands 64-bit largesize headers', () => {
    const inner = moovWith(visualEntry('avc1', 64, 64, avcC(0x42, 0xc0, 0x1e)));
    const largeMoov = [...u32(1), ...ascii('moov'), ...u32(0), ...u32(16 + inner.length - 8), ...inner.slice(8)];
    expect(parseMp4Codecs(toBuf(largeMoov)).codecs).toEqual(['avc1.42C01E']);
  });
});

describe('detectContainer / parseWebmCodecs', () => {
  it('detects mp4 by ftyp, webm by EBML magic, other otherwise', () => {
    expect(detectContainer(toBuf([...ftyp(), 0, 0, 0, 0]))).toBe('mp4');
    expect(detectContainer(toBuf([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('webm');
    expect(detectContainer(toBuf(ascii('RIFF....AVI LIST')))).toBe('other');
    expect(detectContainer(new ArrayBuffer(0))).toBe('other');
  });
  it('maps Matroska codec ids', () => {
    const head = toBuf([0x1a, 0x45, 0xdf, 0xa3, ...ascii('....V_VP9....A_OPUS....')]);
    expect(parseWebmCodecs(head)).toEqual(['vp9', 'opus']);
  });
});

describe('buildCodecInfo / pickDecodePath', () => {
  it('flags HEVC/AVC and builds a mime with codecs', () => {
    const info = buildCodecInfo('mp4', ['hvc1.1.6.L93.B0', 'mp4a']);
    expect(info.hasHevc).toBe(true);
    expect(info.hasAvc).toBe(false);
    expect(info.mime).toBe('video/mp4; codecs="hvc1.1.6.L93.B0, mp4a"');
    // no DOM in node → HEVC assumed unplayable natively (v1 probed <video>)
    expect(info.canPlayNatively).toBe(false);
    const avc = buildCodecInfo('mp4', ['avc1.64001F']);
    expect(avc.hasAvc).toBe(true);
    expect(avc.canPlayNatively).toBe(true);
    expect(buildCodecInfo('webm', []).mime).toBe('video/webm');
  });

  it('routes like v1 pickVideoDecodePath', () => {
    const base: CodecInfo = { container: 'mp4', codecs: [], hasHevc: false, hasAvc: false, canPlayNatively: true, mime: 'video/mp4' };
    expect(pickDecodePath(base)).toBe('native');
    expect(pickDecodePath({ ...base, hasAvc: true })).toBe('native');
    // unknown codecs still get handed to <video> (v1: `if (!codecs) return 'video'`)
    expect(pickDecodePath({ ...base, canPlayNatively: false })).toBe('native');
    const hevc = { ...base, hasHevc: true, canPlayNatively: false };
    const g = globalThis as { VideoDecoder?: unknown };
    const saved = g.VideoDecoder;
    delete g.VideoDecoder;
    expect(pickDecodePath(hevc)).toBe('unsupported');
    g.VideoDecoder = class {};
    expect(pickDecodePath(hevc)).toBe('webcodecs-hevc');
    if (saved === undefined) delete g.VideoDecoder; else g.VideoDecoder = saved;
    expect(pickDecodePath({ ...hevc, canPlayNatively: true })).toBe('native');
  });
});

describe('fitToMax', () => {
  it('scales uniformly only when a side exceeds the cap (v1 sizeCanvas)', () => {
    expect(fitToMax(1920, 1080, 4096)).toEqual({ width: 1920, height: 1080 });
    expect(fitToMax(8192, 4320, 4096)).toEqual({ width: 4096, height: 2160 });
    expect(fitToMax(1000, 5000, 4096)).toEqual({ width: 819, height: 4096 });
  });
});

describe('hevcCodecCandidates', () => {
  it('tries the file codec, both spellings, then the v1 defaults, deduplicated', () => {
    expect(hevcCodecCandidates('hev1.1.6.L93.B0')).toEqual([
      'hev1.1.6.L93.B0', 'hvc1.1.6.L93.B0', 'hvc1.2.4.L120.B0',
    ]);
    expect(hevcCodecCandidates(undefined)).toEqual(['hvc1.1.6.L93.B0', 'hvc1.2.4.L120.B0', 'hev1.1.6.L93.B0']);
  });
});

describe('hasVideoSampleEntry / sniffVideoCodecs tail merge', () => {
  it('treats an stsd with only audio entries as inconclusive', () => {
    expect(hasVideoSampleEntry({ codecs: ['mp4a'], source: 'stsd' })).toBe(false);
    expect(hasVideoSampleEntry({ codecs: ['hvc1.1.6.L93.B0'], source: 'scan' })).toBe(false);
    expect(hasVideoSampleEntry({ codecs: ['mp4a', 'avc1.64001F'], source: 'stsd' })).toBe(true);
    expect(hasVideoSampleEntry({ codecs: ['av01'], source: 'stsd' })).toBe(true);
  });

  it('still reads the tail when the head moov only yielded an audio stsd, and merges codecs', async () => {
    // Head: complete audio trak, video trak "cut off" (absent). Tail: the video trak's moov.
    const head = [...ftyp(), ...moovWith(box('mp4a', new Array(28).fill(0)))];
    const pad = new Uint8Array(SNIFF_BYTES + 4096);
    const tail = moovWith(visualEntry('hvc1', 1920, 1080, HEVC_MAIN));
    const blob = new Blob([new Uint8Array(head), pad, new Uint8Array(tail)]);
    const info = await sniffVideoCodecs(blob);
    expect(info.container).toBe('mp4');
    expect(info.codecs).toEqual(['mp4a', 'hvc1.1.6.L93.90']);
    expect(info.hasHevc).toBe(true);
  });

  it('does not read the tail once the head named a video track', async () => {
    const head = [...ftyp(), ...moovWith(visualEntry('avc1', 1280, 720, avcC(0x64, 0x00, 0x1f)))];
    const pad = new Uint8Array(SNIFF_BYTES + 4096);
    const tail = moovWith(visualEntry('hvc1', 1920, 1080, HEVC_MAIN));
    const info = await sniffVideoCodecs(new Blob([new Uint8Array(head), pad, new Uint8Array(tail)]));
    expect(info.codecs).toEqual(['avc1.64001F']);
    expect(info.hasHevc).toBe(false);
  });
});

describe('resumeAllVideos', () => {
  type FakeVid = { paused: boolean; readyState: number; plays: number; play(): Promise<void> };
  const mk = (paused: boolean, readyState: number): FakeVid => ({
    paused, readyState, plays: 0,
    play() { this.plays++; return Promise.resolve(); },
  });
  const asEl = (v: FakeVid) => v as unknown as HTMLVideoElement;

  it('retries paused-with-data elements but leaves user-paused ones alone', () => {
    const a = mk(true, 2), b = mk(true, 2), playing = mk(false, 2), noData = mk(true, 1);
    const unregister = [a, b, playing, noData].map(v => registerVideoForGestureResume(asEl(v)));
    setVideoUserPaused(asEl(b), true);
    resumeAllVideos();
    expect(a.plays).toBe(1);
    expect(b.plays).toBe(0);      // explicit pause() survives a gesture
    expect(playing.plays).toBe(0);
    expect(noData.plays).toBe(0);
    setVideoUserPaused(asEl(b), false);
    resumeAllVideos();
    expect(a.plays).toBe(2);
    expect(b.plays).toBe(1);
    unregister.forEach(fn => fn());
    resumeAllVideos();
    expect(a.plays).toBe(2);
  });
});

describe('createSharedPlayer', () => {
  function fakePlayer(): FramePlayer & { disposed: number } {
    const p: FramePlayer & { disposed: number } = {
      canvas: {} as HTMLCanvasElement,
      width: 0, height: 0, currentTime: 0, duration: 0, paused: false,
      ready: Promise.resolve(),
      disposed: 0,
      play() {}, pause() {}, seek() {},
      dispose() { p.disposed++; },
      onFrame: undefined,
    };
    return p;
  }

  it('shares one player per key and disposes on the last release', () => {
    const built: ReturnType<typeof fakePlayer>[] = [];
    const factory = () => { const p = fakePlayer(); built.push(p); return p; };
    const a = createSharedPlayer('blob:x', factory);
    const b = createSharedPlayer('blob:x', factory);
    const c = createSharedPlayer('blob:y', factory);
    expect(built.length).toBe(2);
    expect(a.player.canvas).toBe(b.player.canvas);
    expect(a.player.canvas).not.toBe(c.player.canvas);
    expect(sharedPlayerRefCount('blob:x')).toBe(2);
    a.release();
    a.release(); // double release is a no-op
    expect(sharedPlayerRefCount('blob:x')).toBe(1);
    expect(built[0].disposed).toBe(0);
    b.release();
    expect(sharedPlayerRefCount('blob:x')).toBe(0);
    expect(built[0].disposed).toBe(1);
    // a fresh request after teardown builds a new player
    const d = createSharedPlayer('blob:x', factory);
    expect(built.length).toBe(3);
    expect(d.player.canvas).not.toBe(a.player.canvas);
    d.release();
    c.release();
    expect(sharedPlayerRefCount('blob:y')).toBe(0);
  });

  it('fans onFrame out to every consumer instead of sharing one slot', () => {
    const built: ReturnType<typeof fakePlayer>[] = [];
    const factory = () => { const p = fakePlayer(); built.push(p); return p; };
    const a = createSharedPlayer('blob:z', factory);
    const b = createSharedPlayer('blob:z', factory);
    let hitsA = 0, hitsB = 0;
    a.player.onFrame = () => { hitsA++; };
    b.player.onFrame = () => { hitsB++; };
    built[0].onFrame?.();
    expect([hitsA, hitsB]).toEqual([1, 1]);
    // Re-assigning replaces only that consumer's callback.
    a.player.onFrame = () => { hitsA += 10; };
    built[0].onFrame?.();
    expect([hitsA, hitsB]).toEqual([11, 2]);
    // Clearing one does not silence the other.
    a.player.onFrame = undefined;
    built[0].onFrame?.();
    expect([hitsA, hitsB]).toEqual([11, 3]);
    // Releasing drops the listener; dispose() on a handle is release().
    b.player.dispose();
    expect(sharedPlayerRefCount('blob:z')).toBe(1);
    built[0].onFrame?.();
    expect(hitsB).toBe(3);
    a.release();
    expect(built[0].disposed).toBe(1);
  });
});

/* ---------- HEVC player with fake WebCodecs / DOM / rAF ---------- */

type FakeFrame = { timestamp: number; closed: boolean; close(): void };
const makeFrame = (timestamp: number): FakeFrame => ({ timestamp, closed: false, close() { this.closed = true; } });

class FakeDecoder {
  static instances: FakeDecoder[] = [];
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  queued: number[] = [];
  resets = 0;
  flushes = 0;
  private pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  constructor(private init: { output: (f: FakeFrame) => void; error: (e: Error) => void }) {
    FakeDecoder.instances.push(this);
  }
  static isConfigSupported(): Promise<{ supported: boolean }> { return Promise.resolve({ supported: true }); }
  configure(): void { this.state = 'configured'; }
  decode(chunk: { timestamp: number }): void { this.queued.push(chunk.timestamp); }
  reset(): void {
    this.state = 'unconfigured';
    this.resets++;
    this.queued = [];
    const p = this.pending; this.pending = [];
    p.forEach(x => x.reject(new Error('AbortError')));
  }
  flush(): Promise<void> {
    this.flushes++;
    return new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  close(): void { this.state = 'closed'; }
  /** Emit the next `n` queued frames to the output callback (all by default). */
  emit(n = this.queued.length): void {
    for (const ts of this.queued.splice(0, n)) this.init.output(makeFrame(ts));
  }
  resolveFlush(): void { const p = this.pending; this.pending = []; p.forEach(x => x.resolve()); }
}

class FakeChunk {
  timestamp: number;
  constructor(init: { timestamp: number }) { this.timestamp = init.timestamp; }
}

describe('createHevcPlayer', () => {
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  let rafQueue: { id: number; cb: FrameRequestCallback }[] = [];
  let rafId = 0;
  let now = 0;
  let draws = 0;

  function tick(): void {
    const batch = rafQueue; rafQueue = [];
    for (const { cb } of batch) cb(now);
  }
  /** Let settled promise chains run (a handful of macrotask turns). */
  const flushAsync = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  /**
   * Poll until `cond` holds. The player's boot path crosses real async work
   * (the dynamic `import('mp4box')` through vite-node, `Blob.arrayBuffer()`,
   * `isConfigSupported`) whose tick count depends on suite load, so a fixed
   * number of `setTimeout(0)` turns is not enough in a full run.
   */
  async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  /** Every player built by a test; disposed in afterEach so a failed test's async boot cannot leak into the next. */
  let players: FramePlayer[] = [];

  beforeEach(() => {
    for (const k of ['document', 'VideoDecoder', 'EncodedVideoChunk', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k];
    rafQueue = []; rafId = 0; now = 1000; draws = 0;
    players = [];
    FakeDecoder.instances = [];
    mp4boxFakes.files.length = 0;
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => { draws++; } }) }) };
    g.VideoDecoder = FakeDecoder;
    g.EncodedVideoChunk = FakeChunk;
    g.requestAnimationFrame = (cb: FrameRequestCallback) => { const id = ++rafId; rafQueue.push({ id, cb }); return id; };
    g.cancelAnimationFrame = (id: number) => { rafQueue = rafQueue.filter(r => r.id !== id); };
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    for (const p of players) p.dispose();
    players = [];
    // Give any in-flight boot a chance to observe `stopped` before the globals go away.
    await flushAsync();
    vi.restoreAllMocks();
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; }
    rafQueue = [];
    FakeDecoder.instances = [];
    mp4boxFakes.files.length = 0;
  });

  const TIMESCALE = 1000;
  /** Samples [from, to) at 10 fps in a 1000-tick timescale. */
  const samples = (from: number, to: number, nb: number) => {
    const out = [];
    for (let i = from; i < to; i++) out.push({ number: i, track_id: 1, is_sync: i === 0, cts: i * 100, dts: i * 100, duration: 100, timescale: TIMESCALE, size: 1, data: new Uint8Array(1), nb });
    return out;
  };

  async function boot(opts: { loop?: boolean } = {}, nbSamples = 10) {
    const filesBefore = mp4boxFakes.files.length;
    const decodersBefore = FakeDecoder.instances.length;
    const player = createHevcPlayer(new Blob([new Uint8Array(64)]), opts);
    players.push(player);
    await waitFor(() => mp4boxFakes.files.length > filesBefore, 'MP4Box.createFile()');
    const file = mp4boxFakes.files[filesBefore];
    expect(file).toBeDefined();
    file.onReady!({
      hasMoov: true, duration: 1000, timescale: 1000, isFragmented: false, isProgressive: true, brands: [], tracks: [], audioTracks: [],
      videoTracks: [{ id: 1, codec: 'hvc1.1.6.L93.B0', timescale: TIMESCALE, duration: 1000, movie_duration: 1000, movie_timescale: 1000, nb_samples: nbSamples, track_width: 64, track_height: 48 }],
    });
    await waitFor(() => FakeDecoder.instances.length > decodersBefore && file.starts >= 1, 'decoder configured and extraction started');
    const dec = FakeDecoder.instances[decodersBefore];
    expect(dec).toBeDefined();
    expect(FakeDecoder.instances.length).toBe(decodersBefore + 1);
    expect(file.starts).toBe(1);
    // `ready` settles on the first decoded frame, which the tests emit themselves.
    return { player, file, dec, feed: (from: number, to: number) => file.onSamples!(1, null, samples(from, to, nbSamples)) };
  }

  it('flushes the decoder once the last sample is queued', async () => {
    const { player, dec, feed } = await boot();
    feed(0, 5);
    expect(dec.flushes).toBe(0);
    feed(5, 10);
    expect(dec.flushes).toBe(1);
    player.dispose();
  });

  it('restarts the loop exactly once at the end and keeps a single rAF chain', async () => {
    const { player, file, dec, feed } = await boot({ loop: true });
    feed(0, 10);
    dec.emit(); // all 10 frames land at once
    expect(rafQueue.length).toBe(1);
    tick(); // presents frame 0 (only it is due)
    expect(draws).toBe(1);
    expect(player.currentTime).toBe(0);
    expect(rafQueue.length).toBe(1);

    now = 2000; // 1 s later: everything is due; frame 9 is drawn, the rest dropped
    tick();
    expect(draws).toBe(2);
    expect(dec.resets).toBe(1);
    expect(file.seeks).toEqual([0]);
    expect(file.starts).toBe(2);
    expect(player.currentTime).toBe(0);    // clock re-anchored, not stuck at 0.9
    expect(rafQueue.length).toBe(1);       // one chain, not two

    // Decoder latency: several empty ticks before the first re-decoded frame.
    for (let i = 0; i < 5; i++) { now += 16; tick(); }
    expect(dec.resets).toBe(1);            // no re-fire
    expect(file.starts).toBe(2);
    expect(rafQueue.length).toBe(1);

    // The re-decoded run arrives and plays from 0.
    feed(0, 10);
    dec.emit(1);
    now = 3000;
    tick();
    expect(draws).toBe(3);
    expect(player.currentTime).toBe(0);
    expect(player.paused).toBe(false);
    player.dispose();
    expect(rafQueue.length).toBe(0);
  });

  it('treats a drained decoder as end-of-clip even outside the 200 ms tail window', async () => {
    // 6 samples in a clip whose header says 1 s: last pts 0.5 s is 500 ms short of the end.
    const { player, file, dec, feed } = await boot({ loop: true }, 6);
    feed(0, 6);
    expect(dec.flushes).toBe(1);
    dec.emit();
    dec.resolveFlush();
    await flushAsync();
    tick();
    now = 2000;
    tick();
    expect(player.currentTime).toBe(0);    // restarted
    expect(file.seeks).toEqual([0]);
    expect(dec.resets).toBe(1);
    // A stale flush from the previous run must not end the new run early.
    feed(0, 6);
    dec.emit(1);
    now = 3000;
    tick();
    expect(file.seeks).toEqual([0]);
    player.dispose();
  });

  it('with loop=false pauses at the end and play() restarts from 0', async () => {
    const { player, file, dec, feed } = await boot({ loop: false });
    feed(0, 10);
    dec.emit();
    tick();
    now = 2000;
    tick();
    expect(player.paused).toBe(true);
    expect(rafQueue.length).toBe(0);
    expect(file.starts).toBe(1);
    player.play();
    expect(player.paused).toBe(false);
    expect(file.seeks).toEqual([0]);
    expect(file.starts).toBe(2);
    expect(dec.resets).toBe(1);
    expect(rafQueue.length).toBe(1);
    player.dispose();
  });

  it('seek() while paused presents the sought frame without resuming', async () => {
    const { player, file, dec, feed } = await boot({ loop: true });
    feed(0, 10);
    dec.emit();
    tick();
    expect(draws).toBe(1);
    player.pause();
    expect(player.paused).toBe(true);
    player.seek(0.5);
    expect(file.seeks).toEqual([0.5]);
    expect(player.currentTime).toBe(0.5);
    expect(rafQueue.length).toBe(0);        // still paused: nothing armed yet
    feed(5, 10);
    dec.emit(1);                            // first re-decoded frame (pts 0.5 s)
    expect(rafQueue.length).toBe(1);
    now = 5000;
    tick();
    expect(draws).toBe(2);                  // drawn even though paused
    expect(player.currentTime).toBe(0.5);
    expect(player.paused).toBe(true);
    expect(rafQueue.length).toBe(0);        // and no loop running while paused
    player.play();
    expect(rafQueue.length).toBe(1);
    tick();
    expect(player.paused).toBe(false);
    player.dispose();
  });
});
