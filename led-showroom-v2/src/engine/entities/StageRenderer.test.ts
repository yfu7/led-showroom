import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createDocument, createStage } from '../document/defaults';
import { assets } from '../persistence/AssetStore';
import { applyTransform, type RenderContext } from './EntityRenderer';
import {
  StageRenderer, createStageRenderer, stageDeckCenter, stageLocalBounds, stageMaterialArray, stageSkirtColor, stageTopY,
} from './StageRenderer';

function ctx(): RenderContext {
  const doc = createDocument();
  return {
    doc, assets, camera: new THREE.PerspectiveCamera(), invalidate() {}, setLoading() {},
    unit: 'in', needs: { css3d: false, pixelGrid: false }, maxTextureSize: 4096,
  };
}

describe('stage placement maths', () => {
  it('lifts the deck box by half its height (bottom-centre origin)', () => {
    expect(stageDeckCenter({ widthIn: 48, depthIn: 48, heightIn: 24 })).toEqual([0, 12, 0]);
    expect(stageDeckCenter({ widthIn: 96, depthIn: 48, heightIn: 8 })).toEqual([0, 4, 0]);
  });

  it('top surface is at heightIn in local space', () => {
    for (const h of [8, 16, 24, 32, 40, 48]) expect(stageTopY({ widthIn: 48, depthIn: 48, heightIn: h })).toBe(h);
  });

  it('local bounds span the footprint and rise from the floor to the top', () => {
    expect(stageLocalBounds({ widthIn: 48, depthIn: 96, heightIn: 24 })).toEqual({ min: [-24, 0, -48], max: [24, 24, 48] });
  });

  it('puts the top material on the +y face only (BoxGeometry face order)', () => {
    const top = new THREE.MeshBasicMaterial(), side = new THREE.MeshBasicMaterial();
    const arr = stageMaterialArray(top, side);
    expect(arr).toHaveLength(6);
    expect(arr[2]).toBe(top);
    arr.forEach((m, i) => { if (i !== 2) expect(m).toBe(side); });
  });

  it('derives a slightly lighter skirt colour from the deck colour', () => {
    const top = new THREE.Color('#1a1a1c');
    const skirt = stageSkirtColor(top);
    const hslTop = { h: 0, s: 0, l: 0 }, hslSkirt = { h: 0, s: 0, l: 0 };
    top.getHSL(hslTop); skirt.getHSL(hslSkirt);
    expect(hslSkirt.l).toBeGreaterThan(hslTop.l);
    expect(hslSkirt.l - hslTop.l).toBeCloseTo(0.04, 5);
  });
});

describe('StageRenderer', () => {
  it('builds a tagged root with the box as the only selection mesh', () => {
    const e = createStage(24, [10, 0, -5]);
    const r = createStageRenderer(e, ctx()) as StageRenderer;
    expect(r.root.userData.entityId).toBe(e.id);
    expect(r.root.userData.entityType).toBe('stage');
    expect(r.selectionMeshes()).toEqual([r.box]);
    expect(r.box.userData.part).toBe('stage');
    expect(r.box.position.y).toBe(12);
    expect(r.topSurfaceY()).toBe(24);
    r.dispose();
  });

  it('world bounds follow the entity transform (position + uniform scale)', () => {
    const e = createStage(16, [100, 0, 20]);
    e.transform.scale = [2, 2, 2];
    const r = new StageRenderer(e, ctx());
    applyTransform(r.root, e.transform);
    const b = r.bounds();
    expect(b.min.x).toBeCloseTo(100 - 48);
    expect(b.max.x).toBeCloseTo(100 + 48);
    expect(b.min.y).toBeCloseTo(0);
    expect(b.max.y).toBeCloseTo(32);
    expect(b.min.z).toBeCloseTo(20 - 48);
    expect(b.max.z).toBeCloseTo(20 + 48);
    r.dispose();
  });

  it('rebuilds geometry when dims change and swaps materials for a colour override', () => {
    const e = createStage(8);
    delete e.color;
    const c = ctx();
    const r = new StageRenderer(e, c);
    expect(r.box.userData.sharedMaterial).toBe(true);
    const sharedTop = (r.box.material as THREE.Material[])[2];

    const e2 = { ...e, heightIn: 40, widthIn: 96, color: '#ff0000' };
    r.update(e2, c);
    expect(r.box.position.y).toBe(20);
    const b = r.bounds();
    expect(b.max.x - b.min.x).toBeCloseTo(96);
    expect(b.max.y).toBeCloseTo(40);
    expect(r.box.userData.sharedMaterial).toBe(false);
    const top = (r.box.material as THREE.MeshStandardMaterial[])[2];
    expect(top).not.toBe(sharedTop);
    expect(top.color.getHexString()).toBe('ff0000');

    const e3 = { ...e2, color: undefined };
    r.update(e3, c);
    expect(r.box.userData.sharedMaterial).toBe(true);
    expect((r.box.material as THREE.Material[])[2]).toBe(sharedTop);
    r.dispose();
  });
});
