import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { IPOSTER } from './specs';
import {
  BEZEL_LINE_OFFSET_IN,
  FRONT_EMISSIVE_BASE,
  basePlateGeometry,
  bezelLineGeometry,
  createWallMaterials,
  disposeGeometryCache,
  ghostPanelGeometry,
  miteredPanelGeometry,
  panelGeometry,
  panelMaterialArray,
  setFrontBrightness,
  supportBracketGeometry,
} from './geometry';

const base = IPOSTER.accessories!.base;
const support = IPOSTER.accessories!.support;
/* CAD panel: 25.2 x 18.9 x 1.77 in = 640.08 x 480.06 x 44.958 mm (see specs.ts). */
const W = IPOSTER.widthIn, H = IPOSTER.heightIn, D = IPOSTER.depthIn;

function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}
const size = (g: THREE.BufferGeometry): THREE.Vector3 => bbox(g).getSize(new THREE.Vector3());

afterEach(() => disposeGeometryCache());

describe('panelGeometry', () => {
  it('has the spec dimensions, centred on the origin', () => {
    const g = panelGeometry(IPOSTER);
    // Positions are float32, so 4 decimals (5e-5 in) is the tightest meaningful tolerance here.
    const s = size(g);
    expect(s.x).toBeCloseTo(W, 4);
    expect(s.y).toBeCloseTo(H, 4);
    expect(s.z).toBeCloseTo(D, 4);
    // The inch-authored solid exports as 640.08 x 480.06 x 44.958 mm.
    expect(s.x * 25.4).toBeCloseTo(640.08, 3);
    expect(s.y * 25.4).toBeCloseTo(480.06, 3);
    expect(s.z * 25.4).toBeCloseTo(44.958, 3);
    const b = bbox(g);
    expect(b.max.z).toBeCloseTo(D / 2, 4); // screen face at +panelD/2
    expect(b.min.x).toBeCloseTo(-W / 2, 4);
    expect(g.index!.count).toBe(36);
    expect(g.attributes.position.count).toBe(24);
  });

  it('is cached per spec dims and cleared by disposeGeometryCache', () => {
    const a = panelGeometry(IPOSTER);
    expect(panelGeometry({ ...IPOSTER, id: 'other-same-dims' })).toBe(a);
    expect(panelGeometry({ ...IPOSTER, widthIn: 30 })).not.toBe(a);
    disposeGeometryCache();
    expect(panelGeometry(IPOSTER)).not.toBe(a);
  });
});

