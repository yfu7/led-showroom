/**
 * Minimal typings for the `mp4box` package (0.5.4, CommonJS UMD bundle, no
 * upstream types). Only the surface used by src/engine/content/video.ts is
 * declared; everything else is left untyped. The UMD assigns named exports
 * onto `exports` (createFile, DataStream, ISOFile, ...), so both
 * `import MP4Box from 'mp4box'` (Vite CJS interop: default = module.exports)
 * and `import { createFile } from 'mp4box'` resolve.
 */
declare module 'mp4box' {
  /** An ArrayBuffer tagged with the byte offset it was sliced from in the file. */
  export interface MP4BoxBuffer extends ArrayBuffer {
    fileStart: number;
  }

  /** One track as reported by ISOFile.getInfo(). */
  export interface MP4TrackInfo {
    id: number;
    /** RFC 6381 codec string, e.g. 'hvc1.1.6.L93.B0' or 'avc1.64001F'. */
    codec: string;
    /** Media timescale (ticks per second). */
    timescale: number;
    /** Duration in media timescale ticks. */
    duration: number;
    movie_duration: number;
    movie_timescale: number;
    nb_samples: number;
    track_width: number;
    track_height: number;
    type?: string;
    video?: { width: number; height: number };
    audio?: { sample_rate: number; channel_count: number; sample_size: number };
  }

  /** Movie-level info passed to onReady. */
  export interface MP4Info {
    hasMoov: boolean;
    /** Duration in movie timescale ticks. */
    duration: number;
    timescale: number;
    isFragmented: boolean;
    isProgressive: boolean;
    brands: string[];
    tracks: MP4TrackInfo[];
    videoTracks: MP4TrackInfo[];
    audioTracks: MP4TrackInfo[];
  }

  /** One extracted sample passed to onSamples. */
  export interface MP4Sample {
    number: number;
    track_id: number;
    is_sync: boolean;
    /** Composition and decode timestamps in `timescale` ticks. */
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    size: number;
    data: Uint8Array;
  }

  /** Any parsed ISOBMFF box. Config boxes (avcC/hvcC) can serialise themselves. */
  export interface Mp4BoxNode {
    type?: string;
    size?: number;
    write?: (stream: DataStream) => void;
    [key: string]: unknown;
  }

  /** A visual sample entry from the stsd box. */
  export interface MP4SampleEntry extends Mp4BoxNode {
    avcC?: Mp4BoxNode;
    hvcC?: Mp4BoxNode;
  }

  /** The parsed `trak` box hierarchy, as far as we walk it. */
  export interface MP4Trak {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: MP4SampleEntry[] } } } };
    [key: string]: unknown;
  }

  /** mp4box's growable byte writer/reader. */
  export class DataStream {
    constructor(arrayBuffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    static LITTLE_ENDIAN: boolean;
    /** Backing buffer trimmed to the bytes written so far. */
    buffer: ArrayBuffer;
    byteLength: number;
  }

  /** The demuxer object returned by createFile(). */
  export interface MP4BoxFile {
    onReady?: (info: MP4Info) => void;
    onError?: (err: string) => void;
    onSamples?: (trackId: number, user: unknown, samples: MP4Sample[]) => void;
    onMoovStart?: () => void;
    /** Append a chunk (must carry `fileStart`); returns the next expected offset. */
    appendBuffer(buffer: MP4BoxBuffer, last?: boolean): number;
    start(): void;
    stop(): void;
    flush(): void;
    /** Position extraction at `time` seconds (on the previous RAP when useRap). */
    seek(time: number, useRap?: boolean): { offset: number; time: number };
    setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number; rapAlignement?: boolean }): void;
    unsetExtractionOptions(trackId: number): void;
    releaseUsedSamples(trackId: number, sampleNumber: number): void;
    getTrackById(trackId: number): MP4Trak | undefined;
    getInfo(): MP4Info;
    moov?: unknown;
  }

  /** Create a demuxer. `keepMdatData` (default true) keeps sample bytes in memory for re-extraction. */
  export function createFile(keepMdatData?: boolean): MP4BoxFile;

  const MP4Box: {
    createFile: typeof createFile;
    DataStream: typeof DataStream;
  };
  export default MP4Box;
}
