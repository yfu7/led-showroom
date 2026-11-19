/**
 * A throwaway paper-white copy of the scene, for the drawing sheet.
 *
 * Hidden-line removal without a CPU line solver: every surface is re-materialised as opaque paper
 * white and pushed back a hair with `polygonOffset`, then black `EdgesGeometry` lines are drawn on
 * top. The depth buffer then does the occlusion — an edge behind a surface loses the depth test and
 * simply is not drawn, which is what a hidden-line drawing looks like.
 *
 * What is copied, and what is deliberately not:
 *
 *  - Source is `scene.world`, the parent of all entity roots. That excludes the backdrop, the
 *    ground grid and the lights, which belong to the viewport rather than to the model.
 *  - `userData.helper` is skipped: the pixel-grid planes, the 3D dimension annotations and the
 *    contact shadows under photo cutouts all carry it. The sheet draws its own dimensions in 2D.
 *  - Content windows (`userData.part === 'content'`) are skipped: they sit a hair in front of the
 *    panel faces, so filling them white would z-fight, and a construction drawing is about the
 *    structure rather than what is playing on it.
 *  - Photo cutouts (`userData.part === 'photo'`) are billboards — they turn to face the camera, so
 *    in an orthographic elevation they would be a plausible-looking lie. Each is replaced by the
 *    outline of the entity's declared dimensions box, which is the real footprint.
 *  - Existing `Line` objects (bezel outlines, room guides) are skipped: the panel meshes already
 *    produce those seams through `EdgesGeometry`, and taking both doubled every panel edge at a
 *    small offset. One source means one uniform line weight.
 *
 * Nothing in the live scene is mutated, and no source geometry or material is disposed — only what
 * this module allocated, which is what `dispose()` releases.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Entity } from '../document/types';
import type { Vec3 } from '../math';
import { LAYER_MAIN } from '../scene/Renderer';

export interface LineArtOptions {
  /** Surface colour. Pure white by default, which is what the sheet is painted. */
  paper?: string;
  /** Line colour. */
  ink?: string;
  /** `EdgesGeometry` crease angle, degrees. 24 keeps panel seams and drops tessellation chatter. */
  angle?: number;
  /**
   * Budget for drawn edge segments. Past it, remaining meshes contribute a bounding-box outline
   * instead of true edges and `simplified` is set — a ten-wall scene of mitred panels can otherwise
   * build a few hundred thousand segments and stall the tab.
   */
  maxSegments?: number;
}

export interface LineArt {
  scene: THREE.Scene;
  /** World bounds of everything drawn. Empty when the scene has no visible geometry. */
  bounds: THREE.Box3;
  meshes: number;
  segments: number;
  /** True when the edge budget forced some meshes down to a bounding box. */
  simplified: boolean;
  dispose(): void;
}

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;

/** Edge segments in an `EdgesGeometry` (always a non-indexed line list). */
const segmentsOf = (g: THREE.BufferGeometry): number => Math.floor((g.getAttribute('position')?.count ?? 0) / 2);

/** Box with its origin at the bottom centre, matching how entity dims are declared. */
function dimsBoxGeometry(dims: Vec3): THREE.BufferGeometry {
  const h = Math.max(0.01, dims[1]);
  const g = new THREE.BoxGeometry(Math.max(0.01, dims[0]), h, Math.max(0.01, dims[2]));
  g.translate(0, h / 2, 0);
  return g;
}

/** `dims` if the entity declares them (equipment always, imported models when known). */
function declaredDims(e: Entity | undefined): Vec3 | null {
  const d = (e as { dims?: Vec3 } | undefined)?.dims;
  return d && d.length === 3 ? d : null;
}

/**
 * Build the line-art scene. Synchronous and allocation-heavy: call it once per sheet and dispose it
 * when the sheet is composed.
 */
