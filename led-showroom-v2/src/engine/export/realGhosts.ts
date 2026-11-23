/**
 * Client-facing outputs (Save image, video, the 3D viewer, GLB) draw a ghost, a part the build
 * needs and we do not hold, as the real part: what is to buy is ours to know, not the client's to
 * see. The app keeps drawing ghosts see-through; this lends them the real look for one export.
 * The CAD sheet needs none of it: its line art draws every surface opaque already.
 */
import type * as THREE from 'three';
import type { Engine } from '../Engine';

type GhostHost = Pick<Engine, 'doc' | 'invalidate'> & { scene: Pick<Engine['scene'], 'rootOf'> };

/** Make every ghost opaque and shadow-casting. The returned function puts them back; it runs once. */
export function realGhosts(engine: GhostHost): () => void {
  const mats = new Map<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }>();
  const meshes = new Map<THREE.Mesh, boolean>();
  for (const e of engine.doc.entities) {
    if (e.type !== 'equipment' || !e.ghost) continue;
    engine.scene.rootOf(e.id)?.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (typeof m.userData.realCastShadow === 'boolean' && !meshes.has(m)) {
        meshes.set(m, m.castShadow);
        m.castShadow = m.userData.realCastShadow;
      }
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat?.userData.ghost || mats.has(mat)) continue;
        mats.set(mat, { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite });
        mat.transparent = false; mat.opacity = 1; mat.depthWrite = true; mat.needsUpdate = true;
      }
    });
  }
  if (mats.size || meshes.size) engine.invalidate();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const [mat, s] of mats) { Object.assign(mat, s); mat.needsUpdate = true; }
    for (const [m, cast] of meshes) m.castShadow = cast;
    if (mats.size || meshes.size) engine.invalidate();
  };
}