describe('miteredPanelGeometry', () => {
  it('has 36 non-indexed vertices, normals and 6 material groups in face order', () => {
    const g = miteredPanelGeometry(IPOSTER, null, null);
    expect(g.index).toBeNull();
    expect(g.attributes.position.count).toBe(36);
    expect(g.attributes.normal.count).toBe(36);
    expect(g.groups).toHaveLength(6);
    g.groups.forEach((grp, i) => {
      expect(grp.start).toBe(i * 6);
      expect(grp.count).toBe(6);
      expect(grp.materialIndex).toBe(i);
    });
    // front-face group (index 4) vertices all lie on z = +hd
    const pos = g.attributes.position;
    for (let v = 24; v < 30; v++) expect(pos.getZ(v)).toBeCloseTo(D / 2, 6);
    for (let v = 30; v < 36; v++) expect(pos.getZ(v)).toBeCloseTo(-D / 2, 6);
  });

  it('matches the plain panel bbox with no cuts', () => {
    const s = size(miteredPanelGeometry(IPOSTER, null, null));
    expect(s.x).toBeCloseTo(W, 4);
    expect(s.y).toBeCloseTo(H, 4);
    expect(s.z).toBeCloseTo(D, 4);
  });

  it('a convex left cut (negative front) grows the bbox on the left only', () => {
    const hw = IPOSTER.widthIn / 2;
    const g = miteredPanelGeometry(IPOSTER, { front: -0.5, back: 0.5 }, null);
    const b = bbox(g);
    expect(b.min.x).toBeCloseTo(-hw - 0.5, 6);
    expect(b.max.x).toBeCloseTo(hw, 6);
    // front-left edge extended, back-left edge trimmed
    const pos = g.attributes.position;
    // FTL is the first vertex of the +Z group (index 24)
    expect(pos.getX(24)).toBeCloseTo(-hw - 0.5, 6);
    // BTL is the last vertex of the -Z group (index 35)
    expect(pos.getX(35)).toBeCloseTo(-hw + 0.5, 6);
  });

  it('a convex right cut grows the bbox on the right only', () => {
    const hw = IPOSTER.widthIn / 2;
    const b = bbox(miteredPanelGeometry(IPOSTER, null, { front: -0.75, back: 0.75 }));
    expect(b.max.x).toBeCloseTo(hw + 0.75, 6);
    expect(b.min.x).toBeCloseTo(-hw, 6);
  });

  it('a concave cut (positive front) shrinks the front edge and extends the back', () => {
    const hw = IPOSTER.widthIn / 2;
    const b = bbox(miteredPanelGeometry(IPOSTER, { front: 0.4, back: -0.4 }, null));
    expect(b.min.x).toBeCloseTo(-hw - 0.4, 6); // back edge extended
    const pos = miteredPanelGeometry(IPOSTER, { front: 0.4, back: -0.4 }, null).attributes.position;
    expect(pos.getX(24)).toBeCloseTo(-hw + 0.4, 6); // FTL trimmed
  });

  it('returns a fresh geometry each call', () => {
    expect(miteredPanelGeometry(IPOSTER, null, null)).not.toBe(miteredPanelGeometry(IPOSTER, null, null));
  });
});

/** x-extent [min, max] of all vertices whose z is within 1e-3 of `z`. */
function xExtentAtZ(g: THREE.BufferGeometry, z: number): [number, number] {
  const pos = g.attributes.position;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i) - z) < 1e-3) {
      min = Math.min(min, pos.getX(i));
      max = Math.max(max, pos.getX(i));
    }
  }
  return [min, max];
}

describe('basePlateGeometry', () => {
  it('lies flat: 25.08 wide x 0.25 thick x 18.78 deep, hanging below the origin (y in [-thick, 0])', () => {
    const g = basePlateGeometry(base);
    const s = size(g);
    expect(s.x).toBeCloseTo(25.08, 4);
    expect(s.y).toBeCloseTo(0.25, 4);
    expect(s.z).toBeCloseTo(18.78, 4);
    const b = bbox(g);
    // Top face on the origin (the panel rests on it); bottom at -thick = bracket ground line.
    expect(b.max.y).toBeCloseTo(0, 6);
    expect(b.min.y).toBeCloseTo(-0.25, 6);
    expect(b.min.x).toBeCloseTo(-12.54, 4);
    expect(b.max.z).toBeCloseTo(9.39, 4);
    expect(b.min.z).toBeCloseTo(-9.39, 4);
  });

  it('is oriented as v1: wide notched edge (14.06) toward +Z, narrow frontW edge (9.06) toward -Z', () => {
    const g = basePlateGeometry(base);
    const [fxMin, fxMax] = xExtentAtZ(g, 9.39);
    expect(fxMin).toBeCloseTo(-7.03, 3);
    expect(fxMax).toBeCloseTo(7.03, 3);
    const [bxMin, bxMax] = xExtentAtZ(g, -9.39);
    expect(bxMin).toBeCloseTo(-4.53, 3);
    expect(bxMax).toBeCloseTo(4.53, 3);
    // Full 25.08 width is reached only on the middle band (inside the notches).
    const [mxMin, mxMax] = xExtentAtZ(g, 9.39 - base.notch);
    expect(mxMin).toBeCloseTo(-12.54, 3);
    expect(mxMax).toBeCloseTo(12.54, 3);
  });

  it('respects a custom thickness (bottom at -thick)', () => {
    const b = bbox(basePlateGeometry({ ...base, thick: 0.5 }));
    expect(b.max.y).toBeCloseTo(0, 6);
    expect(b.min.y).toBeCloseTo(-0.5, 6);
  });

  it('is a 12-vertex dodecagonal outline extruded without bevel', () => {
    const g = basePlateGeometry(base);
    // ExtrudeGeometry is non-indexed: side walls = 12 edges x 2 tris x 3 verts = 72,
    // plus two caps of 10 triangles each (12-gon triangulated) = 60 -> 132.
    expect(g.index).toBeNull();
    expect(g.attributes.position.count).toBe(132);
  });

  it('is cached per spec values', () => {
    expect(basePlateGeometry(base)).toBe(basePlateGeometry({ ...base }));
    expect(basePlateGeometry({ ...base, thick: 0.5 })).not.toBe(basePlateGeometry(base));
  });
});

