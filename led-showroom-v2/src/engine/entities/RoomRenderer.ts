/**
 * Room renderer (v1 "Venue Space", index.html 6774-7012): five planes — back wall, floor,
 * ceiling, left and right walls — at real scale, each optionally textured with an uploaded photo
 * or video.
 *
 * Local frame: the origin is the floor centre of the BACK wall line. x ∈ [-widthIn/2, widthIn/2],
 * y ∈ [0, heightIn], and the room extends towards +Z by depthIn (the back wall plane is z = 0).
 * Every plane is single-sided and faces INTO the room so the surfaces render from inside.
 *
 * Outline mode (`entity.outlineWalls`, what every booth preset uses) swaps the four upright
 * surfaces for a hint of the volume: the floor plane renders exactly as it always does, photo and
 * all, and the back / left / right / ceiling planes are replaced by four faded dashed vertical
 * guides at the footprint corners, running y = 0 → heightIn. See {@link ROOM_GUIDE} for the
 * numbers. The guides are not pick targets — the floor stays the click handle — but they do count
 * towards {@link RoomRenderer.bounds}, so framing a booth still frames its whole volume.
 */
import * as THREE from 'three';
import type { ContentSource, RoomEntity, SurfaceMedia } from '../document/types';
import type { EntityRenderer, RenderContext, RendererFactory } from './EntityRenderer';
import { tagRoot } from './EntityRenderer';
import { createContentMedia, type ContentMedia } from '../content/ContentLayer';

export type RoomSide = 'back' | 'floor' | 'ceiling' | 'left' | 'right';
export const ROOM_SIDES: readonly RoomSide[] = ['back', 'floor', 'ceiling', 'left', 'right'] as const;

export interface RoomDims {
  widthIn: number;
  heightIn: number;
  depthIn: number;
}

/** Placement of one room plane in the room-local frame (a +Z-facing PlaneGeometry, rotated). */
export interface RoomPlanePlacement {
  side: RoomSide;
  /** PlaneGeometry width / height. */
  width: number;
  height: number;
  /** Plane centre. */
  position: [number, number, number];
  /** Euler XYZ in radians. */
  rotation: [number, number, number];
  /** Unit normal after rotation; always points into the room. */
  normal: [number, number, number];
}

/* ───────────────────────────── Pure placement maths ───────────────────────────── */

/**
 * Where each plane goes (v1 6858-6870, re-based on the floor-centre-of-back-wall origin and made
 * single-sided). PlaneGeometry faces +Z before rotation; the rotations below turn that normal
 * towards the room centre so a FrontSide material renders from inside:
 *   back    z = 0,     faces +Z   (unrotated)
 *   floor   y = 0,     faces +Y   (rx = -90°)
 *   ceiling y = H,     faces -Y   (rx = +90°)
 *   left    x = -W/2,  faces +X   (ry = +90°)
 *   right   x = +W/2,  faces -X   (ry = -90°)
 * Texture orientation: the image top sits at the back for the floor and at the front for the
 * ceiling; wall images read left-to-right for a viewer standing inside the room.
 */
export function roomPlanePlacement(side: RoomSide, d: RoomDims): RoomPlanePlacement {
  const W = d.widthIn, H = d.heightIn, D = d.depthIn;
  const midY = H / 2, midZ = D / 2;
  switch (side) {
    case 'back': return { side, width: W, height: H, position: [0, midY, 0], rotation: [0, 0, 0], normal: [0, 0, 1] };
    case 'floor': return { side, width: W, height: D, position: [0, 0, midZ], rotation: [-Math.PI / 2, 0, 0], normal: [0, 1, 0] };
    case 'ceiling': return { side, width: W, height: D, position: [0, H, midZ], rotation: [Math.PI / 2, 0, 0], normal: [0, -1, 0] };
    case 'left': return { side, width: D, height: H, position: [-W / 2, midY, midZ], rotation: [0, Math.PI / 2, 0], normal: [1, 0, 0] };
    case 'right': return { side, width: D, height: H, position: [W / 2, midY, midZ], rotation: [0, -Math.PI / 2, 0], normal: [-1, 0, 0] };
  }
}

