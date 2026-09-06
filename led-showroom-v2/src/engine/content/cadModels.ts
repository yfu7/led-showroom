/**
 * Manufacturer CAD meshes that ship with the app.
 *
 * The SolidWorks STEP files in `../cad/step` are converted to GLB by `scripts/step-to-glb.cjs`
 * (`npm run cad`), which merges every solid of a part into one indexed mesh, converts millimetres
 * to inches and re-frames the part. The results live in `public/models/*.glb` and are loaded from
 * here at runtime.
 *
 * This module is the shared loading seam for both users of that CAD:
 *   - `ledwall/geometry.ts` swaps the base plate and back supports in behind the parametric
 *     extrusions it builds synchronously;
 *   - `entities/EquipmentRenderer.ts` renders `geometry: 'cad'` catalog products.
 *
 * Everything except {@link loadCadGeometry} is pure, so the interesting parts (flattening a loaded
 * scene, the origin convention, the in-place swap) are testable under node. `loadCadGeometry` is a
 * no-op outside the browser unless a loader is injected with {@link setCadLoader}; nothing here
 * throws into the render path — a failed load simply leaves the caller's placeholder in place.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadModel } from './modelLoaders';

/** Which end of an axis' bounding-box extent lands on the origin. */
export type Anchor = 'min' | 'center' | 'max';

/** Origin convention for a loaded part, one anchor per axis. See {@link anchorGeometry}. */
export interface CadAnchors {
  x: Anchor;
  y: Anchor;
  z: Anchor;
}

/** Key form of {@link CadAnchors} (for cache keys and logging): e.g. `center|max|center`. */
export const anchorKey = (a: CadAnchors): string => `${a.x}|${a.y}|${a.z}`;

/**
 * Translate `geom` in place so its bounding box sits on the origin the way `anchors` says: `min`
 * puts the low end of that axis on 0, `max` the high end, `center` the midpoint. This is the one
 * place a CAD part's origin convention is fixed — consumers then place the mesh with the same
 * coordinates they use for the parametric geometry, and never compensate for the CAD frame.
 *
 * Returns the same geometry (mutated). An empty geometry is left alone.
 */
export function anchorGeometry(geom: THREE.BufferGeometry, anchors: CadAnchors): THREE.BufferGeometry {
  geom.computeBoundingBox();
  const b = geom.boundingBox;
  if (!b || b.isEmpty()) return geom;
  const pick = (min: number, max: number, a: Anchor): number => (a === 'min' ? min : a === 'max' ? max : (min + max) / 2);
  geom.translate(
    -pick(b.min.x, b.max.x, anchors.x),
    -pick(b.min.y, b.max.y, anchors.y),
    -pick(b.min.z, b.max.z, anchors.z),
  );
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Collapse a loaded scene graph into a single geometry in the scene's own frame: every mesh's
 * geometry is cloned, baked through its world matrix and merged. Only `position` and `normal`
 * survive (the converted CAD parts carry nothing else, and merging needs a matching attribute set);
 * material groups are dropped, since a CAD part is drawn with one material.
 *
 * Returns null when the object holds no mesh, or when the merge fails.
 */
export function flattenToGeometry(obj: THREE.Object3D): THREE.BufferGeometry | null {
  obj.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  obj.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.clearGroups();
    parts.push(g);
  });
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  // mergeGeometries needs every input to agree on indexing; de-index the lot if any is non-indexed.
  const mixed = parts.some(g => !g.index);
  const inputs = mixed ? parts.map(g => g.toNonIndexed()) : parts;
  const merged = mergeGeometries(inputs, false);
  for (const g of inputs) g.dispose();
  if (mixed) for (const g of parts) g.dispose();
  if (!merged) return null;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Replace everything about `target` with a copy of `source`, keeping the target object's identity
 * so meshes already pointing at it pick the new shape up without being rebuilt. Attributes are
 * cloned, so target and source can be disposed independently.
 *
 * `target.dispose()` runs first: it releases the GPU buffers of the attributes that are about to be
 * dropped (a geometry stays usable afterwards and re-uploads on the next render).
 */
export function adoptGeometry(target: THREE.BufferGeometry, source: THREE.BufferGeometry): THREE.BufferGeometry {
  if (target === source) return target;
  target.dispose();
  for (const name of Object.keys(target.attributes)) target.deleteAttribute(name);
  target.setIndex(source.index ? source.index.clone() : null);
  for (const [name, attr] of Object.entries(source.attributes)) {
    target.setAttribute(name, (attr as THREE.BufferAttribute).clone());
  }
  target.clearGroups();
  for (const g of source.groups) target.addGroup(g.start, g.count, g.materialIndex);
  target.computeBoundingBox();
  target.computeBoundingSphere();
  return target;
}

/** Size of a geometry's bounding box, as [w, h, d]. Empty geometry measures 0. */
export function geometrySize(geom: THREE.BufferGeometry): [number, number, number] {
  geom.computeBoundingBox();
  const b = geom.boundingBox;
  if (!b || b.isEmpty()) return [0, 0, 0];
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Loading                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** How a CAD url turns into a geometry. Overridable for tests — see {@link setCadLoader}. */
export type CadLoader = (url: string) => Promise<THREE.BufferGeometry>;

const cache = new Map<string, Promise<THREE.BufferGeometry>>();
let loader: CadLoader | null = null;

/**
 * Inject a loader (tests, or a host that serves the CAD from somewhere else). Passing null restores
 * the default GLB loader. Setting a loader clears the cache, so the next request goes through it.
 */
export function setCadLoader(fn: CadLoader | null): void {
  loader = fn;
  clearCadGeometryCache();
}

/**
 * Whether a CAD load can be attempted at all: a browser with `fetch`, or an injected loader. Under
 * node (the test environment) the shipped `/models/*.glb` cannot be fetched, so callers keep their
 * parametric placeholder and nothing is logged.
 */
export function cadLoadingAvailable(): boolean {
  return !!loader || (typeof window !== 'undefined' && typeof fetch === 'function');
}

async function defaultLoad(url: string): Promise<THREE.BufferGeometry> {
  const obj = await loadModel(url, 'glb', url.split('/').pop() || 'model.glb');
  const geom = flattenToGeometry(obj);
  // The loaded scene was only a carrier: drop its own geometries and materials.
  obj.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m?.dispose();
    }
  });
  if (!geom) throw new Error(`CAD model ${url} contains no mesh`);
  return geom;
}

/**
 * Load a shipped CAD part, framed by `anchors`, and cache it per url+anchors. The returned geometry
 * is SHARED between every caller — treat it as read-only (copy it with {@link adoptGeometry} if you
 * need your own). Rejects when loading is unavailable, so callers must handle the rejection.
 */
export function loadCadGeometry(url: string, anchors: CadAnchors): Promise<THREE.BufferGeometry> {
  const key = `${url}|${anchorKey(anchors)}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (!cadLoadingAvailable()) throw new Error('CAD loading is not available in this environment');
      const geom = await (loader ?? defaultLoad)(url);
      return anchorGeometry(geom, anchors);
    })();
    // A failed load must not poison the cache: drop it so a later attempt can retry.
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
    cache.set(key, p);
  }
  return p;
}

/** Dispose every cached CAD geometry and clear the cache (tests / teardown). */
export function clearCadGeometryCache(): void {
  for (const p of cache.values()) p.then(g => g.dispose()).catch(() => {});
  cache.clear();
}
