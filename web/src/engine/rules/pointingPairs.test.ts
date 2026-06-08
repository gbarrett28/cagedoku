/**
 * Tests for PointingPairs — port of Python's test_pointing_pairs.py.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { PointingPairs } from './pointingPairs.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('PointingPairs', () => {
  it('eliminates a digit confined to one row within a box from the rest of that row', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Box 0: rows 0-2, cols 0-2. Confine digit 5 to row 0 within box 0.
    for (let r = 1; r < 3; r++)
      for (let c = 0; c < 3; c++)
        bs.cands(r, c).delete(5);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new PointingPairs().apply(ctx).eliminations;
    const elimMap = new Map<string, number>();
    for (const e of elims) {
      if (e.digit === 5) elimMap.set(`${e.cell[0]},${e.cell[1]}`, e.digit);
    }

    // 5 must be eliminated from (0,3)..(0,8)
    for (let c = 3; c < 9; c++) {
      expect(elimMap.has(`0,${c}`)).toBe(true);
    }

    const hints = new PointingPairs().asHints(ctx, [...elims]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.displayName).toBe('Pointing Pairs');
  });

  it('near-miss: digit in 2 rows within box → no pointing-pairs elimination', () => {
    // Digit 3 appears in (0,0) and (1,1) in box 0 — spanning 2 rows and 2 cols.
    // Neither rows.size===1 nor cols.size===1, so no elimination is produced.
    const bs = new KillerBoardState(makeTrivialSpec());
    // Remove digit 3 from all box-0 cells except (0,0) and (1,1)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        if (!(r === 0 && c === 0) && !(r === 1 && c === 1))
          bs.cands(r, c).delete(3);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new PointingPairs().apply(ctx).eliminations;
    expect(elims.filter(e => e.digit === 3)).toHaveLength(0);
  });

  it('near-miss: single candidate in box (carrier.length < 2) → no pointing pairs', () => {
    // Digit 2 appears in only (0,0) within box 0 — this is a Hidden Single, not
    // a Pointing Pair. The rule requires carriers.length >= 2 to be non-trivial.
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        if (!(r === 0 && c === 0))
          bs.cands(r, c).delete(2);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new PointingPairs().apply(ctx).eliminations;
    expect(elims.filter(e => e.digit === 2)).toHaveLength(0);
  });

  it('asHints: returns correct shape for a pointing-pairs hint', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    for (let r = 1; r < 3; r++)
      for (let c = 0; c < 3; c++)
        bs.cands(r, c).delete(5);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const rule = new PointingPairs();
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, [...elims]);
    expect(hints.length).toBeGreaterThan(0);
    const hint = hints[0]!;
    expect(hint.ruleName).toBe('PointingPairs');
    expect(hint.displayName).toBe('Pointing Pairs');
    expect(hint.placement).toBeNull();
    expect(hint.eliminations.length).toBeGreaterThan(0);
    // Carrier cells (inside box) must be in highlightCells but not in eliminations
    const elimCellKeys = new Set(hint.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    for (const c of [0, 1, 2]) {
      expect(elimCellKeys.has(`0,${c}`)).toBe(false); // box cells are carriers, not targets
    }
  });

  it('eliminates a digit confined to one column within a box from the rest of that col', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Confine digit 8 to col 0 within box 0
    for (let r = 0; r < 3; r++)
      for (let c = 1; c < 3; c++)
        bs.cands(r, c).delete(8);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new PointingPairs().apply(ctx).eliminations;
    const elimMap = new Map<string, number>();
    for (const e of elims) {
      if (e.digit === 8) elimMap.set(`${e.cell[0]},${e.cell[1]}`, e.digit);
    }

    // 8 must be eliminated from col 0, rows 3-8
    for (let r = 3; r < 9; r++) {
      expect(elimMap.has(`${r},0`)).toBe(true);
    }
  });
});
