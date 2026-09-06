/**
 * CAD mesh helpers, and the shipped meshes themselves.
 *
 * The interesting half of this file reads `public/models/*.glb` off disk, rebuilds the geometry the
 * way `loadCadGeometry` would and checks that each part, once framed by its anchors, lands exactly
 * where the code that places it assumes: the base plate's top face on the panel bottom, the
 * brackets' feet on the ground with their bar on the cabinet back, the display table on the floor.
 * That is the placement contract, verified against the manufacturer's CAD rather than a comment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  adoptGeometry, anchorGeometry, anchorKey, cadLoadingAvailable, clearCadGeometryCache, flattenToGeometry,
  geometrySize, loadCadGeometry, setCadLoader, type CadAnchors,
} from './cadModels';
import { ACCESSORY_CAD } from '../ledwall/geometry';
import { EQUIPMENT_BY_ID } from '../catalog/equipment';
import { IPOSTER } from '../ledwall/specs';

/* ───────────────────────── GLB reader (test-only) ───────────────────────── */

interface GlbJson {
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
  nodes: { mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/**
 * Minimal GLB reader for the files `scripts/step-to-glb.cjs` writes: one JSON chunk, one BIN chunk,
 * one mesh, float POSITION/NORMAL and uint32 indices, no node transforms. It asserts those
 * assumptions rather than covering glTF in general.
 */
function readGlb(file: string): { json: GlbJson; bin: Buffer } {
  const buf = readFileSync(file);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as GlbJson;
  const binStart = 20 + jsonLen + 8;
  return { json, bin: buf.subarray(binStart) };
}

function accessorArray(json: GlbJson, bin: Buffer, index: number): Float32Array | Uint32Array {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const n = acc.count * COMPONENTS[acc.type];
  if (acc.componentType === 5126) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.readFloatLE(offset + i * 4);
    return out;
  }
  expect(acc.componentType).toBe(5125); // uint32
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.readUInt32LE(offset + i * 4);
  return out;
}

/** The shipped GLB as a three geometry, in the file's own frame. */
function glbGeometry(name: string): THREE.BufferGeometry {
  const { json, bin } = readGlb(join(process.cwd(), 'public', 'models', name));
  expect(json.meshes).toHaveLength(1);
  for (const node of json.nodes ?? []) {
    expect(node.matrix ?? node.translation ?? node.rotation ?? node.scale).toBeUndefined();
  }
  const prim = json.meshes[0].primitives[0];
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(accessorArray(json, bin, prim.attributes.POSITION) as Float32Array, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(accessorArray(json, bin, prim.attributes.NORMAL) as Float32Array, 3));
  geom.setIndex(new THREE.BufferAttribute(accessorArray(json, bin, prim.indices!) as Uint32Array, 1));
  geom.computeBoundingBox();
  return geom;
}

const box = (g: THREE.BufferGeometry): THREE.Box3 => {
  g.computeBoundingBox();
  return g.boundingBox!;
};

/* ───────────────────────── pure helpers ───────────────────────── */

describe('anchorGeometry', () => {
  /** A 4 × 2 × 6 box sitting somewhere arbitrary, so every anchor has work to do. */
  const offsetBox = (): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(4, 2, 6);
    g.translate(11, -7, 3);
    return g;
  };

  it('puts the chosen end of each axis on the origin', () => {
    const b = box(anchorGeometry(offsetBox(), { x: 'center', y: 'max', z: 'center' }));
    expect(b.min.x).toBeCloseTo(-2, 9);
    expect(b.max.x).toBeCloseTo(2, 9);
    expect(b.max.y).toBeCloseTo(0, 9);
    expect(b.min.y).toBeCloseTo(-2, 9);
    expect(b.min.z).toBeCloseTo(-3, 9);
    expect(b.max.z).toBeCloseTo(3, 9);
  });

  it('supports min and max anchors independently per axis', () => {
    const b = box(anchorGeometry(offsetBox(), { x: 'min', y: 'min', z: 'max' }));
    expect(b.min.x).toBeCloseTo(0, 9);
    expect(b.min.y).toBeCloseTo(0, 9);
    expect(b.max.z).toBeCloseTo(0, 9);
    expect(b.min.z).toBeCloseTo(-6, 9);
  });

  it('never changes the size, and is idempotent', () => {
    const a: CadAnchors = { x: 'center', y: 'min', z: 'max' };
    const g = anchorGeometry(offsetBox(), a);
    expect(geometrySize(g)).toEqual([4, 2, 6]);
    const before = box(g).clone();
    anchorGeometry(g, a);
    expect(box(g).min.toArray()).toEqual(before.min.toArray());
  });

  it('leaves an empty geometry alone', () => {
    const g = new THREE.BufferGeometry();
    expect(() => anchorGeometry(g, { x: 'min', y: 'min', z: 'min' })).not.toThrow();
    expect(geometrySize(g)).toEqual([0, 0, 0]);
  });

  it('keys anchors for the cache', () => {
    expect(anchorKey({ x: 'center', y: 'max', z: 'center' })).toBe('center|max|center');
  });
});

