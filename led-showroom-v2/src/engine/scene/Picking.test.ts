/**
 * `pickEntity`'s `exclude` set is the only thing that keeps hidden entities from swallowing
 * clicks: three's raycaster does not honour `visible`, and the scene hides an entity by clearing
 * `visible` on its root, not on the leaf meshes the ray actually meets. These tests pin both
 * halves — the raycaster behaviour that makes the exclude necessary, and the exclude itself.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hiddenEntityIds } from '../tools/BoxSelect';
import { entityIdOf, pickEntity } from './Picking';

/** A camera at +Z looking down −Z, so NDC (0, 0) shoots straight at the origin. */
function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  cam.position.set(0, 0, 50);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** An entity root (a Group, as SceneManager builds them) with one leaf mesh at the origin. */
function entityRoot(id: string, z = 0): THREE.Group {
  const root = new THREE.Group();
  root.userData.entityId = id;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial());
  mesh.position.z = z;
  root.add(mesh);
  return root;
}

const CENTRE = new THREE.Vector2(0, 0);

describe('pickEntity', () => {
  it('hits the entity under the pointer', () => {
    const scene = new THREE.Scene();
    scene.add(entityRoot('wall'));
    scene.updateMatrixWorld(true);
    expect(pickEntity(CENTRE, camera(), scene)?.entityId).toBe('wall');
  });

  it('still hits a mesh whose entity root is invisible (the reason exclude exists)', () => {
    const scene = new THREE.Scene();
    const root = entityRoot('wall');
    root.visible = false; // exactly what SceneManager does for a hidden entity
    scene.add(root);
    scene.updateMatrixWorld(true);
    // The leaf mesh's own `visible` is untouched, so Picking's `!h.object.visible` check misses it.
    expect(pickEntity(CENTRE, camera(), scene)?.entityId).toBe('wall');
  });

  it('skips excluded ids and falls through to what is behind them', () => {
    const scene = new THREE.Scene();
    const front = entityRoot('hidden-wall', 10);
    front.visible = false;
    scene.add(front, entityRoot('visible-wall', -10));
    scene.updateMatrixWorld(true);
    const hidden = hiddenEntityIds([
      { id: 'hidden-wall', visible: false },
      { id: 'visible-wall', visible: true },
    ]);
    expect(pickEntity(CENTRE, camera(), scene, { exclude: hidden })?.entityId).toBe('visible-wall');
  });

  it('returns null when every candidate is excluded', () => {
    const scene = new THREE.Scene();
    scene.add(entityRoot('wall'));
    scene.updateMatrixWorld(true);
    expect(pickEntity(CENTRE, camera(), scene, { exclude: new Set(['wall']) })).toBeNull();
  });

  it('excludes the children of a hidden group, which have visible: true of their own', () => {
    const hidden = hiddenEntityIds([
      { id: 'group', visible: false },
      { id: 'child', visible: true, parentId: 'group' },
    ]);
    const scene = new THREE.Scene();
    scene.add(entityRoot('child'));
    scene.updateMatrixWorld(true);
    expect(hidden.has('child')).toBe(true);
    expect(pickEntity(CENTRE, camera(), scene, { exclude: hidden })).toBeNull();
  });

  it('filters by entity type when onlyTypes is given', () => {
    const scene = new THREE.Scene();
    const root = entityRoot('wall');
    root.userData.entityType = 'ledwall';
    scene.add(root);
    scene.updateMatrixWorld(true);
    expect(pickEntity(CENTRE, camera(), scene, { onlyTypes: new Set(['stage']) })).toBeNull();
    expect(pickEntity(CENTRE, camera(), scene, { onlyTypes: new Set(['ledwall']) })?.entityId).toBe('wall');
  });
});

describe('entityIdOf', () => {
  it('walks up to the nearest ancestor carrying an entity id', () => {
    const root = entityRoot('wall');
    expect(entityIdOf(root.children[0])).toBe('wall');
    expect(entityIdOf(null)).toBeNull();
    expect(entityIdOf(new THREE.Object3D())).toBeNull();
  });
});
