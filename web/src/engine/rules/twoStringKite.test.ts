import { describe, it, expect } from 'vitest';
import { TwoStringKite } from './twoStringKite.js';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger } from '../types.js';
import type { Cell } from '../types.js';
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';

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
function makeKiteBoard(): BoardState {
  const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
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

const GLOBAL_CTX = (board: BoardState) =>
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

  it('asHints: endpoints in colourGroups (blue/green), knots in highlightCells (orange)', () => {
    // Endpoints: rowEnd (7,3)=blue, colEnd (1,6)=green. Knots: (7,8) and (8,6) → orange.
    const board = makeKiteBoard();
    const ctx = GLOBAL_CTX(board);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    const hint = hints[0]!;

    expect(hint.colourGroups?.length).toBe(2);
    const allGroupCells = hint.colourGroups!.flatMap(g => g.cells);
    // Endpoints are in colourGroups; knots are NOT (they go to highlightCells)
    for (const [r, c] of [[7, 3], [1, 6]] as [number, number][]) {
      expect(allGroupCells.some(([gr, gc]) => gr === r && gc === c)).toBe(true);
    }
    for (const [r, c] of [[7, 8], [8, 6]] as [number, number][]) {
      expect(allGroupCells.some(([gr, gc]) => gr === r && gc === c)).toBe(false);
    }

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
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = GLOBAL_CTX(board);
    expect(rule.apply(ctx).eliminations).toHaveLength(0);
    expect(rule.asHints(ctx, [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression tests against rule-bug fixtures
// Skipped while TwoStringKite is in DISABLED_RULES; active once the rule is fixed.
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: readonly (readonly (readonly number[])[])[]): BoardState {
  const spec = {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0))),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, []);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const keep = new Set(stalledCandidates[r]![c]!);
      const elims: Array<{ cell: Cell; digit: number }> = [];
      for (let d = 1; d <= 9; d++) {
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
      if (elims.length) engine.applyEliminations(elims);
    }
  }
  return board;
}

const kiteFixtures = ruleBugFixtures.filter(f => f.ruleName === 'TwoStringKite');
const itKite = DISABLED_RULES.includes('TwoStringKite') ? it.skip : it;

describe('TwoStringKite — rule-bug regression fixtures', () => {
  for (const fixture of kiteFixtures) {
    itKite(`${fixture.name}: no elimination contradicts golden solution`, () => {
      const board = boardFromStallCandidates(fixture.stalledCandidates);
      const ctx = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const;
      const result = new TwoStringKite().apply(ctx);
      for (const e of result.eliminations) {
        const [r, c] = e.cell;
        expect(fixture.goldenSolution[r]![c]).not.toBe(e.digit);
      }
    });
  }
});
