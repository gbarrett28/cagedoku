/**
 * Tests for engine/backtracker.ts — MRV backtracking solver.
 * Port of Python's tests/solver/engine/test_backtracker.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from './boardState.js';
import { mrvBacktrack } from './backtracker.js';
import { KNOWN_SOLUTION, makeTrivialSpec, makeBoxCageSpec } from './fixtures.js';

describe('mrvBacktrack', () => {
  it('returns null when a cell has no candidates', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Wipe all candidates from (row=0, col=0) — no solution possible.
    bs.candidates[0]![0]! = new Set();
    expect(mrvBacktrack(bs)).toBeNull();
  });

  it('solves the trivial spec (81 single-cell cages) to the known solution', () => {
    // In the trivial spec each cell is its own 1-cell cage with its solution
    // digit as the total.  The backtracker must recover KNOWN_SOLUTION exactly.
    const bs = new BoardState(makeTrivialSpec());
    const result = mrvBacktrack(bs);
    expect(result).not.toBeNull();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(result![r]![c]).toBe(KNOWN_SOLUTION[r]![c]);
  });

  it('solves a 9-cage box spec (harder constraint structure)', () => {
    // 9 cages, one per 3×3 box, each summing to 45.  No unique solution
    // exists without the uniqueness constraints from rows/cols — the solver
    // must use both cage and row/col constraints to complete it.
    const bs = new BoardState(makeBoxCageSpec());
    const result = mrvBacktrack(bs);
    // A valid solution must exist (the puzzle is not over-constrained).
    expect(result).not.toBeNull();
    // Every row must sum to 45 (basic sudoku validity).
    for (let r = 0; r < 9; r++) {
      const rowSum = (result![r]! as number[]).reduce((a, b) => a + b, 0);
      expect(rowSum).toBe(45);
    }
  });
});
