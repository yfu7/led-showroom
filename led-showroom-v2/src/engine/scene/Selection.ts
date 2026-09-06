/**
 * Selection / hover feedback: crisp edge lines in the accent colour drawn on top of the
 * selected meshes, plus a soft bounding box with corner ticks for the whole selection.
 */
import * as THREE from 'three';
import { LAYER_GIZMO } from './Renderer';

export interface SelectionColors { selected: string; hover: string; box: string }

export const DEFAULT_SELECTION_COLORS: SelectionColors = { selected: '#28ace3', hover: '#7fcdee', box: '#28ace3' };
export const LIGHT_SELECTION_COLORS: SelectionColors = { selected: '#28ace3', hover: '#1b8dbe', box: '#28ace3' };

export class SelectionHelper {
  readonly group = new THREE.Group();
  private edges = new Map<string, THREE.LineSegments[]>();
  private hoverEdges: THREE.LineSegments[] = [];
  private box: THREE.LineSegments;
  private selectedMat: THREE.LineBasicMaterial;
  private hoverMat: THREE.LineBasicMaterial;
  private boxMat: THREE.LineBasicMaterial;
  private geomCache = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>();

  constructor(colors: SelectionColors = DEFAULT_SELECTION_COLORS) {
    this.group.name = 'selection';
    this.group.userData.helper = true;
    this.selectedMat = new THREE.LineBasicMaterial({ color: colors.selected, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    this.hoverMat = new THREE.LineBasicMaterial({ color: colors.hover, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    this.boxMat = new THREE.LineBasicMaterial({ color: colors.box, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
    this.box = new THREE.LineSegments(new THREE.BufferGeometry(), this.boxMat);
    this.box.renderOrder = 998;
    this.box.userData.helper = true;
    this.box.userData.unpickable = true;
    this.box.visible = false;
    this.box.layers.set(LAYER_GIZMO);
    this.group.add(this.box);
  }

  setColors(colors: SelectionColors): void {
    this.selectedMat.color.set(colors.selected);
    this.hoverMat.color.set(colors.hover);
    this.boxMat.color.set(colors.box);
  }

  private edgesFor(mesh: THREE.Mesh, mat: THREE.LineBasicMaterial): THREE.LineSegments {
    let eg = this.geomCache.get(mesh.geometry);
    if (!eg) { eg = new THREE.EdgesGeometry(mesh.geometry, 20); this.geomCache.set(mesh.geometry, eg); }
    const ls = new THREE.LineSegments(eg, mat);
    ls.userData.helper = true;
    ls.userData.unpickable = true;
    ls.userData.sharedGeometry = true;
    ls.userData.sharedMaterial = true;
    ls.renderOrder = 999;
    ls.layers.set(LAYER_GIZMO);
    ls.matrixAutoUpdate = false;
    return ls;
  }

  /** Rebuild outlines for the given entity meshes. */
  setSelected(items: { id: string; meshes: THREE.Mesh[] }[]): void {
    for (const arr of this.edges.values()) for (const ls of arr) ls.removeFromParent();
    this.edges.clear();
    for (const it of items) {
      const arr = it.meshes.map(m => { const ls = this.edgesFor(m, this.selectedMat); ls.userData.source = m; this.group.add(ls); return ls; });
      this.edges.set(it.id, arr);
    }
    this.syncMatrices();
  }

  setHover(meshes: THREE.Mesh[]): void {
    for (const ls of this.hoverEdges) ls.removeFromParent();
    this.hoverEdges = meshes.map(m => { const ls = this.edgesFor(m, this.hoverMat); ls.userData.source = m; this.group.add(ls); return ls; });
    this.syncMatrices();
  }

  /** Bounding box of the whole selection (world space), drawn with corner ticks. */
  setBounds(bounds: THREE.Box3 | null): void {
    if (!bounds || bounds.isEmpty()) { this.box.visible = false; return; }
    const min = bounds.min, max = bounds.max;
    const size = bounds.getSize(new THREE.Vector3());
    const t = Math.max(2, Math.min(size.x, size.y, size.z, 24) * 0.25); // tick length
    const pts: number[] = [];
    const corner = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      pts.push(x, y, z, x + sx * t, y, z, x, y, z, x, y + sy * t, z, x, y, z, x, y, z + sz * t);
    };
    corner(min.x, min.y, min.z, 1, 1, 1); corner(max.x, min.y, min.z, -1, 1, 1);
    corner(min.x, max.y, min.z, 1, -1, 1); corner(max.x, max.y, min.z, -1, -1, 1);
    corner(min.x, min.y, max.z, 1, 1, -1); corner(max.x, min.y, max.z, -1, 1, -1);
    corner(min.x, max.y, max.z, 1, -1, -1); corner(max.x, max.y, max.z, -1, -1, -1);
    this.box.geometry.dispose();
    this.box.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.box.visible = true;
  }

  /** Keep outline transforms in sync with their source meshes (call after entities move). */
  syncMatrices(): void {
    const sync = (ls: THREE.LineSegments) => {
      const src = ls.userData.source as THREE.Mesh | undefined;
      if (!src) return;
      src.updateWorldMatrix(true, false);
      ls.matrix.copy(src.matrixWorld);
      ls.matrixWorld.copy(src.matrixWorld);
      ls.visible = src.visible && (src.parent?.visible ?? true);
    };
    for (const arr of this.edges.values()) arr.forEach(sync);
    this.hoverEdges.forEach(sync);
  }

  clear(): void { this.setSelected([]); this.setHover([]); this.setBounds(null); }

  dispose(): void {
    this.clear();
    this.selectedMat.dispose(); this.hoverMat.dispose(); this.boxMat.dispose();
    this.box.geometry.dispose();
  }
}
