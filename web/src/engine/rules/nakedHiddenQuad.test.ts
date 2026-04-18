/**
 * Tests for NakedHiddenQuad.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { NakedHiddenQuad } from './nakedHiddenQuad.js';
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

describe('NakedHiddenQuad', () => {
  it('naked quad: eliminates quad digits from other row cells', () => {
    const bs = new BoardState(makeTrivialSpec());

    // Four cells forming a naked quad: union = {1,2,3,4}
    bs.candidates[0][0] = new Set([1, 2]);
    bs.candidates[0][1] = new Set([2, 3]);
    bs.candidates[0][2] = new Set([3, 4]);
    bs.candidates[0][3] = new Set([1, 4]);
    for (let c = 4; c < 9; c++) bs.candidates[0][c] = new Set([1, 2, 3, 4, 5]);

    const elims = new NakedHiddenQuad().apply(makeCtx(bs, 0)).eliminations;

    // 1,2,3,4 should be eliminated from cells 4-8
    for (let c = 4; c < 9; c++) {
      for (const d of [1, 2, 3, 4]) {
        expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === c && e.digit === d)).toBe(true);
      }
    }
    // Quad cells not targeted
    expect(elims.every(e => e.cell[1] >= 4)).toBe(true);
  });

  it('hidden quad: restricts four cells to only the quad digits', () => {
    const bs = new BoardState(makeTrivialSpec());

    // Digits 1,2,3,4 appear only in cells 0-3 — hidden quad
    bs.candidates[0][0] = new Set([1, 2, 5]);
    bs.candidates[0][1] = new Set([2, 3, 6]);
    bs.candidates[0][2] = new Set([3, 4, 7]);
    bs.candidates[0][3] = new Set([1, 4, 8]);
    for (let c = 4; c < 9; c++) bs.candidates[0][c] = new Set([5, 6, 7, 8, 9]);

    const elims = new NakedHiddenQuad().apply(makeCtx(bs, 0)).eliminations;

    // Extras eliminated from the quad cells
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 5)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 1 && e.digit === 6)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 2 && e.digit === 7)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 3 && e.digit === 8)).toBe(true);
    // Only quad cells (0-3) are touched
    expect(elims.every(e => e.cell[1] <= 3)).toBe(true);
  });
});
