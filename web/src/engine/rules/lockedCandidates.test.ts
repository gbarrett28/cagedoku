/**
 * Tests for LockedCandidates — box-line and cage-line reductions.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { LockedCandidates } from './lockedCandidates.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';
import { validateCageLayout } from '../../image/validation.js';

function makeCtx(bs: KillerBoardState, unitId: number): RuleContext {
  return {
    unit: bs.units[unitId] ?? null,
    cell: null,
    board: bs,
    hint: Trigger.COUNT_DECREASED,
    hintDigit: null,
  };
}

/**
 * 3-cell L-cage: (0,0), (0,1), (1,0).
 * Cells (0,0) and (0,1) share row 0; (1,0) is in row 1.
 * All other cells are single-cell cages.
 */
function makeLCageSpec() {
  const cageTotals: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      if (r === 0 && c === 0) return 14; // cage head: 5+3+6
      if ((r === 0 && c === 1) || (r === 1 && c === 0)) return 0;
      return (r * 9 + c) % 9 + 1;
    }));
  const borderX: boolean[][] = Array.from({ length: 9 }, (_, col) =>
    Array.from({ length: 8 }, (__, rowGap) =>
      !(col === 0 && rowGap === 0)));
  const borderY: boolean[][] = Array.from({ length: 8 }, (_, colGap) =>
    Array.from({ length: 9 }, (__, row) =>
      !(colGap === 0 && row === 0)));
  return validateCageLayout(cageTotals, borderX, borderY);
}

describe('LockedCandidates — box-line (row→box)', () => {
  it('eliminates a digit confined to one box within a row from the rest of that box', () => {
    // Digit 5 in row 0 is confined to cols 0,1,2 (box 0).
    // All other row-0 cells have 5 removed. The rule must eliminate 5 from
    // box-0 cells in rows 1 and 2.
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let c = 3; c < 9; c++) bs.cands(0, c).delete(5);

    const rowUid = bs.rowUnitId(0);
    const elims = new LockedCandidates().apply(makeCtx(bs, rowUid)).eliminations;

    const elimKeys = new Set(elims.filter(e => e.digit === 5).map(e => `${e.cell[0]},${e.cell[1]}`));
    for (let r = 1; r < 3; r++)
      for (let c = 0; c < 3; c++)
        expect(elimKeys.has(`${r},${c}`)).toBe(true);

    // Row 0 cells (carriers, inside row) must NOT be targets
    for (let c = 0; c < 9; c++)
      expect(elimKeys.has(`0,${c}`)).toBe(false);
  });

  it('near-miss: d in 2 different boxes within a row → no box-line elimination', () => {
    // Digit 5 in row 0 appears in col 0 (box 0) and col 4 (box 1).
    // boxCols spans 2 box-columns — the guard boxCols.size === 1 fails.
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let c = 0; c < 9; c++) {
      if (c !== 0 && c !== 4) bs.cands(0, c).delete(5);
    }
    const rowUid = bs.rowUnitId(0);
    const elims = new LockedCandidates().apply(makeCtx(bs, rowUid)).eliminations;
    expect(elims.filter(e => e.digit === 5)).toHaveLength(0);
  });
});

describe('LockedCandidates — cage-line (row→cage)', () => {
  it('eliminates a digit confined to a cage within a row from cage cells outside the row', () => {
    // L-cage: (0,0), (0,1), (1,0). Digit 5 in row 0 confined to (0,0) and (0,1)
    // — both in the L-cage. The cage also extends to (1,0) in row 1.
    // The rule should eliminate 5 from (1,0).
    const bs = new KillerBoardState(makeLCageSpec());
    for (let c = 2; c < 9; c++) bs.cands(0, c).delete(5);

    const rowUid = bs.rowUnitId(0);
    const elims = new LockedCandidates().apply(makeCtx(bs, rowUid)).eliminations;
    const elim10 = elims.find(e => e.cell[0] === 1 && e.cell[1] === 0 && e.digit === 5);
    expect(elim10).toBeDefined();
  });

  it('near-miss: d has candidate outside the cage → no cage-line elimination', () => {
    // Digit 5 in row 0: inside L-cage at (0,0) and (0,1), but ALSO at (0,5)
    // (outside the cage). commonCageIds is empty — the guard fails.
    const bs = new KillerBoardState(makeLCageSpec());
    for (let c = 2; c < 9; c++) {
      if (c !== 5) bs.cands(0, c).delete(5);
    }
    const rowUid = bs.rowUnitId(0);
    const elims = new LockedCandidates().apply(makeCtx(bs, rowUid)).eliminations;
    expect(elims.filter(e => e.digit === 5)).toHaveLength(0);
  });
});

describe('LockedCandidates — asHints', () => {
  it('returns hint with correct shape for a box-line reduction', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let c = 3; c < 9; c++) bs.cands(0, c).delete(5);

    const rowUid = bs.rowUnitId(0);
    const rule = new LockedCandidates();
    const ctx = makeCtx(bs, rowUid);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, [...elims]);

    expect(hints.length).toBeGreaterThan(0);
    const h = hints.find(hint => hint.eliminations.some(e => e.digit === 5));
    expect(h).toBeDefined();
    expect(h!.ruleName).toBe('LockedCandidates');
    expect(h!.placement).toBeNull();
    // Carrier cells (row 0, cols 0-2) must not appear as elimination targets
    const elimKeys = new Set(h!.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    for (let c = 0; c < 3; c++) expect(elimKeys.has(`0,${c}`)).toBe(false);
  });
});
