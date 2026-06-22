/**
 * Tests for NakedPair — port of Python's test_naked_pair.py.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { NakedPair } from './nakedPair.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('NakedPair', () => {
  it('eliminates the pair digits from all other row cells', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);

    // Pair cells: both have {4,6}
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 6]);
    // Other cells: have 6 but not 4 (count(4)=2 triggers COUNT_HIT_TWO)
    for (let c = 2; c < 9; c++) {
      bs.candidates[0]![c]! = new Set([1, 2, 3, 5, 6, 7, 8, 9]);
    }
    // Sync counts
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid]![d] = [...Array(9).keys()].filter(c => bs.cands(0, c).has(d)).length;
    }

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    const elims = new NakedPair().apply(ctx).eliminations;
    const elimMap = new Map<string, Set<number>>();
    for (const e of elims) {
      const key = `${e.cell[0]},${e.cell[1]}`;
      if (!elimMap.has(key)) elimMap.set(key, new Set());
      elimMap.get(key)!.add(e.digit);
    }

    // d2=6 eliminated from (0,2)..(0,8)
    for (let c = 2; c < 9; c++) {
      expect(elimMap.get(`0,${c}`)?.has(6)).toBe(true);
    }
    // Pair cells (0,0) and (0,1) are NOT targets
    expect(elimMap.has('0,0')).toBe(false);
    expect(elimMap.has('0,1')).toBe(false);

    const hints = new NakedPair().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.displayName).toBe('Naked Pair');
    expect(hints[0]!.eliminations).toStrictEqual(elims);
  });

  it('GLOBAL: finds pair when neither digit has unit-count 2 (issue #57 regression)', () => {
    // Row 6 from issue #57: r6c0={1,5}, r6c3={1,5,6,8,9}, r6c5={1,6,9}, r6c6={1,5}.
    // Digit 1 appears in 4 cells; digit 5 in 3 — COUNT_HIT_TWO never fires.
    // GLOBAL must detect the naked pair {r6c0,r6c6}={1,5} and eliminate 1 and 5
    // from r6c3 and 1 from r6c5.
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(6);
    bs.candidates[6]![0]! = new Set([1, 5]);
    bs.candidates[6]![1]! = new Set([2]);
    bs.candidates[6]![2]! = new Set([6, 8, 9]);
    bs.candidates[6]![3]! = new Set([1, 5, 6, 8, 9]);
    bs.candidates[6]![4]! = new Set([2]);
    bs.candidates[6]![5]! = new Set([1, 6, 9]);
    bs.candidates[6]![6]! = new Set([1, 5]);
    bs.candidates[6]![7]! = new Set([3]);
    bs.candidates[6]![8]! = new Set([7]);
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid]![d] = [...Array(9).keys()].filter(c => bs.cands(6, c).has(d)).length;
    }
    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.GLOBAL,
      hintDigit: null,
    };
    const elims = new NakedPair().apply(ctx).eliminations;
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 3 && e.digit === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 3 && e.digit === 5)).toBe(true);
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 5 && e.digit === 1)).toBe(true);
    expect(elims.every(e => e.cell[1] !== 0 && e.cell[1] !== 6)).toBe(true);
  });

  it('GLOBAL with null unit: finds pair by scanning all board units (real engine behavior)', () => {
    // Same board as the previous GLOBAL test, but ctx.unit = null.
    // The real engine always passes unit: null for GLOBAL triggers;
    // the existing test passes a non-null unit and therefore never exposed the bug.
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(6);
    bs.candidates[6]![0]! = new Set([1, 5]);
    bs.candidates[6]![1]! = new Set([2]);
    bs.candidates[6]![2]! = new Set([6, 8, 9]);
    bs.candidates[6]![3]! = new Set([1, 5, 6, 8, 9]);
    bs.candidates[6]![4]! = new Set([2]);
    bs.candidates[6]![5]! = new Set([1, 6, 9]);
    bs.candidates[6]![6]! = new Set([1, 5]);
    bs.candidates[6]![7]! = new Set([3]);
    bs.candidates[6]![8]! = new Set([7]);
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid]![d] = [...Array(9).keys()].filter(c => bs.cands(6, c).has(d)).length;
    }
    const ctx: RuleContext = {
      unit: null,
      cell: null,
      board: bs,
      hint: Trigger.GLOBAL,
      hintDigit: null,
    };
    const elims = new NakedPair().apply(ctx).eliminations;
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 3 && e.digit === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 3 && e.digit === 5)).toBe(true);
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 5 && e.digit === 1)).toBe(true);
    expect(elims.every(e => e.cell[1] !== 0 && e.cell[1] !== 6)).toBe(true);
  });

  it('near-miss: cell with 3 candidates is not a naked pair even if counts match', () => {
    // Cell (0,0) has {4,6,9} (3 candidates) and cell (0,1) has {4,6} (2 candidates).
    // count(4) = 2, so COUNT_HIT_TWO fires for digit 4.
    // But (0,0).size !== 2, so the naked-pair condition fails — no elimination.
    // This verifies the guard: cands(c1).size === 2.
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    bs.candidates[0]![0]! = new Set([4, 6, 9]); // 3 candidates — NOT a naked pair
    bs.candidates[0]![1]! = new Set([4, 6]);
    for (let c = 2; c < 9; c++) bs.candidates[0]![c]! = new Set([1, 2, 3, 5, 7, 8]);
    for (let d = 1; d <= 9; d++)
      bs.counts[rowUid]![d] = [...Array(9).keys()].filter(c => bs.cands(0, c).has(d)).length;

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    expect(new NakedPair().apply(ctx).eliminations).toEqual([]);
  });

  it('asHints: highlightCells contains only the pair cells, not elimination targets (issue #141)', () => {
    // Regression for bug #141: highlightCells must be exactly [c1, c2].
    // Elimination cells must NOT appear in highlightCells so the UI can render
    // pattern cells (orange) and elimination cells (yellow) without overlap.
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 6]);
    for (let c = 2; c < 9; c++) {
      bs.candidates[0]![c]! = new Set([1, 2, 3, 5, 6, 7, 8, 9]);
    }
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid]![d] = [...Array(9).keys()].filter(c => bs.cands(0, c).has(d)).length;
    }
    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    const elims = new NakedPair().apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = new NakedPair().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    const h = hints[0]!;
    // highlightCells must be exactly the two pair cells
    expect(h.highlightCells).toHaveLength(2);
    // No elimination cell should appear in highlightCells
    const elimKeys = new Set(h.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    for (const [r, c] of h.highlightCells) {
      expect(elimKeys.has(`${r},${c}`)).toBe(false);
    }
  });

  it('returns empty when two cells do not share the same pair', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 7]); // different second digit
    bs.counts[rowUid]![4] = 2;

    const ctx: RuleContext = {
      unit: bs.units[rowUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    expect(new NakedPair().apply(ctx).eliminations).toEqual([]);
  });

  it('fix (issue #151): two independent pairs produce two hints, each scoped to its own pair', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const full = () => new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const single = () => new Set([9]);
    // Everything starts as a singleton so no cell anywhere can accidentally
    // form a second pair; the two intended pairs are carved out explicitly.
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c] = single();
    // Row 0: naked pair {4,6} at (0,0),(0,1), which is unavoidably also a
    // box-0 pair (cols 0-1 are in box 0). Box 0's other cells stay singleton
    // so the box contributes no eliminations of its own — only row 0's
    // cols 6-8 do, keeping this pair's effect confined to row 0.
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 6]);
    bs.candidates[0]![6]! = full();
    bs.candidates[0]![7]! = full();
    bs.candidates[0]![8]! = full();
    // Row 1: a completely unrelated naked pair {2,5} at (1,3),(1,4), which is
    // unavoidably also a box-1 pair (cols 3-4 are in box 1). Box 1's other
    // cells stay singleton for the same reason as above; row 1's cols 6-8
    // (outside both box 0 and box 1) carry the row's own elimination.
    bs.candidates[1]![3]! = new Set([2, 5]);
    bs.candidates[1]![4]! = new Set([2, 5]);
    bs.candidates[1]![6]! = full();
    bs.candidates[1]![7]! = full();
    bs.candidates[1]![8]! = full();

    const ctx: RuleContext = { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
    const elims = new NakedPair().apply(ctx).eliminations;
    expect(elims.some(e => e.cell[0] === 1 && (e.digit === 2 || e.digit === 5))).toBe(true);

    const hints = new NakedPair().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(2);

    const rowZeroHint = hints.find(h => h.highlightCells.some(([r]) => r === 0))!;
    expect(rowZeroHint.highlightCells).toEqual([[0, 0], [0, 1]]);
    expect(rowZeroHint.eliminations.every(e => e.digit === 4 || e.digit === 6)).toBe(true);
    expect(rowZeroHint.eliminations.some(e => e.cell[0] === 1)).toBe(false);

    const rowOneHint = hints.find(h => h.highlightCells.some(([r]) => r === 1))!;
    expect(rowOneHint.highlightCells).toEqual([[1, 3], [1, 4]]);
    expect(rowOneHint.eliminations.every(e => e.digit === 2 || e.digit === 5)).toBe(true);
    expect(rowOneHint.eliminations.some(e => e.cell[0] === 0)).toBe(false);
  });

  it('merges a pair spanning two units (row + box) into a single hint (issue #151)', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const full = () => new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // (0,0) and (0,1) are simultaneously a row-0 pair and a box-0 pair; the fix
    // must merge both into one hint rather than emitting it twice.
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 6]);
    for (let c = 2; c < 9; c++) bs.candidates[0]![c]! = full();
    for (let r = 1; r < 3; r++) for (let c = 0; c < 3; c++) bs.candidates[r]![c]! = full();
    for (let r = 1; r < 9; r++) for (let c = 3; c < 9; c++) bs.candidates[r]![c]! = new Set([9]);
    for (let r = 3; r < 9; r++) for (let c = 0; c < 3; c++) bs.candidates[r]![c]! = new Set([9]);

    const ctx: RuleContext = { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
    const elims = new NakedPair().apply(ctx).eliminations;
    const hints = new NakedPair().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    const h = hints[0]!;
    expect(h.highlightCells).toEqual([[0, 0], [0, 1]]);
    // Peers from row 0 (e.g. (0,2)) and box 0 (e.g. (1,0)) are both covered.
    expect(h.eliminations.some(e => e.cell[0] === 0 && e.cell[1] === 2)).toBe(true);
    expect(h.eliminations.some(e => e.cell[0] === 1 && e.cell[1] === 0)).toBe(true);
  });
});
