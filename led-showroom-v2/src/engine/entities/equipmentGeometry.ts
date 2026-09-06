/**
 * Parametric, to-scale low-poly models for every `EquipmentGeometry`.
 *
 * Pure builder (no render context, no React): `buildEquipment(entity)` returns a local-space
 * group whose origin is the bottom centre (the item stands on y = 0), whose front faces +Z and
 * whose overall size follows `entity.dims` = [width, height, depth] in inches.
 *
 * Materials are created per build (one body / accent / glass / metal / dark set shared by all
 * meshes of that build) and every mesh is flagged `userData.sharedMaterial` so `disposeObject()`
 * skips them; the owner disposes them with `disposeEquipmentBuild()`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EquipmentEntity, EquipmentGeometry } from '../document/types';

export interface EquipmentBuild {
  group: THREE.Group;
  /** Every mesh (all pickable; all cast + receive shadows except the unlit screen plane). */
  meshes: THREE.Mesh[];
  /** Unlit content plane for screen-bearing items (kiosk / totem / screen). Owns a MeshBasicMaterial. */
  screen?: THREE.Mesh;
  /** Materials owned by this build (disposed with it). */
  materials: THREE.Material[];
}

/* ───────────────────────────── materials ───────────────────────────── */

/** Near-black glossy glass for dark screens. */
export const SCREEN_GLASS = { color: 0x08080a, metalness: 0.1, roughness: 0.15 } as const;

interface Palette {
  body: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  all: THREE.Material[];
}

/**
 * Parse a document colour with a fallback. `Color.set()` does not throw for an unknown style
 * string (it only warns and leaves the colour untouched), so the colour is initialised with the
 * fallback first and only overwritten when parsing succeeds.
 */
export function colorOf(value: unknown, fallback: string): THREE.Color {
  const c = new THREE.Color(fallback);
  if (typeof value === 'string' && value.trim()) {
    try { c.set(value); } catch { c.set(fallback); }
  }
  return c;
}

/** Secondary colour when the entity has no explicit accent: a lighter/darker shade of the body. */
export function derivedAccent(body: THREE.Color): THREE.Color {
  const hsl = body.getHSL({ h: 0, s: 0, l: 0 });
  return body.clone().offsetHSL(0, 0, hsl.l > 0.5 ? -0.16 : 0.14);
}

function makePalette(entity: EquipmentEntity): Palette {
  const body = colorOf(entity.color, '#6b6f78');
  const accent = entity.accent ? colorOf(entity.accent, '#28ace3') : derivedAccent(body);
  const mk = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  const p = {
    body: mk({ color: body, roughness: 0.55, metalness: 0.08 }),
    accent: mk({ color: accent, roughness: 0.4, metalness: 0.15 }),
    glass: mk({ ...SCREEN_GLASS }),
    metal: mk({ color: 0xb7bac0, roughness: 0.35, metalness: 0.85 }),
    dark: mk({ color: 0x1a1a1d, roughness: 0.6, metalness: 0.2 }),
  };
  return { ...p, all: [p.body, p.accent, p.glass, p.metal, p.dark] };
}

/* ───────────────────────────── primitives ───────────────────────────── */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** One tube of a merged tube batch (see `Parts.tubes`). */
interface TubeSeg { a: THREE.Vector3; b: THREE.Vector3; r: number; segments?: number }

/** Cylinder geometry spanning `a` → `b` with the placement baked into the vertices. */
function tubeGeometry(a: THREE.Vector3, b: THREE.Vector3, r: number, segments: number): THREE.CylinderGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, Math.max(len, 0.01), segments);
  const dir = len > 1e-6 ? b.clone().sub(a).normalize() : UP.clone();
  const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, dir), ONE);
  g.applyMatrix4(m);
  return g;
}

class Parts {
  readonly group = new THREE.Group();
  readonly meshes: THREE.Mesh[] = [];
  constructor(readonly pal: Palette) {}

  private add(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.sharedMaterial = true;
    this.group.add(m);
    this.meshes.push(m);
    return m;
  }

