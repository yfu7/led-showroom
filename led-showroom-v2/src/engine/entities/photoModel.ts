/**
 * Photo models: a product cutout stood up in the scene at its real size.
 *
 * The published product photos are transparent cutouts shot from a three-quarter angle. Rather than
 * approximate each one with boxes, the product IS the photograph: a single alpha-tested plane whose
 * height is the product's real height and whose width follows the image's own aspect, so nothing is
 * stretched. The plane turns about Y to face the camera (a Y-billboard), which is what keeps a flat
 * cutout reading as an object from any orbit angle.
 *
 * Selection bounds, snapping and measurement all use the entity's declared width/height/depth, not
 * the plane, so the numbers stay truthful even though the model is a picture.
 */
import * as THREE from 'three';

/** Alpha below this is discarded, which also gives a clean cutout shadow. */
export const PHOTO_ALPHA_TEST = 0.5;
/** Soft contact shadow ellipse under a cutout, as a fraction of the product's width. */
export const CONTACT_SHADOW_SCALE = 0.9;

const loader = new THREE.TextureLoader();
const cache = new Map<string, Promise<THREE.Texture>>();

/** Load (and cache) a product cutout. Textures are shared between every instance of a product. */
export function loadProductTexture(url: string): Promise<THREE.Texture> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        url,
        tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 8;
          tex.generateMipmaps = true;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => reject(new Error(`Could not load product image ${url}`)),
      );
    });
    cache.set(url, p);
  }
  return p;
}

/** Drop a cached texture (only for tests / teardown; instances share it). */
export function clearProductTextureCache(): void { cache.clear(); }

/**
 * Plane size for a cutout: the real height is authoritative, the width follows the image aspect so
 * the product keeps its proportions. Falls back to the declared width when the image is unmeasured.
 */
export function photoPlaneSize(dims: [number, number, number], image: { width: number; height: number } | null): { w: number; h: number } {
  const h = Math.max(0.1, dims[1]);
  if (!image || !image.width || !image.height) return { w: Math.max(0.1, dims[0]), h };
  return { w: h * (image.width / image.height), h };
}

/** A soft round contact shadow so a cutout does not appear to float. */
export function makeContactShadow(widthIn: number, depthIn: number, color = 0x000000): THREE.Mesh {
  const size = 64;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let tex: THREE.Texture;
  if (canvas) {
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.22)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    tex = new THREE.CanvasTexture(canvas);
  } else {
    tex = new THREE.Texture();
  }
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color, toneMapped: false });
  const w = Math.max(1, widthIn) * CONTACT_SHADOW_SCALE;
  const d = Math.max(1, depthIn) * CONTACT_SHADOW_SCALE;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.05;
  mesh.renderOrder = -1;
  mesh.userData.unpickable = true;
  mesh.userData.helper = true;
  return mesh;
}

/**
 * Turn `obj` about Y so its +Z faces the camera, leaving pitch and roll alone. `parentYaw` is the
 * world yaw already applied by the entity's own transform, which is subtracted so the billboard is
 * absolute rather than compounding with the object's rotation.
 */
export function faceCameraY(obj: THREE.Object3D, camera: THREE.Camera, parentYaw = 0): boolean {
  const objWorld = obj.getWorldPosition(_v1);
  const camWorld = camera.getWorldPosition(_v2);
  const dx = camWorld.x - objWorld.x;
  const dz = camWorld.z - objWorld.z;
  if (dx * dx + dz * dz < 1e-6) return false;
  const yaw = Math.atan2(dx, dz) - parentYaw;
  if (Math.abs(wrapPi(yaw - obj.rotation.y)) < 0.0005) return false;
  obj.rotation.y = yaw;
  return true;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Normalise an angle to (-π, π]. Both ±π land on +π, so the boundary has one representation. */
export function wrapPi(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r <= 0) r += Math.PI * 2;
  return r - Math.PI;
}
