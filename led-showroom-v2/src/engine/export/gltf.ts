/**
 * glTF / GLB export of the scene (or the selection) via three's GLTFExporter.
 *
 * The exported tree is rebuilt from `engine.scene.world` rather than cloned: helpers, gizmos,
 * pixel-grid overlays, selection outlines, bezel lines and CSS3D iframes are skipped, geometry
 * and materials are shared with the live scene (nothing is disposed), video textures are frozen
 * to their current frame, shader materials become plain standard materials, and the whole scene
 * is wrapped in a group that converts inches to metres (glTF's unit).
 *
 * `collectExportable` / `suggestGltfFilename` are pure (three.js only) and unit-tested.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Engine } from '../Engine';
import type { Document } from '../document/types';

export interface GltfExportOptions {
  /** .glb (binary) instead of .gltf (JSON). */
  binary: boolean;
  /** Export only the selected entities (whole scene when nothing is selected). */
  selectionOnly: boolean;
}

/** Inches → metres. */
export const INCH_TO_METRE = 0.0254;

const MAIN_LAYER = new THREE.Layers(); // layer 0

function isCss3d(o: THREE.Object3D): boolean {
  return (o as unknown as { isCSS3DObject?: boolean }).isCSS3DObject === true;
}

/** Objects that are scene furniture, not model content. */
export function isExportable(o: THREE.Object3D): boolean {
  if (!o.visible) return false;
  if (o.userData.helper) return false;
  if (o.userData.unpickable && o.userData.part !== 'content') return false;
  if (isCss3d(o)) return false;
  if (!o.layers.test(MAIN_LAYER)) return false;
  if ((o as THREE.Sprite).isSprite || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) return false;
  return true;
}

/** Freeze a live (video / canvas) texture to a static image texture the exporter can serialise. */
function freezeTexture(tex: THREE.Texture): THREE.Texture | null {
  const img = tex.image as unknown;
  if (!img) return null;
  const isVideo = typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement;
  if (!isVideo && !(tex as THREE.VideoTexture).isVideoTexture) return tex;
  if (typeof document === 'undefined') return null;
  const v = img as HTMLVideoElement;
  const w = v.videoWidth || v.width, h = v.videoHeight || v.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try { ctx.drawImage(v, 0, 0, w, h); } catch { return null; }
  const out = new THREE.CanvasTexture(canvas);
  out.colorSpace = tex.colorSpace;
  out.flipY = tex.flipY;
  out.wrapS = tex.wrapS; out.wrapT = tex.wrapT;
  out.repeat.copy(tex.repeat); out.offset.copy(tex.offset);
  return out;
}

/** Textures created for one export (frozen video frames); disposed afterwards. */
export type FrozenTextures = Set<THREE.Texture>;

/** A material the exporter understands, sharing the original where possible. */
function exportMaterial(m: THREE.Material, frozen?: FrozenTextures): THREE.Material {
  const sm = m as THREE.ShaderMaterial;
  if (sm.isShaderMaterial) {
    const color = (sm.uniforms?.color?.value as THREE.Color | undefined) ?? (sm.uniforms?.uColor?.value as THREE.Color | undefined);
    return new THREE.MeshStandardMaterial({ color: color instanceof THREE.Color ? color : new THREE.Color(0x111114), roughness: 0.6, metalness: 0.1 });
  }
  const mapped = m as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  if (mapped.map) {
    const still = freezeTexture(mapped.map);
    if (still !== mapped.map) {
      const c = mapped.clone();
      c.map = still;
      c.needsUpdate = true;
      if (still) frozen?.add(still);
      return c;
    }
  }
  return m;
}

/**
 * Rebuild the exportable part of `src` as a fresh tree. Meshes share geometry with the live
 * scene; the returned object carries `src`'s local transform. Returns null when nothing under
 * `src` is exportable.
 */