  /** Axis-aligned box; `y` is the bottom face unless `centred`. */
  box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, centred = false): THREE.Mesh {
    return this.add(new THREE.BoxGeometry(Math.max(w, 0.01), Math.max(h, 0.01), Math.max(d, 0.01)), mat, x, centred ? y : y + h / 2, z);
  }

  /** Vertical cylinder standing on `y`. */
  cyl(rTop: number, rBot: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, segments = 32): THREE.Mesh {
    return this.add(new THREE.CylinderGeometry(Math.max(rTop, 0.01), Math.max(rBot, 0.01), Math.max(h, 0.01), segments), mat, x, y + h / 2, z);
  }

  /** Cylinder tube between two points (any orientation). */
  tube(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, segments = 10): THREE.Mesh {
    return this.add(tubeGeometry(a, b, r, segments), mat, 0, 0, 0);
  }

  /**
   * Many tubes of one material baked into a SINGLE mesh (one geometry, one draw call, one
   * selection outline). Used for trusses, which would otherwise be 40-60 meshes per stick.
   */
  tubes(segs: TubeSeg[], mat: THREE.Material): THREE.Mesh {
    const parts = segs.map(s => tubeGeometry(s.a, s.b, s.r, s.segments ?? 8));
    const merged: THREE.BufferGeometry = (parts.length ? mergeGeometries(parts) : null) ?? new THREE.BufferGeometry();
    for (const g of parts) g.dispose();
    return this.add(merged, mat, 0, 0, 0);
  }

  /**
   * Prism extruded along X from a side profile given in the (z, y) plane; `width` centred on x = 0.
   * The profile must be a simple polygon (any winding).
   */
  prismX(profile: [z: number, y: number][], width: number, mat: THREE.Material): THREE.Mesh {
    const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(width, 0.01), bevelEnabled: false });
    // shape-x → world z, shape-y → world y, extrusion (shape-z ∈ [0, width]) → world x, then centre on x = 0
    geo.rotateY(-Math.PI / 2).translate(width / 2, 0, 0);
    geo.computeVertexNormals();
    return this.add(geo, mat, 0, 0, 0);
  }

  sphere(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, widthSeg = 20, heightSeg = 14): THREE.Mesh {
    return this.add(new THREE.SphereGeometry(Math.max(r, 0.01), widthSeg, heightSeg), mat, x, y, z);
  }

  /** Vertical capsule of total height `h`, centred at `y`. */
  capsule(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const rr = Math.max(0.01, Math.min(r, h / 2));
    return this.add(new THREE.CapsuleGeometry(rr, Math.max(h - 2 * rr, 0), 6, 16), mat, x, y, z);
  }

  /** Unlit content plane facing +Z, centred at (x, y, z). Hidden until content is mapped. */
  screenPlane(w: number, h: number, x: number, y: number, z: number): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const m = this.add(new THREE.PlaneGeometry(Math.max(w, 0.01), Math.max(h, 0.01)), mat, x, y, z);
    m.userData.sharedMaterial = false; // owned by the build, disposed with it
    m.userData.screen = true;
    m.castShadow = false;
    m.visible = false;
    return m;
  }
}

/* ───────────────────────────── builders ───────────────────────────── */

/** Builds into `p` and optionally returns the screen plane. */
type Builder = (p: Parts, w: number, h: number, d: number) => THREE.Mesh | void;

const buildBox: Builder = (p, w, h, d) => { p.box(w, h, d, p.pal.body); };

const buildCylinder: Builder = (p, w, h, d) => { const r = Math.min(w, d) / 2; p.cyl(r, r, h, p.pal.body, 0, 0, 0, 48); };

const buildKiosk: Builder = (p, w, h, d) => {
  const plinthH = Math.min(2, h * 0.05);
  const headerH = Math.min(8, h * 0.16);
  const bodyH = h - plinthH - headerH;
  p.box(w * 1.06, plinthH, d * 1.06, p.pal.dark);
  p.box(w, bodyH, d, p.pal.body, 0, plinthH);
  p.box(w, headerH, d * 0.9, p.pal.accent, 0, plinthH + bodyH, -d * 0.05);
  // screen recess on the upper front of the body (a thin dark bezel proud of the face)
  const sw = w * 0.72, sh = Math.min(bodyH * 0.42, sw * 1.4);
  const sy = plinthH + bodyH * 0.62;
  p.box(sw + 1, sh + 1, 0.6, p.pal.glass, 0, sy - (sh + 1) / 2, d / 2 - 0.2);
  return p.screenPlane(sw, sh, 0, sy, d / 2 + 0.16);
};

