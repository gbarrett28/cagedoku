/**
 * Tests for LinearSystem virtual-cage derivation.
 */

import { describe, expect, it } from 'vitest';
import { LinearSystem } from './linearSystem.js';
import { makeThreeCellCageSpec, makeRowCageSpec, makeOutieSpec, KNOWN_SOLUTION, makeTrivialBorderX, makeTrivialBorderY } from './fixtures.js';
import { validateCageLayout } from '../image/validation.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import type { Cell } from './types.js';

const specs: ReadonlyArray<[string, PuzzleSpec]> = [
  ['three-cell cage spec', makeThreeCellCageSpec()],
  ['row cage spec', makeRowCageSpec()],
  ['outie spec', makeOutieSpec()],
];

describe('LinearSystem._deriveNonburbVirtualCages', () => {
  it.each(specs)('derives virtual cages with precomputedSolns: null for %s', (_name, spec) => {
    const ls = new LinearSystem(spec);
    expect(ls.virtualCages.length).toBeGreaterThan(0);
    for (const vc of ls.virtualCages) {
      expect(vc.precomputedSolns).toBeNull();
    }
  });

  it.each(specs)('every derived virtual cage cell set is non-empty and within bounds for %s', (_name, spec) => {
    const ls = new LinearSystem(spec);
    for (const vc of ls.virtualCages) {
      expect(vc.cells.length).toBeGreaterThan(0);
      expect(vc.cells.length).toBeLessThanOrEqual(9);
      for (const [r, c] of vc.cells) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(8);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(8);
      }
    }
  });
});

function makeCrossBoxDeltaSpec(): PuzzleSpec {
  // Two 3-cell cages straddling the box0/box1 boundary in rows 0-1. Combined with
  // box0's own sum-45 equation, RREF reduces this to a genuinely mixed-sign live
  // row -- (0,2) - (1,3) - (1,4) = -6 -- that only becomes a clean two-term delta
  // pair, (0,2) - (1,3) = 3, once (1,4) is substituted mid-solve.
  const cageTotals = KNOWN_SOLUTION.map(row => [...row]);
  const borderX = makeTrivialBorderX();
  const borderY = makeTrivialBorderY();

  const cageA = KNOWN_SOLUTION[0]![2]! + KNOWN_SOLUTION[0]![3]! + KNOWN_SOLUTION[0]![4]!;
  cageTotals[0]![2] = cageA; cageTotals[0]![3] = 0; cageTotals[0]![4] = 0;
  borderY[2]![0] = false; // open colGap=2, row=0 -> connects (0,2)-(0,3)
  borderY[3]![0] = false; // open colGap=3, row=0 -> connects (0,3)-(0,4)

  const cageF = KNOWN_SOLUTION[1]![2]! + KNOWN_SOLUTION[1]![3]! + KNOWN_SOLUTION[1]![4]!;
  cageTotals[1]![2] = cageF; cageTotals[1]![3] = 0; cageTotals[1]![4] = 0;
  borderY[2]![1] = false; // open colGap=2, row=1 -> connects (1,2)-(1,3)
  borderY[3]![1] = false; // open colGap=3, row=1 -> connects (1,3)-(1,4)

  return validateCageLayout(cageTotals, borderX, borderY);
}

describe('LinearSystem.substituteLiveRows — delta-pair derivation', () => {
  it('has no delta pair for (0,2)/(1,3) at construction', () => {
    const ls = new LinearSystem(makeCrossBoxDeltaSpec());
    expect(ls.pairsForCell([0, 2] as Cell)).toEqual([]);
  });

  it('derives a fresh delta pair once the shared cell (1,4) is substituted', () => {
    const ls = new LinearSystem(makeCrossBoxDeltaSpec());
    const v4 = KNOWN_SOLUTION[1]![4]!; // 9
    ls.substituteLiveRows([1, 4] as Cell, v4);

    expect(ls.deltaPairs).toContainEqual([[0, 2], [1, 3], 3]);
    expect(ls.pairsForCell([0, 2] as Cell)).toContainEqual([[0, 2], [1, 3], 3]);
    expect(ls.pairsForCell([1, 3] as Cell)).toContainEqual([[0, 2], [1, 3], 3]);
  });

  it('still derives the unrelated virtual-cage and single-cell results from the same substitution', () => {
    const ls = new LinearSystem(makeCrossBoxDeltaSpec());
    const v4 = KNOWN_SOLUTION[1]![4]!;
    const result = ls.substituteLiveRows([1, 4] as Cell, v4);

    expect(result).toContainEqual([[[0, 4]], KNOWN_SOLUTION[0]![4]!, true]);
    expect(result).toContainEqual([[[1, 2], [1, 3]], KNOWN_SOLUTION[1]![2]! + KNOWN_SOLUTION[1]![3]!, true]);
  });
});

