import { describe, it, expect } from 'vitest';
import { XYZWing } from './xyzWing.js';
import { KillerBoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger } from '../types.js';

/**
 * Board for XYZWing test.
 * Pivot P at (0,0) = {1,2,3}.
 * Pincer A at (0,1) = {1,3} — sees P via row 0.
 * Pincer B at (1,0) = {2,3} — sees P via col 0.
 * (1,1) sees P via box 0, A via col 1, B via row 1 → digit 3 eliminated.
 * All other cells in rows/cols beyond (1,1) have 3 removed to avoid spurious targets.
 */
function makeXYZWingBoard(): KillerBoardState {
  const board = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, [], {});
  // Pivot (0,0) = {1,2,3}
  for (const d of [4,5,6,7,8,9]) engine.applyEliminations([{ cell: [0,0], digit: d }]);
  // Pincer A (0,1) = {1,3}
  for (const d of [2,4,5,6,7,8,9]) engine.applyEliminations([{ cell: [0,1], digit: d }]);
  // Pincer B (1,0) = {2,3}
  for (const d of [1,4,5,6,7,8,9]) engine.applyEliminations([{ cell: [1,0], digit: d }]);
  // Remove 3 from rows 2-8 entirely (no elimination targets there)
  for (let r = 2; r < 9; r++) for (let c = 0; c < 9; c++)
    engine.applyEliminations([{ cell: [r, c], digit: 3 }]);
  // Remove 3 from row 0 cols 2-8 and row 1 cols 2-8 (leaving only (1,1) as target)
  for (let c = 2; c < 9; c++) {
    engine.applyEliminations([{ cell: [0, c], digit: 3 }]);
    engine.applyEliminations([{ cell: [1, c], digit: 3 }]);
  }
  return board;
}

const GLOBAL_CTX = (board: KillerBoardState) =>
  ({ board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const);

describe('XYZWing', () => {
  const rule = new XYZWing();

  it('eliminates z from cells seeing all three of pivot and both pincers', () => {
    const board = makeXYZWingBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);

    expect(result.eliminations.length).toBeGreaterThan(0);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}:${e.digit}`);
    expect(targets).toContain('1,1:3');
  });

  it('does NOT eliminate from cells that do not see the pivot', () => {
    const board = makeXYZWingBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    // No cell at row>=2 should be a target (3 was removed from all of them)
    expect(result.eliminations.every(e => e.cell[0] < 2)).toBe(true);
  });

  it('asHints returns a hint with correct shape', () => {
    const board = makeXYZWingBoard();
    const ctx = GLOBAL_CTX(board);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('XYZWing');
    expect(hints[0]!.displayName).toBe('XYZ-Wing');
    expect(hints[0]!.explanation).toMatch(/XYZ.Wing/i);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('returns empty when no XYZWing pattern exists', () => {
    const board = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    expect(result.eliminations).toHaveLength(0);
    expect(rule.asHints(ctx, [])).toHaveLength(0);
  });

  it('near-miss: target sees both pincers but NOT pivot — no elimination', () => {
    // XYZ-Wing requires the target to see ALL THREE of pivot, pincer A, and pincer B.
    // When the target misses the pivot, the case P=z is unresolved: P could hold z and
    // T can't see it, so the elimination is unsound. The rule must not fire.
    //
    // P=(0,0)={1,2,3}, A=(0,6)={1,3} sees P via row 0,
    // B=(6,0)={2,3} sees P via col 0.
    // T=(6,6)={3,5} sees A via col 6 and B via row 6, but does NOT see P=(0,0).
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    bs.candidates[0]![0]! = new Set([1, 2, 3]); // pivot P
    bs.candidates[0]![6]! = new Set([1, 3]);     // pincer A — sees P via row 0
    bs.candidates[6]![0]! = new Set([2, 3]);     // pincer B — sees P via col 0
    bs.candidates[6]![6]! = new Set([3, 5]);     // T sees A (col 6) + B (row 6), NOT P

    const elims = new XYZWing().apply(GLOBAL_CTX(bs)).eliminations;
    expect(elims.every(e => !(e.cell[0] === 6 && e.cell[1] === 6 && e.digit === 3))).toBe(true);
  });
});