const buildTotem: Builder = (p, w, h, d) => {
  const baseH = Math.min(1.5, h * 0.03);
  const bodyD = Math.max(2, d * 0.28);
  const bodyZ = -(d - bodyD) / 2 + d * 0.15;
  p.box(w * 1.1, baseH, d, p.pal.dark);                                  // heavy base plate
  p.box(w, h - baseH, bodyD, p.pal.body, 0, baseH, bodyZ);
  const frontZ = bodyZ + bodyD / 2;
  const sw = w * 0.86, sh = (h - baseH) * 0.8, sy = baseH + (h - baseH) * 0.55;
  p.box(sw + 1.2, sh + 1.2, 0.5, p.pal.glass, 0, sy - (sh + 1.2) / 2, frontZ + 0.1);
  return p.screenPlane(sw, sh, 0, sy, frontZ + 0.42);
};

/**
 * Box truss along X (length `len`), section `sh` × `sd`, section centre at y = `cy`, z = 0.
 * All chords and braces are merged into ONE mesh (see `Parts.tubes`).
 */
function trussAlong(p: Parts, len: number, sh: number, sd: number, mat: THREE.Material, cy: number): THREE.Mesh {
  const r = Math.min(0.6, sh * 0.06), br = r * 0.55;
  const hx = len / 2, hy = sh / 2 - r, hz = sd / 2 - r;
  const segs: TubeSeg[] = [];
  const seg = (a: THREE.Vector3, b: THREE.Vector3, rr: number, segments: number) => segs.push({ a, b, r: rr, segments });
  for (const y of [cy - hy, cy + hy]) for (const z of [-hz, hz]) seg(V(-hx, y, z), V(hx, y, z), r, 12);   // chords
  for (const x of [-(hx - br), hx - br]) {                                                                  // end frames (flush with the chord ends)
    seg(V(x, cy - hy, -hz), V(x, cy + hy, -hz), br, 8);
    seg(V(x, cy - hy, hz), V(x, cy + hy, hz), br, 8);
    seg(V(x, cy - hy, -hz), V(x, cy - hy, hz), br, 8);
    seg(V(x, cy + hy, -hz), V(x, cy + hy, hz), br, 8);
  }
  const n = Math.max(1, Math.round(len / Math.max(sh, 12)));                                               // zig-zag braces
  const step = len / n;
  for (let i = 0; i < n; i++) {
    // outer brace ends are pulled in by the tube radius so no end cap pokes past the stick length
    const xa = Math.max(-hx + i * step, -(hx - br)), xb = Math.min(-hx + (i + 1) * step, hx - br), f = i % 2 === 0;
    seg(V(xa, cy + hy, f ? -hz : hz), V(xb, cy + hy, f ? hz : -hz), br, 8);   // top
    seg(V(xa, cy - hy, f ? hz : -hz), V(xb, cy - hy, f ? -hz : hz), br, 8);   // bottom
    seg(V(xa, f ? cy - hy : cy + hy, hz), V(xb, f ? cy + hy : cy - hy, hz), br, 8);   // front
    seg(V(xa, f ? cy + hy : cy - hy, -hz), V(xb, f ? cy - hy : cy + hy, -hz), br, 8); // back
  }
  const m = p.tubes(segs, mat);
  m.name = 'truss';
  return m;
}

const buildTruss: Builder = (p, w, h, d) => { trussAlong(p, w, h, d, p.pal.metal, h / 2); };

const buildTrussUpright: Builder = (p, w, h, d) => {
  const plateH = 0.5;
  const plate = Math.max(w, d) * 2;
  p.box(plate, plateH, plate, p.pal.dark);
  // build a horizontal truss centred on the origin, then stand it up (+X → +Y)
  const len = h - plateH;
  const truss = trussAlong(p, len, w, d, p.pal.metal, 0);
  truss.rotation.z = Math.PI / 2;
  truss.position.set(0, plateH + len / 2, 0);
};

