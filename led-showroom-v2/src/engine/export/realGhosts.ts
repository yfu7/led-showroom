/**
 * Client-facing outputs (Save image, video, the 3D viewer, GLB) draw a ghost, a part the build
 * needs and we do not hold, as the real part: what is to buy is ours to know, not the client's to
 * see. The app keeps drawing ghosts see-through; this lends them the real look for one export.
 * The CAD sheet needs none of it: its line art draws every surface opaque already.
 *
 * Holds overlap (a video take runs while a GLB saves), so there is one shared state rather than
 * per-call snapshots: ghosts look real while anything holds them, and the last release sets the
 * ghost look back. Both looks are fixed, so a part rebuilt mid-hold is simply set again.
 */
import type * as THREE from 'three';
import type { Engine } from '../Engine';
import { GHOST_OPACITY } from '../entities/equipmentGeometry';

type GhostHost = Pick<Engine, 'doc' | 'invalidate'> & { scene: Pick<Engine['scene'], 'rootOf'> };

let holders = 0;

/**
 * Give every ghost the real part's look (`real`) or the see-through one. Idempotent, and it finds
 * parts rebuilt since the last call. True when anything changed.
 */
export function setGhostLook(engine: GhostHost, real: boolean): boolean {
  let changed = false;
  const opacity = real ? 1 : GHOST_OPACITY;
  for (const e of engine.doc.entities) {
    if (e.type !== 'equipment' || !e.ghost) continue;
    engine.scene.rootOf(e.id)?.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (typeof m.userData.realCastShadow === 'boolean') {
        const cast = real && m.userData.realCastShadow;
        if (m.castShadow !== cast) { m.castShadow = cast; changed = true; }
      }
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat?.userData.ghost) continue;
        if (mat.transparent === !real && mat.opacity === opacity && mat.depthWrite === real) continue;
        mat.transparent = !real; mat.opacity = opacity; mat.depthWrite = real; mat.needsUpdate = true;
        changed = true;
      }
    });
  }
  return changed;
}

/** True while an export holds the ghosts real. */
export const ghostsHeldReal = (): boolean => holders > 0;

/** Hold the ghosts real. The returned release runs once; the last one sets the ghost look back. */
export function realGhosts(engine: GhostHost): () => void {
  holders++;
  if (setGhostLook(engine, true)) engine.invalidate();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0 && setGhostLook(engine, false)) engine.invalidate();
  };
}
