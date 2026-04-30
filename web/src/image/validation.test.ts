/**
 * Tests for image/validation.ts — Stage 2 union-find cage layout validation.
 *
 * All tests are pure-logic (no OpenCV dependency) and run in the standard
 * Vitest node environment.
 */

import { describe, expect, it } from 'vitest';
import { validateCageLayout } from './validation.js';
import { ProcessingError } from '../solver/errors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Border arrays where every inner edge is a cage wall (81 single-cell cages). */
function allWallsBorderX(): boolean[][] {
  return Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
}
function allWallsBorderY(): boolean[][] {
  return Array.from({ length: 8 }, () => new Array<boolean>(9).fill(true));
}

/**
 * Trivial cage-totals array: every cell is its own cage head with total=5.
 * Valid because size=1 allows totals in [1,9].
 */
function trivialCageTotals(): number[][] {
  return Array.from({ length: 9 }, () => new Array<number>(9).fill(5));
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe('validateCageLayout — valid inputs', () => {
  it('accepts 81 single-cell cages (trivial spec)', () => {
    const spec = validateCageLayout(
      trivialCageTotals(),
      allWallsBorderX(),
      allWallsBorderY(),
    );
    expect(spec.regions).toHaveLength(9);
    // All 81 cells are assigned — regions[row][col] > 0 for every cell
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(spec.regions[r]![c]!).toBeGreaterThan(0);
  });

  it('produces 81 distinct cage indices for trivial spec', () => {
    const spec = validateCageLayout(
      trivialCageTotals(),
      allWallsBorderX(),
      allWallsBorderY(),
    );
    const indices = new Set<number>();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        indices.add(spec.regions[r]![c]!);
    expect(indices.size).toBe(81);
  });

  it('accepts a valid 2-cell cage spanning rows 0-1 in col 0 (vertical neighbours)', () => {
    // borderX[col][rowGap] = false opens the horizontal wall between rows 0 and 1 in col 0.
    const borderX = allWallsBorderX();
    borderX[0]![0] = false;

    // Row-major: head at (row=0, col=0); merged cell at (row=1, col=0).
    const totals = trivialCageTotals();
    totals[0]![0] = 9;  // row=0, col=0 is the cage head
    totals[1]![0] = 0;  // row=1, col=0 is merged (no head)

    const spec = validateCageLayout(totals, borderX, allWallsBorderY());
    // regions[row=0][col=0] and regions[row=1][col=0] share the same cage
    expect(spec.regions[0]![0]!).toBe(spec.regions[1]![0]!);
    // A cell in a different row is in its own cage
    expect(spec.regions[2]![0]!).not.toBe(spec.regions[0]![0]!);
  });

  it('accepts a valid 2-cell cage spanning cols 0-1 in row 0 (horizontal neighbours)', () => {
    // borderY[colGap][row] = false opens the vertical wall between cols 0 and 1 in row 0.
    const borderY = allWallsBorderY();
    borderY[0]![0] = false;

    // Row-major: head at (row=0, col=0); merged cell at (row=0, col=1).
    const totals = trivialCageTotals();
    totals[0]![0] = 9;  // row=0, col=0 is the cage head
    totals[0]![1] = 0;  // row=0, col=1 is merged (no head)

    const spec = validateCageLayout(totals, allWallsBorderX(), borderY);
    // regions[row=0][col=0] and regions[row=0][col=1] share the same cage
    expect(spec.regions[0]![0]!).toBe(spec.regions[0]![1]!);
    // A cell in a different column is in its own cage
    expect(spec.regions[0]![2]!).not.toBe(spec.regions[0]![0]!);
  });

  it('passes through borderX/borderY unchanged', () => {
    const bx = allWallsBorderX();
    const by = allWallsBorderY();
    const spec = validateCageLayout(trivialCageTotals(), bx, by);
    expect(spec.borderX).toBe(bx);
    expect(spec.borderY).toBe(by);
  });
});

// ---------------------------------------------------------------------------
// Range validation
// ---------------------------------------------------------------------------

describe('validateCageLayout — cage total range', () => {
  it('accepts minimum valid total for 1-cell cage (total=1)', () => {
    const totals = trivialCageTotals();
    totals[3]![3] = 1;
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).not.toThrow();
  });

  it('accepts maximum valid total for 1-cell cage (total=9)', () => {
    const totals = trivialCageTotals();
    totals[3]![3] = 9;
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).not.toThrow();
  });

  it('throws for 1-cell cage with total=0 (interpreted as no head)', () => {
    const totals = trivialCageTotals();
    totals[3]![3] = 0; // cell (3,3) has no cage head — leaves it unassigned
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).toThrow();
  });

  it('throws for 1-cell cage with total=10 (> max 9)', () => {
    const totals = trivialCageTotals();
    totals[3]![3] = 10;
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).toThrow();
  });

  it('accepts a 2-cell cage with total=3 (minimum for size 2)', () => {
    // borderX[col=0][rowGap=0]: open wall between row 0 and row 1 in col 0.
    const borderX = allWallsBorderX();
    borderX[0]![0] = false;
    // Row-major: head at (row=0, col=0); merged at (row=1, col=0).
    const totals = trivialCageTotals();
    totals[0]![0] = 3; totals[1]![0] = 0;
    expect(() =>
      validateCageLayout(totals, borderX, allWallsBorderY()),
    ).not.toThrow();
  });

  it('throws for a 2-cell cage with total=2 (< minimum 3)', () => {
    const borderX = allWallsBorderX();
    borderX[0]![0] = false;
    // Row-major: head at (row=0, col=0); merged at (row=1, col=0).
    const totals = trivialCageTotals();
    totals[0]![0] = 2; totals[1]![0] = 0;
    expect(() =>
      validateCageLayout(totals, borderX, allWallsBorderY()),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error conditions
// ---------------------------------------------------------------------------

describe('validateCageLayout — region_reassigned', () => {
  it('throws ProcessingError when two heads map to the same component', () => {
    // borderX[col=0][rowGap=0] = false: open wall between row 0 and row 1 in col 0.
    const borderX = allWallsBorderX();
    borderX[0]![0] = false;

    const totals = trivialCageTotals();
    // Row-major: both (row=0,col=0) and (row=1,col=0) are in the merged component
    // and both have non-zero totals — two heads in one cage.
    totals[0]![0] = 5;  // row=0, col=0
    totals[1]![0] = 5;  // row=1, col=0

    expect(() =>
      validateCageLayout(totals, borderX, allWallsBorderY()),
    ).toThrow(ProcessingError);
  });
});

describe('validateCageLayout — unassigned_region', () => {
  it('throws ProcessingError when a cell has no cage head', () => {
    const totals = trivialCageTotals();
    totals[4]![4] = 0; // remove the cage head — (4,4) is now unassigned

    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).toThrow(ProcessingError);
  });
});

// ---------------------------------------------------------------------------
// Row-major orientation contract (T2)
//
// These tests FAIL with the current col-major implementation and PASS after
// the row-major fix.  They define the expected contract:
//   cageTotals[row][col]  — first index is the visual row
//   regions[row][col]     — first index is the visual row
// ---------------------------------------------------------------------------

describe('validateCageLayout — row-major orientation (T2)', () => {
  it('cageTotals[row][col] head unifies the correct adjacent cells', () => {
    // Open the vertical wall between col=5 and col=6 in visual row=2.
    // borderY convention (intentional exception): borderY[colGap][row]
    //   borderY[5][2] = false => no wall between col 5 and col 6 in row 2.
    const borderY = allWallsBorderY();
    borderY[5]![2] = false;

    // Row-major cageTotals:
    //   totals[row=2][col=5] = 5  => head of the 2-cell cage (total 5 in [3,17])
    //   totals[row=2][col=6] = 0  => merged cell, no head
    //   all other cells = 5       => each is its own 1-cell cage
    const totals = trivialCageTotals();
    totals[2]![6] = 0;

    // After the row-major fix: must not throw; the two cells share a cage index.
    // With the col-major bug: misreads the zeroed slot, putting two heads in the
    // merged component => ProcessingError.
    const spec = validateCageLayout(totals, allWallsBorderX(), borderY);
    expect(spec.regions[2]![5]!).toBe(spec.regions[2]![6]!);
    // Adjacent cell in the same row outside the cage must have a different index.
    expect(spec.regions[2]![4]!).not.toBe(spec.regions[2]![5]!);
  });

  it('regions[row][col] — cells in the same visual row share a cage when connected horizontally', () => {
    // Independent scenario: col=1 and col=2 in row=7.
    const borderY = allWallsBorderY();
    borderY[1]![7] = false;  // no wall between col 1 and col 2 in row 7

    const totals = trivialCageTotals();
    totals[7]![2] = 0;  // (row=7, col=2) is the merged cell

    const spec = validateCageLayout(totals, allWallsBorderX(), borderY);
    expect(spec.regions[7]![1]!).toBe(spec.regions[7]![2]!);
    expect(spec.regions[6]![1]!).not.toBe(spec.regions[7]![1]!);
  });
});
