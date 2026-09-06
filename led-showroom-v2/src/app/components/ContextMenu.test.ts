/**
 * `placeAtPoint` is the only thing keeping a right-click menu on screen. `win` and `pad` are
 * injected so it can be exercised without a DOM.
 */
import { describe, expect, it } from 'vitest';
import { placeAtPoint } from './ContextMenu';

const WIN = { w: 1000, h: 800 };

describe('placeAtPoint', () => {
  it('hangs the panel down and to the right of the point when it fits', () => {
    expect(placeAtPoint(100, 200, { w: 200, h: 300 }, WIN)).toEqual({ left: 100, top: 200 });
  });

  it('flips to the left of the point when it would overflow the right edge', () => {
    // 900 + 200 = 1100 > 1000 - 6, so the panel's right edge lands on the cursor instead.
    expect(placeAtPoint(900, 200, { w: 200, h: 300 }, WIN)).toEqual({ left: 700, top: 200 });
  });

  it('flips above the point when it would overflow the bottom edge', () => {
    expect(placeAtPoint(100, 700, { w: 200, h: 300 }, WIN)).toEqual({ left: 100, top: 400 });
  });

  it('flips both ways in the bottom-right corner', () => {
    expect(placeAtPoint(990, 700, { w: 200, h: 300 }, WIN)).toEqual({ left: 790, top: 400 });
  });

  it('clamps a flipped panel back inside the far pad', () => {
    // Horizontally: a window-wide panel flips to -5 and clamps to the left pad.
    // Vertically: 799 flips to 499, which would leave 1px below the panel, so it clamps to 494.
    expect(placeAtPoint(995, 799, { w: 1000, h: 300 }, WIN)).toEqual({ left: 6, top: 494 });
  });

  it('clamps a panel larger than the window to the top-left pad', () => {
    expect(placeAtPoint(400, 400, { w: 1400, h: 1200 }, WIN)).toEqual({ left: 6, top: 6 });
  });

  it('never places the panel above or left of the pad, even at the origin', () => {
    expect(placeAtPoint(0, 0, { w: 200, h: 300 }, WIN)).toEqual({ left: 6, top: 6 });
  });

  it('honours a custom pad', () => {
    expect(placeAtPoint(0, 0, { w: 200, h: 300 }, WIN, 20)).toEqual({ left: 20, top: 20 });
    expect(placeAtPoint(900, 200, { w: 200, h: 300 }, WIN, 20)).toEqual({ left: 700, top: 200 });
  });
});
