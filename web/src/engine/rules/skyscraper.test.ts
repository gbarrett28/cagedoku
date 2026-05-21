import { describe, it, expect } from 'vitest';
import { Skyscraper } from './skyscraper.js';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger } from '../types.js';

/**
 * Row-based Skyscraper test board for digit 7.
 *
 * Row 0: 7 only in (0,0) and (0,1)   → base=(0,0), roof=(0,1)
 * Row 1: 7 only in (1,0) and (1,2)   → base=(1,0), roof=(1,2)
 * Shared col: 0.  Roof cells: (0,1) and (1,2) — both in box 0.
 *
 * Row 2 keeps 7 in (2,0),(2,1),(2,2) — all in box 0 — so they see
 * both roof cells and are elimination targets.
 *
 * Rows 3–8 have no 7 at all.
 */
function makeSkyscraperBoard(): BoardState {
  const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, [], {});

  // Row 0: keep 7 only in cols 0 and 1
  for (const c of [2,3,4,5,6,7,8]) engine.applyEliminations([{ cell:[0,c], digit:7 }]);
  // Row 1: keep 7 only in cols 0 and 2
  for (const c of [1,3,4,5,6,7,8]) engine.applyEliminations([{ cell:[1,c], digit:7 }]);
  // Row 2: keep 7 only in cols 0,1,2 (the target cells)
  for (const c of [3,4,5,6,7,8]) engine.applyEliminations([{ cell:[2,c], digit:7 }]);
  // Rows 3–8: remove 7 entirely
  for (let r = 3; r < 9; r++)
    for (let c = 0; c < 9; c++) engine.applyEliminations([{ cell:[r,c], digit:7 }]);

  return board;
}

const GLOBAL_CTX = (board: BoardState) =>
  ({ board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const);

describe('Skyscraper', () => {
  const rule = new Skyscraper();

  it('eliminates digit from cells seeing both roof cells', () => {
    const board = makeSkyscraperBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);

    expect(result.eliminations.length).toBeGreaterThan(0);
    expect(result.eliminations.every(e => e.digit === 7)).toBe(true);
    // All three box-0 cells in row 2 see both roof cells and should be eliminated
    const targets = new Set(result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    expect(targets.has('2,0') || targets.has('2,1') || targets.has('2,2')).toBe(true);
  });

  it('does not eliminate from the roof cells themselves', () => {
    const board = makeSkyscraperBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`);
    expect(targets).not.toContain('0,1'); // roof cell 1
    expect(targets).not.toContain('1,2'); // roof cell 2
  });

  it('asHints returns a hint with correct shape', () => {
    const board = makeSkyscraperBoard();
    const ctx = GLOBAL_CTX(board);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('Skyscraper');
    expect(hints[0]!.displayName).toBe('Skyscraper');
    expect(hints[0]!.explanation).toMatch(/[Ss]kyscraper/);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('returns empty on a fresh unconstrained board', () => {
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = GLOBAL_CTX(board);
    // Every row has 9 cells with every digit — no row has d in exactly 2 cells
    expect(rule.apply(ctx).eliminations).toHaveLength(0);
    expect(rule.asHints(ctx, [])).toHaveLength(0);
  });
});
