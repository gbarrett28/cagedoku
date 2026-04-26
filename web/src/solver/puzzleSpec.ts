/**
 * Validated puzzle contract passed from image processing to the solver.
 *
 * Mirrors Python's `PuzzleSpec` from `killer_sudoku.solver.puzzle_spec`.
 *
 * Array conventions:
 *   regions / cageTotals: [col][row], both 9×9.
 *   borderX: [col][rowGap], shape 9×8. borderX[col][rowGap] = wall between
 *     rows rowGap and rowGap+1 in column col.
 *   borderY: [colGap][row], shape 8×9. borderY[colGap][row] = wall between
 *     columns colGap and colGap+1 in row.
 */

import type { Brdrs } from './errors.js';

/**
 * Validated puzzle contract produced after all cage-layout consistency checks
 * have passed. Represents the clean boundary between the image pipeline and
 * the solver.
 */
export interface PuzzleSpec {
  /** (9, 9) 1-based cage index per cell; 0 means unassigned. [col][row] */
  regions: number[][];
  /** (9, 9) declared cage sum at each cage's head cell, 0 elsewhere. [col][row] */
  cageTotals: number[][];
  /**
   * (9, 8) horizontal cage-wall flags.
   * borderX[col][rowGap] = true means a wall between rows rowGap and rowGap+1
   * in column col.
   */
  borderX: boolean[][];
  /**
   * (8, 9) vertical cage-wall flags.
   * borderY[colGap][row] = true means a wall between columns colGap and
   * colGap+1 in row.
   */
  borderY: boolean[][];
}

/**
 * Expand compact border arrays to per-cell (9, 9, 4) form for rendering.
 *
 * borderX[col][rowGap] = true means a horizontal cage wall between rows rowGap
 * and rowGap+1 in column col (shape 9×8). borderY[colGap][row] = true means a
 * vertical cage wall between columns colGap and colGap+1 in row (shape 8×9).
 * Outer grid edges are always true (walled).
 *
 * Note: the loop variable `col` plays the role of row-index in the result
 * array for the isbv lines, and vice-versa. This mirrors the same naming
 * artefact in the Python source.
 *
 * @param borderX - (9, 8) horizontal cage-wall flags.
 * @param borderY - (8, 9) vertical cage-wall flags.
 * @returns (9, 9, 4) bool array; true means a wall is present.
 */
export function buildBrdrs(borderX: boolean[][], borderY: boolean[][]): Brdrs {
  // Initialise all edges as walled (true) — outer grid edges are always walls.
  const result: Brdrs = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [true, true, true, true])
  );

  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 8; row++) {
      const isbh = borderX[col]![row]!;
      const isbv = borderY[row]![col]!;
      // isbh: horizontal wall in column col, between rows row and row+1.
      result[row]![col]![1] = isbh;
      result[row + 1]![col]![3] = isbh;
      // isbv: vertical wall in row `row`, between cols `col` and `col`+1.
      // `col` acts as row-index into result here; `row` acts as col-index.
      result[col]![row]![2] = isbv;
      result[col]![row + 1]![0] = isbv;
    }
  }

  return result;
}
