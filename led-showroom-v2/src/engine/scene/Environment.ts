/**
 * Scene environment: ground grid (shader, radially faded), floor (shadow catcher), lighting rigs,
 * axis marker and the DOM backdrop (colour / venue photo).
 */
import * as THREE from 'three';
import type { Environment as EnvDoc, LightingPreset } from '../document/types';

export interface EnvTheme {
  gridMinor: string;
  gridMajor: string;
  gridAxisX: string;
  gridAxisZ: string;
  floor: string;
  backdropTop: string;
  backdropBottom: string;
}

/** Night (default): blue-black, so the LED wall is the only bright thing in the room. */
export const DARK_THEME: EnvTheme = {
  gridMinor: '#8cbee1', gridMajor: '#8cbee1', gridAxisX: '#e0574f', gridAxisZ: '#4a8ee0',
  floor: '#0d1218', backdropTop: '#16202b', backdropBottom: '#05070a',
};
/** Studio: Veloxity's white-to-grey ground for lit rooms and print. */
export const LIGHT_THEME: EnvTheme = {
  gridMinor: '#5f6980', gridMajor: '#5f6980', gridAxisX: '#d05a55', gridAxisZ: '#3f73c7',
  floor: '#eef1f5', backdropTop: '#ffffff', backdropBottom: '#dfe5ec',
};

