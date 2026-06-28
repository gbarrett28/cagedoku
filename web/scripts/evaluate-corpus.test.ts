import { describe, expect, it } from 'vitest';

describe('contour dump JSON schema', () => {
  it('is valid for a well-formed patch entry', () => {
    const entry = {
      pixels: new Array(64 * 64).fill(0),
      depth: 2,
      fillRatio: 0.42,
      w: 18,
      h: 22,
    };
    expect(entry.pixels).toHaveLength(64 * 64);
    expect(entry.depth).toBeGreaterThanOrEqual(2);
    expect(entry.fillRatio).toBeGreaterThanOrEqual(0);
    expect(entry.fillRatio).toBeLessThanOrEqual(1);
    expect(entry.w).toBeGreaterThan(0);
    expect(entry.h).toBeGreaterThan(0);
  });
});
