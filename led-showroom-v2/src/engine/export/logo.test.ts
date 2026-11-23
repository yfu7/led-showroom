import { describe, expect, it } from 'vitest';
import { LOGO_COLOR, LOGO_H, LOGO_PATH, LOGO_W } from './logo';

describe('Veloxity logo', () => {
  it('reads the wordmark path, box and blue from the saved SVG', () => {
    expect([LOGO_W, LOGO_H]).toEqual([126, 28]);
    expect(LOGO_PATH.startsWith('M7.988 21.647')).toBe(true);
    expect(LOGO_PATH.endsWith('z')).toBe(true);
    expect(LOGO_COLOR.toUpperCase()).toBe('#28ACE3');
  });
});
