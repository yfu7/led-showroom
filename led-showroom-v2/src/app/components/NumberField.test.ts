/**
 * The field-width helpers. They are the only pure logic in NumberField and they are load-bearing:
 * the quantisation is what stops a box resizing under the pointer mid-scrub, the ceiling is what
 * stops a very long value pushing a 328px dock open, and `fieldValueMayClip` decides which fields
 * carry their full value in a tooltip.
 */
import { describe, expect, it } from 'vitest';
import { FIELD_CHAR_STEPS, fieldChars, fieldValueMayClip } from './NumberField';

describe('fieldChars', () => {
  it('never reports less than the narrowest step, so an empty box does not collapse', () => {
    expect(fieldChars('')).toBe(4);
    expect(fieldChars('0')).toBe(4);
    expect(fieldChars('-48')).toBe(4);
  });

  it('quantises to the steps rather than tracking every digit', () => {
    // A scrub from 0 through -3097 to -25413 crosses one step, not five widths.
    expect(fieldChars('0')).toBe(4);
    expect(fieldChars('-3097')).toBe(7);
    expect(fieldChars('-25413')).toBe(7);
    expect(fieldChars('1234.5')).toBe(7);
    expect(fieldChars('-1234.5')).toBe(7);
    expect(fieldChars('-31356.3')).toBe(10);
  });

  it('reports a step for every length, in increasing order', () => {
    for (let n = 0; n <= 40; n++) {
      const c = fieldChars('x'.repeat(n));
      expect(FIELD_CHAR_STEPS).toContain(c);
      expect(c).toBeGreaterThanOrEqual(Math.min(n, FIELD_CHAR_STEPS[FIELD_CHAR_STEPS.length - 1]));
    }
  });

  it('caps at the widest step, so a long value is clipped instead of widening its panel', () => {
    const widest = FIELD_CHAR_STEPS[FIELD_CHAR_STEPS.length - 1];
    expect(fieldChars('-1234567890.75')).toBe(widest);
    expect(fieldChars('x'.repeat(200))).toBe(widest);
  });

  it('is monotonic in the length of the value', () => {
    let prev = 0;
    for (let n = 0; n <= 30; n++) {
      const c = fieldChars('x'.repeat(n));
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe('fieldValueMayClip', () => {
  it('is false for values that fit the narrowest step', () => {
    expect(fieldValueMayClip('')).toBe(false);
    expect(fieldValueMayClip('0')).toBe(false);
    expect(fieldValueMayClip('-48')).toBe(false);
    expect(fieldValueMayClip('1219')).toBe(false);
  });

  it('is true once the value is longer than that — those get a tooltip', () => {
    expect(fieldValueMayClip('-1234.5')).toBe(true);
    expect(fieldValueMayClip('-31356.3')).toBe(true);
    // ft-in reads as one long string in a single field.
    expect(fieldValueMayClip('-102\' 10.5"')).toBe(true);
  });
});
