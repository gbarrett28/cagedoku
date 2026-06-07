/**
 * Tests for HiddenPair.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { HiddenPair } from './hiddenPair.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('HiddenPair', () => {
  it('eliminates extra candidates from the pair cells', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);

    // Pair digits 4 and 6 appear only in cells (0,0) and (0,1)
    bs.candidates[0]![0]! = new Set([1, 4, 6]);
    bs.candidates[0]![1]! = new Set([4, 5, 6]);
    for (let c = 2; c < 9; c++) bs.candidates[0]![c]! = new Set([2, 3, 7, 8, 9]);

    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid]![d] = Array.from({ length: 9 }, (_, c) => c)
        .filter(c => bs.cands(0, c).has(d)).length;
    }

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
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

  it('asHints: returns a hint with correct shape for a hidden pair', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    bs.candidates[0]![0]! = new Set([1, 4, 6]);
    bs.candidates[0]![1]! = new Set([4, 5, 6]);
    for (let c = 2; c < 9; c++) bs.candidates[0]![c]! = new Set([2, 3, 7, 8, 9]);
    for (let d = 1; d <= 9; d++)
      bs.counts[rowUid]![d] = [0,1,2,3,4,5,6,7,8].filter(c => bs.cands(0, c).has(d)).length;

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null, cell: null,
      board: bs, hint: Trigger.COUNT_HIT_TWO, hintDigit: 4,
    };
    const rule = new HiddenPair();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);

    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBe(1);
    expect(hints[0]!.ruleName).toBe('HiddenPair');
    expect(hints[0]!.displayName).toBe('Hidden Pair');
    expect(hints[0]!.explanation).toContain('4');
    expect(hints[0]!.explanation).toContain('6');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('near-miss: d1 in 3 cells → no hidden pair (pairCells.length !== 2)', () => {
    // hintDigit d1=4 appears in 3 cells — pairCells.length = 3, not 2.
    // Even if some d2 shares 2 of those cells, the rule must not fire.
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    // d1=4 in cells (0,0), (0,1), (0,2)
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 6]);
    bs.candidates[0]![2]! = new Set([4, 8]);
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3, 5, 7, 9]);
    for (let d = 1; d <= 9; d++)
      bs.counts[rowUid]![d] = Array.from({ length: 9 }, (_, c) => c)
        .filter(c => bs.cands(0, c).has(d)).length;

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    expect(new HiddenPair().apply(ctx).eliminations).toEqual([]);
  });

  it('returns empty when two digits do not share the same two cells', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);

    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 7]); // d2=7, not 6
    bs.candidates[0]![2]! = new Set([6, 7]);
    for (let c = 3; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3]);
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid]![d] = Array.from({ length: 9 }, (_, c) => c)
        .filter(c => bs.cands(0, c).has(d)).length;
    }

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    expect(new HiddenPair().apply(ctx).eliminations).toEqual([]);
  });
});
