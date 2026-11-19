/**
 * Panel spec maths — the mount hole pattern.
 *
 * The numbers here are a measurement off a real cabinet, not a derivation, so the tests pin the
 * arithmetic that turns "an M10 hole at each corner, starting 1 in in from either edge" into
 * coordinates. Get the near-side/centre distinction wrong and every hole moves 0.197 in, which is
 * half a bolt diameter — far enough to miss, close enough to look right in a screenshot.
 */
import { describe, it, expect } from 'vitest';
import { IPOSTER, mountHoles, type PanelSpec } from './specs';

/** A spec with the field under test swapped, so a case cannot drift from the real product. */
const variant = (over: Partial<PanelSpec>): PanelSpec => ({ ...IPOSTER, ...over });

describe('mountHoles', () => {
  it('puts one hole at each of the four corners', () => {
    expect(mountHoles(IPOSTER)).toHaveLength(4);
  });

  it('measures to the hole CENTRE, half a bolt in from where the hole starts', () => {
    const m = IPOSTER.mount!;
    const inset = m.holeInsetIn + m.boltDiaIn / 2; // 1 + 0.19685
    expect(inset).toBeCloseTo(1.19685, 10);
    for (const h of mountHoles(IPOSTER)) {
      expect(IPOSTER.widthIn / 2 - Math.abs(h.x)).toBeCloseTo(inset, 10);
      expect(IPOSTER.heightIn / 2 - Math.abs(h.y)).toBeCloseTo(inset, 10);
    }
  });

  it('places the iPoster holes at (±11.40315, ±8.25315)', () => {
    expect(mountHoles(IPOSTER).map(h => [+h.x.toFixed(5), +h.y.toFixed(5)])).toEqual([
      [-11.40315, -8.25315],
      [11.40315, -8.25315],
      [-11.40315, 8.25315],
      [11.40315, 8.25315],
    ]);
  });

  it('returns them bottom-left, bottom-right, top-left, top-right', () => {
    const [bl, br, tl, tr] = mountHoles(IPOSTER);
    expect(bl!.x).toBeLessThan(0); expect(bl!.y).toBeLessThan(0);
    expect(br!.x).toBeGreaterThan(0); expect(br!.y).toBeLessThan(0);
    expect(tl!.x).toBeLessThan(0); expect(tl!.y).toBeGreaterThan(0);
    expect(tr!.x).toBeGreaterThan(0); expect(tr!.y).toBeGreaterThan(0);
  });

  it('is symmetric about both axes — the pattern has no handedness', () => {
    const h = mountHoles(IPOSTER);
    expect(h.reduce((s, p) => s + p.x, 0)).toBeCloseTo(0, 10);
    expect(h.reduce((s, p) => s + p.y, 0)).toBeCloseTo(0, 10);
  });

  /**
   * The gap between two holes either side of a seam is what a rigger measures with a tape, so it
   * is worth stating once: two insets plus whatever the seam is. Bezels on, that is 0.06 in more
   * than bezels off.
   */
  it('leaves 2.3937 in between the holes either side of a flush seam', () => {
    const h = mountHoles(IPOSTER);
    const right = h[1]!.x, left = h[0]!.x;
    expect(IPOSTER.widthIn - right + left).toBeCloseTo(2 * 1.19685, 10);
  });

  it('has nothing to report for a spec that records no mount', () => {
    expect(mountHoles(variant({ mount: undefined }))).toEqual([]);
  });

  /**
   * A spec whose inset reaches past the middle is wrong. Four holes crossed over the centre line
   * would render as a deliberate pattern; nothing renders as nothing.
   */
  it('reports nothing rather than crossing the holes over when the inset overruns the face', () => {
    expect(mountHoles(variant({ mount: { ...IPOSTER.mount!, holeInsetIn: 12 } }))).toEqual([]);
    // Height is the shorter axis, so it fails first: 9.45 in of half-height against a 9.3 in inset.
    expect(mountHoles(variant({ mount: { ...IPOSTER.mount!, holeInsetIn: 9.3 } }))).toEqual([]);
    expect(mountHoles(variant({ mount: { ...IPOSTER.mount!, holeInsetIn: 9.2 } }))).toHaveLength(4);
  });

  it('reports nothing when the inset lands exactly on the centre line', () => {
    const exact = IPOSTER.heightIn / 2 - IPOSTER.mount!.boltDiaIn / 2;
    expect(mountHoles(variant({ mount: { ...IPOSTER.mount!, holeInsetIn: exact } }))).toEqual([]);
  });

  it('follows the face size, not a constant', () => {
    const big = mountHoles(variant({ widthIn: 50.4, heightIn: 37.8 }));
    expect(big.map(h => [+h.x.toFixed(5), +h.y.toFixed(5)])).toEqual([
      [-24.00315, -17.70315],
      [24.00315, -17.70315],
      [-24.00315, 17.70315],
      [24.00315, 17.70315],
    ]);
  });
});

describe('IPOSTER.mount', () => {
  it('records the measurement as M10 corner holes in the back face', () => {
    expect(IPOSTER.mount).toEqual({
      bolt: 'M10',
      boltDiaIn: 0.3937,
      holeInsetIn: 1,
      pattern: 'corners',
      face: 'back',
    });
  });

  it('states the bolt diameter as the inch value of M10', () => {
    expect(IPOSTER.mount!.boltDiaIn * 25.4).toBeCloseTo(10, 3);
  });
});
