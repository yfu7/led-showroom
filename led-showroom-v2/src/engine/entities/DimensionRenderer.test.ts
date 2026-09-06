import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createDimension, createDocument, createGroup, createStage } from '../document/defaults';
import { assets } from '../persistence/AssetStore';
import { applyTransform, type RenderContext } from './EntityRenderer';
import {
  DimensionRenderer, MEASURE_LABEL_LIFT_IN, MEASURE_LINE_RENDER_ORDER, MEASURE_MARKER_RADIUS_IN, MEASURE_MARKER_RENDER_ORDER,
  axisBreakdownPoints, createDimensionRenderer, dimensionDistance, dimensionLabelPosition, dimensionLabelText, redrawLabelSprite,
} from './DimensionRenderer';
import { GroupRenderer, createGroupRenderer } from './GroupRenderer';
import { StageRenderer } from './StageRenderer';

function ctx(unit: RenderContext['unit'] = 'in'): RenderContext {
  const doc = createDocument();
  return {
    doc, assets, camera: new THREE.PerspectiveCamera(), invalidate() {}, setLoading() {},
    unit, needs: { css3d: false, pixelGrid: false }, maxTextureSize: 4096,
  };
}

describe('dimension helpers', () => {
  it('distance is the straight line between the two points', () => {
    expect(dimensionDistance([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(dimensionDistance([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('label text is the formatted distance in the display unit, or the override', () => {
    expect(dimensionLabelText([0, 0, 0], [120, 0, 0], 'in')).toBe('120"');
    expect(dimensionLabelText([0, 0, 0], [120, 0, 0], 'ft')).toBe("10' 0\"");
    expect(dimensionLabelText([0, 0, 0], [3, 4, 0], 'in')).toBe('5"');
    expect(dimensionLabelText([0, 0, 0], [3, 4, 0], 'in', 'Throw')).toBe('Throw');
    expect(dimensionLabelText([0, 0, 0], [3, 4, 0], 'in', '   ')).toBe('5"');
    expect(dimensionLabelText([0, 0, 0], [3, 4, 0], 'in')).not.toMatch(/px/);
  });

  it('label sits at the midpoint lifted 4 in', () => {
    expect(dimensionLabelPosition([0, 0, 0], [10, 20, 30])).toEqual([5, 10 + MEASURE_LABEL_LIFT_IN, 15]);
  });

  it('axis breakdown walks dx, dy, dz and drops degenerate legs', () => {
    expect(axisBreakdownPoints([0, 0, 0], [10, 20, 30])).toEqual([[0, 0, 0], [10, 0, 0], [10, 20, 0], [10, 20, 30]]);
    expect(axisBreakdownPoints([0, 0, 0], [10, 0, 30])).toEqual([[0, 0, 0], [10, 0, 0], [10, 0, 30]]);
    expect(axisBreakdownPoints([0, 0, 0], [0, 0, 30])).toEqual([[0, 0, 0], [0, 0, 30]]);
    expect(axisBreakdownPoints([5, 5, 5], [5, 5, 5])).toEqual([[5, 5, 5]]);
  });
});

describe('DimensionRenderer', () => {
  it('places children in world space and ignores the entity transform', () => {
    const e = createDimension([0, 0, 0], [30, 40, 0]);
    e.transform.position = [100, 100, 100];
    e.transform.rotation = [0, 90, 0];
    const r = createDimensionRenderer(e, ctx()) as DimensionRenderer;
    // Simulate the SceneManager: re-apply the transform, then update world matrices.
    applyTransform(r.root, e.transform);
    r.root.updateMatrixWorld(true);
    const wa = r.markerA.getWorldPosition(new THREE.Vector3());
    const wb = r.markerB.getWorldPosition(new THREE.Vector3());
    expect(wa.toArray()).toEqual([0, 0, 0]);
    expect(wb.toArray()).toEqual([30, 40, 0]);
    expect(r.root.matrixAutoUpdate).toBe(false);
    expect(r.root.matrixWorldAutoUpdate).toBe(false);
    r.dispose();
  });

  it('ignores a parent group transform too (world-point contract for grouped measurements)', () => {
    const e = createDimension([0, 0, 0], [30, 40, 0]);
    const r = new DimensionRenderer(e, ctx());
    const parent = new THREE.Group();
    parent.position.set(100, 50, -20);
    parent.rotation.y = Math.PI / 2;
    parent.add(r.root);
    parent.updateMatrixWorld(true);
    expect(r.markerA.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([0, 0, 0]);
    expect(r.markerB.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([30, 40, 0]);
    const b = r.bounds();
    expect(b.min.x).toBeCloseTo(-MEASURE_MARKER_RADIUS_IN); expect(b.max.x).toBeCloseTo(30 + MEASURE_MARKER_RADIUS_IN);
    r.dispose();
  });

  it('draws nothing pickable so chained measurements land on the surface beneath', () => {
    const e = createDimension([0, 0, 0], [30, 40, 0]);
    const r = new DimensionRenderer(e, ctx());
    expect(r.markerA.userData.unpickable).toBe(true);
    expect(r.markerB.userData.unpickable).toBe(true);
    expect(r.line.userData.unpickable).toBe(true);
    expect(r.breakdown.userData.unpickable).toBe(true);
    expect(r.label?.userData.unpickable).toBe(true);
    const scene = new THREE.Scene();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial());
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor, r.root);
    scene.updateMatrixWorld(true);
    // Ray straight down onto endpoint a, which sits on the floor: the floor must win, not the sphere.
    const rc = new THREE.Raycaster(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0));
    rc.camera = new THREE.PerspectiveCamera(); // Sprite.raycast needs a camera
    rc.camera.updateMatrixWorld();
    const hit = rc.intersectObject(scene, true).find(h => !h.object.userData.unpickable && h.object.visible);
    expect(hit?.object).toBe(floor);
    expect(hit!.point.y).toBeCloseTo(0);
    r.dispose();
  });

  it('draws v1-styled markers, line and a label sprite', () => {
    const e = createDimension([0, 0, 0], [30, 40, 0]);
    const r = new DimensionRenderer(e, ctx('in'));
    expect(r.selectionMeshes()).toEqual([r.markerA, r.markerB]);
    expect(r.markerA.renderOrder).toBe(MEASURE_MARKER_RENDER_ORDER);
    expect(r.line.renderOrder).toBe(MEASURE_LINE_RENDER_ORDER);
    expect((r.markerA.material as THREE.MeshBasicMaterial).depthTest).toBe(false);
    expect((r.markerA.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xeab308);
    expect(r.markerA.userData.sharedGeometry).toBe(true);
    expect(r.markerA.userData.sharedMaterial).toBe(true);
    expect((r.markerA.geometry as THREE.SphereGeometry).parameters.radius).toBe(MEASURE_MARKER_RADIUS_IN);
    expect(r.label?.userData.label).toBe('50"');
    expect(r.label?.position.toArray()).toEqual([15, 20 + MEASURE_LABEL_LIFT_IN, 0]);
    expect(r.breakdown.visible).toBe(true);
    expect(r.breakdown.userData.unpickable).toBe(true);

    const b = r.bounds();
    expect(b.min.x).toBeCloseTo(-MEASURE_MARKER_RADIUS_IN);
    expect(b.max.y).toBeCloseTo(40 + MEASURE_MARKER_RADIUS_IN);
    r.dispose();
  });

  it('relabels on unit change and hides the breakdown for axis-aligned measurements', () => {
    const e = createDimension([0, 0, 0], [24, 0, 0]);
    const r = new DimensionRenderer(e, ctx('in'));
    expect(r.label?.userData.label).toBe('24"');
    expect(r.breakdown.visible).toBe(false);
    r.update(e, ctx('ft'));
    expect(r.label?.userData.label).toBe("2' 0\"");
    r.update({ ...e, b: [24, 12, 0] }, ctx('ft'));
    expect(r.breakdown.visible).toBe(true);
    expect(r.markerB.position.toArray()).toEqual([24, 12, 0]);
    r.dispose();
  });

  it('redraws an existing label canvas in place and rebuilds only when the text no longer fits', () => {
    const calls: string[] = [];
    const fakeCtx = {
      font: '', fillStyle: '', textAlign: '', textBaseline: '',
      measureText: (t: string) => ({ width: t.length * 33 }),
      clearRect: () => calls.push('clear'), fillRect: () => calls.push('fillRect'), fillText: (t: string) => calls.push('text:' + t),
      beginPath: () => {}, fill: () => {}, roundRect: () => calls.push('roundRect'),
    };
    const canvas = { width: 300, height: 118, getContext: () => fakeCtx } as unknown as HTMLCanvasElement;
    const map = new THREE.Texture(canvas);
    map.needsUpdate = false;
    const version = map.version;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map }));
    sprite.userData.label = 'old';

    expect(redrawLabelSprite(sprite, '50"')).toBe(true);      // 3*33 + 40 = 139 <= 300
    expect(sprite.userData.label).toBe('50"');
    expect(map.version).toBe(version + 1);
    expect(calls).toEqual(['clear', 'roundRect', 'text:50"']);
    expect(redrawLabelSprite(sprite, '123456789"')).toBe(false); // 10*33 + 40 = 370 > 300
    expect(sprite.userData.label).toBe('50"');
    // No canvas (node fallback sprite): cannot redraw.
    const bare = new THREE.Sprite(new THREE.SpriteMaterial());
    expect(redrawLabelSprite(bare, 'x')).toBe(false);
    map.dispose(); sprite.material.dispose(); bare.material.dispose();
  });

  it('frame() scales the label with camera distance', () => {
    const e = createDimension([0, 0, 0], [10, 0, 0]);
    const c = ctx();
    const r = new DimensionRenderer(e, c);
    c.camera.position.set(0, 0, 400);
    c.camera.updateMatrixWorld();
    r.frame(0, c);
    expect(r.label!.scale.y).toBeCloseTo(6 * 2, 1);
    r.dispose();
  });
});

describe('GroupRenderer', () => {
  it('has no selection meshes and bounds equal to the union of its children', () => {
    const c = ctx();
    const g = createGroup();
    const gr = createGroupRenderer(g, c) as GroupRenderer;
    expect(gr.selectionMeshes()).toEqual([]);
    expect(gr.bounds().isEmpty()).toBe(true);

    const s1 = createStage(24, [0, 0, 0]);
    const s2 = createStage(8, [100, 0, 0]);
    const r1 = new StageRenderer(s1, c), r2 = new StageRenderer(s2, c);
    applyTransform(r1.root, s1.transform); applyTransform(r2.root, s2.transform);
    gr.root.add(r1.root, r2.root);
    g.transform.position = [0, 10, 0];
    applyTransform(gr.root, g.transform);

    const b = gr.bounds();
    expect(b.min.x).toBeCloseTo(-24); expect(b.max.x).toBeCloseTo(124);
    expect(b.min.y).toBeCloseTo(10); expect(b.max.y).toBeCloseTo(34);

    r1.root.visible = false;
    const b2 = gr.bounds();
    expect(b2.min.x).toBeCloseTo(76); expect(b2.max.y).toBeCloseTo(18);
    r1.dispose(); r2.dispose(); gr.dispose();
  });
});