describe('flattenToGeometry', () => {
  const meshAt = (x: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    m.position.x = x;
    return m;
  };

  it('bakes world transforms and merges every mesh into one geometry', () => {
    const group = new THREE.Group();
    group.add(meshAt(-5), meshAt(5));
    group.position.y = 3;
    const g = flattenToGeometry(group)!;
    const b = box(g);
    expect(b.min.x).toBeCloseTo(-6, 6);
    expect(b.max.x).toBeCloseTo(6, 6);
    expect(b.min.y).toBeCloseTo(2, 6); // the group's own offset is baked in
    expect(g.getAttribute('position').count).toBe(48); // two boxes of 24 vertices
    expect(g.index).not.toBeNull();
  });

  it('keeps only position and normal', () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const g = flattenToGeometry(m)!;
    expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position']);
    expect(g.groups).toHaveLength(0);
  });

  it('returns the single mesh geometry untouched in size, and null for an empty object', () => {
    const g = flattenToGeometry(new THREE.Mesh(new THREE.BoxGeometry(3, 4, 5)))!;
    expect(geometrySize(g)).toEqual([3, 4, 5]);
    expect(flattenToGeometry(new THREE.Group())).toBeNull();
  });
});

describe('adoptGeometry', () => {
  it('takes on the source shape while keeping the target object identity', () => {
    const target = new THREE.BoxGeometry(1, 1, 1);
    const source = new THREE.BoxGeometry(10, 20, 30);
    const same = adoptGeometry(target, source);
    expect(same).toBe(target);
    expect(geometrySize(target)).toEqual([10, 20, 30]);
    expect(target.index!.count).toBe(source.index!.count);
  });

  it('copies attributes rather than sharing them, so the two dispose independently', () => {
    const target = new THREE.BoxGeometry(1, 1, 1);
    const source = new THREE.BoxGeometry(2, 2, 2);
    adoptGeometry(target, source);
    expect(target.getAttribute('position')).not.toBe(source.getAttribute('position'));
    source.dispose();
    expect(geometrySize(target)).toEqual([2, 2, 2]);
  });

  it('drops attributes and groups the source does not have', () => {
    const target = new THREE.BoxGeometry(1, 1, 1);
    target.addGroup(0, 3, 0);
    target.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(48), 2));
    const source = new THREE.BufferGeometry();
    source.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    adoptGeometry(target, source);
    expect(Object.keys(target.attributes)).toEqual(['position']);
    expect(target.groups).toHaveLength(0);
    expect(target.index).toBeNull();
  });
});

/* ───────────────────────── loading ───────────────────────── */

describe('loadCadGeometry', () => {
  afterEach(() => setCadLoader(null));

  it('is unavailable under node until a loader is injected', () => {
    expect(cadLoadingAvailable()).toBe(false);
    setCadLoader(async () => new THREE.BoxGeometry(1, 1, 1));
    expect(cadLoadingAvailable()).toBe(true);
  });

  it('frames the loaded part once and caches it per url + anchors', async () => {
    let calls = 0;
    setCadLoader(async () => {
      calls++;
      const g = new THREE.BoxGeometry(2, 8, 4);
      g.translate(100, 100, 100);
      return g;
    });
    const a = await loadCadGeometry('/models/x.glb', { x: 'center', y: 'min', z: 'center' });
    const again = await loadCadGeometry('/models/x.glb', { x: 'center', y: 'min', z: 'center' });
    expect(again).toBe(a);
    expect(calls).toBe(1);
    expect(box(a).min.y).toBeCloseTo(0, 9);
    expect(box(a).max.y).toBeCloseTo(8, 9);

    const other = await loadCadGeometry('/models/x.glb', { x: 'center', y: 'max', z: 'center' });
    expect(other).not.toBe(a);
    expect(calls).toBe(2);
  });

  it('rejects without caching the failure, so a later attempt retries', async () => {
    let calls = 0;
    setCadLoader(async () => { calls++; throw new Error('nope'); });
    const anchors: CadAnchors = { x: 'center', y: 'min', z: 'center' };
    await expect(loadCadGeometry('/models/y.glb', anchors)).rejects.toThrow('nope');
    await expect(loadCadGeometry('/models/y.glb', anchors)).rejects.toThrow('nope');
    expect(calls).toBe(2);
  });

  it('rejects when no loader is available at all', async () => {
    clearCadGeometryCache();
    await expect(loadCadGeometry('/models/z.glb', { x: 'min', y: 'min', z: 'min' })).rejects.toThrow(/not available/);
  });
});

