/**
 * The `geometry: 'cad'` branch of the equipment renderer: a wireframe box of the declared size
 * stands in until the shipped mesh loads, the mesh is scaled to the declared dims, and the entity's
 * bounds come from those dims throughout (so selection, framing and measurement never wobble while
 * the model is in flight). Runs in node with an injected CAD loader — no DOM, no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createDocument, createEquipment } from '../document/defaults';
import { assets } from '../persistence/AssetStore';
import { setCadLoader } from '../content/cadModels';
import type { EquipmentEntity } from '../document/types';
import type { RenderContext } from './EntityRenderer';
import { EquipmentRenderer, cadFitScale } from './EquipmentRenderer';
import type { EquipmentDef } from '../catalog/equipment';

/**
 * The catalog ships no `geometry: 'cad'` product today — the CAD meshes we ship are LED-wall
 * accessories, built by `ledwall/geometry.ts`. This fixture keeps the renderer branch covered
 * so the seam still works the day a CAD product is added.
 */
const TABLE: EquipmentDef = {
  id: 'test-cad-part', name: 'Test CAD part', category: 'display',
  geometry: 'cad', dims: [100.8, 56.7, 25.2], color: '#1f2226', accent: '#28ace3',
  model: '/models/test-cad-part.glb',
  description: 'Fixture for the cad renderer branch.',
};

function ctx(): RenderContext & { invalidated: number; loading: Map<string, boolean> } {
  const loading = new Map<string, boolean>();
  return {
    doc: createDocument(), assets, camera: new THREE.PerspectiveCamera(),
    invalidated: 0, loading,
    invalidate() { this.invalidated++; },
    setLoading(_id, key, v) { loading.set(key, v); },
    unit: 'in', needs: { css3d: false, pixelGrid: false }, maxTextureSize: 4096,
  };
}

/** The shipped mesh stand-in: a box of the fixture's declared size, centred on the origin. */
const fakeMesh = (): THREE.BufferGeometry => new THREE.BoxGeometry(TABLE.dims[0], TABLE.dims[1], TABLE.dims[2]);

const entity = (over: Partial<EquipmentEntity> = {}): EquipmentEntity => ({ ...createEquipment(TABLE), ...over });

/** Meshes under a renderer root, by their `userData.part` tag (last one wins — see {@link allParts}). */
function parts(r: EquipmentRenderer): Record<string, THREE.Mesh> {
  const out: Record<string, THREE.Mesh> = {};
  r.root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) out[String(m.userData.part)] = m; });
  return out;
}

/** Every mesh under a renderer root carrying `userData.part === part`. */
function allParts(r: EquipmentRenderer, part: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  r.root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.part === part) out.push(m); });
  return out;
}

afterEach(() => setCadLoader(null));

describe('cadFitScale', () => {
  it('is 1 when the mesh is already the declared size', () => {
    expect(cadFitScale([100.8, 56.7, 25.2], [100.8, 56.7, 25.2])).toEqual([1, 1, 1]);
  });

  it('fits the mesh to edited dimensions, per axis', () => {
    expect(cadFitScale([100.8, 56.7, 25.2], [50.4, 56.7, 50.4])).toEqual([0.5, 1, 2]);
  });

  it('leaves a flat or degenerate axis alone rather than blowing up', () => {
    expect(cadFitScale([0, 10, 10], [20, 20, 20])).toEqual([1, 2, 2]);
    expect(cadFitScale([10, 10, 10], [0, 10, 10])).toEqual([1, 1, 1]);
  });
});