/** Stylised human, proportions of a 69" figure scaled to `h`. Faces +Z. */
const buildFigure: Builder = (p, w, h, d) => {
  const s = h / 69;
  const m = p.pal.body;
  const headR = 4.5 * s;
  const legH = 33 * s, legR = Math.min(2.6 * s, w * 0.12);
  const torsoH = 24 * s, torsoR = Math.min(6.2 * s, w * 0.31, d * 0.5);
  const armH = 26 * s, armR = Math.min(1.8 * s, w * 0.09);
  const hip = 4 * s;
  const footD = Math.min(d, 9 * s);
  for (const sx of [-1, 1]) {
    p.capsule(legR, legH + legR, m, sx * hip, (legH + legR) / 2, 0);
    p.box(legR * 2, 1.2 * s, footD, m, sx * hip, 0, footD * 0.15);
  }
  p.capsule(torsoR, torsoH, m, 0, legH - s + torsoH / 2, 0);                  // 32 … 56
  const shoulderY = legH - s + torsoH - 2 * s;                                 // 54
  const armX = Math.min(torsoR + armR + 0.4 * s, w / 2 - armR);
  for (const sx of [-1, 1]) p.capsule(armR, armH, m, sx * armX, shoulderY - armH / 2 + armR, 0.5 * s);
  p.cyl(1.6 * s, 2.2 * s, 5 * s, m, 0, shoulderY + 1.5 * s, 0, 16);           // neck 55.5 … 60.5
  p.sphere(headR, m, 0, h - headR, 0.3 * s);                                   // head top at h
};

const buildTableRound: Builder = (p, w, h, d) => {
  const r = Math.min(w, d) / 2;
  const topT = Math.min(1.5, h * 0.05);
  const baseH = Math.min(1.2, h * 0.04);
  p.cyl(r * 0.62, r * 0.68, baseH, p.pal.dark, 0, 0, 0, 40);
  p.cyl(r * 0.09, r * 0.14, h - topT - baseH, p.pal.metal, 0, baseH, 0, 24);
  p.cyl(r, r, topT, p.pal.body, 0, h - topT, 0, 48);
};

const buildTableRect: Builder = (p, w, h, d) => {
  const topT = Math.min(1.5, h * 0.05);
  const leg = Math.min(1.6, w * 0.05, d * 0.05);
  const inset = leg * 1.5;
  const apronH = Math.min(3, h * 0.1);
  p.box(w, topT, d, p.pal.body, 0, h - topT);
  p.box(w - inset * 2, apronH, d - inset * 2, p.pal.dark, 0, h - topT - apronH);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.box(leg, h - topT, leg, p.pal.metal, sx * (w / 2 - inset), 0, sz * (d / 2 - inset));
};

const buildChair: Builder = (p, w, h, d) => {
  const seatY = Math.min(18, h * 0.53);
  const seatT = Math.min(2, seatY * 0.12);
  const leg = Math.min(1, w * 0.06);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.box(leg, seatY - seatT, leg, p.pal.metal, sx * (w / 2 - leg), 0, sz * (d / 2 - leg));
  p.box(w, seatT, d, p.pal.body, 0, seatY - seatT);
  for (const sx of [-1, 1]) p.box(leg, h - seatY, leg, p.pal.metal, sx * (w / 2 - leg), seatY, -(d / 2 - leg));   // back posts
  const backH = (h - seatY) * 0.62, backT = Math.min(1.2, d * 0.08);
  p.box(w, backH, backT, p.pal.body, 0, h - backH, -(d / 2 - leg));
};

const buildSofa: Builder = (p, w, h, d) => {
  const legH = Math.min(2.5, h * 0.08);
  const seatY = Math.min(17, h * 0.55);            // top of the seat cushions
  const armW = Math.min(6, w * 0.12);
  const backD = Math.min(7, d * 0.22);
  const cushT = Math.min(4.5, seatY * 0.3);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.box(1.2, legH, 1.2, p.pal.dark, sx * (w / 2 - armW / 2), 0, sz * (d / 2 - 2));
  p.box(w - armW * 2, seatY - cushT - legH, d - 1, p.pal.body, 0, legH, 0);                          // base frame
  p.box(w, h - legH, backD * 0.5, p.pal.body, 0, legH, -d / 2 + backD * 0.25);                        // back frame
  const armH = seatY + Math.min(7, (h - seatY) * 0.5) - legH;
  for (const sx of [-1, 1]) p.box(armW, armH, d, p.pal.body, sx * (w / 2 - armW / 2), legH, 0);    // arms
  const inner = w - armW * 2;
  const seats = Math.max(1, Math.round(inner / 24));
  const seatW = inner / seats;
  const seatDepth = d - backD - 0.5, seatZ = -d / 2 + backD + seatDepth / 2;
  for (let i = 0; i < seats; i++) {
    const x = -w / 2 + armW + seatW * (i + 0.5);
    p.box(seatW - 0.8, cushT, seatDepth, p.pal.accent, x, seatY - cushT, seatZ);                        // seat cushion
    p.box(seatW - 0.8, h - seatY - 1, backD * 0.6, p.pal.accent, x, seatY, -d / 2 + backD * 0.8);      // back cushion
  }
};