/* ───────────────────────── the shipped CAD ───────────────────────── */

describe('the shipped accessory CAD', () => {
  it('is the manufacturer part at its measured size', () => {
    expect(geometrySize(glbGeometry('iposter-base.glb')).map(v => +v.toFixed(3))).toEqual([25.08, 0.25, 18.78]);
    expect(geometrySize(glbGeometry('iposter-support-lh.glb')).map(v => +v.toFixed(3))).toEqual([2, 21.14, 6.7]);
    expect(geometrySize(glbGeometry('iposter-support-rh.glb')).map(v => +v.toFixed(3))).toEqual([2, 21.14, 6.7]);
  });

  it('ships a panel mesh that is exactly the panel spec the parametric box is built from', () => {
    // The guard against re-rounding the inch-authored CAD to whole millimetres: 640 x 480 x 45 mm
    // would make this mesh and `panelGeometry(IPOSTER)` disagree by 0.003 in per axis.
    expect(geometrySize(glbGeometry('iposter-panel.glb')).map(v => +v.toFixed(3)))
      .toEqual([IPOSTER.widthIn, IPOSTER.heightIn, IPOSTER.depthIn]);
    expect([IPOSTER.widthIn, IPOSTER.heightIn, IPOSTER.depthIn]).toEqual([25.2, 18.9, 1.77]);
  });

  it('frames the base plate with its top face on the panel bottom, centred in x and z', () => {
    const g = anchorGeometry(glbGeometry('iposter-base.glb'), ACCESSORY_CAD.base.anchors);
    const b = box(g);
    // accessoryPlacements puts this mesh at the panel's bottom centre, so the plate must hang below.
    expect(b.max.y).toBeCloseTo(0, 6);
    expect(b.min.y).toBeCloseTo(-0.25, 3);
    expect(b.min.x).toBeCloseTo(-12.54, 3);
    expect(b.max.x).toBeCloseTo(12.54, 3);
    expect(b.min.z).toBeCloseTo(-9.39, 3);
    expect(b.max.z).toBeCloseTo(9.39, 3);
  });

  it('frames each bracket with its feet on the ground and its bar on the cabinet back', () => {
    for (const name of ['iposter-support-lh.glb', 'iposter-support-rh.glb'] as const) {
      const part = name.includes('-lh') ? ACCESSORY_CAD['support-lh'] : ACCESSORY_CAD['support-rh'];
      const b = box(anchorGeometry(glbGeometry(name), part.anchors));
      // Placed at (±(panelW/2 − width/2), 0, −panelD/2): the plate's top face, panel back plane.
      expect(b.min.y).toBeCloseTo(0, 6);
      expect(b.max.y).toBeCloseTo(21.14, 3);
      expect(b.max.z).toBeCloseTo(0, 6);
      expect(b.min.z).toBeCloseTo(-6.7, 3);
      expect(b.min.x).toBeCloseTo(-1, 3);
      expect(b.max.x).toBeCloseTo(1, 3);
    }
  });

  it('ships the right and left brackets as true mirrors, not one part reused', () => {
    const points = (name: string): number[][] => {
      const a = glbGeometry(name).getAttribute('position');
      const out: number[][] = [];
      for (let i = 0; i < a.count; i++) out.push([a.getX(i), a.getY(i), a.getZ(i)]);
      return out;
    };
    const lh = points('iposter-support-lh.glb');
    const rh = points('iposter-support-rh.glb');
    // Float tolerance, not string keys: the two parts were tessellated independently.
    const has = (p: number[]): boolean =>
      lh.some(q => Math.abs(q[0] - p[0]) < 1e-4 && Math.abs(q[1] - p[1]) < 1e-4 && Math.abs(q[2] - p[2]) < 1e-4);
    expect(rh.every(p => has([-p[0], p[1], p[2]]))).toBe(true); // RH is LH mirrored in x
    expect(rh.some(p => !has(p))).toBe(true); // …and the part is not x-symmetric, so it matters
  });

  it('points at files that exist, one per part', () => {
    for (const part of Object.values(ACCESSORY_CAD)) {
      expect(part.url).toMatch(/^\/models\/.+\.glb$/);
      expect(() => glbGeometry(part.url.split('/').pop()!)).not.toThrow();
    }
  });
});
