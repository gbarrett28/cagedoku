import { describe, expect, it } from 'vitest';
import { extractAspectFeatures } from './aspectFeatures.js';

function buildImage(rows: string[]): Uint8Array {
  const size = rows.length;
  const img = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      img[y * size + x] = rows[y]![x] === '#' ? 255 : 0;
    }
  }
  return img;
}

describe('extractAspectFeatures', () => {
  it('reports a small ratio for a narrow, tall glyph (like "1")', () => {
    const img = buildImage([
      '.#.....',
      '.#.....',
      '.#.....',
      '.#.....',
      '.#.....',
      '.#.....',
      '.#.....',
    ]);
    const [ratio] = extractAspectFeatures([img], 7);
    // ink bbox is 1 column wide, 7 rows tall -> 1/7
    expect(ratio).toBeCloseTo(1 / 7);
  });

  it('reports a larger ratio for a wide glyph (like "7")', () => {
    const img = buildImage([
      '#######',
      '......#',
      '.....#.',
      '....#..',
      '...#...',
      '..#....',
      '.#.....',
    ]);
    const [ratio] = extractAspectFeatures([img], 7);
    // ink bbox spans the full 7x7 extent -> 1.0
    expect(ratio).toBeCloseTo(1);
  });

  it('returns 0 for a blank image with no ink', () => {
    const img = buildImage([
      '.......',
      '.......',
      '.......',
    ]);
    const [ratio] = extractAspectFeatures([img], 7);
    expect(ratio).toBe(0);
  });

  it('computes independent ratios per image in a batch', () => {
    const narrow = buildImage(['.#', '.#']);
    const wide = buildImage(['##', '..']);
    const [r1, r2] = extractAspectFeatures([narrow, wide], 2);
    expect(r1).toBeCloseTo(1 / 2);
    expect(r2).toBeCloseTo(2 / 1);
  });
});