const buildScreen: Builder = (p, w, h, d) => {
  const slabT = Math.min(2.5, d * 0.12);
  const slabH = Math.min(h * 0.64, w * 9 / 16 + 3);
  const slabY = h - slabH;                          // bottom of the slab; top at h
  const legR = Math.min(1.2, w * 0.03);
  const legX = w * 0.28;
  const legZ = -(slabT / 2 + legR * 0.6);
  for (const sx of [-1, 1]) {
    p.box(2.2, 1, d, p.pal.dark, sx * legX, 0, 0);
    p.cyl(legR, legR, slabY + slabH * 0.5 - 1, p.pal.metal, sx * legX, 1, legZ, 16);
  }
  p.tube(V(-legX, slabY * 0.55, legZ), V(legX, slabY * 0.55, legZ), legR * 0.8, p.pal.metal, 12);   // crossbar
  p.box(w, slabH, slabT, p.pal.body, 0, slabY, 0);
  const bez = Math.min(0.6, w * 0.012);
  p.box(w - bez * 2, slabH - bez * 2, 0.3, p.pal.glass, 0, slabY + bez, slabT / 2 + 0.05);
  return p.screenPlane(w - bez * 2, slabH - bez * 2, 0, slabY + slabH / 2, slabT / 2 + 0.3);
};

/**
 * One bay of pipe-and-drape. The uprights sit at the bay ends and each base plate is tucked
 * INSIDE the bay (its outer edge flush with the bay end), so the footprint in X is exactly `w`
 * and adjacent bays tile edge to edge; in Z the plate (≥ 12", ≤ w) may extend beyond `d`.
 */
const buildDrape: Builder = (p, w, h, d) => {
  const poleR = Math.min(0.9, d * 0.15);
  const baseW = Math.min(Math.max(d * 2, 12), w);
  const folds = Math.max(4, Math.round(w / 9));
  const slabW = w / folds;
  const fabricT = Math.max(0.6, d * 0.25);
  for (let i = 0; i < folds; i++) {
    const xc = -w / 2 + slabW * (i + 0.5);
    // slabs overlap their neighbours slightly to hide seams, but never past the bay ends
    const x0 = Math.max(-w / 2, xc - slabW / 2 - 0.075), x1 = Math.min(w / 2, xc + slabW / 2 + 0.075);
    const z = Math.sin(i * Math.PI * 0.85) * (d / 2 - fabricT / 2) * 0.8;     // sinusoidal fold offset
    p.box(x1 - x0, h - poleR * 2.2, fabricT, p.pal.body, (x0 + x1) / 2, 0.05, z);
  }
  for (const sx of [-1, 1]) {
    p.box(baseW, 0.35, baseW, p.pal.dark, sx * (w / 2 - baseW / 2), 0, 0);       // plate inside the bay
    p.cyl(poleR, poleR, h - poleR - 0.35, p.pal.metal, sx * (w / 2 - poleR), 0.35, 0, 16);
  }
  p.tube(V(-w / 2 + poleR, h - poleR, 0), V(w / 2 - poleR, h - poleR, 0), poleR, p.pal.metal, 12);   // crossbar, top at h
};

/** Podium proportions shared with the tests: body top and reading-top thickness at the low edge. */
export function podiumProfile(h: number): { baseH: number; topT: number; bodyTop: number } {
  return { baseH: Math.min(1.5, h * 0.04), topT: Math.min(1.5, h * 0.03), bodyTop: h * 0.86 };
}

const buildPodium: Builder = (p, w, h, d) => {
  const { baseH, topT, bodyTop } = podiumProfile(h);
  p.box(w * 1.05, baseH, d * 1.05, p.pal.dark);
  p.box(w, bodyTop - baseH, d, p.pal.body, 0, baseH);
  // Slanted reading top as a SOLID wedge sitting on the body: high at the audience side (+Z, top
  // at h), sloping down toward the presenter (-Z, top at bodyTop + topT). Profile in (z, y).
  const top = p.prismX([[-d / 2, bodyTop], [d / 2, bodyTop], [d / 2, h], [-d / 2, bodyTop + topT]], w * 1.06, p.pal.accent);
  top.name = 'reading-top';
  p.box(w * 1.06, 1.2, 1, p.pal.accent, 0, bodyTop + topT, -d / 2 + 0.5).name = 'book-stop';   // on the surface at the low edge
};