describe('supportBracketGeometry', () => {
  it('is 2 wide x 21.14 tall x 6.7 deep, foot toward -Z, floor at y = 0', () => {
    const g = supportBracketGeometry(support);
    const s = size(g);
    expect(s.x).toBeCloseTo(2, 4);
    expect(s.y).toBeCloseTo(21.14, 4);
    expect(s.z).toBeCloseTo(6.7, 4);
    const b = bbox(g);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.max.z).toBeCloseTo(0, 6);
    expect(b.min.z).toBeCloseTo(-6.7, 4);
    expect(b.min.x).toBeCloseTo(-1, 6);
  });

  it('includes all three v1 elliptical cutouts (vertex count matches a verbatim v1 build)', () => {
    const withHoles = supportBracketGeometry(support);
    // Verbatim v1 3384-3404 reference build: profile + the three CAD cutouts, no fit filter.
    const ref = new THREE.Shape();
    ref.moveTo(0, 0);
    ref.lineTo(0, 20.14);
    ref.lineTo(1.0, 21.14);
    ref.lineTo(6.7, 0);
    ref.closePath();
    for (const [cx, cy, rx, ry] of [
      [2.8, 4.0, 1.2, 1.8],
      [2.0, 9.5, 0.8, 2.2],
      [1.4, 14.5, 0.35, 1.8],
    ]) {
      const h = new THREE.Path();
      h.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false);
      ref.holes.push(h);
    }
    const refGeom = new THREE.ExtrudeGeometry(ref, { depth: 2.0, bevelEnabled: false });
    expect(refGeom.attributes.position.count).toBe(936); // v1-exact for the iPoster bracket
    expect(withHoles.attributes.position.count).toBe(refGeom.attributes.position.count);
    // Dropping any one hole changes the count, so this pins all three being present.
    const twoHoles = new THREE.Shape().copy(ref);
    twoHoles.holes = ref.holes.slice(0, 2);
    const twoGeom = new THREE.ExtrudeGeometry(twoHoles, { depth: 2.0, bevelEnabled: false });
    expect(twoGeom.attributes.position.count).toBeLessThan(936);
    refGeom.dispose();
    twoGeom.dispose();
  });

  it('skips cutouts that do not fit a tiny custom bracket', () => {
    const tiny = supportBracketGeometry({ ...support, totalH: 3, footD: 2, chamfer: 0.5 });
    expect(tiny.attributes.position.count).toBe(36);
    expect(size(tiny).y).toBeCloseTo(3, 6);
  });
});

