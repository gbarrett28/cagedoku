/**
 * Tests for UniqueRectangle.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { UniqueRectangle } from './uniqueRectangle.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import type { Cell } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';
import { SolverEngine } from '../solverEngine.js';
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';

function globalCtx(bs: BoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('UniqueRectangle', () => {
  it('type 1: eliminates UR pair from the floor cell', () => {
    const bs = new BoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();

    // Rectangle: rows 0,3 × cols 0,3
    // Three roof corners with exactly {4,7}
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![3]! = new Set([4, 7]);
    bs.candidates[3]![0]! = new Set([4, 7]);
    // Floor corner has {3,4,7} — 4 and 7 must be eliminated
    bs.candidates[3]![3]! = new Set([3, 4, 7]);

    const elims = new UniqueRectangle().apply(globalCtx(bs)).eliminations;
    expect(elims.some(e => e.cell[0] === 3 && e.cell[1] === 3 && e.digit === 4)).toBe(true);
    expect(elims.some(e => e.cell[0] === 3 && e.cell[1] === 3 && e.digit === 7)).toBe(true);
    // Digit 3 (not part of the UR pair) not eliminated
    expect(elims.every(e => e.digit !== 3)).toBe(true);
  });

  it('asHints type 1: returns hint with correct shape', () => {
    const bs = new BoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![3]! = new Set([4, 7]);
    bs.candidates[3]![0]! = new Set([4, 7]);
    bs.candidates[3]![3]! = new Set([3, 4, 7]);
    const ctx = globalCtx(bs);
    const rule = new UniqueRectangle();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('UniqueRectangle');
    expect(hints[0]!.explanation.length).toBeGreaterThan(0);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('asHints type 2: returns hint with correct shape', () => {
    const bs = new BoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[1]![1]! = new Set([4, 7]);
    bs.candidates[0]![1]! = new Set([4, 5, 7]);
    bs.candidates[1]![0]! = new Set([4, 5, 7]);
    bs.candidates[0]![2]! = new Set([5, 8]); // target
    const ctx = globalCtx(bs);
    const rule = new UniqueRectangle();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('UniqueRectangle');
    expect(hints[0]!.explanation).toContain('Type 2');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('type 2: eliminates extra digit from cells seeing both extra corners', () => {
    const bs = new BoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();

    // Rectangle: rows 0,1 × cols 0,1 (all in box 0)
    // Two base corners with exactly {4,7}
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[1]![1]! = new Set([4, 7]);
    // Two extra corners with {4,7,5}; extra digit x=5
    bs.candidates[0]![1]! = new Set([4, 5, 7]);
    bs.candidates[1]![0]! = new Set([4, 5, 7]);
    // Target (0,2): sees (0,1) via row 0 AND (1,0) via box 0 → eliminate 5
    bs.candidates[0]![2]! = new Set([5, 8]);
    // Decoy (5,0): sees (1,0) via col 0 but not (0,1) → NOT eliminated
    bs.candidates[5]![0]! = new Set([5, 9]);

    const elims = new UniqueRectangle().apply(globalCtx(bs)).eliminations;
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 2 && e.digit === 5)).toBe(true);
    // (5,0) does not see both extra corners
    expect(elims.every(e => !(e.cell[0] === 5 && e.cell[1] === 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression tests against rule-bug fixtures
// Skipped while UniqueRectangle is in DISABLED_RULES; active once the rule is fixed.
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: number[][][]): BoardState {
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

const urFixtures = ruleBugFixtures.filter(f => f.ruleName === 'UniqueRectangle');
const itUR = DISABLED_RULES.includes('UniqueRectangle') ? it.skip : it;

describe('UniqueRectangle — rule-bug regression fixtures', () => {
  for (const fixture of urFixtures) {
    itUR(`${fixture.name}: no elimination contradicts golden solution`, () => {
      const board = boardFromStallCandidates(fixture.stalledCandidates);
      const ctx: RuleContext = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
      const result = new UniqueRectangle().apply(ctx);
      for (const e of result.eliminations) {
        const [r, c] = e.cell;
        expect(fixture.goldenSolution[r]![c]).not.toBe(e.digit);
      }
    });
  }
});
