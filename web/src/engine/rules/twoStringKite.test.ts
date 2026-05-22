import { describe, it, expect } from 'vitest';
import { TwoStringKite } from './twoStringKite.js';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger } from '../types.js';

/**
 * 2-String Kite test board for digit 5.
 *
 * Row 0: 5 only in (0,0) and (0,5)  → corner=(0,0), row-end=(0,5)
 * Col 0: 5 only in (0,0) and (6,0)  → corner=(0,0), col-end=(6,0)
 * row-end (0,5) and col-end (6,0) do NOT see each other (different row, col, box).
 *
 * Target (6,5): sees row-end (0,5) via col 5 AND col-end (6,0) via row 6 → elim 5.
 *
 * Row 6 and col 5 intentionally have 3+ cells with 5 so no reciprocal strong link
 * forms — prevents the symmetric second kite that would back-eliminate the corner.
 */
function makeKiteBoard(): BoardState {
  const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, [], {});
  const elim = (r: number, c: number) => engine.applyEliminations([{ cell: [r, c], digit: 5 }]);

  // Row 0: keep 5 only in cols 0 and 5
  for (const c of [1,2,3,4,6,7,8]) elim(0, c);
  // Col 0: keep 5 only in rows 0 and 6
  for (const r of [1,2,3,4,5,7,8]) elim(r, 0);
  // Row 6: keep 5 in cols 0, 5, 8 (3 cells → no strong link for r=6)
  // Col 5: keep 5 in rows 0, 3, 6 (3 cells → no strong link for cornerC=5)
  // Target (6,5) is in both row 6 and col 5 — sees row-end and col-end.
  // All remaining non-anchor cells: eliminate 5.
  for (let r = 1; r < 9; r++) {
    for (const c of [1,2,3,4,5,6,7,8]) {
      if (r === 6 && (c === 5 || c === 8)) continue; // row-6 extras
      if (r === 3 && c === 5) continue;              // col-5 extra
      elim(r, c);
    }
  }

  return board;
}

const GLOBAL_CTX = (board: BoardState) =>
  ({ board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const);

describe('TwoStringKite', () => {
  const rule = new TwoStringKite();

  it('eliminates digit from cell seeing both row-end and col-end', () => {
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);

    expect(result.eliminations.length).toBeGreaterThan(0);
    expect(result.eliminations.every(e => e.digit === 5)).toBe(true);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`);
    expect(targets).toContain('6,5'); // target sees (0,5) via col 5 and (6,0) via row 6
  });

  it('does not eliminate from the three pattern cells', () => {
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`);
    expect(targets).not.toContain('0,0'); // corner
    expect(targets).not.toContain('0,5'); // row-end
    expect(targets).not.toContain('6,0'); // col-end
  });

  it('asHints returns a hint with correct shape', () => {
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('TwoStringKite');
    expect(hints[0]!.displayName).toBe('2-String Kite');
    expect(hints[0]!.explanation).toMatch(/[Kk]ite/);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
    // highlightCells must include corner, row-end, col-end, and the target
    const highlighted = hints[0]!.highlightCells.map(([r, c]) => `${r},${c}`);
    expect(highlighted).toContain('0,0'); // corner
    expect(highlighted).toContain('0,5'); // row-end
    expect(highlighted).toContain('6,0'); // col-end
  });

  it('returns empty on a fresh unconstrained board', () => {
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = GLOBAL_CTX(board);
    expect(rule.apply(ctx).eliminations).toHaveLength(0);
    expect(rule.asHints(ctx, [])).toHaveLength(0);
  });
});
