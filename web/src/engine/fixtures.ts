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
  // Row-major: cage at (row=0,col=0) and (row=1,col=0), connected by open horizontal
  // wall in col 0 between rows 0 and 1.
  const total = KNOWN_SOLUTION[0]![0]! + KNOWN_SOLUTION[1]![0]!;
  const cageTotals: number[][] = KNOWN_SOLUTION.map(row => [...row]);
  cageTotals[0]![0] = total;  // row=0, col=0 is the cage head
  cageTotals[1]![0] = 0;      // row=1, col=0 is merged (no head)

  const borderX: boolean[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 8 }, () => true));
  borderX[0]![0] = false; // borderX[col=0][rowGap=0]: open wall between rows 0 and 1 in col 0

  const borderY: boolean[][] = Array.from({ length: 8 }, () =>
    Array.from({ length: 9 }, () => true));
  return validateCageLayout(cageTotals, borderX, borderY);
}

export const TWO_CELL_CAGE_TOTAL = KNOWN_SOLUTION[0]![0]! + KNOWN_SOLUTION[1]![0]!; // 5+6=11; // 8

/**
 * Return a PuzzleSpec where each 3×3 box forms its own 9-cell cage with total 45.
 *
 * Any permutation of {1..9} within each box satisfies the cage total, so no
 * individual cell value can be determined from these constraints alone. This
 * fixture is used by UI flow tests where cells must remain empty after confirm
 * (no auto-placement), making digit-entry and undo behaviour testable.
 */
export function makeBoxCageSpec(): PuzzleSpec {
  // 9 cages, one per 3×3 box.  Head cells at (row=boxRow, col=boxCol) for
  // boxRow, boxCol ∈ {0,3,6}.  All cells within a box are connected (no inner
  // walls); boxes are separated by walls at row-gaps 2,5 and col-gaps 2,5.
  const cageTotals: number[][] = Array.from({ length: 9 }, () =>
    new Array<number>(9).fill(0));
  for (const boxRow of [0, 3, 6]) {
    for (const boxCol of [0, 3, 6]) {
      cageTotals[boxRow]![boxCol] = 45;  // row-major: cageTotals[row][col]
    }
  }
  // borderX[col][rowGap]: wall present only at row-gaps 2 and 5 (box boundaries).
  const borderX: boolean[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 8 }, (_, rowGap) => rowGap === 2 || rowGap === 5));
  // borderY[colGap][row]: wall present only at col-gaps 2 and 5.
  const borderY: boolean[][] = Array.from({ length: 8 }, (_, colGap) =>
    Array.from({ length: 9 }, () => colGap === 2 || colGap === 5));
  return validateCageLayout(cageTotals, borderX, borderY);
}

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
  // Row-major: cage at (row=0,col=0), (row=1,col=0), (row=2,col=0) — a 3-cell
  // vertical run in column 0.  Connected by two open horizontal walls in col 0.
  const total = KNOWN_SOLUTION[0]![0]! + KNOWN_SOLUTION[1]![0]! + KNOWN_SOLUTION[2]![0]!;
  const cageTotals = makeTrivialCageTotals();
  cageTotals[0]![0] = total;  // row=0, col=0 is the cage head
  cageTotals[1]![0] = 0;      // row=1, col=0 is merged
  cageTotals[2]![0] = 0;      // row=2, col=0 is merged

  const borderX = makeTrivialBorderX();
  borderX[0]![0] = false;  // borderX[col=0][rowGap=0]: open between rows 0 and 1
  borderX[0]![1] = false;  // borderX[col=0][rowGap=1]: open between rows 1 and 2

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
  // 4-cell cage at (row=5,col=0), (row=6,col=0), (row=7,col=0), (row=7,col=1)
  // — an L-shape in the bottom-left area.  Head at (row=5,col=0), total=24.
  // Connected by two open horizontal walls in col=0 and one open vertical wall
  // in row=7.
  const cageTotals = makeTrivialCageTotals();
  cageTotals[5]![0] = 24;  // row=5, col=0 — cage head
  cageTotals[6]![0] = 0;   // row=6, col=0 — merged
  cageTotals[7]![0] = 0;   // row=7, col=0 — merged
  cageTotals[7]![1] = 0;   // row=7, col=1 — merged

  const borderX = makeTrivialBorderX();
  borderX[0]![5] = false;  // borderX[col=0][rowGap=5]: open between rows 5 and 6
  borderX[0]![6] = false;  // borderX[col=0][rowGap=6]: open between rows 6 and 7

  const borderY = makeTrivialBorderY();
  borderY[0]![7] = false;  // borderY[colGap=0][row=7]: open between col 0 and 1 in row 7

  return validateCageLayout(cageTotals, borderX, borderY);
}