describe('LinearSystem._deriveTailEliminations', () => {
  // killer_sudoku_293.jpg (observer corpus) -- the puzzle whose rule-based solve
  // stalls after only 3 cells and falls back to backtracking. Two live rows
  // produced by the constructor's own RREF pass -- one for cage M+N+O+P+Q's
  // combination, one for cage M+N+O+P+S's -- share an identical three-cell tail
  // (R8C7, R9C7, R9C8, i.e. (7,6),(8,6),(8,7)) with matching coefficients.
  // Subtracting one from the other cancels the tail and reveals
  // R7C4 - R6C7 = 8, a delta pair the single-pass RREF didn't produce as one of
  // its own basis rows (RREF guarantees independence across pivot columns, not
  // that every such pairwise cancellation has already been found).
  const spec293: PuzzleSpec = {
    regions: [
      [1, 2, 2, 2, 3, 3, 4, 5, 5],
      [1, 6, 6, 2, 7, 7, 4, 8, 8],
      [6, 6, 9, 9, 9, 7, 4, 10, 10],
      [11, 11, 12, 9, 13, 14, 14, 15, 16],
      [12, 12, 12, 17, 13, 14, 14, 15, 16],
      [18, 18, 17, 17, 13, 13, 19, 15, 16],
      [18, 20, 20, 17, 21, 21, 19, 19, 22],
      [23, 23, 20, 24, 24, 21, 21, 19, 22],
      [25, 25, 20, 24, 24, 26, 26, 26, 22],
    ],
    cageTotals: [
      [9, 20, 0, 0, 7, 0, 22, 11, 0],
      [0, 20, 0, 0, 18, 0, 0, 5, 0],
      [0, 0, 19, 0, 0, 0, 0, 7, 0],
      [9, 0, 24, 0, 23, 16, 0, 16, 19],
      [0, 0, 0, 25, 0, 0, 0, 0, 0],
      [10, 0, 0, 0, 0, 0, 23, 0, 0],
      [0, 16, 0, 0, 12, 0, 0, 0, 14],
      [12, 0, 0, 19, 0, 0, 0, 0, 0],
      [15, 0, 0, 0, 0, 14, 0, 0, 0],
    ],
    borderX: [
      [false, true, true, true, true, false, true, true],
      [true, false, true, true, true, true, true, true],
      [true, true, true, false, true, true, false, false],
      [false, true, false, true, false, false, true, false],
      [true, true, true, false, false, true, true, false],
      [true, false, true, false, true, true, false, true],
      [false, false, true, false, true, false, true, true],
      [true, true, true, false, false, true, false, true],
      [true, true, true, false, false, true, false, false],
    ],
    borderY: [
      [true, true, false, false, false, false, true, false, false],
      [false, false, true, true, false, true, false, true, true],
      [false, true, false, true, true, false, true, true, true],
      [true, true, false, true, true, true, true, false, false],
      [false, false, true, true, true, false, false, true, true],
      [true, true, true, false, false, true, true, false, false],
      [true, true, true, true, true, true, false, true, false],
      [false, false, false, true, true, true, true, true, true],
    ],
  };

  it('derives R7C4 - R6C7 = 8 at construction, with no cell substitutions needed', () => {
    const ls = new LinearSystem(spec293);
    expect(ls.pairsForCell([6, 3] as Cell)).toContainEqual([[5, 6], [6, 3], -8]);
    expect(ls.pairsForCell([5, 6] as Cell)).toContainEqual([[5, 6], [6, 3], -8]);
  });
});
