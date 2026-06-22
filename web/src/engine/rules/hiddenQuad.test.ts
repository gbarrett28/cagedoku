/**
 * Tests for HiddenQuad.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { HiddenQuad } from './hiddenQuad.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function makeCtx(bs: KillerBoardState, row: number): RuleContext {
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

describe('HiddenQuad', () => {
  it('asHints: hidden quad returns hint with correct shape', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([1, 2, 5]);
    bs.candidates[0]![1]! = new Set([2, 3, 6]);
    bs.candidates[0]![2]! = new Set([3, 4, 7]);
    bs.candidates[0]![3]! = new Set([1, 4, 8]);
    for (let c = 4; c < 9; c++) bs.candidates[0]![c]! = new Set([5, 6, 7, 8, 9]);
    const ctx = makeCtx(bs, 0);
    const rule = new HiddenQuad();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBe(1);
    expect(hints[0]!.ruleName).toBe('HiddenQuad');
    expect(hints[0]!.displayName).toBe('Hidden Quad');
    expect(hints[0]!.explanation).toContain('Hidden Quad');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
    // secondaryHighlightCells covers the rest of the unit, not the hidden-quad cells
    expect(hints[0]!.secondaryHighlightCells).toHaveLength(5);
    expect(hints[0]!.secondaryHighlightCells!.every(([r, c]) => !(r === 0 && [0, 1, 2, 3].includes(c)))).toBe(true);
  });

  it('near-miss hidden quad: one digit appears in a 5th cell → no hidden quad', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Digits 1,2,3,4 should form a hidden quad in cells 0-3.
    // But digit 1 also appears in cell 4 → cellsWith.size===5, not 4 → guard fails.
    bs.candidates[0]![0]! = new Set([1, 2, 5]);
    bs.candidates[0]![1]! = new Set([2, 3, 6]);
    bs.candidates[0]![2]! = new Set([3, 4, 7]);
    bs.candidates[0]![3]! = new Set([1, 4, 8]);
    bs.candidates[0]![4]! = new Set([1, 5, 6, 7]); // digit 1 leaks into cell 4
    for (let c = 5; c < 9; c++) bs.candidates[0]![c]! = new Set([5, 6, 7, 8, 9]);

    const elims = new HiddenQuad().apply(makeCtx(bs, 0)).eliminations;
    // Hidden quad does not fire → extras 5 from cell 0 must not be eliminated
    expect(elims.some(e => e.cell[1] === 0 && e.digit === 5)).toBe(false);
  });

  it('hidden quad: restricts four cells to only the quad digits', () => {
    const bs = new KillerBoardState(makeTrivialSpec());

    // Digits 1,2,3,4 appear only in cells 0-3 — hidden quad
    bs.candidates[0]![0]! = new Set([1, 2, 5]);
    bs.candidates[0]![1]! = new Set([2, 3, 6]);
    bs.candidates[0]![2]! = new Set([3, 4, 7]);
    bs.candidates[0]![3]! = new Set([1, 4, 8]);
    for (let c = 4; c < 9; c++) bs.candidates[0]![c]! = new Set([5, 6, 7, 8, 9]);

    const elims = new HiddenQuad().apply(makeCtx(bs, 0)).eliminations;

    // Extras eliminated from the quad cells
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 5)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 1 && e.digit === 6)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 2 && e.digit === 7)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 3 && e.digit === 8)).toBe(true);
    // Only quad cells (0-3) are touched
    expect(elims.every(e => e.cell[1] <= 3)).toBe(true);
  });
});
