/**
 * Units. The engine works in inches (world unit = 1 in). Everything the user sees is
 * formatted through this module in their chosen display unit.
 */
export type Unit = 'in' | 'ft' | 'mm' | 'cm' | 'm';

export const UNITS: { id: Unit; label: string; long: string }[] = [
  { id: 'in', label: 'in', long: 'Inches' },
  { id: 'ft', label: 'ft', long: 'Feet & inches' },
  { id: 'mm', label: 'mm', long: 'Millimetres' },
  { id: 'cm', label: 'cm', long: 'Centimetres' },
  { id: 'm', label: 'm', long: 'Metres' },
];

const IN_PER: Record<Unit, number> = {
  in: 1,
  ft: 12,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1 / 0.0254,
};

/** Convert a length in inches to `unit`. */
export function fromInches(inches: number, unit: Unit): number {
  return inches / IN_PER[unit];
}

/** Convert a length in `unit` to inches. */
export function toInches(value: number, unit: Unit): number {
  return value * IN_PER[unit];
}

/** Sensible decimal places for a unit. */
export function unitDecimals(unit: Unit): number {
  switch (unit) {
    case 'mm': return 0;
    case 'cm': return 1;
    case 'm': return 3;
    case 'ft': return 2;
    default: return 2;
  }
}

/** Sensible nudge/step size for a unit, expressed in inches. */
export function unitStepInches(unit: Unit, fine = false): number {
  switch (unit) {
    case 'mm': return fine ? 1 / 25.4 : 10 / 25.4;
    case 'cm': return fine ? 0.1 / 2.54 : 1 / 2.54;
    case 'm': return fine ? 1 / 2.54 : 10 / 2.54;
    case 'ft': return fine ? 1 : 12;
    default: return fine ? 0.125 : 1;
  }
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Format inches as a human string in `unit`.
 *  - in  → 25.13"
 *  - ft  → 8' 4.5"   (or 4.5" when under a foot)
 *  - mm  → 638 mm, cm → 63.8 cm, m → 0.638 m
 */
export function formatLength(inches: number, unit: Unit, opts: { decimals?: number; compact?: boolean } = {}): string {
  const d = opts.decimals ?? unitDecimals(unit);
  if (!Number.isFinite(inches)) return '—';
  if (unit === 'ft') {
    const sign = inches < 0 ? '-' : '';
    const abs = Math.abs(inches);
    const feet = Math.floor(abs / 12);
    let rem = abs - feet * 12;
    let remStr = trimZeros(rem.toFixed(d));
    if (parseFloat(remStr) >= 12) { remStr = '0'; return `${sign}${feet + 1}' 0"`; }
    if (feet === 0) return `${sign}${remStr}"`;
    return `${sign}${feet}' ${remStr}"`;
  }
  const v = fromInches(inches, unit);
  const s = trimZeros(v.toFixed(d));
  if (unit === 'in') return `${s}"`;
  return opts.compact ? `${s}${unit}` : `${s} ${unit}`;
}

/** Format a width x height (x depth) tuple. */
export function formatDims(inches: number[], unit: Unit): string {
  return inches.map(v => formatLength(v, unit)).join(' × ');
}

/** Format an area in inches² as ft² or m². */
export function formatArea(sqIn: number, unit: Unit): string {
  if (unit === 'mm' || unit === 'cm' || unit === 'm') {
    return `${(sqIn * 0.00064516).toFixed(2)} m²`;
  }
  return `${(sqIn / 144).toFixed(1)} ft²`;
}

/**
 * Parse a user-typed length in the current unit. Accepts plain numbers (in the current unit),
 * feet-and-inches (8' 4", 8'4, 8ft 4in, 8 ft), and explicit suffixes (25in, 640mm, 2.5m, 63cm).
 * Returns inches, or null if it cannot be parsed.
 */
export function parseLength(input: string, unit: Unit): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;

  // feet + inches:  8' 4.5"  |  8'4  |  8ft 4in  |  8 ft
  const ftIn = s.match(/^(-?\d*\.?\d+)\s*(?:'|ft|feet|foot)\s*(?:(\d*\.?\d+)\s*(?:"|in|inch|inches)?)?$/);
  if (ftIn) {
    const ft = parseFloat(ftIn[1]);
    const inch = ftIn[2] ? parseFloat(ftIn[2]) : 0;
    return Math.sign(ft || 1) * (Math.abs(ft) * 12 + inch);
  }
  const suffixed = s.match(/^(-?\d*\.?\d+)\s*("|in|inch|inches|mm|cm|m)$/);
  if (suffixed) {
    const v = parseFloat(suffixed[1]);
    const u = suffixed[2];
    if (u === '"' || u.startsWith('in')) return v;
    if (u === 'mm') return toInches(v, 'mm');
    if (u === 'cm') return toInches(v, 'cm');
    if (u === 'm') return toInches(v, 'm');
  }
  const plain = s.match(/^-?\d*\.?\d+$/);
  if (plain) {
    const v = parseFloat(s);
    return unit === 'ft' ? v * 12 : toInches(v, unit);
  }
  // simple arithmetic like "48*3" or "96/2" in the current unit
  if (/^[\d\s.+\-*/()]+$/.test(s)) {
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict"; return (${s});`)();
      if (typeof v === 'number' && Number.isFinite(v)) return unit === 'ft' ? v * 12 : toInches(v, unit);
    } catch { /* fallthrough */ }
  }
  return null;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const FT = 12;