/** Local-space bounds of the whole room (all five planes, whether shown or not). */
export function roomLocalBounds(d: RoomDims): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [-d.widthIn / 2, 0, 0], max: [d.widthIn / 2, d.heightIn, d.depthIn] };
}

/** Local centre of the room volume (useful for framing the camera inside it). */
export function roomCenter(d: RoomDims): [number, number, number] {
  return [0, d.heightIn / 2, d.depthIn / 2];
}

/* ─────────────────────── Outline-mode corner guides ─────────────────────── */

/**
 * Look of the dashed height guides drawn in place of the walls in outline mode.
 *
 * `dashIn` / `gapIn` are INCHES, like every other length in this engine: a dash sized for a unit
 * cube would smear into a solid line at booth scale. 3 in on / 2 in off puts about nineteen dashes
 * up a standard 8 ft booth — enough to read as a measured guide, never enough to read as a wall.
 *
 * `color` is a mid, faintly cool grey. It sits near the middle of the luminance range, so it keeps
 * contrast against the near-black ground of the Night theme AND against the pale ground of Studio,
 * where a light guide would vanish. It is deliberately not the brand cyan: the viewport reserves
 * that for selection, and a booth outline is not a selection.
 *
 * `opacity` 0.3 with `depthWrite: false` keeps it a soft annotation — it tints whatever is behind
 * it instead of punching a hole in the depth buffer and cutting into the build inside the booth.
 * It is a ceiling, not a constant: the renderer scales it by the room's own opacity so fading a
 * booth fades all of it.
 */
export const ROOM_GUIDE = { color: 0x8a93a0, dashIn: 3, gapIn: 2, opacity: 0.3 } as const;

/** The four footprint corners of a room, as local [x, z] pairs (back pair first). */
export function roomFootprintCorners(d: RoomDims): [number, number][] {
  const hw = d.widthIn / 2;
  return [[-hw, 0], [hw, 0], [-hw, d.depthIn], [hw, d.depthIn]];
}

/**
 * Flat vertex list for the corner guides: one floor-to-ceiling segment per footprint corner, so
 * four segments / eight vertices / 24 numbers, laid out for `THREE.LineSegments`.
 */
export function roomGuidePositions(d: RoomDims): number[] {
  const out: number[] = [];
  for (const [x, z] of roomFootprintCorners(d)) out.push(x, 0, z, x, d.heightIn, z);
  return out;
}

/**
 * Line distances for those guides: every corner restarts at 0, so all four run the same dash phase.
 *
 * `computeLineDistances()` would carry a running total across the segments of one `LineSegments`
 * (0, H, H, 2H, …). With a 5 in period and a 96 in height, 96 mod 5 = 1, so each corner would start
 * another inch into the period and the four guides would tick out of step — worse, differently at
 * every height. Four corner guides that dash together read as one measured object.
 */
export function roomGuideDistances(d: RoomDims): number[] {
  return roomFootprintCorners(d).flatMap(() => [0, d.heightIn]);
}

/** Stable key describing which media a surface shows (null/undefined → ''). */
export function surfaceMediaKey(m: SurfaceMedia | null | undefined): string {
  if (!m || (!m.assetId && !m.url)) return '';
  return JSON.stringify([m.kind, m.assetId ?? '', m.url ?? '']);
}

/** Surface media → content source understood by `createContentMedia`. */
export function surfaceToSource(m: SurfaceMedia): ContentSource {
  return { type: m.kind, url: m.url, assetId: m.assetId, name: m.name, loop: true, muted: true };
}

/* ───────────────────────────── Renderer ───────────────────────────── */

interface PlaneState {
  side: RoomSide;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  mediaKey: string;
  media: ContentMedia | null;
  loading: boolean;
}

