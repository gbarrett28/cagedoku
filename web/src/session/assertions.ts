export interface AssertionContext {
  name: string;
  description: string;
  puzzleSpecJson: string;
  solutionJson: string;
  actionLog: string;
}

export class AssertionViolation extends Error {
  readonly ctx: AssertionContext;
  constructor(ctx: AssertionContext) {
    super(`[Assertion] ${ctx.name}: ${ctx.description}`);
    this.ctx = ctx;
  }
}

/**
 * Validates a 9×9 sudoku solution grid.
 * Returns null if valid, or a human-readable description of the first problem found.
 */
export function validateSudokuSolution(solution: number[][]): string | null {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if ((solution[r]![c] ?? 0) === 0) return `Cell r${r + 1}c${c + 1} is unsolved (0)`;
    }
  }
  for (let r = 0; r < 9; r++) {
    const seen = new Set<number>();
    for (let c = 0; c < 9; c++) {
      const d = solution[r]![c]!;
      if (seen.has(d)) return `Row ${r + 1} has duplicate digit ${d}`;
      seen.add(d);
    }
  }
  for (let c = 0; c < 9; c++) {
    const seen = new Set<number>();
    for (let r = 0; r < 9; r++) {
      const d = solution[r]![c]!;
      if (seen.has(d)) return `Col ${c + 1} has duplicate digit ${d}`;
      seen.add(d);
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const seen = new Set<number>();
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          const d = solution[br * 3 + dr]![bc * 3 + dc]!;
          if (seen.has(d)) return `Box (${br + 1},${bc + 1}) has duplicate digit ${d}`;
          seen.add(d);
        }
      }
    }
  }
  return null;
}

/**
 * Returns true if any non-zero digit appears more than once in the same row,
 * column, or 3×3 box. Zeros (empty cells) are ignored.
 */
export function hasDuplicateDigits(grid: readonly (readonly number[])[]): boolean {
  for (let r = 0; r < 9; r++) {
    const seen = new Set<number>();
    for (let c = 0; c < 9; c++) {
      const d = grid[r]![c]!;
      if (d !== 0) { if (seen.has(d)) return true; seen.add(d); }
    }
  }
  for (let c = 0; c < 9; c++) {
    const seen = new Set<number>();
    for (let r = 0; r < 9; r++) {
      const d = grid[r]![c]!;
      if (d !== 0) { if (seen.has(d)) return true; seen.add(d); }
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const seen = new Set<number>();
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          const d = grid[br * 3 + dr]![bc * 3 + dc]!;
          if (d !== 0) { if (seen.has(d)) return true; seen.add(d); }
        }
      }
    }
  }
  return false;
}

/** Returns the set of `"row,col"` (0-based) cell keys that participate in any row, column,
 *  or 3×3 box duplicate. Zeros are never treated as duplicates. */
export function classicDuplicateCells(grid: readonly (readonly number[])[]): Set<string> {
  const errorCells = new Set<string>();
  const check = (cells: [number, number][]) => {
    const seen = new Map<number, string>();
    for (const [r, c] of cells) {
      const d = grid[r]![c]!;
      if (d === 0) continue;
      const key = `${r},${c}`;
      const prev = seen.get(d);
      if (prev !== undefined) { errorCells.add(key); errorCells.add(prev); }
      else seen.set(d, key);
    }
  };
  for (let i = 0; i < 9; i++) {
    check(Array.from({ length: 9 }, (_, j): [number, number] => [i, j]));
    check(Array.from({ length: 9 }, (_, j): [number, number] => [j, i]));
  }
  for (let br = 0; br < 3; br++)
    for (let bc = 0; bc < 3; bc++)
      check(Array.from({ length: 9 }, (_, k): [number, number] =>
        [br * 3 + Math.floor(k / 3), bc * 3 + (k % 3)]));
  return errorCells;
}
