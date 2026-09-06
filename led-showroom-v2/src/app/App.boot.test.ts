import { describe, expect, it } from 'vitest';
import { shouldAutoFrame } from './App';

describe('boot framing guard', () => {
  it('fits the scene when there is nothing to preserve', () => {
    expect(shouldAutoFrame({ restoredView: false, locked: false })).toBe(true);
  });

  it('keeps a camera restored from the last session (v1 userViewDirty)', () => {
    expect(shouldAutoFrame({ restoredView: true, locked: false })).toBe(false);
  });

  it('keeps a locked view even without a restored pose', () => {
    expect(shouldAutoFrame({ restoredView: false, locked: true })).toBe(false);
    expect(shouldAutoFrame({ restoredView: true, locked: true })).toBe(false);
  });
});