export function collectExportable(src: THREE.Object3D, frozen?: FrozenTextures): THREE.Object3D | null {
  if (!isExportable(src)) return null;
  const mesh = src as THREE.Mesh;
  let out: THREE.Object3D;
  if (mesh.isMesh) {
    const im = src as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      const copy = new THREE.InstancedMesh(im.geometry, im.material, im.count);
      copy.instanceMatrix.copy(im.instanceMatrix);
      if (im.instanceColor) copy.instanceColor = new THREE.InstancedBufferAttribute(im.instanceColor.array.slice(), im.instanceColor.itemSize);
      out = copy;
    } else {
      const mat = Array.isArray(mesh.material) ? mesh.material.map(m => exportMaterial(m, frozen)) : exportMaterial(mesh.material, frozen);
      out = new THREE.Mesh(mesh.geometry, mat);
    }
  } else {
    out = new THREE.Group();
  }
  out.name = src.name;
  out.position.copy(src.position);
  out.quaternion.copy(src.quaternion);
  out.scale.copy(src.scale);
  if (src.userData.entityId) { out.userData.entityId = src.userData.entityId; out.userData.entityType = src.userData.entityType; }
  for (const child of src.children) {
    const c = collectExportable(child, frozen);
    if (c) out.add(c);
  }
  if (!mesh.isMesh && out.children.length === 0) return null;
  return out;
}

/** Wrap roots in a metre-scaled scene group. Each root is placed with its world transform. */
export function buildExportRoot(roots: THREE.Object3D[], name = 'showroom', frozen?: FrozenTextures): THREE.Group {
  const root = new THREE.Group();
  root.name = name;
  root.scale.setScalar(INCH_TO_METRE);
  for (const r of roots) {
    r.updateWorldMatrix(true, false);
    const c = collectExportable(r, frozen);
    if (!c) continue;
    r.matrixWorld.decompose(c.position, c.quaternion, c.scale);
    root.add(c);
  }
  root.updateMatrixWorld(true);
  return root;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'showroom';

export function suggestGltfFilename(doc: Pick<Document, 'name'>, opts: GltfExportOptions, selectedNames: string[] = []): string {
  let base = slug(doc.name);
  if (opts.selectionOnly && selectedNames.length) base += '-' + (selectedNames.length === 1 ? slug(selectedNames[0]) : `${selectedNames.length}-objects`);
  return `${base}.${opts.binary ? 'glb' : 'gltf'}`;
}

/**
 * Export the scene (or the selection) as glTF. Resolves to a `File` (a `Blob` whose `.name` is
 * the suggested filename, e.g. `my-showroom.glb`). Throws when nothing is exportable.
 */
export async function exportGltf(engine: Engine, opts: GltfExportOptions): Promise<File> {
  const selectionOnly = opts.selectionOnly && engine.selection.length > 0;
  let roots: THREE.Object3D[];
  if (selectionOnly) {
    roots = engine.selection.map(id => engine.scene.rootOf(id)).filter((r): r is THREE.Object3D => !!r);
    // a selected entity nested under another selected one (group member) is already covered by its ancestor
    const set = new Set(roots);
    roots = roots.filter(r => { for (let p = r.parent; p; p = p.parent) if (set.has(p)) return false; return true; });
  } else {
    roots = engine.scene.world.children.slice();
  }
  engine.scene.world.updateWorldMatrix(true, true);
  const frozen: FrozenTextures = new Set();
  const root = buildExportRoot(roots, slug(engine.doc.name), frozen);
  if (!root.children.length) throw new Error('Nothing to export');

  const exporter = new GLTFExporter();
  let result: ArrayBuffer | { [key: string]: unknown };
  try {
    result = await exporter.parseAsync(root, {
      binary: opts.binary,
      onlyVisible: true,
      trs: true,
      includeCustomExtensions: false,
      maxTextureSize: Math.min(4096, engine.renderer.maxTextureSize || 4096),
    });
  } finally {
    for (const t of frozen) t.dispose(); // frozen video frames are ours; geometry/materials stay shared with the scene
  }

  const selectedNames = selectionOnly ? engine.selectedEntities().map(e => e.name) : [];
  const filename = suggestGltfFilename(engine.doc, opts, selectedNames);
  const blob = result instanceof ArrayBuffer
    ? new Blob([result], { type: 'model/gltf-binary' })
    : new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' });
  return new File([blob], filename, { type: blob.type });
}

