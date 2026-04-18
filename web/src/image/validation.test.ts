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
    // All 81 cells are assigned
    for (let c = 0; c < 9; c++)
      for (let r = 0; r < 9; r++)
        expect(spec.regions[c][r]).toBeGreaterThan(0);
  });

  it('produces 81 distinct cage indices for trivial spec', () => {
    const spec = validateCageLayout(
      trivialCageTotals(),
      allWallsBorderX(),
      allWallsBorderY(),
    );
    const indices = new Set<number>();
    for (let c = 0; c < 9; c++)
      for (let r = 0; r < 9; r++)
        indices.add(spec.regions[c][r]);
    expect(indices.size).toBe(81);
  });

  it('accepts a valid 2-cell horizontal cage (rows 0-1 in col 0)', () => {
    const borderX = allWallsBorderX();
    borderX[0][0] = false; // open wall between row 0 and row 1 in col 0

    const totals = trivialCageTotals();
    totals[0][0] = 9; // head of the 2-cell cage (total in [3,17])
    totals[0][1] = 0; // not a cage head — merged into (0,0)

    const spec = validateCageLayout(totals, borderX, allWallsBorderY());
    // (0,0) and (0,1) must share the same cage index
    expect(spec.regions[0][0]).toBe(spec.regions[0][1]);
    // All other cells are distinct from that cage
    expect(spec.regions[0][2]).not.toBe(spec.regions[0][0]);
  });

  it('accepts a valid 2-cell vertical cage (cols 0-1 in row 0)', () => {
    const borderY = allWallsBorderY();
    borderY[0][0] = false; // open wall between col 0 and col 1 in row 0

    const totals = trivialCageTotals();
    totals[0][0] = 9; // head of the 2-cell cage
    totals[1][0] = 0; // merged into (0,0)

    const spec = validateCageLayout(trivialCageTotals().map((col, c) =>
      c === 0 ? col.map((v, r) => (r === 0 ? 9 : v)) : col,
    ).map((col, c) => c === 1 ? col.map((v, r) => (r === 0 ? 0 : v)) : col),
    allWallsBorderX(), borderY);

    expect(spec.regions[0][0]).toBe(spec.regions[1][0]);
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
    totals[3][3] = 1;
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).not.toThrow();
  });

  it('accepts maximum valid total for 1-cell cage (total=9)', () => {
    const totals = trivialCageTotals();
    totals[3][3] = 9;
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).not.toThrow();
  });

  it('throws for 1-cell cage with total=0 (interpreted as no head)', () => {
    const totals = trivialCageTotals();
    totals[3][3] = 0; // cell (3,3) has no cage head — leaves it unassigned
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).toThrow();
  });

  it('throws for 1-cell cage with total=10 (> max 9)', () => {
    const totals = trivialCageTotals();
    totals[3][3] = 10;
    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).toThrow();
  });

  it('accepts a 2-cell cage with total=3 (minimum for size 2)', () => {
    const borderX = allWallsBorderX();
    borderX[0][0] = false;
    const totals = trivialCageTotals();
    totals[0][0] = 3; totals[0][1] = 0;
    expect(() =>
      validateCageLayout(totals, borderX, allWallsBorderY()),
    ).not.toThrow();
  });

  it('throws for a 2-cell cage with total=2 (< minimum 3)', () => {
    const borderX = allWallsBorderX();
    borderX[0][0] = false;
    const totals = trivialCageTotals();
    totals[0][0] = 2; totals[0][1] = 0;
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
    const borderX = allWallsBorderX();
    borderX[0][0] = false; // merge (0,0) and (0,1) into one component

    const totals = trivialCageTotals();
    // Both cells in the merged component have non-zero totals — two heads, one cage.
    totals[0][0] = 5;
    totals[0][1] = 5;

    expect(() =>
      validateCageLayout(totals, borderX, allWallsBorderY()),
    ).toThrow(ProcessingError);
  });
});

describe('validateCageLayout — unassigned_region', () => {
  it('throws ProcessingError when a cell has no cage head', () => {
    const totals = trivialCageTotals();
    totals[4][4] = 0; // remove the cage head — (4,4) is now unassigned

    expect(() =>
      validateCageLayout(totals, allWallsBorderX(), allWallsBorderY()),
    ).toThrow(ProcessingError);
  });
});