/** `gen` is only consulted for generated patterns, which rooms never use. */
const NO_GEN = { wPx: 1, hPx: 1, panelPxW: 1, panelPxH: 1, cols: 1, rows: 1 };

export class RoomRenderer implements EntityRenderer<RoomEntity> {
  entity: RoomEntity;
  readonly root = new THREE.Group();
  private planes = new Map<RoomSide, PlaneState>();
  /** Dashed height guides at the footprint corners; only visible in outline mode. */
  private guides: THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  private dimsKey = '';
  private ctx: RenderContext;

  constructor(entity: RoomEntity, ctx: RenderContext) {
    this.entity = entity;
    this.ctx = ctx;
    tagRoot(this.root, entity);
    this.guides = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
      color: ROOM_GUIDE.color, dashSize: ROOM_GUIDE.dashIn, gapSize: ROOM_GUIDE.gapIn,
      transparent: true, opacity: ROOM_GUIDE.opacity, depthWrite: false,
      // An annotation, not a lit surface: skip tone mapping so the grey lands as authored on both
      // themes (the same treatment the measure lines get in DimensionRenderer). Depth TEST stays
      // on, though — a guide has to be hidden by the build standing in front of it.
      toneMapped: false,
    }));
    this.guides.name = 'room-guides';
    this.guides.userData.part = 'guides';
    // A hairline is a hopeless click target, and picking one would steal the click from the floor
    // it sits on: the floor face is the booth's handle (see the picking convention in Picking.ts).
    this.guides.userData.unpickable = true;
    this.guides.visible = false;
    this.root.add(this.guides);
    for (const side of ROOM_SIDES) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.FrontSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.name = `room-${side}`;
      mesh.userData.part = side;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.planes.set(side, { side, mesh, mediaKey: '', media: null, loading: false });
    }
    this.update(entity, ctx);
  }

  update(entity: RoomEntity, ctx: RenderContext): void {
    this.entity = entity;
    this.ctx = ctx;
    const dKey = `${entity.widthIn}|${entity.heightIn}|${entity.depthIn}`;
    if (dKey !== this.dimsKey) { this.dimsKey = dKey; this.placePlanes(); this.buildGuides(); }
    // Outline mode: the floor still obeys its own show flag, everything upright is a guide instead.
    const outline = entity.outlineWalls;
    this.guides.visible = outline;
    // In outline mode the guides ARE most of the object, so the one control that fades a room has to
    // fade them too — otherwise dropping the opacity dissolves the floor and leaves the dashes at
    // full strength. The colour stays fixed: an annotation is not tinted by the surface colour.
    this.guides.material.opacity = ROOM_GUIDE.opacity * Math.min(1, Math.max(0, entity.opacity));
    for (const st of this.planes.values()) {
      st.mesh.visible = entity.show[st.side] && (!outline || st.side === 'floor');
      const key = surfaceMediaKey(entity.surfaces[st.side]);
      if (key !== st.mediaKey) {
        this.releaseMedia(st);
        st.mediaKey = key;
        if (key) this.loadMedia(st, entity.surfaces[st.side]!);
      }
      this.applyMaterial(st);
      this.syncPlayback(st);
    }
  }

  /** A hidden surface must not keep decoding its video: pause the player while the plane is hidden. */
  private syncPlayback(st: PlaneState): void {
    const player = st.media?.player;
    if (!player) return;
    if (st.mesh.visible) player.play(); else player.pause();
  }

  private placePlanes(): void {
    for (const st of this.planes.values()) {
      const p = roomPlanePlacement(st.side, this.entity);
      st.mesh.geometry.dispose();
      st.mesh.geometry = new THREE.PlaneGeometry(Math.max(0.01, p.width), Math.max(0.01, p.height));
      st.mesh.position.set(p.position[0], p.position[1], p.position[2]);
      st.mesh.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
    }
  }

  /** Rebuild the corner guides for the current dimensions (called whenever the size changes). */
  private buildGuides(): void {
    this.guides.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(roomGuidePositions(this.entity), 3));
    this.guides.geometry = g;
    // Without line distances a LineDashedMaterial draws a solid line. These are written directly
    // rather than computed, so every corner starts on the same dash phase — see roomGuideDistances.
    g.setAttribute('lineDistance', new THREE.Float32BufferAttribute(roomGuideDistances(this.entity), 1));
  }

  /** Colour / opacity / texture for one plane (a textured surface is untinted white). */
  private applyMaterial(st: PlaneState): void {
    const e = this.entity;
    const mat = st.mesh.material;
    const tex = st.media?.texture ?? null;
    if (tex) mat.color.set(0xffffff); else mat.color.set(e.color);
    if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
    const opacity = Math.min(1, Math.max(0, e.opacity));
    const transparent = opacity < 1;
    // `transparent` is baked into the compiled program (#define OPAQUE forces alpha = 1) and the
    // renderer only recompiles when the material version bumps, so flag the change explicitly.
    if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
    mat.opacity = opacity;
    mat.depthWrite = !transparent;
  }

  private loadMedia(st: PlaneState, surface: SurfaceMedia): void {
    const key = `surface:${st.side}`;
    const media = createContentMedia(surfaceToSource(surface), this.ctx.assets, {
      maxTextureSize: this.ctx.maxTextureSize,
      gen: NO_GEN,
      onError: msg => console.warn('[room surface]', st.side, msg),
    });
    st.media = media;
    st.loading = true;
    this.ctx.setLoading(this.entity.id, key, true);
    media.ready.then(() => {
      if (st.media !== media) return; // replaced or released meanwhile
      st.loading = false;
      this.ctx.setLoading(this.entity.id, key, false);
      this.applyMaterial(st);
      this.syncPlayback(st); // the content layer auto-plays; pause again when the side is hidden
      this.ctx.invalidate();
    }).catch(() => {
      if (st.media !== media) return;
      st.loading = false;
      this.ctx.setLoading(this.entity.id, key, false);
    });
  }

  private releaseMedia(st: PlaneState): void {
    if (st.loading) this.ctx.setLoading(this.entity.id, `surface:${st.side}`, false);
    st.loading = false;
    if (st.mesh.material.map) { st.mesh.material.map = null; st.mesh.material.needsUpdate = true; }
    st.media?.dispose();
    st.media = null;
    st.mediaKey = '';
  }

  frame(_dt: number, _ctx: RenderContext): boolean {
    let dirty = false;
    for (const st of this.planes.values()) if (st.mesh.visible && st.media?.update()) dirty = true;
    return dirty;
  }

  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    this.root.updateWorldMatrix(true, true);
    const b = new THREE.Box3();
    for (const st of this.planes.values()) {
      if (!st.mesh.visible) continue;
      const g = st.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      out.union(b.copy(g.boundingBox!).applyMatrix4(st.mesh.matrixWorld));
    }
    // In outline mode the floor alone would flatten the box to y = 0 and framing a booth would
    // ignore its height, so the guides carry the volume even though they are not pickable.
    if (this.guides.visible) {
      const g = this.guides.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox) out.union(b.copy(g.boundingBox).applyMatrix4(this.guides.matrixWorld));
    }
    return out;
  }

  /** Only the visible planes are pick targets; the dashed guides never are (see the constructor). */
  selectionMeshes(): THREE.Mesh[] {
    return Array.from(this.planes.values()).filter(st => st.mesh.visible).map(st => st.mesh);
  }

  dispose(): void {
    for (const st of this.planes.values()) {
      this.releaseMedia(st);
      st.mesh.geometry.dispose();
      st.mesh.material.dispose();
    }
    this.guides.geometry.dispose();
    this.guides.material.dispose();
    this.guides.removeFromParent();
    this.planes.clear();
    this.root.removeFromParent();
  }
}

export const createRoomRenderer: RendererFactory = (entity, ctx) => new RoomRenderer(entity as RoomEntity, ctx);
