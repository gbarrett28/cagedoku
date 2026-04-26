/**
 * Tests for XYWing.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { XYWing } from './xyWing.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function globalCtx(bs: BoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('XYWing', () => {
  it('eliminates z from cells seeing both pincers', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Clear all candidates to isolate the pattern
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();

    // Pivot (0,0) = {1,2}; x=1, y=2
    bs.candidates[0]![0]! = new Set([1, 2]);
    // Pincer A (0,1) = {1,3}: shares x=1 with pivot (same row), z=3
    bs.candidates[0]![1]! = new Set([1, 3]);
    // Pincer B (1,0) = {2,3}: shares y=2 with pivot (same col), z=3
    bs.candidates[1]![0]! = new Set([2, 3]);
    // Target (1,1): sees A via col 1 AND B via row 1 → eliminate 3
    bs.candidates[1]![1]! = new Set([3, 5]);
    // Decoy (2,0): sees B but not A → NOT eliminated
    bs.candidates[2]![0]! = new Set([3, 7]);

    const elims = new XYWing().apply(globalCtx(bs)).eliminations;
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 1 && e.digit === 3)).toBe(true);
    // Pincers themselves not targeted
    expect(elims.every(e => !(e.cell[0] === 0 && e.cell[1] === 1))).toBe(true);
    expect(elims.every(e => !(e.cell[0] === 1 && e.cell[1] === 0))).toBe(true);
  });

  it('returns empty when no bivalue cells form a valid chain', () => {
    const bs = new BoardState(makeTrivialSpec());
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set();

    // Pivot {1,2}, A {1,3}, B {2,4} — B has z=4 ≠ A's z=3, no matching z
    bs.candidates[0]![0]! = new Set([1, 2]);
    bs.candidates[0]![1]! = new Set([1, 3]);
    bs.candidates[1]![0]! = new Set([2, 4]);
    bs.candidates[1]![1]! = new Set([3, 4]);

    expect(new XYWing().apply(globalCtx(bs)).eliminations).toHaveLength(0);
  });
});
