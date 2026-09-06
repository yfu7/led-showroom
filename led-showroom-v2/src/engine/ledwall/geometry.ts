/**
 * LED-wall three.js geometry and materials.
 *
 * Ported from v1 (index.html):
 *   - shared panel BoxGeometry ............................ v1 3406-3408
 *   - buildMiteredPanelGeom(leftCut, rightCut) ............ v1 3409-3442
 *   - base plate shape / geometry ......................... v1 3362-3381 (constants 2149-2153)
 *   - back support bracket profile / geometry ............. v1 3384-3404 (constants 2156-2160)
 *   - bezel line rectangles ............................... v1 4092-4130
 *   - ghost panel (box + EdgesGeometry, blue translucent) . v1 2643-2650, 2659-2713
 *   - materials table ..................................... v1 3222-3253 (stage: 7205-7207)
 *   - brightness -> front emissive ........................ v1 7601-7611
 *
 * All lengths are inches (world unit). Every geometry here is expressed in the
 * PANEL-local frame: the panel is centred on the origin, +Z is the screen face,
 * +Y is up, +X is the panel's right. Wall-level placement (the v2 floor-origin
 * wall frame, corner folding, etc.) is the caller's job.
 *
 * The two accessories are modelled from the manufacturer's SolidWorks CAD
 * (`public/models/iposter-base.glb`, `…-support-lh/rh.glb`, converted from STEP by
 * `scripts/step-to-glb.cjs`). Because a wall is built synchronously and the CAD
 * arrives over the network, the extrusions below stay as the immediate placeholder
 * and the CAD is swapped into the very same BufferGeometry objects when it lands —
 * see {@link preloadAccessoryGeometry} and {@link onAccessoryGeometry}.
 *
 * This module touches three.js but never the DOM, so it runs in node for tests;
 * there the CAD never loads and the extrusions are what you get.
 */
import * as THREE from 'three';
import { adoptGeometry, cadLoadingAvailable, loadCadGeometry, type CadAnchors } from '../content/cadModels';
import type { AccessorySpec, PanelSpec } from './specs';
import type { MiterCut } from './layout';

/**
 * Re-exported for convenience: {@link MiterCut} is defined in './layout'
 * (`miterCutsForColumn`). `front` applies to the +Z (screen) face edge, `back`
 * to the −Z (cabinet) face edge; positive = trim inward, negative = extend
 * outward (v1 3860-3882).
 */
export type { MiterCut } from './layout';

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/** Base plate parameters (`AccessorySpec['base']`). */
export type BasePlateSpec = AccessorySpec['base'];
/** Support bracket parameters (`AccessorySpec['support']`). */
export type SupportBracketSpec = AccessorySpec['support'];

/** Ghost-panel geometry pair: translucent body + wire outline. */
export interface GhostPanelGeometry {
  /** Solid box (raycast target / translucent fill). */
  box: THREE.BoxGeometry;
  /** Outline edges of the same box. */
  edges: THREE.EdgesGeometry;
}

