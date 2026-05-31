import { describe, it, expect, vi } from 'vitest';
import { extractTrainingData } from './trainingExport.js';

describe('extractTrainingData', () => {
  // Helper: build a minimal cageTotals grid (9×9) with one non-zero entry.
  function cageGrid(row: number, col: number, total: number): number[][] {
    const g = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    g[row]![col] = total;
    return g;
  }

  it('produces one sample for a single-digit cage cell', () => {
    const pixels = new Uint8Array(64 * 64).fill(128);
    const thumbs = new Map([['0,0', [pixels]]]);
    const exp = extractTrainingData(thumbs, cageGrid(0, 0, 5), 'killer', 28);
    expect(exp.sampleCount).toBe(1);
    expect(exp.samples[0]!.digit).toBe(5);
    expect(exp.samples[0]!.pixels).toHaveLength(64 * 64);
  });

  it('produces two samples for a two-digit cage cell (total=15)', () => {
    const px1 = new Uint8Array(64 * 64).fill(10);
    const px2 = new Uint8Array(64 * 64).fill(20);
    const thumbs = new Map([['0,3', [px1, px2]]]);
    const exp = extractTrainingData(thumbs, cageGrid(0, 3, 15), 'killer', 28);
    expect(exp.sampleCount).toBe(2);
    expect(exp.samples[0]!.digit).toBe(1);
    expect(exp.samples[1]!.digit).toBe(5);
  });

  it('skips cells where total is 0', () => {
    const thumbs = new Map([['2,2', [new Uint8Array(64 * 64)]]]);
    // cageGrid leaves (2,2) as 0
    const empty = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const exp = extractTrainingData(thumbs, empty, 'killer', 28);
    expect(exp.sampleCount).toBe(0);
    expect(exp.samples).toHaveLength(0);
  });

  it('skips and warns when digit count does not match thumbnail count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // total=15 (2 digits) but only 1 thumbnail
    const thumbs = new Map([['0,0', [new Uint8Array(64 * 64)]]]);
    const exp = extractTrainingData(thumbs, cageGrid(0, 0, 15), 'killer', 28);
    expect(exp.sampleCount).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('populates splitSamples when mergedThumbs is provided', () => {
    const px1 = new Uint8Array(64 * 64).fill(10);
    const px2 = new Uint8Array(64 * 64).fill(20);
    const merged = new Uint8Array(64 * 64).fill(99);
    const thumbs = new Map([['0,3', [px1, px2]]]);
    const mergedThumbs = new Map([['0,3', merged]]);
    const exp = extractTrainingData(thumbs, cageGrid(0, 3, 15), 'killer', 28, mergedThumbs);
    const splits = exp.splitSamples ?? [];
    expect(splits).toHaveLength(1);
    expect(splits[0]!.splitCount).toBe(2);
    expect(splits[0]!.pixels).toHaveLength(64 * 64);
  });

  it('single-digit cells with mergedThumbs get splitCount 1', () => {
    const px = new Uint8Array(64 * 64).fill(5);
    const merged = new Uint8Array(64 * 64).fill(5);
    const thumbs = new Map([['0,0', [px]]]);
    const mergedThumbs = new Map([['0,0', merged]]);
    const exp = extractTrainingData(thumbs, cageGrid(0, 0, 7), 'killer', 28, mergedThumbs);
    expect((exp.splitSamples ?? [])[0]!.splitCount).toBe(1);
  });

  it('passes puzzleType and subres through', () => {
    const exp = extractTrainingData(new Map(), cageGrid(0, 0, 0), 'classic', 32);
    expect(exp.puzzleType).toBe('classic');
    expect(exp.subres).toBe(32);
  });

  it('returns version 1 and thumbnailSize 64', () => {
    const exp = extractTrainingData(new Map(), cageGrid(0, 0, 0), 'killer', 28);
    expect(exp.version).toBe(1);
    expect(exp.thumbnailSize).toBe(64);
  });
});
