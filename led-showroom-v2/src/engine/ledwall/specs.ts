/**
 * LED product specifications. All lengths in inches, resolutions in pixels.
 *
 * Source: the manufacturer's SolidWorks CAD ("LED iPoster" panel, base and back support),
 * which supersedes the rounded inch constants carried over from v1 where the two disagree.
 * The STEP exports are in millimetres, but every part is AUTHORED IN INCHES: each exported
 * extent divides by 25.4 into an exact two-decimal inch value, so the inch numbers below are
 * the design intent and the millimetres are the rounded-looking side.
 */
export interface PanelSpec {
  id: string;
  name: string;
  /** Native resolution of one panel/tile. */
  pxW: number;
  pxH: number;
  /** Physical face size and depth. */
  widthIn: number;
  heightIn: number;
  depthIn: number;
  /** Gap between adjacent panels when bezels are shown. */
  gapIn: number;
  /** Pixel pitch (mm) — derived if omitted. */
  pitchMm?: number;
  /** Peak brightness in nits at 100 %. */
  maxNits: number;
  /** Weight per panel (lb), for the spec sheet. */
  weightLb?: number;
  /** Which accessory set fits this panel. */
  accessories?: AccessorySpec;
  /** How the cabinet takes a bolt - what a truss clamp fastens to. */
  mount?: MountSpec;
}

/**
 * The bolt holes a cabinet hangs from — what a truss clamp fastens to.
 *
 * `holeInsetIn` is where the hole STARTS: panel edge to the NEAR SIDE of the hole, not to its
 * centre. A corner hole is inset from BOTH of the edges that meet at its corner, so its centre
 * sits `holeInsetIn + boltDiaIn / 2` in from each of them.
 */
export interface MountSpec {
  /** Thread designation, e.g. 'M10'. */
  bolt: string;
  /** Nominal bolt diameter (in). M10 = 10 mm = 0.3937 in. */
  boltDiaIn: number;
  /** Panel edge to the NEAR SIDE of the hole (in). */
  holeInsetIn: number;
  /** `corners` = one hole at each of the four corners of {@link face}, and none anywhere else. */
  pattern: 'corners';
  /**
   * The face the holes are in.
   *
   * `back` is the only value the measurement supports, and the only one modelled: the front face
   * is the LED itself, and a half coupler reaches a cabinet from the truss BEHIND the screen.
   * It is a field rather than an assumption buried in the geometry so that a cabinet measured
   * differently is one word to correct.
   */
  face: 'back';
}

/** One mount hole's centre, panel-local inches: origin at the face centre, +x right, +y up. */
export interface MountHole {
  x: number;
  y: number;
}

/**
 * The mount hole centres on one panel, panel-local.
 *
 * Ordered bottom-left, bottom-right, top-left, top-right, so callers can rely on the order rather
 * than sorting. Empty when the spec records no mount.
 *
 * Also empty — rather than crossed over — when the inset would reach past the middle of the panel.
 * Four holes stacked across the centre line would be a drawing of a bad spec instead of a report
 * of one, and a wall of them would look deliberate.
 */
export function mountHoles(spec: PanelSpec): MountHole[] {
  const m = spec.mount;
  if (!m) return [];
  const inset = m.holeInsetIn + m.boltDiaIn / 2;
  const x = spec.widthIn / 2 - inset;
  const y = spec.heightIn / 2 - inset;
  if (!(x > 0) || !(y > 0)) return [];
  return [{ x: -x, y: -y }, { x, y: -y }, { x: -x, y }, { x, y }];
}

export interface AccessorySpec {
  /** Mounting base plate (trapezoid in plan: wide at the back, narrow at the front). */
  base: { backW: number; frontW: number; depth: number; thick: number; notch: number };
  /** Back support bracket (vertical bar + foot, 45° chamfer at the top). */
  support: { width: number; thick: number; totalH: number; chamfer: number; footD: number; inset: number };
}

