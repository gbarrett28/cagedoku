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