/**
 * Speaker cabinet on a tripod. `dims` describe the whole item: the tripod feet stay inside the
 * declared w × d footprint (one foot at -Z, two at +Z, symmetric about the Z axis).
 */
const buildSpeaker: Builder = (p, w, h, d) => {
  const cabH = Math.min(h * 0.42, w * 1.7);
  const cabY = h - cabH;
  const poleR = Math.min(0.9, w * 0.06);
  const foot = Math.min(3, Math.min(w, d) * 0.25);
  const spread = Math.max(poleR * 2, Math.min(w, d) / 2 - foot / 2);                // feet inside the footprint
  const legs: TubeSeg[] = [];
  for (const a of [-Math.PI / 2, Math.PI / 6, Math.PI * 5 / 6]) {                    // tripod
    const fx = Math.cos(a) * spread, fz = Math.sin(a) * spread;
    p.box(foot, 0.6, foot, p.pal.dark, fx, 0, fz);
    legs.push({ a: V(fx, 1.2, fz), b: V(0, cabY * 0.45, 0), r: poleR * 0.8, segments: 8 });
  }
  p.tubes(legs, p.pal.dark).name = 'tripod';
  p.cyl(poleR, poleR, cabY + 1, p.pal.metal, 0, 0, 0, 16);
  p.box(w, cabH, d, p.pal.body, 0, cabY);
  const r = Math.min(w, cabH) * 0.34;
  const woofer = p.cyl(r * 0.65, r, 0.5, p.pal.dark, 0, 0, 0, 32);
  woofer.position.set(0, cabY + cabH * 0.4, d / 2 + 0.25); woofer.rotation.x = Math.PI / 2;
  const tweeter = p.cyl(r * 0.22, r * 0.32, 0.4, p.pal.dark, 0, 0, 0, 20);
  tweeter.position.set(0, cabY + cabH * 0.8, d / 2 + 0.2); tweeter.rotation.x = Math.PI / 2;
};

const buildCounter: Builder = (p, w, h, d) => {
  const kickH = Math.min(3, h * 0.08), kickIn = Math.min(2.5, d * 0.12);
  const topT = Math.min(1.5, h * 0.04);
  const bodyH = h - kickH - topT;
  p.box(w - kickIn * 2, kickH, d - kickIn * 2, p.pal.dark);                          // recessed kick
  p.box(w, bodyH, d, p.pal.body, 0, kickH);
  p.box(w + 1.5, topT, d + 1.5, p.pal.body, 0, h - topT, 0.4);                        // overhanging top
  p.box(w * 0.98, Math.min(6, bodyH * 0.22), 0.4, p.pal.accent, 0, kickH + bodyH * 0.62, d / 2 + 0.05);   // accent band
};

const buildPlant: Builder = (p, w, h, d) => {
  const r = Math.min(w, d) / 2;
  const potH = Math.min(h * 0.3, r * 1.4);
  const potR = r * 0.55;
  p.cyl(potR, potR * 0.8, potH, p.pal.accent, 0, 0, 0, 32);
  p.cyl(potR * 0.9, potR * 0.9, Math.max(0.3, potH * 0.06), p.pal.dark, 0, potH - Math.max(0.3, potH * 0.06) - 0.01, 0, 32);   // soil
  const fH = h - potH;
  p.cyl(r * 0.05, r * 0.07, fH * 0.45, p.pal.dark, 0, potH - 0.5, 0, 10);            // trunk
  const seeds: [number, number, number, number][] = [
    [0, 0.68, 0, 0.62], [0.42, 0.42, 0.25, 0.44], [-0.4, 0.5, -0.2, 0.4], [0.15, 0.32, -0.45, 0.36], [-0.2, 0.36, 0.42, 0.34], [0.05, 1, 0.05, 0.32],
  ];
  for (const [sx, sy, sz, sr] of seeds) {
    const rad = Math.min(r * sr, fH * sr * 0.5);
    p.sphere(rad, p.pal.body, sx * (r - rad), Math.min(potH + fH * sy, h - rad), sz * (r - rad), 18, 12);
  }
};

