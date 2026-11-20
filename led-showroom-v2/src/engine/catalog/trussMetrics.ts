/**
 * Physical metrics of a box truss and of the half coupler that grips it.
 *
 * Single source of truth shared by the DRAWING (`entities/equipmentGeometry.ts`) and the PLANNING
 * (`ledwall/trussRig.ts`). It has to be one source. A half coupler has no slack across its chord:
 * a clamp placed from one set of numbers onto a chord drawn from another misses it by exactly the
 * difference, and the picture quietly stops being the thing you would build.
 *
 * Pure arithmetic. No three.js, no document, no catalog lookup — the section size is the only
 * input, because it is the one number every truss in the fleet actually publishes.
 */

/**
 * Main chord tube, outside diameter.
 *
 * 50 mm on both systems we hold: the DT-GP drawing calls out "50 x 3 mm" chords and Global Truss
 * F34 is a 290 mm square on 50 mm chords. It is also what the 8002 coupler is sold to fit
 * (48–51 mm), which is the real cross-check — the clamp and the chord are one engineered pair.
 */
export const CHORD_OD_IN = 50 / 25.4;

/** Diagonal bracing, outside diameter: "25 x 2 mm" on the same drawing — exactly half the chord. */
export const DIAGONAL_OD_IN = 25 / 25.4;

/**
 * Chord radius for a box truss of the given section.
 *
 * A real chord is 50 mm whatever the section, so this is a constant until the section gets too
 * small to carry one — the junction blocks build their hub and arms from a nominal section that
 * can be a few inches across, and a 50 mm tube inside a 3 in hub would be mostly tube.
 */
export function chordRadiusIn(sectionIn: number): number {
  return Math.min(CHORD_OD_IN / 2, sectionIn * 0.12);
}

/** Diagonal radius: half the chord, which is 25 mm against a 50 mm chord. */
export function diagonalRadiusIn(sectionIn: number): number {
  return chordRadiusIn(sectionIn) / 2;
}

/**
 * Section centre to a chord axis, in each of the section's two axes.
 *
 * The published section is the OUTSIDE of the square, so the chords are inset by their own radius:
 * 11.156 in DT-GP on 50 mm chords puts them 4.59375 in off the axis, and F34's 290 mm square gives
 * the 240 mm chord centres that system is spec'd by — which is the check that this reading of
 * "section" is the right one.
 */
export function chordOffsetIn(sectionIn: number): number {
  return sectionIn / 2 - chordRadiusIn(sectionIn);
}

/** The four chord positions of a square section, as (right, back) offsets from its axis. */
export function chordOffsets(sectionIn: number): { right: number; back: number }[] {
  const o = chordOffsetIn(sectionIn);
  return [
    { right: -o, back: -o }, { right: o, back: -o },
    { right: -o, back: o }, { right: o, back: o },
  ];
}

/**
 * What a half coupler measures, derived from the same arithmetic `buildClamp` draws it with.
 *
 * `reachIn` is the number the whole rig hangs off: back face of the bolt plate to the axis of the
 * chord in the jaw. The plate sits flat on a cabinet with its bolt in a mount hole, so a chord has
 * to pass exactly `reachIn` behind that hole, along the hole's own normal.
 */
export interface ClampMetrics {
  /** Thickness of the flat plate that bolts to the cabinet. */
  plateDIn: number;
  /** Outer radius of the jaw. */
  jawRadiusIn: number;
  /** Bolt face to chord axis — the standoff a chord must sit at. */
  reachIn: number;
  /** Bore the jaw closes around: the largest chord it can take. */
  boreDiaIn: number;
}

/**
 * Metrics for a coupler of `dims` = [width, height, depth] inches.
 *
 * The plate carries the declared height and the jaw is sized from the depth left behind it, which
 * is how the part is drawn: a jaw as tall as the declared height would be as deep as it is tall,
 * and a coupler declared tall and thin would bulge outside its own box.
 */
export function clampMetrics(dims: readonly [number, number, number]): ClampMetrics {
  const [, h, d] = dims;
  const plateDIn = Math.min(d * 0.25, h * 0.4);
  const jawRadiusIn = Math.min(h, d - plateDIn) / 2;
  return { plateDIn, jawRadiusIn, reachIn: plateDIn + jawRadiusIn, boreDiaIn: jawRadiusIn * 0.84 * 2 };
}

