/**
 * Imported 3D model loading (glTF/GLB, OBJ, STL, FBX, PLY) plus the pure helpers the model
 * renderer and inspector need: format detection from a file name, source-unit → inch scale and
 * bounding-box measurement. The three.js example loaders are imported lazily so this module is
 * cheap to import (and testable under node).
 */
import * as THREE from 'three';
import type { ModelFormat } from '../document/types';
import { toInches, type Unit } from '../units';
import type { Vec3 } from '../math';

/** Google-hosted Draco decoders (wasm + js), used for compressed glTF. */
export const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

const FORMAT_BY_EXT: Record<string, ModelFormat> = {
  glb: 'glb',
  gltf: 'gltf',
  obj: 'obj',
  stl: 'stl',
  fbx: 'fbx',
  ply: 'ply',
};

/** Format from a file name / URL extension, or null when unsupported. */
export function detectModelFormat(fileName: string): ModelFormat | null {
  const clean = fileName.split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  if (!m) return null;
  return FORMAT_BY_EXT[m[1].toLowerCase()] ?? null;
}

/** Scale factor that turns lengths authored in `unit` into world inches. */
export function unitScaleToInches(unit: Unit): number {
  return toInches(1, unit);
}

export interface Measurement {
  /** Width, height, depth (world units of the measured object). */
  dims: Vec3;
  /** Lowest point. */
  minY: number;
  /** Box centre. */
  center: Vec3;
}

/** World-space axis-aligned bounds of an object (after updateMatrixWorld). Empty objects measure 0. */
export function measureObject(obj: THREE.Object3D, out = new THREE.Box3()): Measurement {
  obj.updateMatrixWorld(true);
  out.setFromObject(obj, true);
  if (out.isEmpty()) return { dims: [0, 0, 0], minY: 0, center: [0, 0, 0] };
  const size = out.getSize(new THREE.Vector3());
  const c = out.getCenter(new THREE.Vector3());
  return { dims: [size.x, size.y, size.z], minY: out.min.y, center: [c.x, c.y, c.z] };
}

/**
 * Wrap a loaded object in a group scaled by `scale` and translated so the model stands on the
 * floor (min.y = 0) centred on its footprint (x/z centre = 0). Returns the group and the
 * measured dims in the scaled frame.
 */
export function fitOnFloor(obj: THREE.Object3D, scale: number): { group: THREE.Group; dims: Vec3 } {
  const group = new THREE.Group();
  group.name = 'fit';
  group.add(obj);
  group.scale.setScalar(scale);
  const m = measureObject(group);
  group.position.set(-m.center[0], -m.minY, -m.center[2]);
  group.updateMatrixWorld(true);
  return { group, dims: m.dims };
}

/** Neutral material for geometry-only formats (STL, PLY without colours). */
export function neutralMaterial(vertexColors = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0xb8bcc4, metalness: 0.1, roughness: 0.65, vertexColors, side: THREE.DoubleSide });
}

/** Turn a PLY geometry into a mesh (indexed faces) or a point cloud (vertices only). */
export function plyToObject(geometry: THREE.BufferGeometry, pointSizeIn = 0.35): THREE.Object3D {
  const hasColor = !!geometry.getAttribute('color');
  const isMesh = !!geometry.index && geometry.index.count > 0;
  if (isMesh) {
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, neutralMaterial(hasColor));
  }
  const mat = new THREE.PointsMaterial({ size: pointSizeIn, vertexColors: hasColor, color: hasColor ? 0xffffff : 0xb8bcc4 });
  return new THREE.Points(geometry, mat);
}

let dracoLoader: import('three/examples/jsm/loaders/DRACOLoader.js').DRACOLoader | null = null;

/**
 * Load a model from a Blob (an object URL is minted and revoked afterwards) or a URL.
 * glTF files with external resources loaded from a Blob will fail (no base path) — the
 * rejection is left to the caller.
 */
export async function loadModel(blobOrUrl: Blob | string, format: ModelFormat, fileName: string): Promise<THREE.Object3D> {
  const owned = typeof blobOrUrl !== 'string';
  const url = owned ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
  try {
    const obj = await loadByFormat(url, format);
    obj.name = fileName;
    obj.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
    });
    return obj;
  } finally {
    if (owned) URL.revokeObjectURL(url);
  }
}

async function loadByFormat(url: string, format: ModelFormat): Promise<THREE.Object3D> {
  switch (format) {
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      try {
        const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
        if (!dracoLoader) { dracoLoader = new DRACOLoader(); dracoLoader.setDecoderPath(DRACO_DECODER_PATH); }
        loader.setDRACOLoader(dracoLoader);
      } catch { /* Draco unavailable: uncompressed glTF still loads */ }
      const gltf = await loader.loadAsync(url);
      return gltf.scene;
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      return await new OBJLoader().loadAsync(url);
    }
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geom = await new STLLoader().loadAsync(url);
      if (!geom.getAttribute('normal')) geom.computeVertexNormals();
      const hasColor = !!geom.getAttribute('color');
      return new THREE.Mesh(geom, neutralMaterial(hasColor));
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      return await new FBXLoader().loadAsync(url);
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const geom = await new PLYLoader().loadAsync(url);
      return plyToObject(geom);
    }
    default: {
      const never: never = format;
      throw new Error(`Unsupported model format: ${String(never)}`);
    }
  }
}
