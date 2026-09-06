/**
 * Room renderer (v1 "Venue Space", index.html 6774-7012): five planes — back wall, floor,
 * ceiling, left and right walls — at real scale, each optionally textured with an uploaded photo
 * or video.
 *
 * Local frame: the origin is the floor centre of the BACK wall line. x ∈ [-widthIn/2, widthIn/2],
 * y ∈ [0, heightIn], and the room extends towards +Z by depthIn (the back wall plane is z = 0).
 * Every plane is single-sided and faces INTO the room so the surfaces render from inside.
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
  private dimsKey = '';
  private ctx: RenderContext;

  constructor(entity: RoomEntity, ctx: RenderContext) {
    this.entity = entity;
    this.ctx = ctx;
    tagRoot(this.root, entity);
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
    if (dKey !== this.dimsKey) { this.dimsKey = dKey; this.placePlanes(); }
    for (const st of this.planes.values()) {
      st.mesh.visible = entity.show[st.side];
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
    return out;
  }

  selectionMeshes(): THREE.Mesh[] {
    return Array.from(this.planes.values()).filter(st => st.mesh.visible).map(st => st.mesh);
  }

  dispose(): void {
    for (const st of this.planes.values()) {
      this.releaseMedia(st);
      st.mesh.geometry.dispose();
      st.mesh.material.dispose();
    }
    this.planes.clear();
    this.root.removeFromParent();
  }
}

export const createRoomRenderer: RendererFactory = (entity, ctx) => new RoomRenderer(entity as RoomEntity, ctx);
