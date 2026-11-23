/**
 * The exported viewer page's script: a read-only walk round the showroom as it stood at export.
 *
 * Bundled on its own (three inside, no app code) by the `viewer-runtime` Vite plugin and carried in
 * the page as base64, so the page opens from disk with nothing to fetch. It reads the model from
 * `#viewer-glb` (base64 GLB) and the room from `#viewer-config` (JSON, `ViewerConfig`).
 *
 * Orbit by default; Walk stands at eye height (WASD + mouse-look under pointer lock on a desktop,
 * a thumb stick and drag-to-look on a touch screen). Nothing in the page can change the model.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ViewerConfig } from './config';
import { fitPose, VIEWER_EYE_HEIGHT_M, type V3, type ViewerPreset } from './presets';

/** God Mode's PIN. It sits in plain text in a file that gets emailed: the panel shows nothing private. */
const PIN = '3028';
const WALK_SPEED = 1.4; // m/s, a stroll
const RUN = 3;
const LOOK = 0.0022; // rad per pixel of mouse
const TOUCH_LOOK = 0.005;

const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CSS = `
:root{--bg:#0b0f14;--panel:rgba(14,19,26,.86);--line:rgba(255,255,255,.12);--fg:#e8edf3;--muted:#9aa7b5;--accent:#4a8ee0}
@media (prefers-color-scheme: light){:root{--panel:rgba(255,255,255,.9);--line:rgba(0,0,0,.12);--fg:#18202a;--muted:#5b6675}}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#v-canvas{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
.v-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:center;width:max-content;max-width:calc(100vw - 32px);padding:6px;background:var(--panel);border:1px solid var(--line);border-radius:10px;backdrop-filter:blur(8px)}
.v-bar button,.v-top button{appearance:none;border:1px solid transparent;background:transparent;color:var(--fg);font:inherit;padding:6px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}
.v-top button{background:var(--panel);border-color:var(--line)}
.v-bar button:hover,.v-top button:hover{border-color:var(--line)}
.v-bar button[aria-pressed=true]{background:var(--accent);color:#fff}
.v-sep{width:1px;align-self:stretch;background:var(--line);margin:0 2px}
.v-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px}
.v-top{position:fixed;left:16px;right:16px;top:12px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;pointer-events:none}
.v-top>*{pointer-events:auto}
.v-title{padding:6px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-title small{color:var(--muted);margin-left:8px}
.v-hint{position:fixed;left:50%;top:56px;transform:translateX(-50%);padding:6px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;color:var(--muted);width:max-content;max-width:calc(100vw - 32px);text-align:center;pointer-events:none}
.v-msg{position:fixed;inset:0;display:grid;place-items:center;color:var(--muted);padding:16px;text-align:center}
.v-stick{position:fixed;left:24px;bottom:110px;width:120px;height:120px;border-radius:50%;border:1px solid var(--line);background:var(--panel);touch-action:none;display:none}
.v-stick i{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;background:var(--accent);opacity:.85}
.v-god{position:fixed;right:16px;top:56px;width:min(320px,calc(100vw - 32px));max-height:calc(100vh - 150px);overflow:auto;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;font:11px/1.5 ui-monospace,Consolas,monospace;display:none}
.v-god div{display:flex;justify-content:space-between;gap:12px}.v-god span{color:var(--muted)}.v-god b{font-weight:500;text-align:right}
.v-pin{position:fixed;right:16px;top:56px;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:8px;display:none;gap:6px}
.v-pin input{width:90px;font:inherit;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg)}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function main(): void {
  const cfgEl = byId('viewer-config'), glbEl = byId('viewer-glb');
  const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
  const msg = el('div', { class: 'v-msg' }, 'Loading the showroom…');
  document.body.appendChild(msg);
  if (!cfgEl || !glbEl) { msg.textContent = 'This file is missing its model.'; return; }
  const cfg = JSON.parse(cfgEl.textContent || '{}') as ViewerConfig;
  if (cfg.backdrop) document.body.style.background = cfg.backdrop;

  /* ───────── renderer, room ───────── */
  const canvas = el('canvas', { id: 'v-canvas', tabindex: '0' });
  document.body.prepend(canvas);
  let gl: THREE.WebGLRenderer;
  try {
    gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    msg.textContent = 'This browser cannot show 3D (WebGL is off or unavailable).';
    return;
  }
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.NoToneMapping; // as the app: LED content shows at its own colours
  gl.shadowMap.enabled = cfg.shadows;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;
  gl.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const bounds = new THREE.Box3(new THREE.Vector3(...cfg.bounds.min), new THREE.Vector3(...cfg.bounds.max));
  const mid = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(3, bounds.getSize(new THREE.Vector3()).length() * 0.6);

  for (const l of cfg.lights) {
    if (l.kind === 'hemi') scene.add(new THREE.HemisphereLight(l.color, l.ground ?? '#000000', l.intensity));
    else if (l.kind === 'ambient') scene.add(new THREE.AmbientLight(l.color, l.intensity));
    else {
      const d = new THREE.DirectionalLight(l.color, l.intensity);
      const dir = new THREE.Vector3(...(l.dir ?? [0, 1, 0])).normalize();
      d.position.copy(mid).addScaledVector(dir, radius * 2.5);
      d.target.position.copy(mid);
      if (l.key && cfg.shadows) {
        d.castShadow = true;
        d.shadow.mapSize.set(2048, 2048);
        const c = d.shadow.camera;
        c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius; c.near = 0.05; c.far = radius * 6;
        c.updateProjectionMatrix();
        d.shadow.bias = -0.0004; d.shadow.normalBias = 0.015; d.shadow.radius = 4;
      }
      scene.add(d, d.target);
    }
  }
  const floorSize = Math.max(3, cfg.floor.sizeM);
  if (cfg.floor.visible) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: cfg.floor.color, roughness: 0.92, metalness: 0.02 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.05 * 0.0254; floor.receiveShadow = true;
    scene.add(floor);
  } else if (cfg.floor.shadowCatcher && cfg.shadows) {
    const c = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize), new THREE.ShadowMaterial({ opacity: 0.35, transparent: true }));
    c.rotation.x = -Math.PI / 2; c.position.y = -0.04 * 0.0254; c.receiveShadow = true;
    scene.add(c);
  }

  const camera = new THREE.PerspectiveCamera(cfg.fovDeg || 40, 1, 0.02, 2000);
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.12;
  orbit.maxPolarAngle = Math.PI * 0.495; // stay above the floor
  orbit.minDistance = 0.3;
  orbit.maxDistance = Math.max(30, radius * 8);

  /* ───────── UI ───────── */
  const top = el('div', { class: 'v-top' });
  const title = el('div', { class: 'v-title', title: cfg.title }, cfg.title || 'Showroom');
  title.appendChild(el('small', {}, 'view only'));
  const godBtn = el('button', { title: 'Diagnostics (PIN)', 'aria-label': 'Diagnostics' }, '⋯');
  top.append(title, godBtn);
  const bar = el('div', { class: 'v-bar', role: 'toolbar', 'aria-label': 'View' });
  const seg = el('div', { class: 'v-seg' });
  const orbitBtn = el('button', { 'aria-pressed': 'true', title: 'Drag to turn round, scroll or pinch to zoom, right-drag to pan' }, 'Orbit');
  const walkBtn = el('button', { 'aria-pressed': 'false', title: 'Walk the floor at eye height (F)' }, 'Walk');
  seg.append(orbitBtn, walkBtn);
  bar.append(seg, el('span', { class: 'v-sep' }));
  for (const p of cfg.presets) {
    const b = el('button', { title: `Look at ${p.label}`, 'data-preset': p.id }, p.label);
    b.onclick = () => goTo(p);
    bar.appendChild(b);
  }
  bar.appendChild(el('span', { class: 'v-sep' }));
  const resetBtn = el('button', { title: 'Back to where the page opened' }, 'Reset');
  bar.appendChild(resetBtn);
  const hint = el('div', { class: 'v-hint' });
  hint.style.display = 'none';
  const stick = el('div', { class: 'v-stick', 'aria-hidden': 'true' });
  const knob = el('i'); stick.appendChild(knob);
  const god = el('div', { class: 'v-god', 'aria-live': 'off' });
  const pinBox = el('div', { class: 'v-pin' });
  const pinIn = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'PIN', 'aria-label': 'PIN', autocomplete: 'off' });
  pinBox.appendChild(pinIn);
  document.body.append(top, bar, hint, stick, god, pinBox);

  /* ───────── camera moves ───────── */
  type Mode = 'orbit' | 'walk';
  let mode: Mode = 'orbit';
  let tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
  const v3 = (a: V3): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]);
  function moveTo(position: V3, target: V3, animate = true): void {
    if (!animate) { camera.position.copy(v3(position)); orbit.target.copy(v3(target)); orbit.update(); tween = null; return; }
    tween = { from: [camera.position.clone(), orbit.target.clone()], to: [v3(position), v3(target)], t0: performance.now() };
  }
  function goTo(p: ViewerPreset): void {
    if (mode === 'walk') setMode('orbit');
    const pose = fitPose(p, camera.fov, camera.aspect);
    moveTo(pose.position, pose.target);
  }
  resetBtn.onclick = () => { if (mode === 'walk') setMode('orbit'); moveTo(cfg.start.position, cfg.start.target); };

  /* ───────── walk ───────── */
  let yaw = 0, pitch = 0;
  const keys = new Set<string>();
  const stickV = { x: 0, y: 0 };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  // The walker keeps within a few metres of the build.
  const walkMin = bounds.min.clone().subScalar(6), walkMax = bounds.max.clone().addScalar(6);

  function setMode(m: Mode): void {
    if (m === mode) return;
    mode = m;
    orbitBtn.setAttribute('aria-pressed', String(m === 'orbit'));
    walkBtn.setAttribute('aria-pressed', String(m === 'walk'));
    tween = null;
    if (m === 'walk') {
      orbit.enabled = false;
      const f = new THREE.Vector3().subVectors(orbit.target, camera.position);
      yaw = Math.atan2(-f.x, -f.z);
      pitch = 0;
      camera.position.y = VIEWER_EYE_HEIGHT_M;
      stick.style.display = coarse ? 'block' : 'none';
      hint.textContent = coarse
        ? 'Left stick to walk, drag anywhere to look round.'
        : 'Click the view to look with the mouse. W A S D or arrows to walk, Shift to hurry, Esc to free the mouse.';
      hint.style.display = 'block';
      window.setTimeout(() => { if (mode === 'walk') hint.style.display = 'none'; }, 6000);
    } else {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      stick.style.display = 'none';
      hint.style.display = 'none';
      // Orbit round what the walker was looking at, as far off as the room's middle.
      const f = new THREE.Vector3(); camera.getWorldDirection(f);
      const d = Math.max(1, camera.position.distanceTo(mid));
      orbit.target.copy(camera.position).addScaledVector(f, d);
      if (orbit.target.y < 0) orbit.target.y = 0;
      orbit.enabled = true;
      orbit.update();
    }
  }
  orbitBtn.onclick = () => setMode('orbit');
  walkBtn.onclick = () => setMode('walk');

  canvas.addEventListener('click', () => {
    if (mode === 'walk' && !coarse && document.pointerLockElement !== canvas) {
      try { const r = canvas.requestPointerLock() as unknown; if (r instanceof Promise) r.catch(() => {}); } catch { /* drag still looks */ }
    }
  });
  const look = (dx: number, dy: number, k: number): void => {
    yaw -= dx * k;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * k));
  };
  document.addEventListener('mousemove', e => {
    if (mode === 'walk' && document.pointerLockElement === canvas) look(e.movementX, e.movementY, LOOK);
  });
  // Drag-to-look where pointer lock is off (touch, or a browser that refuses the lock).
  let drag: { id: number; x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', e => {
    if (mode !== 'walk' || document.pointerLockElement === canvas) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    look(e.clientX - drag.x, e.clientY - drag.y, e.pointerType === 'touch' ? TOUCH_LOOK : LOOK);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const endDrag = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  let stickId: number | null = null;
  const stickAt = (e: PointerEvent): void => {
    const r = stick.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    stickV.x = x; stickV.y = y;
    knob.style.transform = `translate(${x * 36}px, ${y * 36}px)`;
  };
  stick.addEventListener('pointerdown', e => { stickId = e.pointerId; try { stick.setPointerCapture(e.pointerId); } catch { /* ok */ } stickAt(e); });
  stick.addEventListener('pointermove', e => { if (e.pointerId === stickId) stickAt(e); });
  const stickEnd = (e: PointerEvent): void => {
    if (e.pointerId !== stickId) return;
    stickId = null; stickV.x = 0; stickV.y = 0; knob.style.transform = '';
  };
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);

  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement) return;
    keys.add(e.code);
    if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) setMode(mode === 'walk' ? 'orbit' : 'walk');
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  function walkStep(dt: number): void {
    let fwd = 0, side = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) side -= 1;
    fwd -= stickV.y; side += stickV.x;
    const l = Math.hypot(fwd, side);
    if (l > 1) { fwd /= l; side /= l; }
    const speed = WALK_SPEED * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : 1) * dt;
    // Facing (yaw 0 looks down -z): forward (-sin, -cos), right (cos, -sin).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    camera.position.x += (fx * fwd - fz * side) * speed;
    camera.position.z += (fz * fwd + fx * side) * speed;
    camera.position.x = Math.max(walkMin.x, Math.min(walkMax.x, camera.position.x));
    camera.position.z = Math.max(walkMin.z, Math.min(walkMax.z, camera.position.z));
    camera.position.y = VIEWER_EYE_HEIGHT_M;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  /* ───────── God Mode ───────── */
  let godOn = false;
  godBtn.onclick = () => {
    if (godOn) { godOn = false; god.style.display = 'none'; return; }
    const open = pinBox.style.display !== 'flex';
    pinBox.style.display = open ? 'flex' : 'none';
    if (open) { pinIn.value = ''; pinIn.focus(); }
  };
  pinIn.addEventListener('input', () => {
    if (pinIn.value === PIN) { godOn = true; pinBox.style.display = 'none'; god.style.display = 'block'; pinIn.value = ''; paintGod(); }
  });
  pinIn.addEventListener('keydown', e => { if (e.key === 'Escape') pinBox.style.display = 'none'; });
  let meshes = 0, frames = 0, fps = 0, fpsT = performance.now(), loadMs = 0;
  const f3 = (v: THREE.Vector3): string => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
  const kb = (n: number): string => `${Math.round(n / 1024).toLocaleString()} KB`;
  function paintGod(): void {
    const info = gl.info;
    const rows: [string, string][] = [
      ['fps', String(fps)],
      ['mode', mode],
      ['draw calls', String(info.render.calls)],
      ['triangles', info.render.triangles.toLocaleString()],
      ['geometries / textures', `${info.memory.geometries} / ${info.memory.textures}`],
      ['meshes', String(meshes)],
      ['camera (m)', f3(camera.position)],
      ['target (m)', mode === 'orbit' ? f3(orbit.target) : '-'],
      ['yaw / pitch (deg)', mode === 'walk' ? `${(yaw * 180 / Math.PI).toFixed(1)} / ${(pitch * 180 / Math.PI).toFixed(1)}` : '-'],
      ['fov / aspect', `${camera.fov.toFixed(1)} / ${camera.aspect.toFixed(3)}`],
      ['pixel ratio', String(gl.getPixelRatio())],
      ['shadows', String(cfg.shadows)],
      ['bounds min (m)', cfg.bounds.min.map(n => n.toFixed(2)).join(', ')],
      ['bounds max (m)', cfg.bounds.max.map(n => n.toFixed(2)).join(', ')],
      ['presets', cfg.presets.map(p => p.id).join(' ')],
      ['GLB', kb(cfg.glbBytes)],
      ['load ms', String(loadMs)],
      ['exported', cfg.exportedAt],
      ['app / three', `${cfg.appVersion} / r${THREE.REVISION}`],
    ];
    god.replaceChildren(...rows.map(([k, v]) => { const d = el('div'); d.append(el('span', {}, k), el('b', {}, v)); return d; }));
  }

  /* ───────── loop ───────── */
  function resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    gl.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();
  moveTo(cfg.start.position, cfg.start.target, false);

  let last = performance.now();
  let godT = 0;
  function frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, now - last) / 1000); last = now;
    if (tween) {
      const k = Math.min(1, (now - tween.t0) / 650), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camera.position.lerpVectors(tween.from[0], tween.to[0], e);
      orbit.target.lerpVectors(tween.from[1], tween.to[1], e);
      if (k >= 1) tween = null;
    }
    if (mode === 'walk') walkStep(dt); else orbit.update();
    gl.render(scene, camera);
    frames++;
    if (now - fpsT >= 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
    if (godOn && now - godT > 250) { godT = now; paintGod(); }
    requestAnimationFrame(frame);
  }

  const t0 = performance.now();
  const bytes = decodeBase64(glbEl.textContent || '');
  new GLTFLoader().parse(bytes.buffer as ArrayBuffer, '', gltf => {
    gltf.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { meshes++; m.castShadow = cfg.shadows; m.receiveShadow = cfg.shadows; }
    });
    scene.add(gltf.scene);
    loadMs = Math.round(performance.now() - t0);
    msg.remove();
    requestAnimationFrame(frame);
  }, err => {
    msg.textContent = `The model would not load: ${(err as unknown as { message?: string })?.message ?? String(err)}`;
  });
}

main();