export function buildLineArt(engine: Engine, opts: LineArtOptions = {}): LineArt {
  const paper = opts.paper ?? '#ffffff';
  const ink = opts.ink ?? '#000000';
  const angle = opts.angle ?? 24;
  const maxSegments = opts.maxSegments ?? 400_000;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(paper);

  const surface = new THREE.MeshBasicMaterial({
    color: paper, side: THREE.DoubleSide, toneMapped: false,
    // Push surfaces away from the camera so a coincident edge wins the depth test. Without this
    // every silhouette edge stipples against its own face.
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const line = new THREE.LineBasicMaterial({ color: ink, toneMapped: false });

  const bounds = new THREE.Box3();
  const box = new THREE.Box3();
  /** One EdgesGeometry per source geometry: unmitred panels all share one, and a wall has dozens. */
  const edgeCache = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  const owned: THREE.BufferGeometry[] = [];
  let meshes = 0, segments = 0, simplified = false;

  const place = (obj: THREE.Object3D, matrixWorld: THREE.Matrix4): void => {
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(matrixWorld);
    obj.matrixWorldNeedsUpdate = true;
    obj.layers.set(LAYER_MAIN);
    scene.add(obj);
  };

  const addEdges = (geom: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): void => {
    if (segments >= maxSegments) {
      // Budget spent: a box outline still shows where the thing is, at twelve segments.
      simplified = true;
      geom.computeBoundingBox();
      const b = geom.boundingBox;
      if (!b) return;
      const g = new THREE.BoxGeometry(Math.max(1e-4, b.max.x - b.min.x), Math.max(1e-4, b.max.y - b.min.y), Math.max(1e-4, b.max.z - b.min.z));
      g.translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      const eg = new THREE.EdgesGeometry(g, angle);
      g.dispose();
      owned.push(eg);
      segments += segmentsOf(eg);
      place(new THREE.LineSegments(eg, line), matrixWorld);
      return;
    }
    let eg = edgeCache.get(geom);
    if (!eg) {
      eg = new THREE.EdgesGeometry(geom, angle);
      edgeCache.set(geom, eg);
      owned.push(eg);
    }
    segments += segmentsOf(eg);
    place(new THREE.LineSegments(eg, line), matrixWorld);
  };

  // World matrices for the whole graph in one pass, so every `matrixWorld` read below is current.
  engine.scene.scene.updateMatrixWorld(true);

  /** Entity ids whose billboarded photo plane has to be replaced by a dims box. */
  const billboards = new Set<string>();
  /** Nearest ancestor entity id, for attributing a skipped billboard to its entity. */
  const entityIdOf = (o: THREE.Object3D): string | null => {
    for (let n: THREE.Object3D | null = o; n; n = n.parent) {
      const id = n.userData.entityId as string | undefined;
      if (id) return id;
    }
    return null;
  };

  engine.scene.world.traverseVisible(obj => {
    if (obj.userData.helper) return;
    if (!isMesh(obj)) return;
    if (!obj.layers.isEnabled(LAYER_MAIN)) return;
    const part = obj.userData.part as string | undefined;
    if (part === 'content') return;
    if (part === 'photo') { const id = entityIdOf(obj); if (id) billboards.add(id); return; }
    if (!obj.geometry.getAttribute('position')) return;

    meshes++;
    place(new THREE.Mesh(obj.geometry, surface), obj.matrixWorld);
    addEdges(obj.geometry, obj.matrixWorld);

    obj.geometry.computeBoundingBox();
    if (obj.geometry.boundingBox) bounds.union(box.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld));
  });

  for (const id of billboards) {
    const dims = declaredDims(engine.doc.entities.find(e => e.id === id));
    const root = engine.scene.rootOf(id);
    if (!dims || !root) continue;
    const geom = dimsBoxGeometry(dims);
    owned.push(geom);
    meshes++;
    place(new THREE.Mesh(geom, surface), root.matrixWorld);
    addEdges(geom, root.matrixWorld);
    geom.computeBoundingBox();
    if (geom.boundingBox) bounds.union(box.copy(geom.boundingBox).applyMatrix4(root.matrixWorld));
  }

  return {
    scene, bounds, meshes, segments, simplified,
    dispose() {
      scene.clear();
      for (const g of owned) g.dispose();
      owned.length = 0;
      edgeCache.clear();
      surface.dispose();
      line.dispose();
    },
  };
}
