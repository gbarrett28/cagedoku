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

  it('root-cause repro (issue #151): asHints describes only the first unit\'s pair ' +
    'but eliminations include a second, unrelated pair\'s eliminations', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const full = () => new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Row 0: naked pair {4,6} at (0,0),(0,1); other row-0 cells are full sets
    // (so the pair eliminates 4 and 6 from them).
    bs.candidates[0]![0]! = new Set([4, 6]);
    bs.candidates[0]![1]! = new Set([4, 6]);
    for (let c = 2; c < 9; c++) bs.candidates[0]![c]! = full();
    // Row 1: a completely unrelated naked pair {2,5} at (1,3),(1,4); other
    // row-1 cells are full sets (so this pair eliminates 2 and 5 from them).
    bs.candidates[1]![3]! = new Set([2, 5]);
    bs.candidates[1]![4]! = new Set([2, 5]);
    for (let c = 0; c < 9; c++) if (c !== 3 && c !== 4) bs.candidates[1]![c]! = full();
    // All other cells: singleton {9}, so no other row/col/box accidentally
    // contains a second size-2 cell that could form a spurious pair.
    for (let r = 2; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]! = new Set([9]);

    const ctx: RuleContext = { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
    const elims = new NakedPair().apply(ctx).eliminations;
    // Sanity: row 1's pair did contribute eliminations to the flat array.
    expect(elims.some(e => e.cell[0] === 1 && (e.digit === 2 || e.digit === 5))).toBe(true);

    const hints = new NakedPair().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    const h = hints[0]!;
    // BUG: the explanation/highlight describe row 0's {4,6} pair only...
    expect(h.highlightCells).toEqual([[0, 0], [0, 1]]);
    // ...yet the attached eliminations also include row 1's {2,5} eliminations,
    // which are not explained by the displayed pair at all.
    expect(h.eliminations.some(e => e.cell[0] === 1 && (e.digit === 2 || e.digit === 5))).toBe(true);
  });
});
