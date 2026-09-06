import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { detectModelFormat, fitOnFloor, measureObject, plyToObject, unitScaleToInches } from './modelLoaders';

describe('detectModelFormat', () => {
  it('maps supported extensions (case-insensitive, ignoring query strings)', () => {
    expect(detectModelFormat('booth.glb')).toBe('glb');
    expect(detectModelFormat('Scene.GLTF')).toBe('gltf');
    expect(detectModelFormat('chair.obj')).toBe('obj');
    expect(detectModelFormat('part.stl')).toBe('stl');
    expect(detectModelFormat('rig.FBX')).toBe('fbx');
    expect(detectModelFormat('scan.ply')).toBe('ply');
    expect(detectModelFormat('https://x.test/models/truss.glb?v=2#frag')).toBe('glb');
  });
  it('returns null for unsupported or missing extensions', () => {
    expect(detectModelFormat('photo.png')).toBeNull();
    expect(detectModelFormat('noext')).toBeNull();
    expect(detectModelFormat('archive.tar.gz')).toBeNull();
  });
});

describe('unitScaleToInches', () => {
  it('converts one source unit to inches', () => {
    expect(unitScaleToInches('in')).toBe(1);
    expect(unitScaleToInches('ft')).toBe(12);
    expect(unitScaleToInches('m')).toBeCloseTo(39.3701, 3);
    expect(unitScaleToInches('cm')).toBeCloseTo(0.393701, 5);
    expect(unitScaleToInches('mm')).toBeCloseTo(0.0393701, 6);
  });
});

describe('measureObject', () => {
  it('measures world-space bounds including nested transforms', () => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    m.position.set(10, 5, -3);
    g.add(m);
    g.scale.setScalar(2);
    const r = measureObject(g);
    expect(r.dims.map(v => +v.toFixed(6))).toEqual([4, 8, 12]);
    expect(r.minY).toBeCloseTo(6);
    expect(r.center.map(v => +v.toFixed(6))).toEqual([20, 10, -6]);
  });
  it('returns zeros for an empty object', () => {
    expect(measureObject(new THREE.Group())).toEqual({ dims: [0, 0, 0], minY: 0, center: [0, 0, 0] });
  });
});

describe('fitOnFloor', () => {
  it('scales and re-centres so min.y = 0 and the footprint centre is at the origin', () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3));
    m.position.set(5, 7, -2);
    const { group, dims } = fitOnFloor(m, 10);
    expect(dims.map(v => +v.toFixed(6))).toEqual([10, 20, 30]);
    const after = measureObject(group);
    expect(after.minY).toBeCloseTo(0);
    expect(after.center[0]).toBeCloseTo(0);
    expect(after.center[2]).toBeCloseTo(0);
    expect(after.center[1]).toBeCloseTo(10);
    expect(group.children[0]).toBe(m);
  });
});

describe('plyToObject', () => {
  it('wraps indexed geometry in a Mesh with vertex colours when present', () => {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const colors = new Float32Array(geom.getAttribute('position').count * 3).fill(1);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const obj = plyToObject(geom);
    expect((obj as THREE.Mesh).isMesh).toBe(true);
    expect(((obj as THREE.Mesh).material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });
  it('turns non-indexed vertex-only geometry into Points', () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1, 2, 0, 1]), 3));
    const obj = plyToObject(geom, 0.5);
    expect((obj as THREE.Points).isPoints).toBe(true);
    expect(((obj as THREE.Points).material as THREE.PointsMaterial).size).toBe(0.5);
    expect(((obj as THREE.Points).material as THREE.PointsMaterial).vertexColors).toBe(false);
  });
});
