import { describe, it, expect } from 'vitest';
import { buildPuzzleSpecExport } from './trainingExport.js';
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