/**
 * The LED iPoster tile — the unit that stacks into walls.
 *
 * The face size and depth are the extents of the solid in "LED iPoster - Panel.STEP", which
 * spans x -320.04..+320.04, y -240.03..+240.03, z -44.958..0 mm = 640.08 x 480.06 x 44.958 mm.
 * The part is authored in inches — that is exactly 25.2 x 18.9 x 1.77 in — so those are the
 * numbers below; rounding them to whole millimetres (640 x 480 x 45) would lose 0.003 in per
 * panel and compound across a wall.
 * v1 used 25.125 x 18.875 x 2 in (638.175 x 479.425 x 50.8 mm), which is the drawing's
 * rounded inch call-out and made the pixel pitch slightly non-square (1.8552 x 1.8582 mm).
 * The CAD numbers give an exactly square pitch over the 344 x 258 active pixels:
 * 640.08/344 = 480.06/258 = 1.8606977 mm — the design intent of a "P1.86" product.
 *
 * Cross-checked against the manufacturer's own 6 x 5 assembly ("Veloxity LED iPoster Wall.STEP"):
 * panels butt flush at exactly one panel pitch, so 6 columns span 3840.48 mm = 151.2 in and
 * 5 rows span 2400.30 mm = 94.5 in — both exact only with the inch-authored constants.
 */
export const IPOSTER: PanelSpec = {
  id: 'iposter',
  name: 'LED iPoster panel',
  pxW: 344,
  pxH: 258,
  widthIn: 25.2, // 640.08 mm
  heightIn: 18.9, // 480.06 mm
  depthIn: 1.77, //  44.958 mm
  /**
   * Visualisation seam only. The manufacturer's wall assembly butts panels flush — adjacent
   * columns share an edge at exactly the 640.08 mm panel pitch, and rows stack at 480.06 mm —
   * so a bezels-on readout is deliberately 0.06 in per seam larger than the shipped product.
   * (The gap that does have CAD backing is between BASE PLATES: 637.032 mm plates on a
   * 640.08 mm pitch leave 3.048 mm = 0.12 in of clearance.) Turn bezels off for true totals.
   */
  gapIn: 0.06,
  /** Nominal product pitch; the exact CAD pitch is 640.08/344 = 1.8606977 mm in both axes. */
  pitchMm: 1.86,
  maxNits: 1000,
  // Both accessory sets are confirmed by the CAD to the thousandth of an inch:
  // "LED iPoster - Base.STEP" is 637.0 x 6.3 x 477.0 mm = 25.08 x 0.25 x 18.78 in, and
  // "LED iPoster -LH Back Support.STEP" is 170.2 x 537.0 x 50.8 mm = 6.70 x 21.14 x 2.00 in.
  // Measured off the cabinet, not read from the CAD: an M10 hole at each of the four corners of
  // the back face, each one starting 1 in in from both edges that meet at its corner. Centres are
  // therefore 1.19685 in in from each edge, at (±11.40315, ±8.25315) on the 25.2 x 18.9 in face.
  mount: { bolt: 'M10', boltDiaIn: 0.3937, holeInsetIn: 1, pattern: 'corners', face: 'back' },
  accessories: {
    base: { backW: 25.08, frontW: 9.06, depth: 18.78, thick: 0.25, notch: 5.51 },
    support: { width: 2.0, thick: 1.18, totalH: 21.14, chamfer: 1.0, footD: 6.7, inset: 2.5 },
  },
};

export const PANEL_SPECS: Record<string, PanelSpec> = {
  [IPOSTER.id]: IPOSTER,
};

export function panelSpec(id: string | undefined): PanelSpec {
  return (id && PANEL_SPECS[id]) || IPOSTER;
}

/**
 * Inches per pixel for a panel. The two axes stay independent because a spec may have
 * non-square pixels (v1's rounded inch constants gave 0.07304 x 0.07316); on the CAD
 * iPoster both are 25.2/344 = 18.9/258 = 0.0732558 in (1.8606977 mm).
 */
export function inchesPerPx(spec: PanelSpec): { x: number; y: number } {
  return { x: spec.widthIn / spec.pxW, y: spec.heightIn / spec.pxH };
}

/** Stage decks: 4 ft x 4 ft platforms at standard riser heights. */
export const STAGE_SIZE_IN = 48;
export const STAGE_HEIGHTS_IN = [8, 16, 24, 32, 40, 48] as const;

/** Default spacing between newly added walls. */
export const WALL_GAP_IN = 40;

/** Brightness: 0–100 % maps linearly to 0–maxNits. */
export const brightnessToNits = (pct: number, spec: PanelSpec = IPOSTER): number => Math.round((pct / 100) * spec.maxNits);

/** Limits carried over from v1. */
export const LIMITS = {
  maxCols: 50,
  maxRows: 50,
  maxWalls: 10,
  maxContentWindows: 8,
  maxPresets: 50,
};
