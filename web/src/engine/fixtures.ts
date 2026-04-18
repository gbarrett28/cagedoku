/**
 * Shared test fixtures for engine unit tests.
 *
 * Mirrors Python's `tests/fixtures/minimal_puzzle.py`.
 *
 * Constructs a valid 9×9 killer sudoku where every cell is its own single-cell
 * cage. This is the simplest possible puzzle: each cage has exactly one cell
 * and its total equals the digit that must go there.
 *
 * No image files, model files, or external resources are required.
 */

import { validateCageLayout } from '../image/validation.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';

/** A known valid sudoku solution used as the basis for the trivial puzzle. */
export const KNOWN_SOLUTION: readonly (readonly number[])[] = [
  [5, 3, 4, 6, 7, 8, 9, 1, 2],
  [6, 7, 2, 1, 9, 5, 3, 4, 8],
  [1, 9, 8, 3, 4, 2, 5, 6, 7],
  [8, 5, 9, 7, 6, 1, 4, 2, 3],
  [4, 2, 6, 8, 5, 3, 7, 9, 1],
  [7, 1, 3, 9, 2, 4, 8, 5, 6],
  [9, 6, 1, 5, 3, 7, 2, 8, 4],
  [2, 8, 7, 4, 1, 9, 6, 3, 5],
  [3, 4, 5, 2, 8, 6, 1, 7, 9],
];

/**
 * Return a PuzzleSpec where every cell is its own single-cell cage.
 *
 * cageTotals[col][row] = KNOWN_SOLUTION[col][row] (PuzzleSpec [col][row]
 * convention; no transposition needed because both Python and TS use the
 * same index ordering for this fixture).
 *
 * borderX[col][rowGap] = true (all horizontal walls present).
 * borderY[colGap][row] = true (all vertical walls present).
 */
export function makeTrivialSpec(): PuzzleSpec {
  const cageTotals: number[][] = KNOWN_SOLUTION.map(row => [...row]);
  const borderX: boolean[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 8 }, () => true));
  const borderY: boolean[][] = Array.from({ length: 8 }, () =>
    Array.from({ length: 9 }, () => true));
  return validateCageLayout(cageTotals, borderX, borderY);
}

/**
 * Return a PuzzleSpec where BoardState cells (0,0) and (0,1) form one cage.
 *
 * All other cells remain as single-cell cages.
 * Cage total = 8 (KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1] = 5 + 3).
 *
 * Border removal: borderX[col=0][rowGap=0] = false removes the wall between
 * validation (col=0, row=0) and (col=0, row=1), which equals BoardState cells
 * (0,0) and (0,1).
 */
export function makeTwoCellCageSpec(): PuzzleSpec {
  const total = KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1]; // 8
  const cageTotals: number[][] = KNOWN_SOLUTION.map(row => [...row]);
  cageTotals[0][0] = total;
  cageTotals[0][1] = 0;

  const borderX: boolean[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 8 }, () => true));
  borderX[0][0] = false; // open wall between (col=0,row=0) and (col=0,row=1)

  const borderY: boolean[][] = Array.from({ length: 8 }, () =>
    Array.from({ length: 9 }, () => true));
  return validateCageLayout(cageTotals, borderX, borderY);
}

export const TWO_CELL_CAGE_TOTAL = KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1]; // 8

// ---------------------------------------------------------------------------
// Lower-level helpers (mirrors Python's make_trivial_cage_totals etc.)
// ---------------------------------------------------------------------------

/** Return a mutable copy of the KNOWN_SOLUTION array as cageTotals[col][row]. */
export function makeTrivialCageTotals(): number[][] {
  return KNOWN_SOLUTION.map(row => [...row]);
}

/** Return an all-true (9, 8) borderX[col][rowGap] array. */
export function makeTrivialBorderX(): boolean[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true));
}

/** Return an all-true (8, 9) borderY[colGap][row] array. */
export function makeTrivialBorderY(): boolean[][] {
  return Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => true));
}

/**
 * Return a PuzzleSpec where BoardState cells (0,0), (0,1), (0,2) form one cage.
 *
 * All other cells remain as single-cell cages.
 * Cage total = 12 (KNOWN_SOLUTION[0][0]+[0][1]+[0][2] = 5+3+4).
 *
 * Wall removal: borderX[col=0][rowGap=0] and borderX[col=0][rowGap=1] — removes
 * walls between BS(0,0)↔(0,1) and BS(0,1)↔(0,2) respectively.
 */
export function makeThreeCellCageSpec(): PuzzleSpec {
  const total = KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1] + KNOWN_SOLUTION[0][2]; // 12
  const cageTotals = makeTrivialCageTotals();
  cageTotals[0][0] = total;
  cageTotals[0][1] = 0;
  cageTotals[0][2] = 0;

  const borderX = makeTrivialBorderX();
  borderX[0][0] = false;
  borderX[0][1] = false;

  return validateCageLayout(cageTotals, borderX, makeTrivialBorderY());
}

/**
 * Return a PuzzleSpec with a 4-cell cage {BS(0,5), BS(0,6), BS(0,7), BS(1,7)}.
 *
 * Used by MustContainOutie tests. Cage total = 24 ({1,6,8,9} sums to 24).
 * All other cells are single-cell cages from KNOWN_SOLUTION.
 *
 * Wall removal:
 *   borderX[0][5] = false → BS(0,5)↔BS(0,6)
 *   borderX[0][6] = false → BS(0,6)↔BS(0,7)
 *   borderY[0][7] = false → BS(0,7)↔BS(1,7)
 */
export function makeOutieSpec(): PuzzleSpec {
  const cageTotals = makeTrivialCageTotals();
  cageTotals[0][5] = 24;
  cageTotals[0][6] = 0;
  cageTotals[0][7] = 0;
  cageTotals[1][7] = 0;

  const borderX = makeTrivialBorderX();
  borderX[0][5] = false;
  borderX[0][6] = false;

  const borderY = makeTrivialBorderY();
  borderY[0][7] = false;

  return validateCageLayout(cageTotals, borderX, borderY);
}