/** Materials shared by every wall. See {@link createWallMaterials}. */
export interface WallMaterials {
  /** Cabinet sides (±X, ±Y faces). */
  side: THREE.MeshStandardMaterial;
  /** Screen face (+Z). `emissiveIntensity` is driven by {@link setFrontBrightness}. */
  front: THREE.MeshStandardMaterial;
  /** Cabinet back (−Z). */
  back: THREE.MeshStandardMaterial;
  /** Base plates and support brackets. */
  accessory: THREE.MeshStandardMaterial;
  /** Bezel delineation lines drawn just in front of the screen. */
  bezel: THREE.LineBasicMaterial;
  /** Ghost panel body (translucent blue). */
  ghost: THREE.MeshBasicMaterial;
  /** Ghost panel outline. */
  ghostEdge: THREE.LineBasicMaterial;
  /** Stage deck top surface. */
  stageTop: THREE.MeshStandardMaterial;
  /** Stage deck skirt (sides). */
  stageSide: THREE.MeshStandardMaterial;
  /** Stage deck outline. */
  stageEdge: THREE.LineBasicMaterial;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * BoxGeometry / mitered-panel material-group order: +X, −X, +Y, −Y, +Z (front), −Z (back).
 * Use with {@link panelMaterialArray} to build the per-face material list (v1 3226-3227).
 */
export const PANEL_FACE_ORDER = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;

/** Distance in front of the screen face at which bezel lines are drawn (v1 4097). */
export const BEZEL_LINE_OFFSET_IN = 0.03;

/** Base emissive intensity of the screen face at 100 % brightness (v1 3224, 7611). */
export const FRONT_EMISSIVE_BASE = 0.5;

/* ────────────────────────────────────────────────────────────────────────── */
/* Caches                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const panelCache = new Map<string, THREE.BoxGeometry>();
const ghostCache = new Map<string, GhostPanelGeometry>();
const baseCache = new Map<string, THREE.BufferGeometry>();
const supportCache = new Map<string, THREE.BufferGeometry>();

const panelKey = (spec: PanelSpec): string => `${spec.widthIn}x${spec.heightIn}x${spec.depthIn}`;
const baseKey = (s: BasePlateSpec): string => `${s.backW}|${s.frontW}|${s.depth}|${s.thick}|${s.notch}`;
const supportKey = (s: SupportBracketSpec, mirrored: boolean): string =>
  `${s.width}|${s.thick}|${s.totalH}|${s.chamfer}|${s.footD}|${s.inset}${mirrored ? '|m' : ''}`;

/* ────────────────────────────────────────────────────────────────────────── */
/* Accessory CAD                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/** The three accessory parts we have CAD for. `lh` is the left bracket, `rh` its mirror. */
export type AccessoryPart = 'base' | 'support-lh' | 'support-rh';

/**
 * Where each accessory's CAD lives and how it is framed on load. The anchors put the loaded part
 * straight into the frame `accessoryPlacements` (in './layout') already places meshes in, so the
 * renderer's coordinates never change:
 *
 *   - base: x/z centred on the panel, TOP face on y = 0, so the plate hangs the whole `thick`
 *     below the panel bottom the mesh is positioned at;
 *   - supports: x centred on the bracket, feet on y = 0 (the ground line), and the vertical bar's
 *     back face on z = 0 (the panel's back plane), with the foot running to −footD behind it.
 */
export const ACCESSORY_CAD: Record<AccessoryPart, { url: string; anchors: CadAnchors }> = {
  'base': { url: '/models/iposter-base.glb', anchors: { x: 'center', y: 'max', z: 'center' } },
  'support-lh': { url: '/models/iposter-support-lh.glb', anchors: { x: 'center', y: 'min', z: 'max' } },
  'support-rh': { url: '/models/iposter-support-rh.glb', anchors: { x: 'center', y: 'min', z: 'max' } },
};

/**
 * The IDENTITY of the accessory specs the shipped CAD is allowed to stand in for — not a measurement
 * of the meshes. A CAD mesh is a fixed shape, so it may only replace a spec it matches; a hand-edited
 * accessory spec keeps the parametric extrusion, which is the only thing that can follow it.
 *
 * The envelopes ARE measured from the STEP files (base 25.08 × 0.25 × 18.78 in, bracket 2.00 × 21.14
 * × 6.70 in), but `frontW` and `notch` are v1 profile numbers, not CAD ones. The real plate's top face
 * is a 12-gon that is mirror-symmetric in BOTH x and z: corners at x = ±12.540 and ±7.030 on z = ±9.390,
 * and x = ±4.530 on z = ±7.930 — a 25.08 × 18.78 in rectangle with a shallow trapezoidal notch cut
 * into the middle of EACH long edge, 14.06 in wide at the edge narrowing to 9.06 in over just 1.46 in
 * of depth. {@link extrudedBasePlate} draws a different, z-asymmetric shape — see its JSDoc.
 */
export const CAD_BASE_SPEC: BasePlateSpec = { backW: 25.08, frontW: 9.06, depth: 18.78, thick: 0.25, notch: 5.51 };
/** Only the fields the bracket profile is built from; `thick`/`inset` do not shape the model. */
export const CAD_SUPPORT_SPEC: Pick<SupportBracketSpec, 'width' | 'totalH' | 'chamfer' | 'footD'> =
  { width: 2, totalH: 21.14, chamfer: 1, footD: 6.7 };

/** Tolerance when matching a spec against the CAD, in inches (specs are exact decimals). */
export const CAD_SPEC_TOLERANCE_IN = 0.005;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= CAD_SPEC_TOLERANCE_IN;

/** True when the CAD base plate is the right model for this spec (see {@link CAD_BASE_SPEC}). */
export function basePlateMatchesCad(s: BasePlateSpec): boolean {
  return near(s.backW, CAD_BASE_SPEC.backW) && near(s.frontW, CAD_BASE_SPEC.frontW)
    && near(s.depth, CAD_BASE_SPEC.depth) && near(s.thick, CAD_BASE_SPEC.thick) && near(s.notch, CAD_BASE_SPEC.notch);
}

/** True when the CAD bracket is the right model for this spec (see {@link CAD_SUPPORT_SPEC}). */
export function supportBracketMatchesCad(s: SupportBracketSpec): boolean {
  return near(s.width, CAD_SUPPORT_SPEC.width) && near(s.totalH, CAD_SUPPORT_SPEC.totalH)
    && near(s.chamfer, CAD_SUPPORT_SPEC.chamfer) && near(s.footD, CAD_SUPPORT_SPEC.footD);
}

/** CAD already loaded, per part (shared, read-only — owned by `content/cadModels`). */
const cadLoaded = new Map<AccessoryPart, THREE.BufferGeometry>();
/** Placeholder geometries waiting for their part's CAD to arrive. */
const cadPending = new Map<AccessoryPart, Set<THREE.BufferGeometry>>();
const cadListeners = new Set<() => void>();
let cadPreload: Promise<void> | null = null;

/**
 * Be told when accessory geometry has just been swapped from the extruded placeholder to the CAD
 * mesh. The geometry objects keep their identity, so a listener only has to ask for a re-render —
 * `LedWallRenderer` subscribes with `ctx.invalidate`. Returns an unsubscribe function.
 */
export function onAccessoryGeometry(listener: () => void): () => void {
  cadListeners.add(listener);
  return () => { cadListeners.delete(listener); };
}

/**
 * Warm the accessory CAD cache. Safe to call any number of times (the work happens once) and safe
 * to ignore: it never rejects, and outside the browser it resolves immediately having done nothing.
 * Call it at boot so the first wall shows CAD accessories with no visible placeholder step.
 */
export function preloadAccessoryGeometry(): Promise<void> {
  return (cadPreload ??= loadAccessoryCad());
}

async function loadAccessoryCad(): Promise<void> {
  if (!cadLoadingAvailable()) return;
  const parts = Object.keys(ACCESSORY_CAD) as AccessoryPart[];
  const loaded = await Promise.all(parts.map(async part => {
    const { url, anchors } = ACCESSORY_CAD[part];
    try {
      return await loadCadGeometry(url, anchors);
    } catch (err) {
      console.warn('[accessory cad]', url, (err as Error).message);
      return null;
    }
  }));
  let swapped = false;
  parts.forEach((part, i) => {
    const geom = loaded[i];
    if (!geom) return;
    cadLoaded.set(part, geom);
    const waiting = cadPending.get(part);
    if (!waiting) return;
    for (const target of waiting) { adoptGeometry(target, geom); swapped = true; }
    waiting.clear();
  });
  if (swapped) for (const fn of cadListeners) fn();
}

/**
 * Point `placeholder` at the CAD for `part`: immediately when it is already loaded (so a rebuilt
 * wall never flashes the extrusion again), otherwise by registering it for the swap and kicking the
 * load off.
 */
function requestAccessoryCad(part: AccessoryPart, placeholder: THREE.BufferGeometry): void {
  const geom = cadLoaded.get(part);
  if (geom) { adoptGeometry(placeholder, geom); return; }
  let waiting = cadPending.get(part);
  if (!waiting) { waiting = new Set(); cadPending.set(part, waiting); }
  waiting.add(placeholder);
  void preloadAccessoryGeometry();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Panel                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Shared box geometry for a plain (un-mitered) panel, cached per panel dimensions.
 * Centred on the origin; the +Z face is the screen (v1 3406-3408).
 * Do not dispose the returned geometry directly — call {@link disposeGeometryCache}.
 */
export function panelGeometry(spec: PanelSpec): THREE.BoxGeometry {
  const key = panelKey(spec);
  let g = panelCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(spec.widthIn, spec.heightIn, spec.depthIn);
    panelCache.set(key, g);
  }
  return g;
}

/**
 * Build a panel box whose ±X edges are shifted independently on the front (+Z) and
 * back (−Z) faces, so the ±X side faces become the 45° miter faces at a corner.
 * Port of v1 buildMiteredPanelGeom (3409-3442).
 *
 * Positive cut values move the edge inward (trim); negative values extend it.
 * The result is a fresh non-indexed geometry (36 vertices, 6 material groups in
 * {@link PANEL_FACE_ORDER}); it is NOT cached — the caller owns and disposes it.
 * With both cuts null the shape equals {@link panelGeometry} (but is a separate object).
 */
export function miteredPanelGeometry(
  spec: PanelSpec,
  leftCut: MiterCut | null,
  rightCut: MiterCut | null,
): THREE.BufferGeometry {
  const hw = spec.widthIn / 2;
  const hh = spec.heightIn / 2;
  const hd = spec.depthIn / 2;
  const lf = leftCut ? leftCut.front : 0;
  const lb = leftCut ? leftCut.back : 0;
  const rf = rightCut ? rightCut.front : 0;
  const rb = rightCut ? rightCut.back : 0;

  type P = readonly [number, number, number];
  // 8 corner vertices (F/B = front/back, T/B = top/bottom, L/R = left/right)
  const FTL: P = [-hw + lf, hh, hd];
  const FTR: P = [hw - rf, hh, hd];
  const FBR: P = [hw - rf, -hh, hd];
  const FBL: P = [-hw + lf, -hh, hd];
  const BTL: P = [-hw + lb, hh, -hd];
  const BTR: P = [hw - rb, hh, -hd];
  const BBR: P = [hw - rb, -hh, -hd];
  const BBL: P = [-hw + lb, -hh, -hd];

  // Two CCW triangles for a quad viewed from outside.
  const quad = (a: P, b: P, c: P, d: P): number[] => [...a, ...b, ...c, ...a, ...c, ...d];

  const positions = new Float32Array([
    ...quad(FTR, FBR, BBR, BTR), // +X right face
    ...quad(BTL, BBL, FBL, FTL), // -X left face
    ...quad(FTL, FTR, BTR, BTL), // +Y top face
    ...quad(FBL, BBL, BBR, FBR), // -Y bottom face
    ...quad(FTL, FBL, FBR, FTR), // +Z front face (screen)
    ...quad(BTR, BBR, BBL, BTL), // -Z back face (cabinet)
  ]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  // 6 material groups matching PANEL_FACE_ORDER: +X, -X, +Y, -Y, +Z, -Z
  for (let i = 0; i < 6; i++) geom.addGroup(i * 6, 6, i);
  return geom;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Accessories                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Mounting base plate. Returns the manufacturer's CAD plate once it has loaded, and the parametric
 * extrusion below until then (the same geometry object either way — see {@link adoptBasePlate}).
 *
 * Local frame (both models): x ∈ [−backW/2, backW/2], y ∈ [−thick, 0] (TOP face on y = 0),
 * z ∈ [−depth/2, depth/2]. The origin is the panel's bottom centre and the plate hangs BELOW it,
 * so a panel placed at the origin rests on the plate, and the plate's TOP face (y = 0) is the level
 * the support-bracket feet stand on too — the contract `accessoryPlacements` encodes, and the one the
 * manufacturer's assembly shows. The CAD
 * plate is symmetric in both x and z, so the plate's yaw does not matter.
 *
 * Cached per spec values; dispose via {@link disposeGeometryCache}.
 */
export function basePlateGeometry(spec: BasePlateSpec): THREE.BufferGeometry {
  const key = baseKey(spec);
  const cached = baseCache.get(key);
  if (cached) return cached;
  const geom = extrudedBasePlate(spec);
  baseCache.set(key, geom);
  if (basePlateMatchesCad(spec)) requestAccessoryCad('base', geom);
  return geom;
}

/**
 * Back support bracket. Returns the manufacturer's CAD bracket once it has loaded, and the
 * parametric extrusion below until then (the same geometry object either way).
 *
 * `mirrored` picks the right-hand part. The two CAD brackets are exact x-mirrors of each other, so
 * this replaces the `scale.x = -1` the renderer used to apply — mirroring by a negative scale also
 * inverts the mesh's winding, which shows the bracket's inside faces once it is a real part rather
 * than a width-symmetric extrusion. The extruded placeholder is symmetric, so it is unaffected;
 * the two are cached separately only so each can adopt its own CAD.
 *
 * Local frame (both models): x ∈ [−width/2, width/2], y ∈ [0, totalH] (feet on the floor), and the
 * foot extends behind the panel toward −Z: z ∈ [−footD, 0]. The z = 0 edge is the vertical bar that
 * sits against the cabinet back.
 *
 * Cached per spec values; dispose via {@link disposeGeometryCache}.
 */
export function supportBracketGeometry(spec: SupportBracketSpec, mirrored = false): THREE.BufferGeometry {
  const key = supportKey(spec, mirrored);
  const cached = supportCache.get(key);
  if (cached) return cached;
  const geom = extrudedSupportBracket(spec);
  supportCache.set(key, geom);
  if (supportBracketMatchesCad(spec)) requestAccessoryCad(mirrored ? 'support-rh' : 'support-lh', geom);
  return geom;
}

/**
 * Placeholder base plate: a 12-vertex dodecagon (rectangle with rectangular corner
 * notches) extruded `thick` and laid flat (v1 3362-3381).
 *
 * This is v1's shape, NOT the CAD outline. The manufacturer's plate is mirror-symmetric in both
 * x and z with a shallow trapezoidal notch (14.06 in — 9.06 in over 1.46 in of depth) in the
 * middle of each long edge; this profile is z-asymmetric and cuts `notch` (5.51 in) deep. Both
 * fill the same 25.08 × 0.25 × 18.78 in envelope, and the shipped `iposter-base.glb` replaces this
 * geometry as soon as it loads (see {@link CAD_BASE_SPEC}), so the difference is visible only in
 * the first frames or when the accessory spec has been hand-edited away from the CAD.
 *
 * Same frame as {@link basePlateGeometry}: x ∈ [−backW/2, backW/2], y ∈ [−thick, 0]
 * (top face on y = 0), z ∈ [−depth/2, depth/2].
 *
 * v1 bug (documented, not reproduced): v1 3380 assumed the rotateX(−π/2) sent the
 * extrusion to −Y, but ExtrudeGeometry extrudes toward +Z, which rotateX(−π/2) maps
 * to +Y. v1 then placed the plate at panelBottom (3965) while the brackets sat on
 * ground = panelBottom − thick (3945/3974), so the plate rendered embedded 0.25 in
 * into the bottom panel row and hovering 0.25 in above the bracket feet. v2 adds a
 * `translate(0, −thick, 0)` so the geometry matches v1's stated intent.
 *
 * Orientation is v1's: the wide notched edge
 * (backW − 2·notch, 14.06 in for the iPoster) is toward +Z (the screen side) and the
 * `frontW` (9.06 in) edge is toward −Z (behind the wall). Note the v1 field names
 * ("front"/"back") are the reverse of where the edges end up after v1's rotateY(π);
 * the transform is reproduced exactly so accessory placement matches v1.
 */
function extrudedBasePlate(spec: BasePlateSpec): THREE.BufferGeometry {
  const bw2 = spec.backW / 2;
  const bfw2 = spec.frontW / 2;
  const bd2 = spec.depth / 2;
  const fn = spec.notch; // notch depth (front & back)
  const ifw2 = bw2 - fn; // inner front half-width (7.030 for the iPoster)

  const shape = new THREE.Shape();
  shape.moveTo(-ifw2, bd2); // 1  front-left inner
  shape.lineTo(ifw2, bd2); // 2  front-right inner
  shape.lineTo(ifw2, bd2 - fn); // 3  front-right notch corner
  shape.lineTo(bw2, bd2 - fn); // 4  right full-width top
  shape.lineTo(bw2, -bd2 + fn); // 5  right full-width bottom
  shape.lineTo(bfw2, -bd2 + fn); // 6  back-right notch corner
  shape.lineTo(bfw2, -bd2); // 7  back-right
  shape.lineTo(-bfw2, -bd2); // 8  back-left
  shape.lineTo(-bfw2, -bd2 + fn); // 9  back-left notch corner
  shape.lineTo(-bw2, -bd2 + fn); // 10 left full-width bottom
  shape.lineTo(-bw2, bd2 - fn); // 11 left full-width top
  shape.lineTo(-ifw2, bd2 - fn); // 12 front-left notch corner
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, { depth: spec.thick, bevelEnabled: false });
  // Lay flat: shape XY -> world XZ. The extrusion (+Z in shape space) lands on +Y here,
  // not −Y as v1 3380 claimed — see the JSDoc above for the v1 placement bug.
  geom.rotateX(-Math.PI / 2);
  geom.rotateY(Math.PI); // flip: wide end forward (+Z), narrow end toward the wall back
  geom.translate(0, -spec.thick, 0); // hang below the origin: y ∈ [−thick, 0]
  geom.computeBoundingBox();
  return geom;
}

/**
 * Placeholder back support bracket: a triangular side plate (vertical bar + 45° chamfer
 * at the top + diagonal down to the foot) with three elliptical weight-relief cutouts,
 * extruded `width` and centred on x (v1 3384-3404). Same frame as
 * {@link supportBracketGeometry}, and symmetric in x (mirroring it is a no-op).
 *
 * The three cutouts are the v1 CAD-matched constants (centre, rx, ry):
 * (2.8, 4.0, 1.2, 1.8), (2.0, 9.5, 0.8, 2.2), (1.4, 14.5, 0.35, 1.8) in profile
 * coordinates (x = depth behind the panel, y = height). They are only added when
 * they fit inside the profile so a shorter custom bracket still extrudes cleanly.
 */
function extrudedSupportBracket(spec: SupportBracketSpec): THREE.BufferGeometry {
  const profile = new THREE.Shape();
  profile.moveTo(0, 0); // ground, at panel back
  profile.lineTo(0, spec.totalH - spec.chamfer); // up the vertical bar to the chamfer start
  profile.lineTo(spec.chamfer, spec.totalH); // 45° chamfer peak
  profile.lineTo(spec.footD, 0); // diagonal down to the foot end
  profile.closePath();

  // Weight-relief cutouts matching the CAD side profile (3 oval openings).
  // Diagonal edge runs from (chamfer, totalH) to (footD, 0); inner offset ~1.2 in.
  const cutouts: [number, number, number, number][] = [
    [2.8, 4.0, 1.2, 1.8], // bottom — largest opening
    [2.0, 9.5, 0.8, 2.2], // middle
    [1.4, 14.5, 0.35, 1.8], // upper — narrowest
  ];
  for (const [cx, cy, rx, ry] of cutouts) {
    if (!ellipseFitsProfile(cx, cy, rx, ry, spec)) continue;
    const h = new THREE.Path();
    h.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false);
    profile.holes.push(h);
  }

  const geom = new THREE.ExtrudeGeometry(profile, { depth: spec.width, bevelEnabled: false });
  geom.translate(0, 0, -spec.width / 2); // centre the width
  geom.rotateY(Math.PI / 2); // profile X -> world −Z (foot behind the panel), extrusion -> world X
  geom.computeBoundingBox();
  return geom;
}

/** True if the ellipse's bounding box lies strictly inside the bracket profile. */
function ellipseFitsProfile(cx: number, cy: number, rx: number, ry: number, s: SupportBracketSpec): boolean {
  if (cx - rx <= 0 || cy - ry <= 0) return false;
  // Diagonal from (chamfer, totalH) to (footD, 0): x on that line at height y.
  const xAt = (y: number): number => s.footD - (y / s.totalH) * (s.footD - s.chamfer);
  const top = cy + ry;
  if (top >= s.totalH - s.chamfer) return false;
  // Conservatively check the ellipse's right extreme against the diagonal at its top.
  return cx + rx < xAt(top);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Bezel lines & ghost panels                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Rectangle outline for one panel's bezel lines, as a LineSegments geometry
 * (4 segments, 8 vertices) centred on the origin in the XY plane at z = 0
 * (v1 4092-4130 builds these per column; the caller positions them at
 * panelD/2 + {@link BEZEL_LINE_OFFSET_IN}, in front of the screen face).
 *
 * `leftTrim` / `rightTrim` are the miter `front` cuts (v1 4103-4104): the left
 * edge is at −w/2 + leftTrim and the right edge at w/2 − rightTrim, so the
 * rectangle follows the mitered screen face. Not cached — caller disposes.
 */
export function bezelLineGeometry(w: number, h: number, leftTrim = 0, rightTrim = 0): THREE.BufferGeometry {
  const lx = -w / 2 + leftTrim;
  const rx = w / 2 - rightTrim;
  const yt = h / 2;
  const yb = -h / 2;
  // 4 line segments (pairs of vertices for LineSegments)
  const pts = new Float32Array([
    lx, yt, 0, rx, yt, 0, // top edge
    rx, yt, 0, rx, yb, 0, // right edge
    rx, yb, 0, lx, yb, 0, // bottom edge
    lx, yb, 0, lx, yt, 0, // left edge
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geom;
}

/**
 * Ghost panel geometry used by the on-model shape editor: a panel-sized box plus
 * its EdgesGeometry outline (v1 2649-2650), rendered with `ghost` / `ghostEdge`
 * from {@link createWallMaterials}. Cached per panel dimensions; dispose via
 * {@link disposeGeometryCache}.
 */
export function ghostPanelGeometry(spec: PanelSpec): GhostPanelGeometry {
  const key = panelKey(spec);
  let g = ghostCache.get(key);
  if (!g) {
    const box = new THREE.BoxGeometry(spec.widthIn, spec.heightIn, spec.depthIn);
    g = { box, edges: new THREE.EdgesGeometry(box) };
    ghostCache.set(key, g);
  }
  return g;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Materials                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Create the v1 material table (3222-3253, stage 7205-7207).
 *
 * Ownership: the caller owns these and is responsible for disposing them. They are
 * intended to be shared across every wall in a scene. `front.emissiveIntensity` is
 * NOT a fixed value — the caller sets it from the wall's brightness with
 * {@link setFrontBrightness}. When walls have different brightness values, the caller
 * must `front.clone()` per wall (the other materials can stay shared).
 */
export function createWallMaterials(): WallMaterials {
  return {
    side: new THREE.MeshStandardMaterial({ color: 0xb0b0b8, metalness: 0.6, roughness: 0.35 }),
    front: new THREE.MeshStandardMaterial({
      color: 0x2a2a30,
      emissive: 0x101018,
      emissiveIntensity: FRONT_EMISSIVE_BASE,
      metalness: 0.2,
      roughness: 0.3,
    }),
    back: new THREE.MeshStandardMaterial({ color: 0xa0a0a8, metalness: 0.4, roughness: 0.55 }),
    accessory: new THREE.MeshStandardMaterial({ color: 0x404048, metalness: 0.7, roughness: 0.28 }),
    bezel: new THREE.LineBasicMaterial({ color: 0x555560 }),
    ghost: new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.18, depthWrite: false }),
    ghostEdge: new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.6, depthWrite: false }),
    stageTop: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0 }),
    stageSide: new THREE.MeshStandardMaterial({ color: 0x242428, roughness: 0.95, metalness: 0 }),
    stageEdge: new THREE.LineBasicMaterial({ color: 0x4a4a52 }),
  };
}