/** Will this coupler close around that chord? The 8002 is sold for 48–51 mm and ours is 50. */
export function clampFitsChord(clamp: ClampMetrics, sectionIn: number): boolean {
  return clamp.boreDiaIn >= chordRadiusIn(sectionIn) * 2 - 1e-9;
}

/* ---------------------------- brace nodes ---------------------------- */

/** Thickness of the plate under a generic `truss-upright` prop. The DT-GP base is {@link GP_BASE_PLATE_IN}. */
export const BASE_PLATE_THICK_IN = 0.5;

/** DT-GP section: the outside of the square, shared by every GP stick and block. */
export const GP_SECTION_IN = 11.16;

/**
 * The DT-GP base plate: 36 in square and 1.5 in thick, as measured. The order gives no
 * geometry, so these are nominal.
 *
 * Shared with the planner because the plate decides two things a rig cannot fudge. It lies flat on
 * the floor and reaches forward under the cabinets, so a wall rigged to these legs comes no lower
 * than its top; and a leg's first stick, whose chords take couplers, bolts straight onto it.
 */
export const GP_BASE_PLATE_IN = { size: 36, thick: 1.5 } as const;

/**
 * What a `truss-base` of `dims` draws: a plate the full declared footprint, as thick as
 * {@link GP_BASE_PLATE_IN} or the whole height if that is less, and for any height past the plate a
 * riser of the GP section standing ON it. The catalog's base is the plate alone, so its riser is
 * zero; a base placed at 36.5 in before that still draws its 35.5 in riser. One function, so the
 * drawing and the planner agree on where a riser's chords start.
 */
export function trussBaseProfile(dims: readonly [number, number, number]): {
  plateThick: number; section: number; riserLen: number;
} {
  const [w, h, d] = dims;
  const plateThick = Math.min(GP_BASE_PLATE_IN.thick, Math.max(h, 0));
  return { plateThick, section: Math.min(GP_SECTION_IN, w, d), riserLen: Math.max(h - plateThick, 0) };
}

/**
 * Where the diagonals meet a chord, as distances from one end of a stick of `lenIn`.
 *
 * A half coupler cannot close over a weld, so the planner has to know this, and it has to be the
 * SAME arithmetic the stick is drawn with (`trussAlong`'s zig-zag) or the clamps it rejects will
 * not be the ones the picture shows a brace at. That is the whole reason this lives here.
 *
 * The zig-zag turns at every panel boundary, and the two end frames add a ring of their own just
 * inside each end.
 */
// By length, then section: the planner asks this in its innermost loops, too often to build a string key.
const nodeCache = new Map<number, Map<number, readonly number[]>>();
let nodeCacheSize = 0;

export function braceNodesAlong(lenIn: number, sectionIn: number): readonly number[] {
  let bySection = nodeCache.get(lenIn);
  const hit = bySection?.get(sectionIn);
  if (hit) return hit;
  // Frozen: the array is handed out by reference, so a caller that pushed to it would poison
  // the cache for every later clamp on a stick of this length.
  const out = Object.freeze(computeBraceNodes(lenIn, sectionIn));
  // Bounded: a rig asks for a handful of (length, section) pairs, and the planner asks repeatedly
  // while it searches for a wall height that puts no coupler on a weld.
  if (nodeCacheSize < 256) {
    if (!bySection) nodeCache.set(lenIn, bySection = new Map());
    bySection.set(sectionIn, out);
    nodeCacheSize++;
  }
  return out;
}

function computeBraceNodes(lenIn: number, sectionIn: number): number[] {
  const n = Math.max(1, Math.round(lenIn / Math.max(sectionIn, 12)));
  const step = lenIn / n;
  const br = diagonalRadiusIn(sectionIn);
  const out = new Set<number>([br, lenIn - br]);
  for (let i = 0; i <= n; i++) out.add(i * step);
  return [...out].sort((a, b) => a - b);
}

/**
 * Can a jaw `jawHalfIn` long each way sit at `alongIn` on a stick of `lenIn`?
 *
 * The jaw has to miss every weld by its own half length plus the diagonal's radius, which is the
 * condition for the two solids not to touch.
 */
export function clearOfBraceNodes(alongIn: number, lenIn: number, sectionIn: number, jawHalfIn: number): boolean {
  if (alongIn < 0 || alongIn > lenIn) return false;
  const keepOut = jawHalfIn + diagonalRadiusIn(sectionIn);
  for (const x of braceNodesAlong(lenIn, sectionIn)) if (Math.abs(alongIn - x) < keepOut) return false;
  return true;
}
