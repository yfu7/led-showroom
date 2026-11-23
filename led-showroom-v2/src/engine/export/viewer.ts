/**
 * Interactive viewer export: one self-contained .html that opens from disk (or an email) and lets
 * anyone walk round the showroom as it stood at export, read only.
 *
 * The model is the binary glTF export of the whole scene (frozen frames, no live websites or venue
 * splats: those never leave the app). The page carries it as base64 beside a JSON `ViewerConfig`
 * (lights, floor, backdrop, camera stands) and the viewer runtime (three inside), also as base64:
 * minified three can hold `</script` or `<!--` in its code, which no escaping of plain text can make
 * safe inside a script element, so the page decodes it and runs it with `new Function`.
 *
 * `buildViewerHtml` and `viewerConfigFor`'s maths are pure and unit-tested; `exportViewer` reads
 * the engine and the browser.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { DimensionEntity, LedWallEntity } from '../document/types';
import { LedWallRenderer } from '../entities/LedWallRenderer';
import { dimensionLabelPosition, dimensionLabelText, MEASURE_COLOR, MEASURE_LABEL_HEIGHT_IN } from '../entities/DimensionRenderer';
import { DIMENSION_LINE_COLOR, DIMENSION_TEXT_COLOR, type DimensionPieces } from '../ledwall/dimensions';
import { exportGltf, INCH_TO_METRE } from './gltf';
import { downloadBlob } from './composite';
import type { ViewerConfig, ViewerDimSet, ViewerLight } from '@/viewer/config';
import { viewerPresets, type Box, type V3, type WallView } from '@/viewer/presets';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** JSON that cannot close or open anything inside a script element. */
export const scriptSafeJson = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** UTF-8 text to base64, in chunks (a spread of a few MB would overflow the call stack). */
export function utf8ToBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Wrap base64 at 120 columns: some mail clients choke on a single multi-megabyte line. */
function wrap(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 120) lines.push(b64.slice(i, i + 120));
  return lines.join('\n') + '\n';
}

/** Runs the base64 runtime. Plain text, no `<`: nothing in it can end its script element. */
const BOOT = "(function(){var t=document.getElementById('viewer-runtime').textContent.replace(/\\s+/g,'');var b=atob(t),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);new Function(new TextDecoder().decode(u))();})();";

export interface ViewerHtmlInput {
  config: ViewerConfig;
  /** The GLB, base64. */
  glbBase64: string;
  /** The runtime's JavaScript source (the IIFE bundle). */
  runtime: string;
}

