import { describe, it, expect, vi } from 'vitest';
import { buildPuzzleSpecExport, buildStallStateExport, extractTrainingData } from './trainingExport.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';

const minimalSpec: PuzzleSpec = {
  regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (__, c) => r * 9 + c + 1)),
  cageTotals: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
  borderX: Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false)),
  borderY: Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false)),
};

describe('buildPuzzleSpecExport', () => {
  it('produces version 2 with puzzleType killer', () => {
    const exp = buildPuzzleSpecExport(minimalSpec);
    expect(exp.version).toBe(2);
    expect(exp.puzzleType).toBe('killer');
  });

  it('sets exportedAt to a valid ISO string', () => {
    const exp = buildPuzzleSpecExport(minimalSpec);
    expect(() => new Date(exp.exportedAt)).not.toThrow();
    expect(new Date(exp.exportedAt).toISOString()).toBe(exp.exportedAt);
  });

  it('copies regions as a deep clone (9x9)', () => {
    const exp = buildPuzzleSpecExport(minimalSpec);
    expect(exp.regions).toHaveLength(9);
    expect(exp.regions[0]).toHaveLength(9);
    // mutations to the export must not affect the original
    exp.regions[0]![0] = 999;
    expect(minimalSpec.regions[0]![0]).not.toBe(999);
  });

  it('copies borderX as a deep clone (9x8)', () => {
    const exp = buildPuzzleSpecExport(minimalSpec);
    expect(exp.borderX).toHaveLength(9);
    expect(exp.borderX[0]).toHaveLength(8);
  });

  it('copies borderY as a deep clone (8x9)', () => {
    const exp = buildPuzzleSpecExport(minimalSpec);
    expect(exp.borderY).toHaveLength(8);
    expect(exp.borderY[0]).toHaveLength(9);
  });
});

describe('buildStallStateExport', () => {
  const stalledCandidates = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3]),
  );

  it('returns version 1', () => {
    const exp = buildStallStateExport('killer', stalledCandidates);
    expect(exp.version).toBe(1);
  });

  it('passes puzzleType through', () => {
    expect(buildStallStateExport('killer', stalledCandidates).puzzleType).toBe('killer');
    expect(buildStallStateExport('classic', stalledCandidates).puzzleType).toBe('classic');
  });

  it('passes stalledCandidates through (same reference)', () => {
    const exp = buildStallStateExport('killer', stalledCandidates);
    expect(exp.stalledCandidates).toBe(stalledCandidates);
  });

  it('sets exportedAt to a valid ISO string', () => {
    const exp = buildStallStateExport('killer', stalledCandidates);
    expect(new Date(exp.exportedAt).toISOString()).toBe(exp.exportedAt);
  });
});

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
