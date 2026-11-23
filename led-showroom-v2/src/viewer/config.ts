/**
 * What an exported viewer page carries besides the model: the look of the room and where to stand.
 * Written by `engine/export/viewer.ts`, read by `viewer/runtime.ts`. JSON only.
 */
import type { V3, ViewerPreset } from './presets';

export interface ViewerLight {
  kind: 'hemi' | 'ambient' | 'directional';
  color: string;
  /** Hemisphere lights only. */
  ground?: string;
  intensity: number;
  /** Directional lights: unit vector from the scene's centre towards the light. */
  dir?: V3;
  /** The key light, which casts the shadows when they are on. */
  key?: boolean;
}

export interface ViewerConfig {
  /** Bumped when the page's reading of this changes. */
  v: 1;
  title: string;
  /** ISO time of the export. */
  exportedAt: string;
  appVersion: string;
  fovDeg: number;
  shadows: boolean;
  lights: ViewerLight[];
  floor: { visible: boolean; color: string; sizeM: number; shadowCatcher: boolean };
  /** CSS background behind the canvas: the app's gradient, or the venue photo as a data URL. */
  backdrop: string;
  presets: ViewerPreset[];
  /** Where the camera stood in the app, in metres: the page opens there. */
  start: { position: V3; target: V3 };
  /** Scene box in metres, for walking bounds and the shadow camera. */
  bounds: { min: V3; max: V3 };
  glbBytes: number;
  /** The measurements, shown by the Dimensions toggle (off when the page opens). Empty: no toggle. */
  dims: ViewerDimSet[];
}

/** One kind of measurement as the app draws it, in metres. */
export interface ViewerDimSet {
  /** The walls' own dimensions, or tape measurements placed in the app. */
  kind: 'wall' | 'measure';
  /** Line and label text colours (CSS). */
  line: string;
  text: string;
  /** Line pieces, six numbers each: x1 y1 z1 x2 y2 z2. */
  segs: number[];
  /** `h`: the label's base height, before it is held readable from afar. */
  labels: { text: string; p: V3; h: number }[];
  /** Drawn dashed (a tape's dx / dy / dz breakdown), and how solid. Default solid, opacity 1. */
  dashed?: boolean;
  opacity?: number;
}