/** The whole page. */
export function buildViewerHtml({ config, glbBase64, runtime }: ViewerHtmlInput): string {
  const title = escapeHtml(config.title || 'Showroom');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    `<meta name="generator" content="Veloxity LED Showroom ${escapeHtml(config.appVersion)}">`,
    `<title>${title}</title>`,
    '<style>html,body{margin:0;height:100%;background:#0b0f14}</style>',
    '</head>',
    '<body>',
    `<noscript>This showroom needs JavaScript to show its 3D view.</noscript>`,
    `<script type="application/json" id="viewer-config">${scriptSafeJson(config)}</script>`,
    `<script type="application/octet-stream" id="viewer-glb">\n${wrap(glbBase64)}</script>`,
    `<script type="application/octet-stream" id="viewer-runtime">\n${wrap(utf8ToBase64(runtime))}</script>`,
    `<script>${BOOT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'showroom';
export const suggestViewerFilename = (name: string): string => `${slug(name)}-viewer.html`;

const toM = (v: THREE.Vector3): V3 => [v.x * INCH_TO_METRE, v.y * INCH_TO_METRE, v.z * INCH_TO_METRE];
const boxM = (b: THREE.Box3): Box => ({ min: toM(b.min), max: toM(b.max) });
const hex = (c: THREE.Color): string => `#${c.getHexString()}`;

/**
 * The way a directional light shines, as three.js lights it: from its position towards its target.
 * The app leaves the fill and rim targets at the origin, so the scene's middle must not stand in.
 */
export function lightDir(l: THREE.DirectionalLight): V3 {
  const d = l.position.clone().sub(l.target.position).normalize();
  return [d.x, d.y, d.z];
}

/** The lights as the app has them now. */
function lightsOf(engine: Engine): ViewerLight[] {
  const env = engine.env;
  const dir = lightDir;
  return [
    { kind: 'hemi', color: hex(env.hemi.color), ground: hex(env.hemi.groundColor), intensity: env.hemi.intensity },
    { kind: 'ambient', color: hex(env.ambient.color), intensity: env.ambient.intensity },
    { kind: 'directional', color: hex(env.key.color), intensity: env.key.intensity, dir: dir(env.key), key: true },
    { kind: 'directional', color: hex(env.fill.color), intensity: env.fill.intensity, dir: dir(env.fill) },
    { kind: 'directional', color: hex(env.rim.color), intensity: env.rim.intensity, dir: dir(env.rim) },
  ];
}

/** A blob, object or remote URL as a data URL; null where the browser will not hand it over. */
async function toDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>(resolve => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The CSS the app paints behind the canvas, with a venue photo carried in the file. */
async function backdropOf(engine: Engine, warnings: string[]): Promise<{ css: string; photo: boolean }> {
  const live = engine.renderer.backdropEl.style.background;
  const photo = engine.env.photo;
  if (!photo) return { css: live, photo: false };
  const data = await toDataUrl(photo);
  if (data) return { css: `${engine.doc.environment.backdrop.color && engine.doc.environment.backdrop.color !== 'auto' ? engine.doc.environment.backdrop.color + ' ' : ''}url("${data}") center / cover no-repeat`, photo: true };
  warnings.push('The venue photo could not be read into the file (its host does not allow it): the viewer shows the plain backdrop.');
  const t = engine.env.theme;
  return { css: `radial-gradient(ellipse at 50% 65%, ${t.backdropTop} 0%, ${t.backdropBottom} 70%)`, photo: false };
}

export interface ViewerExportResult {
  filename: string;
  glbBytes: number;
  runtimeBytes: number;
  htmlBytes: number;
  presets: string[];
  photo: boolean;
  warnings: string[];
  ms: number;
}

/** The walls' boxes and facings, in metres. A wall's face looks down its own +z. */
export function wallViews(engine: Engine): WallView[] {
  const out: WallView[] = [];
  for (const e of engine.doc.entities) {
    if (e.type !== 'led-wall') continue;
    const root = engine.scene.rootOf(e.id);
    if (!root?.visible) continue;
    const box = engine.scene.bounds([e.id]);
    if (box.isEmpty()) continue;
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
    out.push({ id: e.id, name: (e as LedWallEntity).name, box: boxM(box), normal: [n.x, n.y, n.z] });
  }
  return out;
}

/** Inches to metres, to a tenth of a millimetre: the page carries no more than it can show. */
const mm10 = (inches: number): number => Math.round(inches * INCH_TO_METRE * 1e4) / 1e4;

/** Pieces in world inches as a page's set in metres; null when there is nothing to show. */
export function dimSetOf(kind: ViewerDimSet['kind'], line: string, text: string, p: DimensionPieces): ViewerDimSet | null {
  if (!p.segs.length && !p.labels.length) return null;
  return {
    kind, line, text,
    segs: p.segs.map(mm10),
    labels: p.labels.map(l => ({ text: l.text, p: [mm10(l.p[0]), mm10(l.p[1]), mm10(l.p[2])], h: mm10(l.h) })),
  };
}

/** True when the object and every parent are shown. */
const shown = (o: THREE.Object3D | undefined): boolean => {
  if (!o) return false;
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
};

/**
 * Every shown wall's dimensions (whether or not they are switched on in the app) and every shown
 * tape measurement, as the app draws them, in the display unit.
 */
export function dimsOf(engine: Engine): ViewerDimSet[] {
  const walls: DimensionPieces = { segs: [], labels: [] }, tape: DimensionPieces = { segs: [], labels: [] };
  const unit = engine.doc.settings.units;
  engine.scene.world.updateWorldMatrix(true, true);
  for (const e of engine.doc.entities) {
    const r = engine.scene.get(e.id);
    if (!r || !shown(r.root)) continue;
    if (e.type === 'led-wall' && r instanceof LedWallRenderer) {
      const p = r.dimensionPieces();
      for (const n of p.segs) walls.segs.push(n);
      for (const l of p.labels) walls.labels.push(l);
    } else if (e.type === 'dimension') {
      const { a, b, label } = e as DimensionEntity;
      tape.segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      tape.labels.push({ text: dimensionLabelText(a, b, unit, label), p: dimensionLabelPosition(a, b), h: MEASURE_LABEL_HEIGHT_IN });
    }
  }
  const css = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
  return [
    dimSetOf('wall', css(DIMENSION_LINE_COLOR), DIMENSION_TEXT_COLOR, walls),
    dimSetOf('measure', css(MEASURE_COLOR), DIMENSION_TEXT_COLOR, tape),
  ].filter((s): s is ViewerDimSet => !!s);
}

/** Export the scene as a standalone viewer page and download it. */
export async function exportViewer(engine: Engine): Promise<ViewerExportResult> {
  const t0 = performance.now();
  const warnings: string[] = [];
  const [{ default: runtime }, glb] = await Promise.all([
    import('virtual:viewer-runtime'),
    // Nothing visible to export (empty, all hidden, scans only): the page shows the bare room.
    exportGltf(engine, { binary: true, selectionOnly: false })
      .catch((err: unknown) => { if ((err as Error)?.message === 'Nothing to export') return null; throw err; }),
  ]);
  const glbBytes = glb ? new Uint8Array(await glb.arrayBuffer()) : new Uint8Array(0);

  engine.scene.world.updateWorldMatrix(true, true);
  const sceneBox = engine.scene.bounds();
  if (sceneBox.isEmpty()) sceneBox.set(new THREE.Vector3(-60, 0, -10), new THREE.Vector3(60, 96, 10));
  const env = engine.doc.environment;
  const backdrop = await backdropOf(engine, warnings);
  const cam = engine.camera.camera;
  const target = engine.camera.controls.target;
  const presets = viewerPresets(boxM(sceneBox), wallViews(engine));
  const websites = engine.doc.entities.some(e => e.type === 'led-wall'
    && (e as LedWallEntity).contentWindows.some(w => w.visible && w.source?.type === 'website'));
  if (websites || engine.doc.entities.some(e => e.type === 'splat' && e.visible !== false)) {
    warnings.push('Live websites and venue scans stay in the app: the viewer shows the build without them.');
  }

  const config: ViewerConfig = {
    v: 1,
    title: engine.doc.name || 'Showroom',
    exportedAt: new Date().toISOString(),
    appVersion: __APP_VERSION__,
    fovDeg: engine.camera.fov,
    shadows: env.lighting.shadows,
    lights: lightsOf(engine),
    floor: {
      visible: engine.env.floor.visible,
      color: hex(engine.env.floor.material.color),
      sizeM: Math.max(120, env.floor.sizeIn) * INCH_TO_METRE,
      shadowCatcher: engine.env.shadowCatcher.visible,
    },
    backdrop: backdrop.css,
    presets,
    start: { position: toM(cam.position), target: toM(target) },
    bounds: boxM(sceneBox),
    glbBytes: glbBytes.length,
    dims: dimsOf(engine),
  };
  const html = buildViewerHtml({ config, glbBase64: bytesToBase64(glbBytes), runtime });
  const filename = suggestViewerFilename(config.title);
  const file = new File([html], filename, { type: 'text/html' });
  downloadBlob(file, filename);
  return {
    filename, glbBytes: glbBytes.length, runtimeBytes: runtime.length, htmlBytes: file.size,
    presets: presets.map(p => p.label), photo: backdrop.photo, warnings, ms: Math.round(performance.now() - t0),
  };
}
