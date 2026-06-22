/**
 * Tests for HiddenSingle — port of Python's test_hidden_single.py.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { HiddenSingle } from './hiddenSingle.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec, makeTwoCellCageSpec } from '../fixtures.js';

function makeCtx(bs: KillerBoardState, rowUid: number, hintDigit: number): RuleContext {
  return {
    unit: bs.units[rowUid] ?? null,
    cell: null,
    board: bs,
    hint: Trigger.COUNT_HIT_ONE,
    hintDigit,
  };
}

describe('HiddenSingle', () => {
  it('eliminates all non-target candidates from the sole cell', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    // Confine digit 7 to cell (0,4) in row 0
    for (let c = 0; c < 9; c++) {
      if (c !== 4) bs.cands(0, c).delete(7);
    }
    bs.counts[rowUid]![7] = 1;

    const result = new HiddenSingle().apply(makeCtx(bs, rowUid, 7));
    const elims = result.eliminations;
    // All eliminations target (0,4) and none remove digit 7
    expect(elims.every(e => e.cell[0] === 0 && e.cell[1] === 4)).toBe(true);
    expect(elims.every(e => e.digit !== 7)).toBe(true);
    // Eliminates every candidate except 7
    expect(elims.length).toBe(bs.cands(0, 4).size - 1);
  });

  it('asHints returns a hint with display name and correct eliminations', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    for (let c = 0; c < 9; c++) {
      if (c !== 4) bs.cands(0, c).delete(7);
    }
    bs.counts[rowUid]![7] = 1;
    const ctx = makeCtx(bs, rowUid, 7);
    const elims = new HiddenSingle().apply(ctx).eliminations;
    const hints = new HiddenSingle().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.displayName).toBe('Hidden Single');
    expect(hints[0]!.eliminations).toStrictEqual(elims);
  });

  it('asHints: highlightCells contains only the sole cell; secondaryHighlightCells covers the rest of the unit', () => {
    // d=7 confined to (0,4) in row 0; col-4 and box-1 peers still hold 7
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    for (let c = 0; c < 9; c++) {
      if (c !== 4) bs.cands(0, c).delete(7);
    }
    bs.counts[rowUid]![7] = 1;
    const ctx = makeCtx(bs, rowUid, 7);
    const elims = new HiddenSingle().apply(ctx).eliminations;
    const hints = new HiddenSingle().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    const hint = hints[0]!;
    // highlightCells contains only the sole cell (0,4)
    expect(hint.highlightCells).toEqual([[0, 4]]);
    // secondaryHighlightCells covers the other 8 cells of row 0
    expect(hint.secondaryHighlightCells).toHaveLength(8);
    expect(hint.secondaryHighlightCells!.some(([r, c]) => r === 0 && c === 0)).toBe(true);
    expect(hint.secondaryHighlightCells!.every(([r, c]) => !(r === 0 && c === 4))).toBe(true);
    // col-4 peers (outside row 0) are in neither highlight set
    expect(hint.secondaryHighlightCells!.some(([r, c]) => r !== 0 && c === 4)).toBe(false);
    // eliminations are unchanged: non-7 candidates of (0,4) only
    expect(hint.eliminations.every(e => e.cell[0] === 0 && e.cell[1] === 4)).toBe(true);
    expect(hint.eliminations.every(e => e.digit !== 7)).toBe(true);
    // explanation still mentions peer removal in prose
    expect(hint.explanation).toContain('also removes 7 from');
  });

  it('returns empty eliminations when digit is absent from all cells', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    for (let c = 0; c < 9; c++) bs.cands(0, c).delete(3);
    bs.counts[rowUid]![3] = 0;

    const result = new HiddenSingle().apply(makeCtx(bs, rowUid, 3));
    expect(result.eliminations).toEqual([]);
  });

  it('near-miss: ctx.unit is null → returns empty (unit context required)', () => {
    // HiddenSingle requires a unit context — the proof relies on the unit constraint
    // (d must appear exactly once in the unit). Without a unit there is no such constraint.
    const bs = new KillerBoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: null, // no unit
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_ONE,
      hintDigit: 7,
    };
    expect(new HiddenSingle().apply(ctx).eliminations).toEqual([]);
  });

  it('cage variant: d absent from one solution → no placement', () => {
    // Two-cell cage {(0,0),(1,0)} with solutions [{5,6},{5,6}] (both contain 5).
    // If we mark digit 5 as absent from one solution, the rule must not fire.
    // We simulate this by using makeTwoCellCageSpec and ensuring that
    // solns do NOT all include a digit — we delete 5 from one solution directly.
    const spec = makeTwoCellCageSpec();
    const bs = new KillerBoardState(spec);
    const cageUid = bs.cageUnitId(0, 0);
    const cageIdx = cageUid - 27;
    // Insert a solution that omits digit 5
    const origSolns = bs.cageSolns[cageIdx]!;
    // Replace with solutions where only one contains 5; the other does not
    const soln5 = origSolns.find(s => s.includes(5));
    if (soln5) {
      // Keep only solutions that do NOT include 5, plus one that does.
      // The guard `solns.every(s => s.includes(d))` must fail.
      bs.cageSolns[cageIdx] = [[6, 7], soln5]; // [6,7] has no 5
    }
    bs.counts[cageUid]![5] = 1; // exactly 1 cell in cage holds 5

    const ctx: RuleContext = {
      unit: bs.units[cageUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_ONE,
      hintDigit: 5,
    };
    const result = new HiddenSingle().apply(ctx);
    expect(result.eliminations).toEqual([]);
  });
});
