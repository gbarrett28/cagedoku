/**
 * Hole-count feature extraction tests — hand-built synthetic shapes verify
 * the BFS outside flood-fill / hole-labelling algorithm without needing any
 * real digit thumbnails or OpenCV.
 */
import { describe, expect, it } from 'vitest';
import { extractHoleFeatures } from './holeFeatures.js';

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

function featuresFor(rows: string[]): Float64Array {
  const img = buildImage(rows);
  return extractHoleFeatures([img], rows.length);
}

describe('extractHoleFeatures', () => {
  it('open arc (0 holes): one-hot bucket 0, both fractions zero', () => {
    const f = featuresFor([
      '#######',
      '#......',
      '#......',
      '#......',
      '#......',
      '#......',
      '#######',
    ]);
    expect(Array.from(f.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(f[3]).toBe(0);
    expect(f[4]).toBe(0);
  });

  it('ring (1 hole): one-hot bucket 1, fraction matches interior/ink ratio', () => {
    const f = featuresFor([
      '########',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '########',
    ]);
    expect(Array.from(f.subarray(0, 3))).toEqual([0, 1, 0]);
    // interior 6x6=36 background px, ink = 64-36=28
    expect(f[3]).toBeCloseTo(36 / 28, 6);
    expect(f[4]).toBe(0);
  });

  it('figure-8 (2 holes): one-hot bucket 2+, two nonzero fractions sorted descending', () => {
    const f = featuresFor([
      '#######',
      '#.....#',
      '#.....#',
      '#######',
      '#.....#',
      '#.....#',
      '#######',
    ]);
    expect(Array.from(f.subarray(0, 3))).toEqual([0, 0, 1]);
    expect(f[3]).toBeGreaterThan(0);
    expect(f[4]).toBeGreaterThan(0);
    expect(f[3]!).toBeGreaterThanOrEqual(f[4]!);
  });

  it('sub-threshold noise speck is filtered out (treated as 0 holes)', () => {
    const f = featuresFor([
      '#######',
      '#######',
      '#######',
      '###.###',
      '#######',
      '#######',
      '#######',
    ]);
    expect(Array.from(f.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(f[3]).toBe(0);
    expect(f[4]).toBe(0);
  });
});