describe('EquipmentRenderer with a CAD product', () => {
  it('shows a placeholder of the declared size before the mesh arrives', () => {
    setCadLoader(() => new Promise(() => {})); // never resolves
    const c = ctx();
    const r = new EquipmentRenderer(entity(), c);
    const box = parts(r).placeholder;
    expect(box).toBeTruthy();
    expect((box.material as THREE.MeshBasicMaterial).wireframe).toBe(true);
    const g = box.geometry as THREE.BoxGeometry;
    expect([g.parameters.width, g.parameters.height, g.parameters.depth]).toEqual(TABLE.dims);
    expect(box.position.y).toBeCloseTo(TABLE.dims[1] / 2, 9);
    expect(c.loading.get('cad')).toBe(true);
    r.dispose();
  });

  it('swaps the mesh in, hides the placeholder and asks for a re-render', async () => {
    let asked = '';
    setCadLoader(async url => { asked = url; return fakeMesh(); });
    const c = ctx();
    const r = new EquipmentRenderer(entity(), c);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(asked).toBe(TABLE.model);
    const p = parts(r);
    expect(p.cad).toBeTruthy();
    expect(p.cad.userData.sharedGeometry).toBe(true); // owned by the CAD cache, not disposed here
    expect(p.placeholder.visible).toBe(false);
    // 1 to float32 precision: the catalog publishes the mesh's own bounds.
    for (const v of p.cad.scale.toArray()) expect(v).toBeCloseTo(1, 6);
    expect(c.invalidated).toBe(1);
    expect(c.loading.get('cad')).toBe(false);
    r.dispose();
  });

  it('scales the mesh when the dimensions are edited', async () => {
    setCadLoader(async () => fakeMesh());
    const c = ctx();
    const r = new EquipmentRenderer(entity({ dims: [50.4, 56.7, 25.2] }), c);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(parts(r).cad.scale.x).toBeCloseTo(0.5, 6);
    r.dispose();
  });

  it('measures from the declared dims, both before and after the load', async () => {
    setCadLoader(async () => fakeMesh());
    const c = ctx();
    const r = new EquipmentRenderer(entity(), c);
    const expected = new THREE.Box3(
      new THREE.Vector3(-TABLE.dims[0] / 2, 0, -TABLE.dims[2] / 2),
      new THREE.Vector3(TABLE.dims[0] / 2, TABLE.dims[1], TABLE.dims[2] / 2),
    );
    expect(r.bounds().equals(expected)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(r.bounds().equals(expected)).toBe(true);
    expect(r.topSurfaceY()).toBe(TABLE.dims[1]);
    expect(r.selectionMeshes()).toHaveLength(1);
    r.dispose();
  });

  it('keeps the placeholder and stops reporting progress when the load fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCadLoader(async () => { throw new Error('offline'); });
    const c = ctx();
    const r = new EquipmentRenderer(entity(), c);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(parts(r).cad).toBeUndefined();
    expect(parts(r).placeholder.visible).toBe(true);
    expect(c.loading.get('cad')).toBe(false);
    r.dispose();
    warn.mockRestore();
  });

  it('disposes what it owns and leaves the shared CAD geometry alone', async () => {
    const shared = fakeMesh();
    setCadLoader(async () => shared);
    const c = ctx();
    const r = new EquipmentRenderer(entity(), c);
    await new Promise(resolve => setTimeout(resolve, 0));
    const p = parts(r);
    const placeholderGeom = vi.spyOn(p.placeholder.geometry, 'dispose');
    const material = vi.spyOn(p.cad.material as THREE.Material, 'dispose');
    const sharedGeom = vi.spyOn(shared, 'dispose');
    r.dispose();
    expect(placeholderGeom).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
    expect(sharedGeom).not.toHaveBeenCalled();
    expect(r.root.children).toHaveLength(0);
  });

  it('adds one mesh, not two, when a rebuild lands while the same url is still loading', async () => {
    // `rebuild()` fires on any buildKey change — a colour edit keeps `model`, so the url is unchanged
    // and both builds get the SAME cached loader promise. Guarding on the url would let the dead
    // build's callback add a second coincident mesh to the live group and orphan its material.
    let resolveLoad: (g: THREE.BufferGeometry) => void = () => {};
    setCadLoader(() => new Promise<THREE.BufferGeometry>(res => { resolveLoad = res; }));
    const c = ctx();
    const e = entity();
    const r = new EquipmentRenderer(e, c);
    r.update({ ...e, color: '#ff0000' }, c); // same model url, new buildKey
    resolveLoad(fakeMesh());
    await new Promise(resolve => setTimeout(resolve, 0));

    const meshes = allParts(r, 'cad');
    expect(meshes).toHaveLength(1);
    expect(allParts(r, 'placeholder')).toHaveLength(1);
    expect(allParts(r, 'placeholder')[0].visible).toBe(false);
    // The surviving mesh is the live build's: disposing it must dispose the only material made.
    const material = vi.spyOn(meshes[0].material as THREE.Material, 'dispose');
    r.dispose();
    expect(material).toHaveBeenCalled();
    expect(r.root.children).toHaveLength(0);
  });

  it('falls back to parametric geometry when a cad item has no mesh url', () => {
    const c = ctx();
    const r = new EquipmentRenderer(entity({ model: undefined }), c);
    expect(parts(r).placeholder).toBeUndefined();
    expect(r.selectionMeshes().length).toBeGreaterThan(0);
    r.dispose();
  });
});
