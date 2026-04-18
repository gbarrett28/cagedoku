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
    bs.counts[rowUid][d] = Array.from({ length: 9 }, (_, c) => c)
      .filter(c => bs.candidates[row][c].has(d)).length;
  }
  return {
    unit: bs.units[rowUid],
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
    bs.candidates[0][0] = new Set([1, 2]);
    bs.candidates[0][1] = new Set([2, 3]);
    bs.candidates[0][2] = new Set([1, 3]);
    // Other cells contain some of {1,2,3}
    for (let c = 3; c < 9; c++) bs.candidates[0][c] = new Set([1, 2, 3, 4, 5]);

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

  it('hidden triple: restricts three cells to only the triple digits', () => {
    const bs = new BoardState(makeTrivialSpec());

    // Digits 1,2,3 appear only in cells (0,0), (0,1), (0,2) — hidden triple
    bs.candidates[0][0] = new Set([1, 2, 4, 5]); // extras 4,5 to be removed
    bs.candidates[0][1] = new Set([2, 3, 6, 7]);  // extras 6,7 to be removed
    bs.candidates[0][2] = new Set([1, 3, 8, 9]);  // extras 8,9 to be removed
    for (let c = 3; c < 9; c++) bs.candidates[0][c] = new Set([4, 5, 6, 7]); // no 1,2,3

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
