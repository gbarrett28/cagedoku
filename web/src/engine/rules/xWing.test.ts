import { describe, it, expect } from 'vitest';
import { XWing } from './xWing.js';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger } from '../types.js';

/** Board where digit 9 appears in exactly 2 cells in each of rows 0 and 5 (cols 1 and 4). */
function makeXWingBoard(): BoardState {
  const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, [], {});
  for (const col of [0, 2, 3, 5, 6, 7, 8]) {
    engine.applyEliminations([{ cell: [0, col], digit: 9 }]);
    engine.applyEliminations([{ cell: [5, col], digit: 9 }]);
  }
  return board;
}

const GLOBAL_CTX = (board: BoardState) =>
  ({ board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const);

describe('XWing.asHints', () => {
  const rule = new XWing();

  it('returns a hint with correct shape when X-Wing pattern exists', () => {
    const board = makeXWingBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    expect(result.eliminations.length).toBeGreaterThan(0);

    const hints = rule.asHints(ctx, result.eliminations);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('XWing');
    expect(hints[0]!.displayName).toBe('X-Wing');
    expect(hints[0]!.explanation).toContain('X-Wing');
    expect(hints[0]!.explanation).toContain('9');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.highlightCells.length).toBeGreaterThanOrEqual(4);
    expect(hints[0]!.placement).toBeNull();
  });

  it('returns empty array when eliminations is empty', () => {
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = GLOBAL_CTX(board);
    // Fresh board: all rows have 9 in all 9 cols (size=9 > 2), so apply() finds no X-Wings
    const result = rule.apply(ctx);
    const hints = rule.asHints(ctx, result.eliminations);
    expect(hints).toHaveLength(0);
  });
});
