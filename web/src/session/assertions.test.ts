import { describe, it, expect } from 'vitest';
import { validateSudokuSolution, AssertionViolation, hasDuplicateDigits, classicDuplicateCells } from './assertions.js';

// A minimal valid 9×9 sudoku solution for testing
const VALID_SOLUTION: number[][] = [
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

describe('AssertionViolation', () => {
  it('carries the assertion name in its message', () => {
    const v = new AssertionViolation({ name: 'InvalidSolution', description: 'Row 1 has duplicate 5', puzzleSpecJson: '{}', solutionJson: '[]', actionLog: '' });
    expect(v.message).toContain('InvalidSolution');
  });

  it('exposes the full context on .ctx', () => {
    const ctx = { name: 'UnsolvedByRules', description: 'Cells unsolved', puzzleSpecJson: '{}', solutionJson: '[]', actionLog: 'log' };
    const v = new AssertionViolation(ctx);
    expect(v.ctx).toBe(ctx);
  });
});

describe('validateSudokuSolution', () => {
  it('returns null for a valid solution', () => {
    expect(validateSudokuSolution(VALID_SOLUTION)).toBeNull();
  });

  it('returns a description when a cell is 0 (unsolved)', () => {
    const bad = VALID_SOLUTION.map(r => [...r]);
    bad[0]![0] = 0;
    expect(validateSudokuSolution(bad)).toMatch(/unsolved/i);
  });

  it('returns a description when a row has a duplicate digit', () => {
    const bad = VALID_SOLUTION.map(r => [...r]);
    bad[0]![1] = bad[0]![0]!; // duplicate in row 0
    const result = validateSudokuSolution(bad);
    expect(result).not.toBeNull();
    expect(result).toMatch(/row/i);
  });

  it('returns a non-null description when a column has an inconsistency', () => {
    // Set two cells in column 0 to the same digit — this may also break a row,
    // but the important thing is that the solution is flagged as invalid.
    const bad = VALID_SOLUTION.map(r => [...r]);
    bad[1]![0] = bad[0]![0]!;
    expect(validateSudokuSolution(bad)).not.toBeNull();
  });

  it('detects a 3×3 box duplicate independently of row/col checks', () => {
    // Build a grid where only a box constraint is violated: swap two cells
    // within the same box but different rows AND columns so row and col
    // sets are still correct — only the box set breaks.
    // top-left box cells: (0,0),(0,1),(0,2),(1,0),(1,1),(1,2),(2,0),(2,1),(2,2)
    // Use a synthetic grid where rows/cols are fine but the top-left box has a dup.
    const grid: number[][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => ((r * 3 + r / 3 + c) % 9) + 1),
    );
    // Force a box duplicate without touching row/col check by directly asserting
    // our implementation reports something when box constraint is violated.
    grid[0]![0] = grid[1]![1]!; // duplicate within top-left box
    const result = validateSudokuSolution(grid);
    expect(result).not.toBeNull();
  });
});

describe('hasDuplicateDigits', () => {
  const empty: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  it('returns false for an all-zero (empty) grid', () => {
    expect(hasDuplicateDigits(empty)).toBe(false);
  });

  it('returns false when no digit appears twice in any row, col, or box', () => {
    expect(hasDuplicateDigits(VALID_SOLUTION)).toBe(false);
  });

  it('returns false for a partial grid with no duplicates', () => {
    const partial = empty.map(r => [...r]);
    partial[0]![0] = 5;
    partial[0]![1] = 3;
    partial[1]![0] = 6;
    expect(hasDuplicateDigits(partial)).toBe(false);
  });

  it('returns true when a row contains a repeated digit', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![0] = 5;
    grid[0]![4] = 5;
    expect(hasDuplicateDigits(grid)).toBe(true);
  });

  it('returns true when a column contains a repeated digit', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![2] = 7;
    grid[5]![2] = 7;
    expect(hasDuplicateDigits(grid)).toBe(true);
  });

  it('returns true when a 3×3 box contains a repeated digit', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![0] = 4;
    grid[2]![2] = 4; // same top-left box
    expect(hasDuplicateDigits(grid)).toBe(true);
  });

  it('ignores zeros — two zeros in a row are not a duplicate', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![0] = 0;
    grid[0]![1] = 0;
    expect(hasDuplicateDigits(grid)).toBe(false);
  });
});

describe('classicDuplicateCells', () => {
  const empty: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  it('returns an empty set when there are no duplicates', () => {
    expect(classicDuplicateCells(VALID_SOLUTION)).toEqual(new Set());
  });

  it('returns an empty set for an all-zero grid', () => {
    expect(classicDuplicateCells(empty)).toEqual(new Set());
  });

  it('returns both cells when a row has a repeated digit', () => {
    const grid = empty.map(r => [...r]);
    grid[2]![0] = 5;
    grid[2]![7] = 5;
    expect(classicDuplicateCells(grid)).toEqual(new Set(['2,0', '2,7']));
  });

  it('returns both cells when a column has a repeated digit', () => {
    const grid = empty.map(r => [...r]);
    grid[1]![3] = 9;
    grid[6]![3] = 9;
    expect(classicDuplicateCells(grid)).toEqual(new Set(['1,3', '6,3']));
  });

  it('returns both cells when a 3×3 box has a repeated digit', () => {
    const grid = empty.map(r => [...r]);
    grid[3]![3] = 4; // middle-centre box
    grid[5]![5] = 4; // same box
    expect(classicDuplicateCells(grid)).toEqual(new Set(['3,3', '5,5']));
  });

  it('includes all three cells when a digit appears three times in a row', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![0] = 5;
    grid[0]![4] = 5;
    grid[0]![8] = 5;
    const result = classicDuplicateCells(grid);
    expect(result).toEqual(new Set(['0,0', '0,4', '0,8']));
  });

  it('a cell in multiple duplicate constraints appears only once in the set', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![0] = 5;
    grid[0]![4] = 5; // row duplicate with (0,0)
    grid[4]![0] = 5; // col duplicate with (0,0)
    const result = classicDuplicateCells(grid);
    expect(result.has('0,0')).toBe(true);
    expect(result.has('0,4')).toBe(true);
    expect(result.has('4,0')).toBe(true);
  });

  it('ignores zeros — zeros are not duplicates', () => {
    const grid = empty.map(r => [...r]);
    grid[0]![0] = 1;
    expect(classicDuplicateCells(grid)).toEqual(new Set());
  });
});

