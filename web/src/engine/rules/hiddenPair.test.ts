/**
 * Tests for HiddenPair.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { HiddenPair } from './hiddenPair.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('HiddenPair', () => {
  it('eliminates extra candidates from the pair cells', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);

    // Pair digits 4 and 6 appear only in cells (0,0) and (0,1)
    bs.candidates[0][0] = new Set([1, 4, 6]);
    bs.candidates[0][1] = new Set([4, 5, 6]);
    for (let c = 2; c < 9; c++) bs.candidates[0][c] = new Set([2, 3, 7, 8, 9]);

    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid][d] = Array.from({ length: 9 }, (_, c) => c)
        .filter(c => bs.candidates[0][c].has(d)).length;
    }

    const ctx: RuleContext = {
      unit: bs.units[rowUid],
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    const elims = new HiddenPair().apply(ctx).eliminations;

    // Non-pair digits eliminated from the hidden-pair cells
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 1 && e.digit === 5)).toBe(true);
    // Pair digits themselves NOT eliminated
    expect(elims.every(e => e.digit !== 4 && e.digit !== 6)).toBe(true);
    // Other cells NOT touched
    expect(elims.every(e => e.cell[1] === 0 || e.cell[1] === 1)).toBe(true);
  });

  it('returns empty when two digits do not share the same two cells', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);

    bs.candidates[0][0] = new Set([4, 6]);
    bs.candidates[0][1] = new Set([4, 7]); // d2=7, not 6
    bs.candidates[0][2] = new Set([6, 7]);
    for (let c = 3; c < 9; c++) bs.candidates[0][c] = new Set([1, 2, 3]);
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid][d] = Array.from({ length: 9 }, (_, c) => c)
        .filter(c => bs.candidates[0][c].has(d)).length;
    }

    const ctx: RuleContext = {
      unit: bs.units[rowUid],
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    expect(new HiddenPair().apply(ctx).eliminations).toEqual([]);
  });
});
