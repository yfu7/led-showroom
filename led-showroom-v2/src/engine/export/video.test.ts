import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEC_CANDIDATES, pickWorkingCodec, probeEncoder } from './video';

const [H264, VP9] = CODEC_CANDIDATES;

describe('picking a codec that records', () => {
  it('takes the first that puts a frame in a file, and says why each before it would not', async () => {
    const got = await pickWorkingCodec(CODEC_CANDIDATES, async cc => (cc === H264 ? 'the encoder returned no frames' : null));
    expect(got.cc).toBe(VP9);
    expect(got.failed).toEqual(['H.264: the encoder returned no frames']);
  });

  it('counts a probe that throws as one that would not do, and comes to none when none does', async () => {
    const got = await pickWorkingCodec(CODEC_CANDIDATES, async () => { throw new Error('boom'); });
    expect(got.cc).toBeNull();
    expect(got.failed).toEqual(CODEC_CANDIDATES.map(c => `${c.label}: boom`));
  });
});

describe('probing an encoder with a real frame', () => {
  /** A stand-in WebCodecs: `emit` decides what the encoder hands its output on encode. */
  function fakeCodecs(emit: (output: (chunk: unknown, meta?: unknown) => void, error: (e: Error) => void) => void, supported = true) {
    class FakeEncoder {
      static isConfigSupported = async () => ({ supported });
      constructor(private init: { output(c: unknown, m?: unknown): void; error(e: Error): void }) {}
      configure() { /* nothing to set up */ }
      encode() { emit(this.init.output, this.init.error); }
      async flush() { /* emitted synchronously */ }
      close() { /* nothing held */ }
    }
    class FakeFrame { close() { /* nothing held */ } }
    vi.stubGlobal('VideoEncoder', FakeEncoder);
    vi.stubGlobal('VideoFrame', FakeFrame);
  }
  afterEach(() => vi.unstubAllGlobals());
  const frame = {} as CanvasImageSource;

  it('says so where the encoder returns no frames', async () => {
    fakeCodecs(() => { /* nothing comes out */ });
    expect(await probeEncoder(H264, frame, 64, 64, 1e6, 30)).toBe('the encoder returned no frames');
  });

  it('says what the MP4 writer said where it refuses the frame', async () => {
    // A chunk with no decoder config: mp4-muxer cannot write the first sample without one.
    fakeCodecs(out => out({ type: 'key', timestamp: 0, duration: 0, byteLength: 4, copyTo() { /* no data */ } }, undefined));
    expect(await probeEncoder(H264, frame, 64, 64, 1e6, 30)).toMatch(/^the MP4 writer refused a frame \(.+\)$/);
  });

  it('says so where the encoder errors', async () => {
    fakeCodecs((_, error) => error(new Error('hardware gone')));
    expect(await probeEncoder(H264, frame, 64, 64, 1e6, 30)).toBe('encoder error (hardware gone)');
  });

  it('turns down a codec the browser does not support at the size', async () => {
    fakeCodecs(() => { /* never reached */ }, false);
    expect(await probeEncoder(H264, frame, 64, 64, 1e6, 30)).toBe('not supported at this size');
  });
});