const GRID_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const GRID_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  uniform float uMinor;      // spacing (in)
  uniform float uMajor;      // spacing (in)
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform vec3 uAxisX;       // colour of the line along X (z = 0)
  uniform vec3 uAxisZ;       // colour of the line along Z (x = 0)
  uniform float uMinorAlpha;
  uniform float uMajorAlpha;
  uniform float uFadeStart;  // distance from camera where fade begins
  uniform float uFadeEnd;
  uniform vec3 uCamPos;

  float gridLine(vec2 p, float spacing, float width) {
    vec2 q = p / spacing;
    vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
    float line = min(g.x, g.y);
    return 1.0 - smoothstep(width, width + 1.0, line);
  }

  void main() {
    vec2 p = vWorld.xz;
    float minor = gridLine(p, uMinor, 0.6) * uMinorAlpha;
    float major = gridLine(p, uMajor, 0.9) * uMajorAlpha;
    vec3 col = mix(uMinorColor, uMajorColor, step(minor, major));
    float a = max(minor, major);
    // axes
    float ax = 1.0 - smoothstep(1.2, 2.2, abs(vWorld.z) / fwidth(vWorld.z));
    float az = 1.0 - smoothstep(1.2, 2.2, abs(vWorld.x) / fwidth(vWorld.x));
    col = mix(col, uAxisX, ax);
    col = mix(col, uAxisZ, az);
    a = max(a, max(ax, az) * 0.9);
    float d = distance(vWorld, uCamPos);
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);
    // also fade very steep grazing angles a touch
    gl_FragColor = vec4(col, a * fade);
    if (gl_FragColor.a < 0.003) discard;
  }`;

export class Environment {
  readonly group = new THREE.Group();
  readonly grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  readonly shadowCatcher: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  readonly lights = new THREE.Group();
  readonly hemi: THREE.HemisphereLight;
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly rim: THREE.DirectionalLight;
  readonly ambient: THREE.AmbientLight;
  theme: EnvTheme = DARK_THEME;
  private backdropEl: HTMLElement;
  private photoUrl: string | null = null;

  constructor(backdropEl: HTMLElement) {
    this.backdropEl = backdropEl;
    this.group.name = 'environment';

    // Floor (visible surface) — sits a hair below the grid so lines draw on top
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(this.theme.floor), roughness: 0.92, metalness: 0.02 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.05;
    this.floor.receiveShadow = true;
    this.floor.name = 'floor';
    this.floor.userData.pickable = 'ground';
    this.group.add(this.floor);

    // Shadow catcher for photo backdrops (transparent floor that still shows shadows)
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35, transparent: true }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = -0.04;
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.visible = false;
    this.shadowCatcher.name = 'shadowCatcher';
    this.shadowCatcher.userData.pickable = 'ground';
    this.group.add(this.shadowCatcher);

    // Grid
    const gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uMinor: { value: 12 }, uMajor: { value: 48 },
        uMinorColor: { value: new THREE.Color(this.theme.gridMinor) },
        uMajorColor: { value: new THREE.Color(this.theme.gridMajor) },
        uAxisX: { value: new THREE.Color(this.theme.gridAxisX) },
        uAxisZ: { value: new THREE.Color(this.theme.gridAxisZ) },
        uMinorAlpha: { value: 0.06 }, uMajorAlpha: { value: 0.15 },
        uFadeStart: { value: 300 }, uFadeEnd: { value: 1800 },
        uCamPos: { value: new THREE.Vector3() },
      },
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gridMat);
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = 0.02;
    this.grid.renderOrder = -1;
    this.grid.name = 'grid';
    this.grid.raycast = () => {}; // never picked
    this.group.add(this.grid);

    // Lights
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a30, 0.6);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.position.set(200, 420, 360);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.6;
    this.key.shadow.radius = 4;
    this.fill = new THREE.DirectionalLight(0x9fb8ff, 0.5);
    this.fill.position.set(-380, 160, 240);
    this.rim = new THREE.DirectionalLight(0xffffff, 0.35);
    this.rim.position.set(60, 240, -420);
    this.lights.add(this.hemi, this.ambient, this.key, this.key.target, this.fill, this.rim);
    this.group.add(this.lights);

    this.setFloorSize(1440);
    this.setBackdrop({ color: '#0b0b0d' });
  }

  setTheme(theme: EnvTheme): void {
    this.theme = theme;
    const u = this.grid.material.uniforms;
    u.uMinorColor.value.set(theme.gridMinor);
    u.uMajorColor.value.set(theme.gridMajor);
    u.uAxisX.value.set(theme.gridAxisX);
    u.uAxisZ.value.set(theme.gridAxisZ);
    this.floor.material.color.set(theme.floor);
    if (!this.photoUrl) this.paintBackdrop(null);
  }

  setFloorSize(sizeIn: number): void {
    const s = Math.max(120, sizeIn);
    for (const m of [this.floor, this.shadowCatcher, this.grid]) {
      m.geometry.dispose();
      m.geometry = new THREE.PlaneGeometry(s, s);
    }
    this.grid.material.uniforms.uFadeStart.value = Math.min(400, s * 0.2);
    this.grid.material.uniforms.uFadeEnd.value = s * 0.95;
  }

  /** Shadow camera should cover the scene bounds. */
  fitShadows(bounds: THREE.Box3): void {
    const c = bounds.isEmpty() ? new THREE.Vector3(0, 40, 0) : bounds.getCenter(new THREE.Vector3());
    const r = bounds.isEmpty() ? 240 : Math.max(120, bounds.getSize(new THREE.Vector3()).length() * 0.6);
    const cam = this.key.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = r * 6;
    cam.updateProjectionMatrix();
    this.key.target.position.copy(c);
    this.key.position.copy(c).add(new THREE.Vector3(0.45, 1, 0.8).normalize().multiplyScalar(r * 2.5));
    this.key.target.updateMatrixWorld();
  }

  applyLighting(preset: LightingPreset, intensity: number, shadows: boolean): void {
    const k = intensity;
    switch (preset) {
      case 'studio':
        this.hemi.intensity = 0.9 * k; this.ambient.intensity = 0.4 * k; this.key.intensity = 2.0 * k; this.fill.intensity = 0.8 * k; this.rim.intensity = 0.5 * k;
        this.hemi.color.set(0xffffff); this.hemi.groundColor.set(0x8a8a90); this.fill.color.set(0xffffff);
        break;
      case 'dark':
        this.hemi.intensity = 0.25 * k; this.ambient.intensity = 0.1 * k; this.key.intensity = 0.7 * k; this.fill.intensity = 0.2 * k; this.rim.intensity = 0.3 * k;
        this.hemi.color.set(0xaab4c8); this.hemi.groundColor.set(0x101014); this.fill.color.set(0x6f86c0);
        break;
      case 'venue':
        this.hemi.intensity = 0.55 * k; this.ambient.intensity = 0.3 * k; this.key.intensity = 1.1 * k; this.fill.intensity = 0.4 * k; this.rim.intensity = 0.2 * k;
        this.hemi.color.set(0xffe9c8); this.hemi.groundColor.set(0x3a2e24); this.fill.color.set(0xffd8a8);
        break;
      case 'showroom':
      default:
        this.hemi.intensity = 0.6 * k; this.ambient.intensity = 0.25 * k; this.key.intensity = 1.6 * k; this.fill.intensity = 0.5 * k; this.rim.intensity = 0.35 * k;
        this.hemi.color.set(0xffffff); this.hemi.groundColor.set(0x2a2a30); this.fill.color.set(0x9fb8ff);
        break;
    }
    this.key.castShadow = shadows;
  }

  /** Apply the document's environment block. */
  apply(env: EnvDoc): void {
    this.grid.visible = env.grid.visible;
    this.grid.material.uniforms.uMinor.value = env.grid.minorIn;
    this.grid.material.uniforms.uMajor.value = env.grid.majorIn;
    this.setFloorSize(env.floor.sizeIn);
    const photo = env.backdrop.photo?.url || null;
    this.floor.visible = env.floor.visible && !photo;
    this.shadowCatcher.visible = !!photo || !env.floor.visible;
    this.applyLighting(env.lighting.preset, env.lighting.intensity, env.lighting.shadows);
    this.setBackdrop({ color: env.backdrop.color, photoUrl: photo });
  }

  /** Update per-frame uniforms. */
  update(camera: THREE.Camera): void {
    this.grid.material.uniforms.uCamPos.value.copy(camera.position);
  }

  /* ───────── backdrop (DOM) ───────── */

  setBackdrop(opts: { color?: string; photoUrl?: string | null }): void {
    if (opts.photoUrl !== undefined) this.photoUrl = opts.photoUrl;
    this.paintBackdrop(opts.color ?? null);
  }

  private paintBackdrop(color: string | null): void {
    const el = this.backdropEl;
    if (this.photoUrl) {
      el.style.background = `${color ? color + ' ' : ''}url("${this.photoUrl}") center / cover no-repeat`;
    } else if (color && color !== 'auto') {
      el.style.background = `radial-gradient(ellipse at 50% 65%, ${this.theme.backdropTop} 0%, ${color} 70%)`;
    } else {
      el.style.background = `radial-gradient(ellipse at 50% 65%, ${this.theme.backdropTop} 0%, ${this.theme.backdropBottom} 70%)`;
    }
  }

  get hasPhoto(): boolean { return !!this.photoUrl; }
  get photo(): string | null { return this.photoUrl; }

  dispose(): void {
    this.grid.geometry.dispose(); this.grid.material.dispose();
    this.floor.geometry.dispose(); this.floor.material.dispose();
    this.shadowCatcher.geometry.dispose(); this.shadowCatcher.material.dispose();
  }
}
