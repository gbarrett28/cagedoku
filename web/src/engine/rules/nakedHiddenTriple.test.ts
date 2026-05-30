/**
 * Tests for NakedHiddenTriple.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { NakedHiddenTriple } from './nakedHiddenTriple.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function makeCtx(bs: BoardState, row: number): RuleContext {
  const rowUid = bs.rowUnitId(row);
  for (let d = 1; d <= 9; d++) {
    bs.counts[rowUid]![d] = Array.from({ length: 9 }, (_, c) => c)
      .filter(c => bs.cands(row, c).has(d)).length;
  }
  return {
    unit: bs.units[rowUid] ?? null,
    cell: null,
    board: bs,
    hint: Trigger.COUNT_DECREASED,
    hintDigit: null,
  };
}

describe('NakedHiddenTriple', () => {
  it('naked triple: eliminates triple digits from other row cells', () => {
    const bs = new BoardState(makeTrivialSpec());

    // Three cells forming a naked triple: union = {1,2,3}
    bs.candidates[0]![0]! = new Set([1, 2]);
    bs.candidates[0]![1]! = new Set([2, 3]);
    bs.candidates[0]![2]! = new Set([1, 3]);
    // Other cells contain some of {1,2,3}
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3, 4, 5]);

    const elims = new NakedHiddenTriple().apply(makeCtx(bs, 0)).eliminations;

    // 1, 2, 3 should be eliminated from cells 3-8
    for (let c = 3; c < 9; c++) {
      expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === c && e.digit === 1)).toBe(true);
      expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === c && e.digit === 2)).toBe(true);
      expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === c && e.digit === 3)).toBe(true);
    }
    // Triple cells themselves are not targets
    expect(elims.every(e => e.cell[1] >= 3)).toBe(true);
  });

  it('asHints: naked triple returns hint with correct shape', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([1, 2]);
    bs.candidates[0]![1]! = new Set([2, 3]);
    bs.candidates[0]![2]! = new Set([1, 3]);
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3, 4, 5]);
    const ctx = makeCtx(bs, 0);
    const rule = new NakedHiddenTriple();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBe(1);
    expect(hints[0]!.ruleName).toBe('NakedHiddenTriple');
    expect(hints[0]!.displayName).toBe('Naked Triple');
    expect(hints[0]!.explanation).toContain('1');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('asHints: hidden triple returns hint with correct shape', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([1, 2, 4, 5]);
    bs.candidates[0]![1]! = new Set([2, 3, 6, 7]);
    bs.candidates[0]![2]! = new Set([1, 3, 8, 9]);
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([4, 5, 6, 7]);
    const ctx = makeCtx(bs, 0);
    const rule = new NakedHiddenTriple();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBe(1);
    expect(hints[0]!.ruleName).toBe('NakedHiddenTriple');
    expect(hints[0]!.displayName).toBe('Hidden Triple');
    expect(hints[0]!.explanation).toContain('Hidden Triple');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('near-miss naked triple: one cell has 1 candidate (naked single included) → no naked triple fires', () => {
    // Cell (0,0) has {1} — a naked single. Cells (0,1) and (0,2) together with (0,0) have union {1,2,3},
    // which satisfies union.size===3. But including a naked single is degenerate (NakedSingle fires first).
    // The fix: guard size<2 prevents this from being treated as a naked triple.
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([1]);       // singleton — naked single
    bs.candidates[0]![1]! = new Set([1, 2]);
    bs.candidates[0]![2]! = new Set([2, 3]);
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3, 4, 5]);

    const elims = new NakedHiddenTriple().apply(makeCtx(bs, 0)).eliminations;
    // naked triple must NOT fire when a singleton is included
    const nakedTripleElims = elims.filter(e => e.cell[1] >= 3 && [1, 2, 3].includes(e.digit));
    expect(nakedTripleElims).toHaveLength(0);
  });

  it('near-miss naked triple: one cell has 4 candidates (union.size=4) → no naked triple', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Cells 0-2 have union {1,2,3,4} — size 4, not 3 → cannot be a naked triple
    bs.candidates[0]![0]! = new Set([1, 2]);
    bs.candidates[0]![1]! = new Set([2, 3]);
    bs.candidates[0]![2]! = new Set([1, 3, 4]); // extra digit breaks the triple
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3, 4, 5]);

    const elims = new NakedHiddenTriple().apply(makeCtx(bs, 0)).eliminations;
    // No naked triple → cells 3-8 must not have 1,2,3 eliminated by this pattern
    // (union.size===4, so the naked-triple branch does not fire)
    const nakedTripleElims = elims.filter(e => e.cell[1] >= 3 && [1, 2, 3].includes(e.digit));
    expect(nakedTripleElims).toHaveLength(0);
  });

  it('near-miss hidden triple: one of the three digits appears in a 4th cell → no hidden triple', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Digits 1,2,3 should form a hidden triple in cells 0-2.
    // But digit 1 also appears in cell 3 → cellsWith.size===4, not 3 → guard fails.
    bs.candidates[0]![0]! = new Set([1, 2, 4, 5]);
    bs.candidates[0]![1]! = new Set([2, 3, 6, 7]);
    bs.candidates[0]![2]! = new Set([1, 3, 8, 9]);
    bs.candidates[0]![3]! = new Set([1, 4, 5, 6]); // digit 1 leaks into cell 3
    for (let c = 4; c < 9; c++) bs.candidates[0]![c]! = new Set([4, 5, 6, 7]);

    const elims = new NakedHiddenTriple().apply(makeCtx(bs, 0)).eliminations;
    // Hidden triple does not fire → extras 4,5 from cell 0 must not be eliminated
    expect(elims.some(e => e.cell[1] === 0 && (e.digit === 4 || e.digit === 5))).toBe(false);
  });

  it('hidden triple: restricts three cells to only the triple digits', () => {
    const bs = new BoardState(makeTrivialSpec());

    // Digits 1,2,3 appear only in cells (0,0), (0,1), (0,2) — hidden triple
    bs.candidates[0]![0]! = new Set([1, 2, 4, 5]); // extras 4,5 to be removed
    bs.candidates[0]![1]! = new Set([2, 3, 6, 7]);  // extras 6,7 to be removed
    bs.candidates[0]![2]! = new Set([1, 3, 8, 9]);  // extras 8,9 to be removed
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([4, 5, 6, 7]); // no 1,2,3

    const elims = new NakedHiddenTriple().apply(makeCtx(bs, 0)).eliminations;

    // Extras eliminated from the triple cells
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 4)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 5)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 1 && e.digit === 6)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 2 && e.digit === 8)).toBe(true);
    // Non-triple digits (4-9) not eliminated from cells outside the triple
    expect(elims.every(e => e.cell[1] <= 2)).toBe(true);
  });
});