/**
 * Per-face material array for a panel mesh (BoxGeometry or {@link miteredPanelGeometry}),
 * in {@link PANEL_FACE_ORDER}: sides on ±X/±Y, `front` on +Z, `back` on −Z (v1 3227).
 * Pass a per-wall `front` clone when brightness differs between walls.
 */
export function panelMaterialArray(mats: Pick<WallMaterials, 'side' | 'back'>, front: THREE.MeshStandardMaterial): THREE.Material[] {
  return [mats.side, mats.side, mats.side, mats.side, front, mats.back];
}

/**
 * Drive the screen-face emissive glow from brightness (v1 applyBrightness, 7601-7611):
 * `emissiveIntensity = 0.5 · (pct / 100) · gridCompensation`.
 *
 * @param front  the `front` material (or a per-wall clone of it)
 * @param pct    brightness 0–100
 * @param gridCompensation  factor > 1 that offsets the darkening of the pixel-grid
 *   overlay so apparent brightness stays constant (v1 gridBrightnessCompensation);
 *   1 when the grid is off.
 */
export function setFrontBrightness(front: THREE.MeshStandardMaterial, pct: number, gridCompensation = 1): void {
  front.emissiveIntensity = FRONT_EMISSIVE_BASE * (pct / 100) * gridCompensation;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Dispose every cached geometry (panel boxes, ghost boxes/edges, base plates,
 * support brackets) and clear the caches. Subsequent calls to the cached builders
 * create fresh geometries. Meshes still referencing the old geometries must be
 * rebuilt.
 *
 * The loaded CAD meshes themselves belong to `content/cadModels` and are only
 * forgotten here (the next accessory build re-reads them from that cache, or
 * re-fetches them if `clearCadGeometryCache()` has since emptied it).
 */
export function disposeGeometryCache(): void {
  for (const g of panelCache.values()) g.dispose();
  for (const g of ghostCache.values()) {
    g.box.dispose();
    g.edges.dispose();
  }
  for (const g of baseCache.values()) g.dispose();
  for (const g of supportCache.values()) g.dispose();
  panelCache.clear();
  ghostCache.clear();
  baseCache.clear();
  supportCache.clear();
  cadLoaded.clear();
  cadPending.clear();
  cadPreload = null;
}
