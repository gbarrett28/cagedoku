import { describe, it, expect } from 'vitest';
import { TwoStringKite } from './twoStringKite.js';
import { KillerBoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger } from '../types.js';
import type { Cell } from '../types.js';

/**
 * 2-String Kite test board for digit 5 — correct shared-box pattern.
 *
 * Row 7: 5 only at (7,3) [rowEnd] and (7,8) [rowKnot, box 8 = rows 6-8, cols 6-8]
 * Col 6: 5 only at (1,6) [colEnd] and (8,6) [colKnot, box 8]
 *
 * rowKnot (7,8) and colKnot (8,6) share box 8, different cells ✓
 * rowEnd  (7,3) and colEnd  (1,6) don't see each other        ✓
 *
 * Proof: if 5 at (7,8) → box weak link → (8,6)≠5 → col strong link → 5=(1,6).
 *        if 5 not at (7,8) → row strong link → 5=(7,3).
 * Either way, T seeing both (7,3) and (1,6) can't have 5.
 *
 * Target (1,3): sees (7,3) via col 3 AND (1,6) via row 1 → eliminate 5 ✓
 * Decoy  (4,3): sees (7,3) via col 3 but NOT (1,6)        → not eliminated ✓
 *
 * Row 1 keeps 5 at {(1,2),(1,3),(1,6)} (3 cells → no row strong link in row 1).
 * Col 3 keeps 5 at {(1,3),(4,3),(7,3)} (3 cells → no col strong link in col 3).
 */
function makeKiteBoard(): KillerBoardState {
  const board = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, [], {});
  const elim = (r: number, c: number) =>
    engine.applyEliminations([{ cell: [r, c] as Cell, digit: 5 }]);

  // Row 7: keep 5 only at cols 3 and 8
  for (const c of [0, 1, 2, 4, 5, 6, 7]) elim(7, c);
  // Col 6: keep 5 only at rows 1 and 8
  for (const r of [0, 2, 3, 4, 5, 6, 7]) elim(r, 6);
  // Row 1: keep 5 at cols 2, 3, 6 (3 cells → no row strong link)
  for (const c of [0, 1, 4, 5, 7, 8]) elim(1, c);
  // Col 3: keep 5 at rows 1, 4, 7 (3 cells → no col strong link)
  for (const r of [0, 2, 3, 5, 6, 8]) elim(r, 3);

  return board;
}

const GLOBAL_CTX = (board: KillerBoardState) =>
  ({ board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const);

describe('TwoStringKite', () => {
  const rule = new TwoStringKite();

  it('eliminates digit from cell seeing both endpoints', () => {
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);

    expect(result.eliminations.length).toBeGreaterThan(0);
    expect(result.eliminations.every(e => e.digit === 5)).toBe(true);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`);
    // (1,3) sees rowEnd (7,3) via col 3 AND colEnd (1,6) via row 1
    expect(targets).toContain('1,3');
  });

  it('does not eliminate from the four pattern cells', () => {
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`);
    expect(targets).not.toContain('7,3'); // rowEnd
    expect(targets).not.toContain('7,8'); // rowKnot
    expect(targets).not.toContain('1,6'); // colEnd
    expect(targets).not.toContain('8,6'); // colKnot
  });

  it('does not eliminate decoy that sees only one endpoint', () => {
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const result = rule.apply(ctx);
    const targets = result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`);
    // (4,3) sees rowEnd (7,3) via col 3 but does NOT see colEnd (1,6)
    expect(targets).not.toContain('4,3');
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
  });

  it('asHints: endpoints and knots in chainCells (with digit 5), knots also in highlightCells (orange)', () => {
    // Endpoints: rowEnd (7,3)=blue, colEnd (1,6)=green. Knots: (7,8) and (8,6) → orange, no wash.
    // All four cells are only relevant for digit 5.
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    const hint = hints[0]!;

    expect(hint.chainCells?.length).toBe(4);
    const ccFor = (r: number, c: number) => hint.chainCells!.find(cc => cc.cell[0] === r && cc.cell[1] === c);
    expect(ccFor(7, 3)).toEqual({ cell: [7, 3], digits: [5], colour: 'blue' });   // rowEnd
    expect(ccFor(1, 6)).toEqual({ cell: [1, 6], digits: [5], colour: 'green' });  // colEnd
    expect(ccFor(7, 8)).toEqual({ cell: [7, 8], digits: [5] });                   // rowKnot, no wash
    expect(ccFor(8, 6)).toEqual({ cell: [8, 6], digits: [5] });                   // colKnot, no wash

    // Endpoint cells must NOT be in highlightCells; knot cells and target MUST be
    for (const [r, c] of [[7, 3], [1, 6]] as [number, number][]) {
      expect(hint.highlightCells.some(([hr, hc]) => hr === r && hc === c)).toBe(false);
    }
    for (const [r, c] of [[7, 8], [8, 6]] as [number, number][]) {
      expect(hint.highlightCells.some(([hr, hc]) => hr === r && hc === c)).toBe(true);
    }
    expect(hint.highlightCells.some(([r, c]) => r === 1 && c === 3)).toBe(true);
  });

  it('returns empty on a fresh unconstrained board', () => {
    const board = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = GLOBAL_CTX(board);
    expect(rule.apply(ctx).eliminations).toHaveLength(0);
    expect(rule.asHints(ctx, [])).toHaveLength(0);
  });
});
