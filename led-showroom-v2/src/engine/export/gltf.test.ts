import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { INCH_TO_METRE, buildExportRoot, collectExportable, isExportable, suggestGltfFilename } from './gltf';

const box = () => new THREE.BoxGeometry(1, 1, 1);
const mesh = (name: string, mat: THREE.Material = new THREE.MeshStandardMaterial()) => { const m = new THREE.Mesh(box(), mat); m.name = name; return m; };

function wallLike(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'led-wall:w1';
  root.userData.entityId = 'w1'; root.userData.entityType = 'led-wall';
  root.position.set(10, 0, -5);
  root.rotation.y = Math.PI / 4;
  root.add(mesh('panel'));
  const hidden = mesh('hidden'); hidden.visible = false; root.add(hidden);
  const helper = mesh('helper'); helper.userData.helper = true; helper.userData.unpickable = true; root.add(helper);
  const bezel = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()); bezel.userData.unpickable = true; root.add(bezel);
  const content = mesh('content', new THREE.MeshBasicMaterial()); content.userData.unpickable = true; content.userData.part = 'content'; root.add(content);
  const grid = mesh('pixel-grid'); grid.layers.set(1); root.add(grid);
  const css = new THREE.Object3D(); (css as unknown as { isCSS3DObject: boolean }).isCSS3DObject = true; css.add(mesh('iframe')); root.add(css);
  const emptyGroup = new THREE.Group(); emptyGroup.name = 'empty'; root.add(emptyGroup);
  const shader = mesh('shader', new THREE.ShaderMaterial({ uniforms: { color: { value: new THREE.Color(0xff0000) } } })); root.add(shader);
  return root;
}

describe('isExportable', () => {
  it('skips invisible, helper, unpickable (non-content), css3d, off-layer and line objects', () => {
    const root = wallLike();
    const byName = (n: string) => root.children.find(c => c.name === n) ?? root.children.find(c => c.userData.unpickable && !c.name && !(c as THREE.Mesh).isMesh)!;
    expect(isExportable(byName('panel'))).toBe(true);
    expect(isExportable(byName('content'))).toBe(true);
    expect(isExportable(byName('hidden'))).toBe(false);
    expect(isExportable(byName('helper'))).toBe(false);
    expect(isExportable(byName('pixel-grid'))).toBe(false);
    expect(isExportable(root.children.find(c => (c as THREE.LineSegments).isLineSegments)!)).toBe(false);
    expect(isExportable(root.children.find(c => (c as unknown as { isCSS3DObject?: boolean }).isCSS3DObject)!)).toBe(false);
  });
});

describe('collectExportable', () => {
  it('rebuilds only the exportable subtree, sharing geometry and copying transforms', () => {
    const src = wallLike();
    const out = collectExportable(src)!;
    expect(out).toBeInstanceOf(THREE.Group);
    expect(out.name).toBe('led-wall:w1');
    expect(out.userData.entityId).toBe('w1');
    expect(out.position.toArray()).toEqual([10, 0, -5]);
    expect(out.rotation.y).toBeCloseTo(Math.PI / 4, 12);
    expect(out.children.map(c => c.name).sort()).toEqual(['content', 'panel', 'shader']);
    const panel = out.children.find(c => c.name === 'panel') as THREE.Mesh;
    const srcPanel = src.children.find(c => c.name === 'panel') as THREE.Mesh;
    expect(panel.geometry).toBe(srcPanel.geometry);
    expect(panel.material).toBe(srcPanel.material);
    const shader = out.children.find(c => c.name === 'shader') as THREE.Mesh;
    expect((shader.material as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    expect((shader.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
  });
  it('returns null for an empty or fully filtered subtree', () => {
    const g = new THREE.Group();
    expect(collectExportable(g)).toBeNull();
    const h = mesh('x'); h.userData.helper = true; g.add(h);
    expect(collectExportable(g)).toBeNull();
    g.visible = false; g.add(mesh('y'));
    expect(collectExportable(g)).toBeNull();
  });
  it('keeps material arrays and instanced meshes', () => {
    const m = new THREE.Mesh(box(), [new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()]);
    const out = collectExportable(m) as THREE.Mesh;
    expect(Array.isArray(out.material) && out.material.length).toBe(2);
    const im = new THREE.InstancedMesh(box(), new THREE.MeshStandardMaterial(), 3);
    im.setMatrixAt(2, new THREE.Matrix4().makeTranslation(1, 2, 3));
    const oi = collectExportable(im) as THREE.InstancedMesh;
    expect(oi.isInstancedMesh).toBe(true);
    expect(oi.count).toBe(3);
    const mat = new THREE.Matrix4(); oi.getMatrixAt(2, mat);
    expect(new THREE.Vector3().setFromMatrixPosition(mat).toArray()).toEqual([1, 2, 3]);
  });
});

describe('buildExportRoot', () => {
  it('scales inches to metres and places roots at their world transform', () => {
    const world = new THREE.Group();
    const parent = new THREE.Group(); parent.position.set(100, 0, 0); world.add(parent);
    const wall = wallLike(); parent.add(wall);
    const root = buildExportRoot([wall], 'scene');
    expect(root.name).toBe('scene');
    expect(root.scale.x).toBe(INCH_TO_METRE);
    expect(root.children.length).toBe(1);
    expect(root.children[0].position.x).toBeCloseTo(110, 9);
    const panel = root.children[0].children.find(c => c.name === 'panel')!;
    const wp = panel.getWorldPosition(new THREE.Vector3());
    expect(wp.x).toBeCloseTo(110 * INCH_TO_METRE, 9);
    expect(buildExportRoot([new THREE.Group()]).children.length).toBe(0);
  });
});

describe('suggestGltfFilename', () => {
  it('slugs the document name and reflects options', () => {
    const doc = { name: 'Trade Show 2026!' };
    expect(suggestGltfFilename(doc, { binary: true, selectionOnly: false })).toBe('trade-show-2026.glb');
    expect(suggestGltfFilename(doc, { binary: false, selectionOnly: false })).toBe('trade-show-2026.gltf');
    expect(suggestGltfFilename(doc, { binary: true, selectionOnly: true }, ['LED Wall 2'])).toBe('trade-show-2026-led-wall-2.glb');
    expect(suggestGltfFilename(doc, { binary: true, selectionOnly: true }, ['a', 'b'])).toBe('trade-show-2026-2-objects.glb');
    expect(suggestGltfFilename({ name: '' }, { binary: true, selectionOnly: true })).toBe('showroom.glb');
  });
});
