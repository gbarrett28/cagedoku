/**
 * Tests for UniqueRectangle.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { UniqueRectangle } from './uniqueRectangle.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import type { Cell } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';
import { SolverEngine } from '../solverEngine.js';
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';

function globalCtx(bs: KillerBoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('UniqueRectangle', () => {
  it('type 1: eliminates UR pair from the floor cell', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();

    // Rectangle: rows 0,1 × cols 0,3 — same row-band (0–2), different col-bands (0–2 vs 3–5)
    // → exactly 2 boxes (box 0 and box 1). UR argument is valid here.
    // Three roof corners with exactly {4,7}
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![3]! = new Set([4, 7]);
    bs.candidates[1]![0]! = new Set([4, 7]);
    // Floor corner has {3,4,7} — 4 and 7 must be eliminated
    bs.candidates[1]![3]! = new Set([3, 4, 7]);

    const elims = new UniqueRectangle().apply(globalCtx(bs)).eliminations;
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 3 && e.digit === 4)).toBe(true);
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 3 && e.digit === 7)).toBe(true);
    // Digit 3 (not part of the UR pair) not eliminated
    expect(elims.every(e => e.digit !== 3)).toBe(true);
  });

  it('asHints type 1: returns hint with correct shape', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    // Same valid 2-box rectangle: rows 0,1 × cols 0,3 (boxes 0 and 1)
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![3]! = new Set([4, 7]);
    bs.candidates[1]![0]! = new Set([4, 7]);
    bs.candidates[1]![3]! = new Set([3, 4, 7]);
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
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    // Valid 2-box rectangle: rows 0,1 × cols 0,4 (boxes 0 and 1, same row-band)
    // Base corners in row 0, extra corners in row 1 (share row 1 → cells in row 1 see both)
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![4]! = new Set([4, 7]);
    bs.candidates[1]![0]! = new Set([4, 5, 7]);
    bs.candidates[1]![4]! = new Set([4, 5, 7]);
    bs.candidates[1]![2]! = new Set([5, 8]); // target: in row 1, sees both extra corners
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

  it('asHints type 1: highlightCells contains only roof cells, not the floor cell (issue #139)', () => {
    // Regression for bug #139: the floor cell (1,3) must not appear in highlightCells.
    // highlightCells must be exactly the 3 roof cells so the UI renders them orange;
    // the floor cell is an elimination target and must only appear in eliminations (yellow).
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![3]! = new Set([4, 7]);
    bs.candidates[1]![0]! = new Set([4, 7]);
    bs.candidates[1]![3]! = new Set([3, 4, 7]);
    const ctx = globalCtx(bs);
    const rule = new UniqueRectangle();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints).toHaveLength(1);
    const h = hints[0]!;
    const elimKeys = new Set(h.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    for (const [r, c] of h.highlightCells) {
      expect(elimKeys.has(`${r},${c}`)).toBe(false);
    }
  });

  it('near-miss: only 2 corners have {a,b} (not 3) → Type 1 does not fire', () => {
    // roofIndices.length must be 3 for Type 1.
    // Here only (0,0) and (0,3) have exactly {4,7}; the other two corners have extra digits.
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![3]! = new Set([4, 7]);
    bs.candidates[1]![0]! = new Set([4, 6, 7]);  // 3 candidates — not a roof corner
    bs.candidates[1]![3]! = new Set([3, 4, 7]);  // 3 candidates — not a roof corner
    const elims = new UniqueRectangle().apply(globalCtx(bs)).eliminations;
    // Type 1 requires 3 exact-{a,b} corners; with only 2, no Type 1 elimination
    const type1Elims = elims.filter(e => e.digit === 4 || e.digit === 7);
    expect(type1Elims.some(e => e.cell[0] === 1)).toBe(false);
  });

  it('near-miss: all 4 corners in the same box → boxes.size === 1 → no UR', () => {
    // Corners rows 0,1 × cols 0,1 are all in box 0 → boxes.size === 1, guard fails.
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![1]! = new Set([4, 7]);
    bs.candidates[1]![0]! = new Set([4, 7]);
    bs.candidates[1]![1]! = new Set([3, 4, 7]);
    const elims = new UniqueRectangle().apply(globalCtx(bs)).eliminations;
    expect(elims).toHaveLength(0);
  });

  it('type 2: eliminates extra digit from cells seeing both extra corners', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();

    // Valid 2-box rectangle: rows 0,1 × cols 0,4 — same row-band (0–2), different col-bands
    // (0–2 vs 3–5) → boxes 0 and 1. UR argument is valid here.
    // Two base corners (row 0) with exactly {4,7}
    bs.candidates[0]![0]! = new Set([4, 7]);
    bs.candidates[0]![4]! = new Set([4, 7]);
    // Two extra corners (row 1) with {4,7,5}; extra digit x=5
    bs.candidates[1]![0]! = new Set([4, 5, 7]);
    bs.candidates[1]![4]! = new Set([4, 5, 7]);
    // Target (1,2): in row 1, sees both extra corners (1,0) and (1,4) via row → eliminate 5
    bs.candidates[1]![2]! = new Set([5, 8]);
    // Decoy (5,0): sees (1,0) via col 0 but NOT (1,4) (different row, col, box) → NOT eliminated
    bs.candidates[5]![0]! = new Set([5, 9]);

    const elims = new UniqueRectangle().apply(globalCtx(bs)).eliminations;
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 2 && e.digit === 5)).toBe(true);
    // (5,0) does not see both extra corners
    expect(elims.every(e => !(e.cell[0] === 5 && e.cell[1] === 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression tests against rule-bug fixtures
// Skipped while UniqueRectangle is in DISABLED_RULES; active once the rule is fixed.
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: readonly (readonly (readonly number[])[])[]): KillerBoardState {
  const spec = {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0))),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
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