describe('bezelLineGeometry', () => {
  it('is a 4-segment rectangle (8 vertices) centred on the origin at z = 0', () => {
    const g = bezelLineGeometry(W, H);
    expect(g.attributes.position.count).toBe(8);
    const b = bbox(g);
    expect(b.min.x).toBeCloseTo(-W / 2, 4);
    expect(b.max.x).toBeCloseTo(W / 2, 4);
    expect(b.min.y).toBeCloseTo(-H / 2, 4);
    expect(b.max.y).toBeCloseTo(H / 2, 4);
    expect(b.min.z).toBe(0);
    expect(b.max.z).toBe(0);
    expect(BEZEL_LINE_OFFSET_IN).toBe(0.03);
  });

  it('respects miter front trims on each side', () => {
    const b = bbox(bezelLineGeometry(10, 4, 0.5, -0.25));
    expect(b.min.x).toBeCloseTo(-4.5, 6);
    expect(b.max.x).toBeCloseTo(5.25, 6);
  });
});

describe('ghostPanelGeometry', () => {
  it('returns a panel-sized box plus its edges, cached', () => {
    const g = ghostPanelGeometry(IPOSTER);
    expect(size(g.box).x).toBeCloseTo(W, 4);
    expect(g.edges).toBeInstanceOf(THREE.EdgesGeometry);
    expect(g.edges.attributes.position.count).toBe(24); // 12 box edges x 2 vertices
    expect(ghostPanelGeometry(IPOSTER)).toBe(g);
  });
});

describe('createWallMaterials / setFrontBrightness', () => {
  it('reproduces the v1 material constants', () => {
    const m = createWallMaterials();
    expect(m.side.color.getHex()).toBe(0xb0b0b8);
    expect(m.side.metalness).toBe(0.6);
    expect(m.side.roughness).toBe(0.35);
    expect(m.front.color.getHex()).toBe(0x2a2a30);
    expect(m.front.emissive.getHex()).toBe(0x101018);
    expect(m.front.emissiveIntensity).toBe(0.5);
    expect(m.front.metalness).toBe(0.2);
    expect(m.front.roughness).toBe(0.3);
    expect(m.back.color.getHex()).toBe(0xa0a0a8);
    expect(m.back.metalness).toBe(0.4);
    expect(m.back.roughness).toBe(0.55);
    expect(m.accessory.color.getHex()).toBe(0x404048);
    expect(m.accessory.metalness).toBe(0.7);
    expect(m.accessory.roughness).toBe(0.28);
    expect(m.bezel.color.getHex()).toBe(0x555560);
    expect(m.ghost.color.getHex()).toBe(0x3b82f6);
    expect(m.ghost.opacity).toBe(0.18);
    expect(m.ghost.transparent).toBe(true);
    expect(m.ghost.depthWrite).toBe(false);
    expect(m.ghostEdge.color.getHex()).toBe(0x93c5fd);
    expect(m.ghostEdge.opacity).toBe(0.6);
    expect(m.stageTop.color.getHex()).toBe(0x1a1a1a);
    expect(m.stageTop.roughness).toBe(0.9);
    expect(m.stageSide.color.getHex()).toBe(0x242428);
    expect(m.stageEdge.color.getHex()).toBe(0x4a4a52);
  });

  it('builds the per-face material array in BoxGeometry face order', () => {
    const m = createWallMaterials();
    const arr = panelMaterialArray(m, m.front);
    expect(arr).toHaveLength(6);
    expect(arr.slice(0, 4).every(x => x === m.side)).toBe(true);
    expect(arr[4]).toBe(m.front);
    expect(arr[5]).toBe(m.back);
  });

  it('sets emissiveIntensity = 0.5 * pct/100 * compensation', () => {
    const m = createWallMaterials();
    setFrontBrightness(m.front, 100);
    expect(m.front.emissiveIntensity).toBeCloseTo(FRONT_EMISSIVE_BASE, 9);
    setFrontBrightness(m.front, 40);
    expect(m.front.emissiveIntensity).toBeCloseTo(0.2, 9);
    setFrontBrightness(m.front, 40, 1.25);
    expect(m.front.emissiveIntensity).toBeCloseTo(0.25, 9);
    setFrontBrightness(m.front, 0);
    expect(m.front.emissiveIntensity).toBe(0);
  });
});