const buildLocker: Builder = (p, w, h, d) => {
  const plinthH = Math.min(2, h * 0.04);
  p.box(w * 0.94, plinthH, d * 0.94, p.pal.dark);
  p.box(w, h - plinthH, d, p.pal.body, 0, plinthH);
  const cols = w >= 30 ? 3 : 2;
  const rows = cols === 3 ? 3 : (h >= 50 ? 4 : 3);
  const count = Math.min(9, Math.max(6, cols * rows));
  const gap = Math.min(0.8, w * 0.025);
  const areaY0 = plinthH + (h - plinthH) * 0.08, areaH = (h - plinthH) * 0.84;
  const cellW = (w - gap * (cols + 1)) / cols, cellH = (areaH - gap * (rows + 1)) / rows;
  let n = 0;
  for (let r = 0; r < rows && n < count; r++) for (let c = 0; c < cols && n < count; c++, n++) {
    const x = -w / 2 + gap + cellW * (c + 0.5) + gap * c;
    const y = areaY0 + areaH - gap - cellH * (r + 1) - gap * r;
    p.box(cellW, cellH, 0.45, p.pal.accent, x, y, d / 2 + 0.05);                                                            // door
    p.box(Math.min(1.2, cellW * 0.12), Math.min(4, cellH * 0.35), 0.5, p.pal.dark, x + cellW * 0.36, y + cellH * 0.35, d / 2 + 0.35);   // handle
  }
};

const BUILDERS: Record<EquipmentGeometry, Builder> = {
  // 'photo' and 'cad' are modelled by EquipmentRenderer (from the product cutout / the shipped CAD
  // mesh); this box is only the fallback for an item that reaches the parametric path without one.
  'photo': buildBox,
  'cad': buildBox,
  'box': buildBox,
  'cylinder': buildCylinder,
  'kiosk': buildKiosk,
  'totem': buildTotem,
  'truss': buildTruss,
  'truss-upright': buildTrussUpright,
  'figure': buildFigure,
  'table-round': buildTableRound,
  'table-rect': buildTableRect,
  'chair': buildChair,
  'sofa': buildSofa,
  'screen': buildScreen,
  'drape': buildDrape,
  'podium': buildPodium,
  'speaker': buildSpeaker,
  'counter': buildCounter,
  'plant': buildPlant,
  'locker': buildLocker,
};

export const EQUIPMENT_GEOMETRIES = Object.keys(BUILDERS) as EquipmentGeometry[];

/** Geometry kinds that carry a content screen. */
export const SCREEN_GEOMETRIES: ReadonlySet<EquipmentGeometry> = new Set<EquipmentGeometry>(['kiosk', 'totem', 'screen']);

/** Clamp document dims to something buildable (positive, finite). */
export function safeDims(dims: EquipmentEntity['dims'] | undefined): [number, number, number] {
  const f = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  return [f(dims?.[0], 24), f(dims?.[1], 24), f(dims?.[2], 24)];
}

/** Key of everything that changes the built geometry / materials. */
export function equipmentBuildKey(entity: EquipmentEntity): string {
  return JSON.stringify([entity.geometry, safeDims(entity.dims), entity.color, entity.accent ?? null]);
}

/**
 * Build the model. Origin = bottom centre, front = +Z, overall height = dims[1]. Never throws
 * for an unknown geometry (falls back to a plain box).
 */
export function buildEquipment(entity: EquipmentEntity): EquipmentBuild {
  const [w, h, d] = safeDims(entity.dims);
  const pal = makePalette(entity);
  const parts = new Parts(pal);
  const builder = BUILDERS[entity.geometry] ?? buildBox;
  const screen = builder(parts, w, h, d) ?? undefined;
  parts.group.name = `equipment-model:${entity.geometry}`;
  const materials: THREE.Material[] = [...pal.all];
  if (screen) materials.push(screen.material as THREE.Material);
  return { group: parts.group, meshes: parts.meshes, screen, materials };
}

/** Dispose everything a build owns (geometries, palette materials, screen material) and detach it. */
export function disposeEquipmentBuild(build: EquipmentBuild): void {
  for (const m of build.meshes) m.geometry.dispose();
  for (const mat of build.materials) mat.dispose();
  build.group.removeFromParent();
}

/**
 * Bounds of a build from its mesh geometry, in the frame of the group's outermost ancestor
 * (world when the group is in a scene, local for a detached build).
 */
export function equipmentBounds(build: EquipmentBuild, out = new THREE.Box3()): THREE.Box3 {
  out.makeEmpty();
  build.group.updateMatrixWorld(true);
  const b = new THREE.Box3();
  for (const m of build.meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
    out.union(b);
  }
  return out;
}
